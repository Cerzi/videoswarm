const crypto = require("crypto");

// A deliberately dumb identity for "versions of the same generation". It
// never traces the graph: it collects seeds, long free text and input media
// wherever they sit, so custom nodes, switches and wrappers cannot break it.
// See docs/architecture/generation-versions.md.

const GENERATION_KEY_VERSION = 1;
const GENERATION_KEY_PREFIX = `gk${GENERATION_KEY_VERSION}-`;

const GENERATION_KEY_LIMITS = Object.freeze({
  maxPayloadBytes: 2 * 1024 * 1024,
  maxDecodeLayers: 2,
  maxNodes: 4096,
  maxInputsPerNode: 256,
  maxSeeds: 256,
  maxTexts: 512,
  maxMedia: 256,
});

const MIN_TEXT_WORDS = 4;
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

// Python's json module writes NaN and Infinity, which ComfyUI emits in fields
// such as `is_changed`. Outside string literals they become null; nothing the
// key reads is ever non-finite.
function replaceNonFiniteTokens(source) {
  let output = "";
  let start = 0;
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    if (current === '"') {
      index += 1;
      while (index < source.length && source[index] !== '"') {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    const token = source.startsWith("NaN", index)
      ? "NaN"
      : source.startsWith("-Infinity", index)
        ? "-Infinity"
        : source.startsWith("Infinity", index)
          ? "Infinity"
          : null;
    if (token) {
      output += `${source.slice(start, index)}null`;
      index += token.length;
      start = index;
      continue;
    }
    index += 1;
  }
  return output + source.slice(start);
}

function parseJson(source) {
  try {
    return JSON.parse(source, reviveNumber);
  } catch (error) {
    if (error instanceof KeyAbandoned) throw error;
    return JSON.parse(replaceNonFiniteTokens(source), reviveNumber);
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

function normalizeText(value) {
  const words = value.trim().split(/\s+/);
  if (words.length < MIN_TEXT_WORDS || words[0] === "") return null;
  return words.join(" ").toLowerCase();
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
    for (const name of names) {
      const value = inputs[name];
      if (name.toLowerCase().includes("seed")) {
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
        add(media, basename, limits.maxMedia);
        continue;
      }
      const text = normalizeText(value);
      if (text !== null) add(texts, text, limits.maxTexts);
    }
  }

  const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    seeds: [...seeds].sort(byCodePoint),
    texts: [...texts].sort(byCodePoint),
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
    parts.media,
  ]);
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${GENERATION_KEY_PREFIX}${digest.slice(0, 32)}`;
}

function computeGenerationKey(payload, options) {
  const parts = deriveGenerationKeyParts(payload, options);
  return parts ? hashGenerationKeyParts(parts) : null;
}

function isGenerationKey(value) {
  return (
    typeof value === "string" &&
    value.length === GENERATION_KEY_PREFIX.length + 32 &&
    value.startsWith(GENERATION_KEY_PREFIX) &&
    /^[0-9a-f]{32}$/.test(value.slice(GENERATION_KEY_PREFIX.length))
  );
}

module.exports = {
  GENERATION_KEY_LIMITS,
  GENERATION_KEY_VERSION,
  MEDIA_EXTENSIONS,
  computeGenerationKey,
  deriveGenerationKeyParts,
  isGenerationKey,
};
