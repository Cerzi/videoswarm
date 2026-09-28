const path = require('path');
const {
  DEFAULT_COMFY_GENERATION_LIMITS,
  ComfyGenerationParserError,
  findComfyApiGraph,
  isComfyApiGraph,
  isPlainObject,
  parseBoundedJson,
  quoteUnsafeJsonIntegers,
} = require('./comfy-payload');

// The Generation panel's reader. It finds a render's output, sampler stages,
// checkpoint, LoRAs, prompt, seed and settings by SOCKET TYPE - what a node
// consumes and produces - instead of by node class, so custom nodes need no
// adapter. Types come from the embedded UI workflow when there is one, and
// from ComfyUI's conventional input names when there is not.
// See docs/architecture/generation-type-flow.md.

const MODEL_EXTENSIONS = new Set(['.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.bin', '.sft']);
const MEDIA_EXTENSIONS = new Map([
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.webp', 'image'],
  ['.mp4', 'video'], ['.mov', 'video'], ['.webm', 'video'], ['.mkv', 'video'],
  ['.wav', 'audio'], ['.mp3', 'audio'], ['.flac', 'audio'],
]);

// Section 1, rule 3: conventional input names, used when the UI workflow does
// not declare a socket's type.
const INPUT_NAME_TYPES = new Map([
  ['model', 'MODEL'],
  ['clip', 'CLIP'],
  ['vae', 'VAE'],
  ['positive', 'CONDITIONING'],
  ['negative', 'CONDITIONING'],
  ['conditioning', 'CONDITIONING'],
  ['text_embeds', 'CONDITIONING'],
  ['latent_image', 'LATENT'],
  ['latent', 'LATENT'],
  ['samples', 'LATENT'],
  ['guider', 'GUIDER'],
  ['sigmas', 'SIGMAS'],
  ['noise', 'NOISE'],
  ['sampler', 'SAMPLER'],
  ['image', 'IMAGE'],
  ['images', 'IMAGE'],
  ['video', 'VIDEO'],
  ['seed', 'INT'],
  ['noise_seed', 'INT'],
  ['steps', 'INT'],
  ['start_at_step', 'INT'],
  ['end_at_step', 'INT'],
  ['cfg', 'FLOAT'],
  ['denoise', 'FLOAT'],
]);
// Switch inputs (rgthree `any_01`, `any_02`, ...) carry whatever they are
// given; ComfyUI declares them `*`.
const ANY_INPUT = /^any_\d+$/i;

// Prompt text is looked for upstream of a conditioning input along every link
// except those carrying models, media, sampling machinery or plain numbers.
// Custom types (a composer's reference set, a conditioning bundle) and untyped
// links pass, because text reaches samplers through them.
const NON_PROMPT_TYPES = new Set([
  'MODEL', 'CLIP', 'VAE', 'LATENT', 'IMAGE', 'VIDEO', 'AUDIO', 'MASK',
  'NOISE', 'SIGMAS', 'SAMPLER', 'GUIDER', 'INT', 'FLOAT', 'BOOLEAN',
  'CLIP_VISION', 'CLIP_VISION_OUTPUT', 'CONTROL_NET', 'UPSCALE_MODEL',
]);
const HELPER_TYPES = new Set(['NOISE', 'SIGMAS', 'SAMPLER', 'GUIDER']);
const MEDIA_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO']);
const MIN_PROMPT_WORDS = 4;

const OUTPUT_EXACT_NAMES = ['filename', 'file_name', 'output_filename'];
const OUTPUT_PREFIX_NAMES = ['filename_prefix', 'output_path'];

const SETTING_NAMES = {
  seed: ['seed', 'noise_seed'],
  steps: ['steps'],
  cfg: ['cfg'],
  denoise: ['denoise', 'denoise_strength'],
  startStep: ['start_at_step', 'start_step'],
  endStep: ['end_at_step', 'end_step'],
  sampler: ['sampler_name'],
  scheduler: ['scheduler'],
};

// Wrapper suites name their own model and text-embedding types
// (WANVIDEOMODEL, WANVIDEOTEXTEMBEDS). They play MODEL and CONDITIONING.
function isModelType(type) {
  return type === 'MODEL' || (typeof type === 'string' && /VIDEOMODEL$|^WAN.*MODEL$/.test(type));
}

function isConditioningType(type) {
  return type === 'CONDITIONING' || (typeof type === 'string' && /TEXT_?EMBEDS$/.test(type));
}

function extensionOf(value) {
  const match = /\.[a-z0-9]+$/i.exec(String(value).trim());
  return match ? match[0].toLowerCase() : '';
}

function isModelFile(value) {
  return typeof value === 'string' && MODEL_EXTENSIONS.has(extensionOf(value));
}

function wordCount(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

// A JSON array or object held in a string (a composer's file list) is data,
// not prose - but prose may start with "[Shot 1]", so it must really parse.
function isJsonContainer(value) {
  const text = value.trim();
  if (!/^[[{]/.test(text) || !/[\]}]$/.test(text)) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function clampString(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function naturalNodeCompare(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function normalizeFileName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.win32.basename(path.posix.basename(value.trim()));
}

// --- payload -----------------------------------------------------------

function isUiWorkflow(value) {
  return isPlainObject(value) && Array.isArray(value.nodes);
}

// The UI workflow travels beside the API prompt: as a sibling of `prompt` in
// the probe payload or a VHS envelope, or inside a sidecar's JSON.
function findUiWorkflow(payload, limits) {
  const queue = [{ value: payload, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.shift();
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = parseBoundedJson(value, limits);
      } catch {
        continue;
      }
    }
    if (!isPlainObject(parsed)) continue;
    if (isUiWorkflow(parsed)) return parsed;
    if (depth >= limits.maxUnwrapDepth) continue;
    for (const key of ['workflow', 'extra_pnginfo', 'comment', 'description']) {
      if (parsed[key] !== undefined) queue.push({ value: parsed[key], depth: depth + 1 });
    }
  }
  return null;
}

function asRef(value, nodes) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [nodeId, slot] = value;
  if ((typeof nodeId !== 'string' && typeof nodeId !== 'number') || !Number.isInteger(slot)) {
    return null;
  }
  const id = String(nodeId);
  return nodes.has(id) ? { nodeId: id, slot } : null;
}

function indexGraph(graph, limits) {
  const entries = Object.entries(graph);
  if (entries.length > limits.maxGraphNodes) {
    throw new ComfyGenerationParserError(
      'COMFY_GRAPH_NODE_LIMIT',
      `ComfyUI graph exceeds the ${limits.maxGraphNodes}-node limit`
    );
  }
  const nodes = new Map();
  for (const [id, node] of entries) {
    if (isPlainObject(node) && typeof node.class_type === 'string' && isPlainObject(node.inputs)) {
      nodes.set(String(id), { id: String(id), classType: node.class_type, inputs: node.inputs });
    }
  }
  let edges = 0;
  for (const node of nodes.values()) {
    for (const value of Object.values(node.inputs)) {
      if (asRef(value, nodes)) edges += 1;
    }
  }
  if (edges > limits.maxGraphEdges) {
    throw new ComfyGenerationParserError(
      'COMFY_GRAPH_EDGE_LIMIT',
      `ComfyUI graph exceeds the ${limits.maxGraphEdges}-edge limit`
    );
  }
  return nodes;
}

// --- Section 1: socket types --------------------------------------------------

function createTypeMap(workflow, nodes) {
  const inputTypes = new Map();
  const outputTypes = new Map();
  const outputNames = new Map();
  const key = (nodeId, part) => `${nodeId}\u0000${part}`;
  const set = (map, entryKey, type, evidence) => {
    if (typeof type !== 'string' || !type || map.has(entryKey)) return;
    map.set(entryKey, { type, evidence });
  };

  const subgraphs = new Map();
  for (const subgraph of workflow?.definitions?.subgraphs || []) {
    if (isPlainObject(subgraph) && typeof subgraph.id === 'string') {
      subgraphs.set(subgraph.id, subgraph);
    }
  }

  // Subgraph inner nodes appear in the API graph as `outer:inner`; nested
  // subgraphs extend the id. ComfyUI flattens subgraphs when it builds the
  // API prompt, so only the inner nodes' own sockets need typing.
  const addNodes = (list, prefix, depth) => {
    if (!Array.isArray(list) || depth > 8) return;
    for (const node of list) {
      if (!isPlainObject(node) || node.id === undefined) continue;
      const apiId = `${prefix}${node.id}`;
      for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
        if (isPlainObject(input)) set(inputTypes, key(apiId, input.name), input.type, 'declared');
      }
      (Array.isArray(node.outputs) ? node.outputs : []).forEach((output, slot) => {
        if (!isPlainObject(output)) return;
        set(outputTypes, key(apiId, slot), output.type, 'declared');
        if (typeof output.name === 'string' && output.name) {
          outputNames.set(key(apiId, slot), output.name);
        }
      });
      const inner = subgraphs.get(node.type);
      if (inner) addNodes(inner.nodes, `${apiId}:`, depth + 1);
    }
  };
  addNodes(workflow?.nodes, '', 0);

  // Rule 3: conventional input names, and each producer's output slot typed
  // by the input that consumes it.
  for (const node of nodes.values()) {
    for (const [name, value] of Object.entries(node.inputs)) {
      const byName = INPUT_NAME_TYPES.get(name.toLowerCase()) ||
        (ANY_INPUT.test(name) ? '*' : null) ||
        (/^conditioning_/i.test(name) ? 'CONDITIONING' : null) ||
        // `audio_vae`, `video_vae`, `t5_clip`: a qualified VAE or CLIP input.
        (/_vae$/i.test(name) ? 'VAE' : null) ||
        (/_clip$/i.test(name) ? 'CLIP' : null);
      if (byName) set(inputTypes, key(node.id, name), byName, 'inferred');
      const ref = asRef(value, nodes);
      const consumed = inputTypes.get(key(node.id, name));
      if (ref && consumed) set(outputTypes, key(ref.nodeId, ref.slot), consumed.type, 'inferred');
    }
  }

  const evidenceRank = { declared: 0, inferred: 1 };
  return {
    input: (nodeId, name) => inputTypes.get(key(nodeId, name)) || null,
    // A link's type is its producer's output, else its consumer's input. A
    // concrete type beats "*" (a switch's output is "*", the save consuming
    // it says VIDEO), and declared evidence beats inferred.
    link(consumerId, name, ref) {
      const produced = outputTypes.get(key(ref.nodeId, ref.slot));
      const consumed = inputTypes.get(key(consumerId, name));
      if (produced && consumed) {
        if (produced.type === '*' && consumed.type !== '*') return consumed;
        if (consumed.type === '*' && produced.type !== '*') return produced;
        if (evidenceRank[consumed.evidence] < evidenceRank[produced.evidence]) return consumed;
      }
      return produced || consumed || null;
    },
    outputsOf(nodeId) {
      const found = [];
      for (let slot = 0; slot < 64; slot += 1) {
        const entry = outputTypes.get(key(nodeId, slot));
        if (entry) found.push(entry.type);
      }
      return found;
    },
    outputName: (nodeId, slot) => outputNames.get(key(nodeId, slot)) || null,
  };
}

// --- Section 2: pass-through, and resolving values ------------------------------

function createReader({ nodes, types, limits }) {
  const inputRefs = (node) =>
    Object.entries(node.inputs)
      .map(([name, value]) => ({ name, ref: asRef(value, nodes) }))
      .filter((entry) => entry.ref);

  const linkType = (node, name, ref) => types.link(node.id, name, ref)?.type || null;

  // A switch or reroute carries its first connected input in name order. A
  // conditional switch (`on_true` / `on_false` and one selector) carries the
  // branch its selector resolves to; an unresolvable selector leaves the value
  // unresolved rather than guessed.
  const passThroughInput = (node) => {
    if ('on_true' in node.inputs && 'on_false' in node.inputs) {
      const selector = Object.keys(node.inputs).find(
        (name) => name !== 'on_true' && name !== 'on_false'
      );
      const chosen = selector ? resolve(node.inputs[selector]) : null;
      if (!chosen || typeof chosen.value !== 'boolean') return null;
      const name = chosen.value ? 'on_true' : 'on_false';
      return { name, ref: asRef(node.inputs[name], nodes) };
    }
    const outputs = types.outputsOf(node.id);
    const refs = inputRefs(node);
    if (outputs.length > 1 || refs.length === 0) return null;
    const literals = Object.values(node.inputs).filter(
      (value) => value !== null && !asRef(value, nodes)
    );
    if (literals.length) return null;
    const outputType = outputs[0] || null;
    const carried = refs.every(({ name, ref }) => {
      if (outputType === null) return types.input(node.id, name)?.type === '*';
      const type = linkType(node, name, ref);
      return type === outputType || type === '*' || outputType === '*';
    });
    if (!carried) return null;
    return [...refs].sort((a, b) => naturalNodeCompare(a.name, b.name))[0];
  };

  // Follow a value through pass-through nodes and one-literal primitives to a
  // literal (`{ value, hops }`) or a real producer (`{ node }`). Declared as a
  // function because pass-through and resolution call each other.
  function resolve(value, visited = new Set(), hops = 0) {
    const ref = asRef(value, nodes);
    if (!ref) {
      return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
        ? { value, hops }
        : null;
    }
    if (visited.has(ref.nodeId) || visited.size > limits.maxTraversalDepth) return null;
    visited.add(ref.nodeId);
    const node = nodes.get(ref.nodeId);
    const through = passThroughInput(node);
    if (through) return resolve(node.inputs[through.name], visited, hops + 1);
    const scalars = Object.values(node.inputs).filter(
      (entry) =>
        typeof entry === 'number' ||
        typeof entry === 'boolean' ||
        (typeof entry === 'string' && entry !== '')
    );
    if (inputRefs(node).length === 0 && scalars.length === 1) {
      return { value: scalars[0], hops: hops + 1 };
    }
    return { node, hops };
  }

  // Upstream nodes by distance, optionally skipping links of excluded types.
  const upstream = (startId, excluded = null) => {
    const distance = new Map([[startId, 0]]);
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift();
      const node = nodes.get(id);
      for (const { name, ref } of inputRefs(node)) {
        if (distance.has(ref.nodeId)) continue;
        if (excluded && excluded.has(linkType(node, name, ref))) continue;
        const next = distance.get(id) + 1;
        if (next > limits.maxTraversalDepth) {
          throw new ComfyGenerationParserError(
            'COMFY_TRAVERSAL_DEPTH_LIMIT',
            `ComfyUI traversal exceeds the maximum depth of ${limits.maxTraversalDepth}`
          );
        }
        if (distance.size >= limits.maxTraversalVisits) {
          throw new ComfyGenerationParserError(
            'COMFY_TRAVERSAL_LIMIT',
            `ComfyUI traversal exceeds the ${limits.maxTraversalVisits}-visit limit`
          );
        }
        distance.set(ref.nodeId, next);
        queue.push(ref.nodeId);
      }
    }
    return distance;
  };

  const inputsWhere = (node, predicate) =>
    inputRefs(node).filter(({ name, ref }) => predicate(linkType(node, name, ref), name));
  const consumes = (node, predicate) => inputsWhere(node, predicate).length > 0;

  return { inputRefs, linkType, passThroughInput, resolve, upstream, inputsWhere, consumes };
}

// --- Section 3: roles ---------------------------------------------------------

function selectOutput(nodes, reader, fileName, limits) {
  const outputs = [...nodes.values()]
    .filter((node) =>
      reader.consumes(node, (type) => type === 'IMAGE' || type === 'VIDEO') &&
      [...OUTPUT_EXACT_NAMES, ...OUTPUT_PREFIX_NAMES].some((name) => typeof node.inputs[name] === 'string')
    )
    .sort((a, b) => naturalNodeCompare(a.id, b.id));
  if (outputs.length > limits.maxOutputs) {
    throw new ComfyGenerationParserError(
      'COMFY_OUTPUT_LIMIT',
      `ComfyUI graph exceeds the ${limits.maxOutputs}-output limit`
    );
  }
  if (!outputs.length) return { node: null, ambiguous: false };

  const target = normalizeFileName(fileName);
  const score = (node) => {
    if (!target) return null;
    const targetStem = target.slice(0, target.length - path.extname(target).length).toLowerCase();
    for (const name of OUTPUT_EXACT_NAMES) {
      const candidate = normalizeFileName(node.inputs[name]);
      if (candidate && candidate.toLowerCase() === target.toLowerCase()) {
        return { score: 3, match: 'exact-filename' };
      }
    }
    for (const name of OUTPUT_PREFIX_NAMES) {
      const prefix = normalizeFileName(node.inputs[name]);
      if (!prefix) continue;
      const stem = prefix.slice(0, prefix.length - path.extname(prefix).length).toLowerCase();
      if (targetStem === stem || targetStem.startsWith(`${stem}_`) || targetStem.startsWith(`${stem}-`)) {
        return { score: 2, match: 'filename-prefix' };
      }
    }
    return null;
  };
  const matches = outputs.map((node) => ({ node, result: score(node) })).filter((entry) => entry.result);
  if (matches.length) {
    const best = Math.max(...matches.map((entry) => entry.result.score));
    const top = matches.filter((entry) => entry.result.score === best);
    return top.length === 1
      ? { node: top[0].node, match: top[0].result.match, ambiguous: false }
      : { node: null, ambiguous: true };
  }
  if (outputs.length === 1) return { node: outputs[0], match: 'only-output', ambiguous: false };
  return { node: null, ambiguous: true };
}

// A sampler stage outputs a LATENT and consumes a model with conditioning, a
// guider, or noise with sigmas. A node that only plans windows or composes
// references (a custom conditioning bundle, no model) is not one.
function isSamplerStage(node, reader, types) {
  if (!types.outputsOf(node.id).includes('LATENT')) return false;
  return (
    (reader.consumes(node, isModelType) && reader.consumes(node, isConditioningType)) ||
    reader.consumes(node, (type) => type === 'GUIDER') ||
    (reader.consumes(node, (type) => type === 'NOISE') &&
      reader.consumes(node, (type) => type === 'SIGMAS'))
  );
}

function modelKind(inputName) {
  if (/^ckpt/i.test(inputName)) return 'checkpoint';
  if (/^unet/i.test(inputName)) return 'unet';
  return 'model';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseComfyGenerationPayload(payload, options = {}) {
  const limits = { ...DEFAULT_COMFY_GENERATION_LIMITS, ...(options.limits || {}) };
  const located = findComfyApiGraph(payload, limits);
  if (!located) return null;
  const nodes = indexGraph(located.graph, limits);
  const workflow = findUiWorkflow(payload, limits);
  const types = createTypeMap(workflow, nodes);
  const reader = createReader({ nodes, types, limits });

  const diagnostics = [];
  const diagnosticKeys = new Set();
  const diagnose = (code, message, node = null, role = null) => {
    const entryKey = `${code}:${node?.id || ''}:${role || ''}`;
    if (diagnosticKeys.has(entryKey) || diagnostics.length >= limits.maxDiagnostics) return;
    diagnosticKeys.add(entryKey);
    diagnostics.push({ code, message, nodeId: node?.id || null, classType: node?.classType || null, role });
  };

  const baseOrigin = isPlainObject(options.origin) ? options.origin : {};
  const origin = {
    kind: clampString(baseOrigin.kind, limits.maxScalarLength) || 'unknown',
    carrier: clampString(baseOrigin.carrier, limits.maxScalarLength) || 'json',
    metadataKey: clampString(baseOrigin.metadataKey, limits.maxScalarLength) || located.metadataKey,
    graphFormat: 'api',
    resolution: 'partial',
    // Whether socket types came from the embedded UI workflow or were
    // inferred from input names. Recorded, not used to lower confidence: on
    // real renders the conventional names proved as reliable.
    typeEvidence: workflow ? 'declared' : 'inferred',
  };

  const empty = {
    provider: 'comfyui',
    origin,
    output: null,
    positivePrompt: null,
    negativePrompt: null,
    promptFragments: [],
    samplerStages: [],
    assets: { models: [], vaes: [], textEncoders: [], loras: [] },
    sourceInputs: [],
    diagnostics,
    prompt: null,
    seed: null,
    model: null,
    models: [],
    sampler: null,
    samplers: [],
    sourceImage: null,
    sourceImages: [],
    generationRun: null,
  };

  const selected = selectOutput(nodes, reader, options.fileName, limits);
  if (!selected.node) {
    diagnose(
      selected.ambiguous ? 'AMBIGUOUS_OUTPUT' : 'OUTPUT_NOT_FOUND',
      selected.ambiguous
        ? 'Several output nodes could own this file'
        : 'No node takes IMAGE or VIDEO and names an output file'
    );
    return { ...empty, origin: { ...origin, resolution: selected.ambiguous ? 'ambiguous' : 'partial' } };
  }

  const reachable = reader.upstream(selected.node.id);
  const stageEntries = [...reachable.entries()]
    .map(([id, distance]) => ({ node: nodes.get(id), distance }))
    .filter(({ node }) => isSamplerStage(node, reader, types))
    .sort((a, b) => b.distance - a.distance || naturalNodeCompare(a.node.id, b.node.id));
  if (stageEntries.length > limits.maxSamplerStages) {
    throw new ComfyGenerationParserError(
      'COMFY_SAMPLER_LIMIT',
      `ComfyUI graph exceeds the ${limits.maxSamplerStages}-sampler limit`
    );
  }

  // --- assets and LoRAs --------------------------------------------------------
  const models = [];
  const vaes = [];
  const textEncoders = [];
  const loras = [];
  const loraByKey = new Map();
  const assetKeys = new Set();

  const bucketNames = new Map([[models, 'models'], [vaes, 'vaes'], [textEncoders, 'textEncoders']]);
  const addAsset = (bucket, kind, name, node) => {
    const clean = clampString(name, limits.maxScalarLength);
    const assetKey = `${bucketNames.get(bucket)}:${kind}:${node.id}:${clean}`;
    if (!clean || assetKeys.has(assetKey) || bucket.length >= limits.maxAssetsPerKind) return;
    assetKeys.add(assetKey);
    bucket.push({ name: clean, kind, nodeId: node.id });
  };

  const modelFiles = (node) => Object.entries(node.inputs).filter(([, value]) => isModelFile(value));
  // A root's model file, else - for a loader whose value carries no
  // extension - a string under a conventional `*_name` input.
  const rootFiles = (node) => {
    const files = modelFiles(node);
    if (files.length) return files;
    return Object.entries(node.inputs).filter(
      ([name, value]) => /_name$/i.test(name) && typeof value === 'string' && value.trim()
    );
  };

  const addLora = (name, node, strengthModel, strengthClip, appliedTo) => {
    const clean = clampString(name, limits.maxScalarLength);
    if (!clean) return;
    const loraKey = `${node.id}:${clean}`;
    let lora = loraByKey.get(loraKey);
    if (!lora) {
      if (loras.length >= limits.maxAssetsPerKind) return;
      lora = { name: clean, nodeId: node.id, strengthModel, strengthClip, appliedTo: [] };
      loraByKey.set(loraKey, lora);
      loras.push(lora);
    }
    if (!lora.appliedTo.includes(appliedTo)) {
      lora.appliedTo.push(appliedTo);
      lora.appliedTo.sort();
    }
  };

  // LoRAs a node holds itself: a model file under a lora-named input
  // (`lora_name`, `lora`, `lora_0`) with the strength of the same suffix, or
  // rgthree Power Lora `{on, lora, strength}` entries. Zero strength or
  // `on: false` is not used, and is not reported.
  const collectOwnLoras = (node, appliedTo) => {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (isPlainObject(value) && typeof value.lora === 'string' && value.lora) {
        const strength = numberOrNull(value.strength ?? value.strengthModel);
        if (value.on === false || strength === 0) continue;
        addLora(value.lora, node, strength, null, appliedTo);
        continue;
      }
      const match = /lora(.*)$/i.exec(name);
      if (!match || !isModelFile(value)) continue;
      const suffix = match[1] === '_name' ? '_model' : match[1];
      const strengthName = [`strength${suffix}`, 'strength']
        .find((candidate) => node.inputs[candidate] !== undefined);
      const strength = strengthName
        ? numberOrNull(reader.resolve(node.inputs[strengthName])?.value)
        : null;
      if (strength === 0) continue;
      addLora(value, node, strength, numberOrNull(node.inputs.strength_clip), appliedTo);
    }
  };

  // A LoRA stack attached to a chain node through a lora-named link input
  // (`lora`, `prev_lora`), collected base-first.
  const collectLoraStack = (node, appliedTo, visited = new Set()) => {
    for (const { name, ref } of reader.inputRefs(node)) {
      if (!/lora/i.test(name) || visited.has(ref.nodeId)) continue;
      visited.add(ref.nodeId);
      const selector = nodes.get(ref.nodeId);
      collectLoraStack(selector, appliedTo, visited);
      collectOwnLoras(selector, appliedTo);
    }
  };

  // Walk a MODEL / CLIP / VAE chain up through pass-through to its root,
  // visiting each node on the way.
  const traceChain = (startRef, isChainType, onRoot, onNode) => {
    const visited = new Set();
    let ref = startRef;
    for (let depth = 0; ref && depth <= limits.maxTraversalDepth; depth += 1) {
      if (visited.has(ref.nodeId)) return;
      visited.add(ref.nodeId);
      const node = nodes.get(ref.nodeId);
      const through = reader.passThroughInput(node);
      if (through) {
        ref = through.ref;
        continue;
      }
      onNode?.(node);
      const next = reader.inputsWhere(node, isChainType)[0];
      if (!next) {
        onRoot(node);
        return;
      }
      ref = next.ref;
    }
  };

  const modelRoots = new Set();
  const traceModel = (ref) =>
    traceChain(
      ref,
      isModelType,
      (root) => {
        modelRoots.add(root.id);
        rootFiles(root).forEach(([name, file]) => addAsset(models, modelKind(name), file, root));
      },
      (node) => {
        collectLoraStack(node, 'model');
        collectOwnLoras(node, 'model');
      }
    );

  // --- Section 3: prompt text ----------------------------------------------------
  const promptFragments = [];
  const promptKeys = new Set();
  let promptLength = 0;

  // Nodes whose text can reach a conditioning input. Each is marked
  // `into-encoder` when its value flows unchanged (through switches only) into
  // a node that produces conditioning, and `upstream` otherwise. A node that
  // passes a positive/negative pair through (an output slot named like one of
  // its inputs) is followed only along the matching input.
  const producesConditioning = (node) => types.outputsOf(node.id).some(isConditioningType);
  const promptReach = (startRef) => {
    const reached = new Map();
    const queue = [{ nodeId: startRef.nodeId, slot: startRef.slot, state: 'start' }];
    while (queue.length && reached.size < limits.maxTraversalVisits) {
      const { nodeId, slot, state } = queue.shift();
      const node = nodes.get(nodeId);
      const slotName = types.outputName(nodeId, slot);
      const previous = reached.get(nodeId);
      const firstVisit = previous === undefined;
      if (firstVisit || (previous === 'upstream' && state !== 'upstream')) reached.set(nodeId, state);
      let refs = reader
        .inputRefs(node)
        .filter(({ name, ref }) => !NON_PROMPT_TYPES.has(reader.linkType(node, name, ref)));
      if (slotName && refs.some(({ name }) => name === slotName)) {
        refs = refs.filter(({ name }) => name === slotName);
      } else if (!firstVisit) {
        continue;
      }
      const carries = producesConditioning(node) ||
        (state === 'into-encoder' && Boolean(reader.passThroughInput(node)));
      for (const { ref } of refs) {
        queue.push({ nodeId: ref.nodeId, slot: ref.slot, state: carries ? 'into-encoder' : 'upstream' });
      }
    }
    return reached;
  };

  // Evidence for a text literal, from the node that holds it: an encoder
  // (it outputs conditioning) used it as written, so it is exact; a pure
  // value holder whose value reaches an encoder unchanged is graph-derived;
  // anything else may transform it before use, so it is only a candidate.
  const textEvidence = (node, state) => {
    if (producesConditioning(node)) return { confidence: 'exact', composition: state === 'start' ? 'direct' : 'combined' };
    const literals = Object.values(node.inputs).filter((value) => !asRef(value, nodes));
    if (state === 'into-encoder' && !reader.inputRefs(node).length && literals.length === 1) {
      return { confidence: 'derived', composition: 'routed' };
    }
    return { confidence: 'candidate', composition: 'upstream' };
  };

  // Text on a node. On an encoder: prose of four or more words, or any string
  // under a declared STRING socket or a text-named input. On a value holder:
  // its one value. Anywhere else: prose only, since short strings there are
  // settings. Never a file or JSON.
  const promptTexts = (node, evidence) =>
    Object.entries(node.inputs).filter(([field, value]) => {
      if (typeof value !== 'string' || !value.trim()) return false;
      if (MEDIA_EXTENSIONS.has(extensionOf(value)) || isModelFile(value) || isJsonContainer(value)) {
        return false;
      }
      const declared = types.input(node.id, field)?.type;
      if (evidence.confidence === 'derived' || wordCount(value) >= MIN_PROMPT_WORDS) return true;
      return evidence.confidence === 'exact' &&
        (declared === 'STRING' || (!declared && /text|prompt/i.test(field)));
    });

  const encoderRoots = [];
  // A text field reached from both walks (a negative made by zeroing the
  // positive) is the positive prompt; a field named for the negative prompt
  // is negative whichever walk found it.
  const claimed = new Set();
  const collectPrompt = (entry, walkRole) => {
    const reach = promptReach(entry.ref);
    for (const [id, state] of [...reach.entries()].sort((a, b) => naturalNodeCompare(a[0], b[0]))) {
      const node = nodes.get(id);
      const evidence = textEvidence(node, state);
      if (!reader.inputRefs(node).length) {
        modelFiles(node).forEach(([, file]) => encoderRoots.push({ node, file }));
      }
      for (const [field, value] of promptTexts(node, evidence)) {
        const role = /neg/i.test(field) ? 'negative' : walkRole;
        const fieldKey = `${id}:${field}`;
        if (role === 'positive') claimed.add(fieldKey);
        else if (walkRole === 'negative' && claimed.has(fieldKey)) continue;
        const promptKey = `${role}:${fieldKey}`;
        if (promptKeys.has(promptKey)) continue;
        if (promptFragments.length >= limits.maxPromptFragments) return;
        let text = value.trim();
        if (text.length > limits.maxPromptLength) {
          text = text.slice(0, limits.maxPromptLength);
          diagnose(
            'PROMPT_FRAGMENT_TRUNCATED',
            'Prompt text was shortened to the configured display and cache limit',
            node,
            role
          );
        }
        if (promptLength + text.length > limits.maxPromptTotalLength) {
          diagnose(
            'PROMPT_TOTAL_LIMIT',
            'Additional prompt text was omitted because the prompt budget was reached',
            node,
            role
          );
          return;
        }
        promptKeys.add(promptKey);
        promptLength += text.length;
        promptFragments.push({
          role,
          text,
          nodeId: id,
          classType: node.classType,
          field,
          composition: evidence.composition,
          confidence: evidence.confidence,
        });
      }
    }
  };

  // --- Section 5: settings per stage --------------------------------------------
  const readSetting = (stage, names) => {
    const helpers = [];
    for (const { ref } of reader.inputsWhere(stage, (type) => HELPER_TYPES.has(type))) {
      // A wrapper around the noise or sigmas passes its own NOISE/SIGMAS on;
      // follow those a few levels.
      let current = nodes.get(ref.nodeId);
      for (let depth = 0; current && depth < 4; depth += 1) {
        helpers.push(current);
        const inner = reader.inputsWhere(current, (type) => HELPER_TYPES.has(type))[0];
        current = inner ? nodes.get(inner.ref.nodeId) : null;
      }
    }
    for (const node of [stage, ...helpers]) {
      for (const name of names) {
        if (node.inputs[name] === undefined) continue;
        const resolved = reader.resolve(node.inputs[name]);
        if (resolved && 'value' in resolved) return resolved.value;
      }
    }
    return null;
  };

  const guiderOf = (stage) => {
    const entry = reader.inputsWhere(stage, (type) => type === 'GUIDER')[0];
    return entry ? reader.resolve(stage.inputs[entry.name])?.node || null : null;
  };

  const text = (value) =>
    value === null || value === undefined ? null : clampString(value, limits.maxScalarLength);
  const numeric = (value) => {
    if (value === null || value === undefined) return null;
    return numberOrNull(value) ?? text(value);
  };

  const samplerStages = stageEntries.map(({ node, distance }) => {
    const read = (key) => readSetting(node, SETTING_NAMES[key]);
    const guider = guiderOf(node);
    const cfg = read('cfg') ?? (guider?.inputs.cfg !== undefined ? reader.resolve(guider.inputs.cfg)?.value ?? null : null);
    return {
      nodeId: node.id,
      classType: node.classType,
      role: 'contributor',
      seed: text(read('seed')),
      steps: numeric(read('steps')),
      cfg: numeric(cfg),
      sampler: text(read('sampler')),
      scheduler: text(read('scheduler')),
      denoise: numeric(read('denoise')),
      startStep: numeric(read('startStep')),
      endStep: numeric(read('endStep')),
      distanceToOutput: distance,
    };
  });
  const nearest = samplerStages.length
    ? Math.min(...samplerStages.map((stage) => stage.distanceToOutput))
    : null;
  const nearestStages = samplerStages.filter((stage) => stage.distanceToOutput === nearest);
  if (nearestStages.length === 1) nearestStages[0].role = 'final';
  if (!samplerStages.length) {
    diagnose(
      'SAMPLER_NOT_FOUND',
      'No node outputs a LATENT from a model and conditioning, a guider, or noise and sigmas',
      selected.node
    );
  }

  // Assets and prompts are read final stage first, so the final stage's
  // model and prompt lead their lists.
  const orderedStages = [...stageEntries].sort(
    (a, b) => a.distance - b.distance || naturalNodeCompare(a.node.id, b.node.id)
  );
  const negatives = [];
  for (const { node } of orderedStages) {
    const owner = guiderOf(node) || node;
    const model = reader.inputsWhere(owner, isModelType)[0];
    if (model) traceModel(model.ref);
    for (const entry of reader.inputsWhere(owner, isConditioningType)) {
      if (/neg/i.test(entry.name)) negatives.push(entry);
      else collectPrompt(entry, 'positive');
    }
  }
  negatives.forEach((entry) => collectPrompt(entry, 'negative'));

  // VAE and text encoder: roots of the VAE and CLIP chains reachable from the
  // output, and model files at the roots of the prompt path (a T5 loader).
  for (const id of [...reachable.keys()].sort(naturalNodeCompare)) {
    const node = nodes.get(id);
    for (const { name, ref } of reader.inputRefs(node)) {
      const type = reader.linkType(node, name, ref);
      if (type === 'VAE') {
        traceChain(ref, (candidate) => candidate === 'VAE', (root) =>
          rootFiles(root).forEach(([, file]) =>
            addAsset(vaes, modelRoots.has(root.id) ? 'bundled-checkpoint' : 'vae', file, root)
          ));
      } else if (type === 'CLIP') {
        traceChain(
          ref,
          (candidate) => candidate === 'CLIP',
          (root) =>
            rootFiles(root).forEach(([, file]) =>
              addAsset(textEncoders, modelRoots.has(root.id) ? 'bundled-checkpoint' : 'text-encoder', file, root)
            ),
          (patch) => collectOwnLoras(patch, 'clip')
        );
      }
    }
  }
  encoderRoots.forEach(({ node, file }) => addAsset(textEncoders, 'text-encoder', file, node));

  // Sources: media-producing roots on the path (no media input of their own)
  // whose string input names a media file.
  const sourceInputs = [];
  for (const id of [...reachable.keys()].sort(naturalNodeCompare)) {
    const node = nodes.get(id);
    if (reader.consumes(node, (type) => MEDIA_TYPES.has(type))) continue;
    for (const value of Object.values(node.inputs)) {
      const kind = typeof value === 'string' ? MEDIA_EXTENSIONS.get(extensionOf(value)) : null;
      if (kind && sourceInputs.length < limits.maxAssetsPerKind) {
        sourceInputs.push({ name: clampString(value, limits.maxScalarLength), kind, nodeId: id, classType: node.classType });
      }
    }
  }

  // Positive fragments first, each role in the order it was found.
  promptFragments.sort((a, b) => Number(a.role !== 'positive') - Number(b.role !== 'positive'));
  const positive = promptFragments.filter((fragment) => fragment.role === 'positive');
  const negative = promptFragments.filter((fragment) => fragment.role === 'negative');
  const single = (fragments) =>
    fragments.length === 1 && fragments[0].confidence !== 'candidate' ? fragments[0].text : null;
  if (positive.length > 1 || negative.length > 1) {
    diagnose('PROMPT_COMPOSED', 'The prompt is composed from several text fields; they are shown as fragments');
  }
  if (promptFragments.some((fragment) => fragment.confidence === 'candidate')) {
    diagnose('PROMPT_CANDIDATE', 'Prompt text passes through a node that may change it before it is used');
  }

  const finalStage = samplerStages.find((stage) => stage.role === 'final') || samplerStages.at(-1) || null;
  const modelNames = [...new Set(models.map((asset) => asset.name))];
  const sourceImages = [...new Set(sourceInputs.filter((source) => source.kind === 'image').map((source) => source.name))];
  const partial = diagnostics.length > 0 || nearestStages.length > 1;
  const positivePrompt = single(positive);

  return {
    ...empty,
    origin: { ...origin, resolution: partial ? 'partial' : 'traced' },
    output: { nodeId: selected.node.id, classType: selected.node.classType, match: selected.match },
    positivePrompt,
    negativePrompt: single(negative),
    promptFragments,
    samplerStages,
    assets: { models, vaes, textEncoders, loras },
    sourceInputs,
    diagnostics,
    prompt: positivePrompt,
    seed: finalStage?.seed || null,
    model: modelNames[0] || null,
    models: modelNames,
    sampler: finalStage?.sampler || null,
    // Sampler names only: schedulers are shown as their own fact, and a
    // scheduler in this list would be displayed as the sampler.
    samplers: [...new Set(samplerStages.map((stage) => stage.sampler).filter(Boolean))],
    sourceImage: sourceImages[0] || null,
    sourceImages,
  };
}

module.exports = {
  DEFAULT_COMFY_GENERATION_LIMITS,
  ComfyGenerationParserError,
  INPUT_NAME_TYPES,
  findComfyApiGraph,
  isComfyApiGraph,
  isSamplerStage,
  parseBoundedJson,
  parseComfyGenerationPayload,
  quoteUnsafeJsonIntegers,
};
