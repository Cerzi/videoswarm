const crypto = require("crypto");
const { replaceNonFiniteJsonTokens } = require("./json-non-finite");

// A deliberately dumb identity for "versions of the same generation". It
// never traces the graph: it collects seeds, free text and input media
// wherever they sit, so custom nodes, switches and wrappers cannot break it.
// See docs/architecture/generation-versions.md.
//
// Version 2 also hashes texts of two or three words. Version 1 read only
// texts of four or more, so same-seed runs of "a cat" and "a dog" sharing a
// long negative prompt counted as versions of one generation.
const GENERATION_KEY_VERSION = 3;
const GENERATION_KEY_PREFIX = `gk${GENERATION_KEY_VERSION}-`;
// The prompt key is the generation key without its seeds: every run of one
// prompt, whatever its seed, sampler settings or model. It is hashed from the
// same parts, so a clip has a prompt key exactly when it has a generation key
// and each version group sits inside one prompt stack. See
// docs/architecture/prompt-stacks.md.
const PROMPT_KEY_VERSION = 2;
const PROMPT_KEY_PREFIX = `pk${PROMPT_KEY_VERSION}-`;

const GENERATION_KEY_LIMITS = Object.freeze({
  maxPayloadBytes: 2 * 1024 * 1024,
  maxDecodeLayers: 2,
  maxNodes: 4096,
  maxInputsPerNode: 256,
  maxSeeds: 256,
  maxTexts: 512,
  maxShortTexts: 512,
  maxMedia: 256,
});

const MIN_TEXT_WORDS = 4;
const MIN_SHORT_TEXT_WORDS = 2;
const MEDIA_EXTENSIONS = Object.freeze([
  ".mp4",
  ".mov",
  ".webm",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".wav",
  ".mp3",
  ".flac",
]);
const INT_LITERAL = /^-?\d+$/;
// Inputs that, beside an input media name on the same node, say where in that
// media the generation starts: a video-to-video run from another cut of one
// source is a different generation. Where the cut ends is left out on
// purpose, so a draft cut short and its full-length final stay versions.
const MEDIA_START_INPUT =
  /^(?:in_time|in_point|start|start_time|start_frame|start_sec|start_seconds|start_index|skip_first_frames|skip_frames)$/;
const TIMECODE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/;

class IntLiteral {
  constructor(source) {
    this.source = source;
  }
}

class KeyAbandoned extends Error {}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Integer literals are kept as their exact source text so that 64-bit seeds
// beyond Number.MAX_SAFE_INTEGER never collapse onto a neighbour.
function reviveNumber(key, value, context) {
  if (typeof value !== "number") return value;
  const source = context?.source;
  if (typeof source === "string") {
    return INT_LITERAL.test(source) ? new IntLiteral(source) : value;
  }
  if (Number.isSafeInteger(value)) return new IntLiteral(String(value));
  // Without source access an unsafe integer cannot be represented exactly.
  if (Number.isInteger(value)) throw new KeyAbandoned("unsafe integer");
  return value;
}

// Strict first; Python NaN/Infinity only on retry (see json-non-finite.js).
function parseJson(source) {
  try {
    return JSON.parse(source, reviveNumber);
  } catch (error) {
    if (error instanceof KeyAbandoned) throw error;
    return JSON.parse(replaceNonFiniteJsonTokens(source), reviveNumber);
  }
}

// Only text is accepted: a pre-parsed object has already lost the exact
// source of its integers.
function decodeGraph(payload, limits) {
  if (typeof payload !== "string") return null;
  let value = payload;
  for (let layer = 0; layer < limits.maxDecodeLayers; layer += 1) {
    if (typeof value !== "string") break;
    const source = value.trim();
    if (!source) return null;
    if (Buffer.byteLength(source, "utf8") > limits.maxPayloadBytes) return null;
    value = parseJson(source);
  }
  if (!isPlainObject(value)) return null;
  // Accept a `{ prompt, workflow }` envelope as well as a bare API graph.
  if (
    Object.prototype.hasOwnProperty.call(value, "prompt") &&
    !isPlainObject(value.prompt?.inputs)
  ) {
    const inner = value.prompt;
    if (typeof inner === "string") return decodeGraph(inner, limits);
    return isPlainObject(inner) ? inner : null;
  }
  return value;
}

function isLink(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === "string" || value[0] instanceof IntLiteral) &&
    value[1] instanceof IntLiteral
  );
}

function linkTarget(value) {
  return value[0] instanceof IntLiteral ? value[0].source : value[0];
}

function soleIntLiteral(inputs, limits) {
  let found = null;
  let inspected = 0;
  for (const name of Object.keys(inputs)) {
    inspected += 1;
    if (inspected > limits.maxInputsPerNode) return null;
    const value = inputs[name];
    if (!(value instanceof IntLiteral)) continue;
    if (found !== null) return null;
    found = value.source;
  }
  return found;
}

// A start written the same way however it is entered: timecodes become
// seconds, and a start at zero is no start at all. Anything unrecognised is
// ignored rather than guessed at.
function normalizeMediaStart(value) {
  let number = null;
  if (value instanceof IntLiteral) {
    number = Number(value.source);
    if (!Number.isSafeInteger(number)) return value.source.replace(/^-?0+(?=\d)/, "");
  } else if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    const timecode = text.match(TIMECODE);
    if (timecode) {
      number =
        Number(timecode[1] || 0) * 3600 + Number(timecode[2]) * 60 + Number(timecode[3]);
    } else if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      number = Number(text);
    }
  }
  if (number === null || !Number.isFinite(number) || number === 0) return null;
  return String(Math.round(number * 1000) / 1000);
}

// Exactly one hop, as for seeds: a primitive node holding the start.
function mediaStartValue(value, nodes, limits) {
  if (!isLink(value)) return normalizeMediaStart(value);
  const source = nodes.get(linkTarget(value));
  if (!source) return null;
  let found;
  let inspected = 0;
  for (const name of Object.keys(source)) {
    inspected += 1;
    if (inspected > limits.maxInputsPerNode) return null;
    const literal = source[name];
    const scalar =
      literal instanceof IntLiteral ||
      typeof literal === "number" ||
      typeof literal === "string";
    if (!scalar) continue;
    if (found !== undefined) return null;
    found = literal;
  }
  return found === undefined ? null : normalizeMediaStart(found);
}

function mediaBasename(value) {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (!MEDIA_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return null;
  }
  const parts = trimmed.split(/[\\/]/);
  const basename = parts[parts.length - 1];
  return basename.length > 0 ? basename : null;
}

// A text of four or more words, or `short` for two or three, normalized;
// null for anything else.
function classifyText(value) {
  const words = value.trim().split(/\s+/);
  if (words[0] === "" || words.length < MIN_SHORT_TEXT_WORDS) return null;
  const text = words.join(" ").toLowerCase();
  return { text, short: words.length < MIN_TEXT_WORDS };
}

function collectParts(graph, limits) {
  const nodes = new Map();
  for (const id of Object.keys(graph)) {
    if (nodes.size >= limits.maxNodes) throw new KeyAbandoned("too many nodes");
    const node = graph[id];
    if (isPlainObject(node) && isPlainObject(node.inputs)) {
      nodes.set(id, node.inputs);
    }
  }

  const seeds = new Set();
  const texts = new Set();
  const shortTexts = new Set();
  const media = new Set();
  const add = (set, value, limit) => {
    set.add(value);
    if (set.size > limit) throw new KeyAbandoned("too many values");
  };

  for (const inputs of nodes.values()) {
    const names = Object.keys(inputs);
    if (names.length > limits.maxInputsPerNode) {
      throw new KeyAbandoned("too many inputs");
    }
    const nodeMedia = [];
    const nodeStarts = [];
    for (const name of names) {
      const value = inputs[name];
      const lowerName = name.toLowerCase();
      if (MEDIA_START_INPUT.test(lowerName)) {
        const start = mediaStartValue(value, nodes, limits);
        if (start !== null) {
          nodeStarts.push(`${lowerName}=${start}`);
          continue;
        }
      }
      if (lowerName.includes("seed")) {
        if (value instanceof IntLiteral) {
          add(seeds, value.source, limits.maxSeeds);
        } else if (isLink(value)) {
          // Exactly one hop: a PrimitiveInt-style node feeding the seed.
          const source = nodes.get(linkTarget(value));
          const literal = source ? soleIntLiteral(source, limits) : null;
          if (literal !== null) add(seeds, literal, limits.maxSeeds);
        }
        continue;
      }
      if (typeof value !== "string") continue;
      const basename = mediaBasename(value);
      if (basename !== null) {
        nodeMedia.push(basename);
        continue;
      }
      const text = classifyText(value);
      if (text?.short) add(shortTexts, text.text, limits.maxShortTexts);
      else if (text) add(texts, text.text, limits.maxTexts);
    }
    // A start applies to the media named on its own node only.
    const startSuffix = nodeStarts.length ? `@${nodeStarts.sort().join(",")}` : "";
    for (const basename of nodeMedia) {
      add(media, `${basename}${startSuffix}`, limits.maxMedia);
    }
  }

  const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    seeds: [...seeds].sort(byCodePoint),
    texts: [...texts].sort(byCodePoint),
    shortTexts: [...shortTexts].sort(byCodePoint),
    media: [...media].sort(byCodePoint),
  };
}

// Returns the parts the key is hashed from, or null when the payload cannot
// yield a key. Total: malformed input returns null and never throws. The
// parts contain prompt text and must never be persisted or logged.
function deriveGenerationKeyParts(payload, options = {}) {
  const limits = { ...GENERATION_KEY_LIMITS, ...options };
  try {
    const graph = decodeGraph(payload, limits);
    if (!graph) return null;
    const parts = collectParts(graph, limits);
    if (parts.seeds.length === 0 || parts.texts.length === 0) return null;
    return parts;
  } catch {
    return null;
  }
}

function hashGenerationKeyParts(parts) {
  const canonical = JSON.stringify([
    GENERATION_KEY_VERSION,
    parts.seeds,
    parts.texts,
    parts.shortTexts,
    parts.media,
  ]);
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${GENERATION_KEY_PREFIX}${digest.slice(0, 32)}`;
}

// The leading tag keeps the two hashes in separate domains even if their
// version numbers and lists ever coincide.
function hashPromptKeyParts(parts) {
  const canonical = JSON.stringify([
    "prompt",
    PROMPT_KEY_VERSION,
    parts.texts,
    parts.shortTexts,
    parts.media,
  ]);
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${PROMPT_KEY_PREFIX}${digest.slice(0, 32)}`;
}

function computeGenerationKey(payload, options) {
  const parts = deriveGenerationKeyParts(payload, options);
  return parts ? hashGenerationKeyParts(parts) : null;
}

// Both keys from one parse, so indexing reads and decodes each payload once.
function computeGenerationKeys(payload, options) {
  const parts = deriveGenerationKeyParts(payload, options);
  if (!parts) return { generationKey: null, promptKey: null };
  return {
    generationKey: hashGenerationKeyParts(parts),
    promptKey: hashPromptKeyParts(parts),
  };
}

function hasHexKeyShape(value, prefix) {
  return (
    typeof value === "string" &&
    value.length === prefix.length + 32 &&
    value.startsWith(prefix) &&
    /^[0-9a-f]{32}$/.test(value.slice(prefix.length))
  );
}

function isGenerationKey(value) {
  return hasHexKeyShape(value, GENERATION_KEY_PREFIX);
}

function isPromptKey(value) {
  return hasHexKeyShape(value, PROMPT_KEY_PREFIX);
}

// How far back from a sampler's `positive` or `negative` input a text node is
// followed (a conditioning node or two between them is common).
const CONDITIONING_HOPS = 3;

// Nodes that feed an input whose name matches `pattern`, up to a few links
// back.
function nodesFeeding(nodes, pattern) {
  const found = new Set();
  const queue = [];
  for (const inputs of nodes.values()) {
    for (const [name, value] of Object.entries(inputs)) {
      if (pattern.test(name) && isLink(value)) queue.push([linkTarget(value), 1]);
    }
  }
  while (queue.length) {
    const [id, depth] = queue.shift();
    if (found.has(id)) continue;
    found.add(id);
    if (depth >= CONDITIONING_HOPS) continue;
    for (const value of Object.values(nodes.get(id) || {})) {
      if (isLink(value)) queue.push([linkTarget(value), depth + 1]);
    }
  }
  return found;
}

/**
 * The prompt's texts for search (prompt-search-and-tag-suggestions.md), each
 * with whether it is a negative prompt: its node feeds a `negative` input and
 * not a `positive` one. Unlike the keys, short texts are included. Returns
 * null when the payload is not a graph. The texts must never be persisted or
 * logged.
 */
function deriveSearchTexts(payload, options = {}) {
  const limits = { ...GENERATION_KEY_LIMITS, ...options };
  try {
    const graph = decodeGraph(payload, limits);
    if (!graph) return null;
    const nodes = new Map();
    for (const id of Object.keys(graph)) {
      if (nodes.size >= limits.maxNodes) return null;
      const node = graph[id];
      if (isPlainObject(node) && isPlainObject(node.inputs)) nodes.set(id, node.inputs);
    }
    const positive = nodesFeeding(nodes, /positive/iu);
    const negative = nodesFeeding(nodes, /negative/iu);
    const texts = [];
    for (const [id, inputs] of nodes) {
      for (const value of Object.values(inputs)) {
        if (typeof value !== "string" || mediaBasename(value) !== null) continue;
        const text = classifyText(value);
        if (!text) continue;
        texts.push({ text: text.text, negative: negative.has(id) && !positive.has(id) });
        if (texts.length > limits.maxTexts + limits.maxShortTexts) return null;
      }
    }
    return texts;
  } catch {
    return null;
  }
}

// Weight files a graph loads: checkpoints, diffusion models, LoRAs, VAEs and
// text encoders are all named by file in their loader's inputs.
const WEIGHT_FILE = /\.(?:safetensors|ckpt|pt|pth|bin|gguf|sft)$/iu;

/**
 * The model and LoRA files a prompt's graph loads, as lowercased file names
 * without folders or extension, for tag suggestions
 * (prompt-search-and-tag-suggestions.md). Returns null when the payload is
 * not a graph. The names must never be persisted or logged.
 */
function deriveResourceNames(payload, options = {}) {
  const limits = { ...GENERATION_KEY_LIMITS, ...options };
  try {
    const graph = decodeGraph(payload, limits);
    if (!graph) return null;
    const names = new Set();
    let nodes = 0;
    for (const id of Object.keys(graph)) {
      if ((nodes += 1) > limits.maxNodes) return null;
      const inputs = graph[id]?.inputs;
      if (!isPlainObject(inputs)) continue;
      for (const value of Object.values(inputs)) {
        if (typeof value !== "string" || !WEIGHT_FILE.test(value.trim())) continue;
        const parts = value.trim().split(/[\\/]/u);
        const name = parts[parts.length - 1].replace(WEIGHT_FILE, "").toLowerCase();
        if (name) names.add(name);
        if (names.size > limits.maxMedia) return null;
      }
    }
    return [...names].sort();
  } catch {
    return null;
  }
}

// Facts about the workflow a clip embeds, for filters
// (docs/architecture/workflow-filters.md): the node types it runs, the weight
// files it loads and its largest steps setting. Never a text input, so never
// a prompt; producer-neutral, so no node type is special-cased. Bump the
// version when what is collected changes: stored facts are then read again.
const WORKFLOW_FACTS_VERSION = 1;
const WORKFLOW_FACT_LIMITS = Object.freeze({ maxTerms: 512, maxTermChars: 128 });
const STEPS_INPUT = /^(?:steps|num_steps|sampling_steps|total_steps)$/u;
const MAX_STEPS = 100_000;

function stepsValue(value, nodes, limits) {
  let source = null;
  if (value instanceof IntLiteral) source = value.source;
  else if (isLink(value)) {
    // One hop, as for seeds: a primitive node feeding the setting.
    const node = nodes[linkTarget(value)];
    if (isPlainObject(node?.inputs)) source = soleIntLiteral(node.inputs, limits);
  }
  const steps = source === null ? NaN : Number(source);
  return Number.isSafeInteger(steps) && steps > 0 && steps <= MAX_STEPS ? steps : null;
}

/**
 * `{ steps, terms }` for a clip's embedded graph, or null without one:
 * `terms` are its node types and weight-file names, lower-cased, distinct and
 * sorted; `steps` the largest steps setting, or null when it has none. Total:
 * malformed input returns null and never throws.
 */
function deriveWorkflowFacts(payload, options = {}) {
  const limits = { ...GENERATION_KEY_LIMITS, ...WORKFLOW_FACT_LIMITS, ...options };
  try {
    const graph = decodeGraph(payload, limits);
    if (!graph) return null;
    const terms = new Set();
    let steps = null;
    let nodes = 0;
    const addTerm = (value) => {
      const term = value.trim().toLowerCase();
      if (!term || term.length > limits.maxTermChars || /[\r\n]/u.test(term)) return;
      terms.add(term);
      if (terms.size > limits.maxTerms) throw new KeyAbandoned("too many terms");
    };
    for (const id of Object.keys(graph)) {
      if ((nodes += 1) > limits.maxNodes) return null;
      const node = graph[id];
      if (!isPlainObject(node)) continue;
      if (typeof node.class_type === "string") addTerm(node.class_type);
      const inputs = node.inputs;
      if (!isPlainObject(inputs)) continue;
      let inspected = 0;
      for (const [name, value] of Object.entries(inputs)) {
        if ((inspected += 1) > limits.maxInputsPerNode) break;
        if (STEPS_INPUT.test(name.toLowerCase())) {
          const found = stepsValue(value, graph, limits);
          if (found !== null) steps = Math.max(steps ?? 0, found);
          continue;
        }
        if (typeof value !== "string" || !WEIGHT_FILE.test(value.trim())) continue;
        const parts = value.trim().split(/[\\/]/u);
        addTerm(parts[parts.length - 1].replace(WEIGHT_FILE, ""));
      }
    }
    return { steps, terms: [...terms].sort() };
  } catch {
    return null;
  }
}

module.exports = {
  GENERATION_KEY_LIMITS,
  GENERATION_KEY_VERSION,
  WORKFLOW_FACTS_VERSION,
  deriveWorkflowFacts,
  MEDIA_EXTENSIONS,
  PROMPT_KEY_VERSION,
  computeGenerationKey,
  computeGenerationKeys,
  deriveGenerationKeyParts,
  deriveResourceNames,
  deriveSearchTexts,
  isGenerationKey,
  isPromptKey,
};
