const {
  DEFAULT_COMFY_GENERATION_LIMITS,
  findComfyApiGraph,
  parseBoundedJson,
} = require('./comfy-generation-parser');

// Reads a ComfyUI render by socket type instead of by node class. Roles are
// defined by what a node consumes and produces - MODEL, CONDITIONING, LATENT,
// GUIDER - which every custom node shares, so no allow-list of classes is
// needed. See docs/architecture/generation-type-flow.md.
//
// Same interface and result shape as parseComfyGenerationPayload, so the
// generation-metadata service could use either. It is not wired in: the
// switch-over is a measured step (Section 8 of the design).

const MODEL_EXTENSIONS = ['.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.bin', '.sft'];
const MEDIA_EXTENSIONS = new Map([
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.webp', 'image'],
  ['.mp4', 'video'], ['.mov', 'video'], ['.webm', 'video'], ['.mkv', 'video'],
  ['.wav', 'audio'], ['.mp3', 'audio'], ['.flac', 'audio'],
]);

// ComfyUI's conventional input names, used only when the UI workflow does not
// declare a socket's type (Section 1, rule 3).
const INPUT_NAME_TYPES = new Map([
  ['model', 'MODEL'],
  ['clip', 'CLIP'],
  ['vae', 'VAE'],
  ['positive', 'CONDITIONING'],
  ['negative', 'CONDITIONING'],
  ['conditioning', 'CONDITIONING'],
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

const OUTPUT_FILENAME_INPUTS = ['filename_prefix', 'filename', 'output_path', 'path'];
// Prompt text is looked for upstream of a conditioning input along every link
// except those that carry models, media, sampling machinery or plain numbers.
// Custom types (a composer's reference set, a conditioning bundle) and
// untyped links pass, because text reaches samplers through them.
const NON_PROMPT_TYPES = new Set([
  'MODEL', 'CLIP', 'VAE', 'LATENT', 'IMAGE', 'VIDEO', 'AUDIO', 'MASK',
  'NOISE', 'SIGMAS', 'SAMPLER', 'GUIDER', 'INT', 'FLOAT', 'BOOLEAN',
  'CLIP_VISION', 'CLIP_VISION_OUTPUT', 'CONTROL_NET', 'UPSCALE_MODEL',
]);
const MIN_PROMPT_WORDS = 4;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isScalar(value) {
  return (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'string' ||
    typeof value === 'boolean';
}

function extensionOf(value) {
  const match = /\.[a-z0-9]+$/i.exec(String(value).trim());
  return match ? match[0].toLowerCase() : '';
}

function isModelFile(value) {
  return typeof value === 'string' && MODEL_EXTENSIONS.includes(extensionOf(value));
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

function wordCount(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

function clamp(value, limit) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, limit) : null;
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

// --- payload -------------------------------------------------------------

function parseMaybeJson(value, limits) {
  if (typeof value === 'string') {
    try {
      return parseBoundedJson(value, limits);
    } catch {
      return null;
    }
  }
  return isPlainObject(value) ? value : null;
}

function isUiWorkflow(value) {
  return isPlainObject(value) && Array.isArray(value.nodes);
}

// The UI workflow travels beside the API prompt: as a sibling of `prompt` in
// the probe payload or a VHS envelope, or inside a sidecar's JSON.
function findUiWorkflow(payload, limits) {
  const queue = [{ value: payload, depth: 0 }];
  while (queue.length) {
    const { value, depth } = queue.shift();
    const parsed = typeof value === 'string' ? parseMaybeJson(value, limits) : value;
    if (!isPlainObject(parsed)) continue;
    if (isUiWorkflow(parsed)) return parsed;
    if (depth >= limits.maxUnwrapDepth) continue;
    for (const key of ['workflow', 'extra_pnginfo', 'comment', 'description']) {
      if (parsed[key] !== undefined) queue.push({ value: parsed[key], depth: depth + 1 });
    }
  }
  return null;
}

// --- Section 1: socket types -------------------------------------------------

function createTypeMap(workflow, nodes) {
  const inputTypes = new Map();
  const outputTypes = new Map();
  const outputNames = new Map();
  const declaredNodes = new Set();
  const set = (map, key, type, evidence) => {
    if (typeof type !== 'string' || !type || map.has(key)) return;
    map.set(key, { type: type.toUpperCase() === '*' ? '*' : type, evidence });
  };

  const subgraphs = new Map();
  for (const subgraph of workflow?.definitions?.subgraphs || []) {
    if (isPlainObject(subgraph) && typeof subgraph.id === 'string') {
      subgraphs.set(subgraph.id, subgraph);
    }
  }

  // Subgraph inner nodes appear in the API graph as `outer:inner`; nested
  // subgraphs extend the id. The API graph is already flattened, so only the
  // inner nodes' own sockets need typing.
  const addNodes = (list, prefix, evidence, depth) => {
    if (!Array.isArray(list) || depth > 8) return;
    for (const node of list) {
      if (!isPlainObject(node) || node.id === undefined) continue;
      const apiId = `${prefix}${node.id}`;
      declaredNodes.add(apiId);
      for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
        if (isPlainObject(input)) {
          set(inputTypes, `${apiId}\u0000${input.name}`, input.type, evidence);
        }
      }
      (Array.isArray(node.outputs) ? node.outputs : []).forEach((output, slot) => {
        if (isPlainObject(output)) {
          set(outputTypes, `${apiId}\u0000${slot}`, output.type, evidence);
          if (typeof output.name === 'string' && output.name) {
            outputNames.set(`${apiId}\u0000${slot}`, output.name);
          }
        }
      });
      const inner = subgraphs.get(node.type);
      if (inner) addNodes(inner.nodes, `${apiId}:`, 'subgraph-declared', depth + 1);
    }
  };
  addNodes(workflow?.nodes, '', 'declared', 0);

  // Rule 3: conventional input names, and each producer's output slot typed
  // by the input that consumes it.
  for (const node of nodes.values()) {
    for (const [name, value] of Object.entries(node.inputs)) {
      const key = `${node.id}\u0000${name}`;
      const byName = INPUT_NAME_TYPES.get(name.toLowerCase()) ||
        (ANY_INPUT.test(name) ? '*' : null);
      if (byName) set(inputTypes, key, byName, 'inferred');
      const ref = asRef(value, nodes);
      const consumed = inputTypes.get(key);
      if (ref && consumed) {
        set(outputTypes, `${ref.nodeId}\u0000${ref.slot}`, consumed.type, 'inferred');
      }
    }
  }

  const evidenceRank = { declared: 0, 'subgraph-declared': 0, inferred: 1 };
  return {
    input(nodeId, name) {
      return inputTypes.get(`${nodeId}\u0000${name}`) || null;
    },
    output(nodeId, slot) {
      return outputTypes.get(`${nodeId}\u0000${slot}`) || null;
    },
    // The type a link carries: its producer's output, else the consumer's
    // input. A concrete type beats "*" (a switch's output is "*", the save
    // consuming it says VIDEO), and declared evidence beats inferred.
    link(consumerId, name, ref) {
      const produced = outputTypes.get(`${ref.nodeId}\u0000${ref.slot}`);
      const consumed = inputTypes.get(`${consumerId}\u0000${name}`);
      if (produced && consumed) {
        if (produced.type === '*' && consumed.type !== '*') return consumed;
        if (consumed.type === '*' && produced.type !== '*') return produced;
        if (evidenceRank[consumed.evidence] < evidenceRank[produced.evidence]) return consumed;
      }
      return produced || consumed || null;
    },
    outputsOf(nodeId) {
      const types = [];
      for (let slot = 0; slot < 64; slot += 1) {
        const entry = outputTypes.get(`${nodeId}\u0000${slot}`);
        if (entry) types.push(entry.type);
      }
      return types;
    },
    outputName(nodeId, slot) {
      return outputNames.get(`${nodeId}\u0000${slot}`) || null;
    },
    hasWorkflow: Boolean(workflow),
    isDeclared: (nodeId) => declaredNodes.has(nodeId),
  };
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

// --- reader --------------------------------------------------------------

function createReader({ nodes, types, limits }) {
  const inputRefs = (node) =>
    Object.entries(node.inputs)
      .map(([name, value]) => ({ name, ref: asRef(value, nodes) }))
      .filter((entry) => entry.ref);

  const inputTypesOf = (node) =>
    Object.keys(node.inputs).map((name) => types.input(node.id, name)?.type).filter(Boolean);

  // Section 2: a switch or reroute has only link inputs, all of its output's
  // type (or "*"). It carries its first connected input, in name order.
  const passThroughInput = (node) => {
    // A conditional switch (`on_true` / `on_false` and one selector, as in
    // KJNodes' LazySwitch) carries the branch its selector resolves to; an
    // unresolvable selector leaves the value unresolved rather than guessed.
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
    // An output nobody typed (its consumer's input name is not conventional)
    // still passes through when every input is declared or named as "*".
    if (outputs.length > 1 || refs.length === 0) return null;
    const literals = Object.values(node.inputs).filter(
      (value) => value !== null && !asRef(value, nodes)
    );
    if (literals.length) return null;
    const outputType = outputs[0] || null;
    const carried = refs.every(({ name, ref }) => {
      const type = types.link(node.id, name, ref)?.type;
      if (outputType === null) return types.input(node.id, name)?.type === '*';
      return type === outputType || type === '*' || outputType === '*';
    });
    if (!carried) return null;
    return [...refs].sort((a, b) => naturalCompare(a.name, b.name))[0];
  };

  // Follow a link through pass-through nodes and one-literal primitives to a
  // real producer or a literal. `hops` > 0 means graph-derived evidence.
  const resolve = (value, visited = new Set(), hops = 0) => {
    const ref = asRef(value, nodes);
    if (!ref) {
      return isScalar(value) ? { value, hops } : null;
    }
    if (visited.has(ref.nodeId) || visited.size > limits.maxTraversalDepth) return null;
    visited.add(ref.nodeId);
    const node = nodes.get(ref.nodeId);
    const through = passThroughInput(node);
    if (through) return resolve(node.inputs[through.name], visited, hops + 1);
    const refs = inputRefs(node);
    const scalars = Object.values(node.inputs).filter(
      (entry) =>
        typeof entry === 'number' ||
        typeof entry === 'boolean' ||
        (typeof entry === 'string' && entry !== '')
    );
    if (refs.length === 0 && scalars.length === 1) {
      return { value: scalars[0], hops: hops + 1, nodeId: node.id };
    }
    return { ref, node, hops };
  };

  const producerOf = (value) => {
    const resolved = resolve(value);
    return resolved?.node || null;
  };

  // Upstream nodes from `start`, optionally skipping links whose type is in
  // `excluded`. Returns node ids by distance.
  const upstream = (startId, excluded = null) => {
    const distance = new Map([[startId, 0]]);
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift();
      if (distance.size > limits.maxTraversalVisits) break;
      const node = nodes.get(id);
      for (const { name, ref } of inputRefs(node)) {
        if (distance.has(ref.nodeId)) continue;
        if (excluded && excluded.has(types.link(node.id, name, ref)?.type)) continue;
        distance.set(ref.nodeId, distance.get(id) + 1);
        queue.push(ref.nodeId);
      }
    }
    return distance;
  };

  const consumes = (node, type) =>
    inputRefs(node).some(({ name, ref }) => types.link(node.id, name, ref)?.type === type);

  const inputOfType = (node, type) =>
    inputRefs(node).find(({ name, ref }) => types.link(node.id, name, ref)?.type === type) || null;

  return { resolve, producerOf, upstream, consumes, inputOfType, inputRefs, passThroughInput, inputTypesOf };
}

// --- Section 3: roles ------------------------------------------------------

function selectOutput(nodes, types, reader, fileName) {
  const stem = String(fileName || '').replace(/\.[^.]+$/, '').toLowerCase();
  const candidates = [];
  for (const node of nodes.values()) {
    const media = reader.consumes(node, 'IMAGE') || reader.consumes(node, 'VIDEO');
    const nameInput = OUTPUT_FILENAME_INPUTS.find((name) => typeof node.inputs[name] === 'string');
    if (!media || !nameInput) continue;
    const base = node.inputs[nameInput].trim().split(/[\\/]/).pop().toLowerCase();
    candidates.push({ node, matches: Boolean(stem && base && stem.startsWith(base)) });
  }
  const matched = candidates.filter((entry) => entry.matches);
  if (matched.length === 1) return { node: matched[0].node, match: 'filename' };
  if (matched.length > 1) return { node: null, ambiguous: true };
  if (candidates.length === 1) return { node: candidates[0].node, match: 'only-output' };
  return { node: null, ambiguous: candidates.length > 1 };
}

function isSamplerStage(node, reader, types) {
  if (!types.outputsOf(node.id).includes('LATENT')) return false;
  if (!reader.consumes(node, 'LATENT')) return false;
  return (
    (reader.consumes(node, 'MODEL') && reader.consumes(node, 'CONDITIONING')) ||
    reader.consumes(node, 'GUIDER') ||
    (reader.consumes(node, 'NOISE') && reader.consumes(node, 'SIGMAS'))
  );
}

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

function parseComfyTypeFlow(payload, options = {}) {
  const limits = { ...DEFAULT_COMFY_GENERATION_LIMITS, ...(options.limits || {}) };
  const located = findComfyApiGraph(payload, limits);
  if (!located) return null;

  const nodes = new Map();
  for (const [id, node] of Object.entries(located.graph)) {
    if (nodes.size >= limits.maxGraphNodes) break;
    if (isPlainObject(node) && typeof node.class_type === 'string' && isPlainObject(node.inputs)) {
      nodes.set(String(id), { id: String(id), classType: node.class_type, inputs: node.inputs });
    }
  }
  const workflow = findUiWorkflow(payload, limits);
  const types = createTypeMap(workflow, nodes);
  const reader = createReader({ nodes, types, limits });
  const diagnostics = [];
  const diagnosticKeys = new Set();
  const diagnose = (code, message, node = null, role = null) => {
    const key = `${code}:${node?.id || ''}:${role || ''}`;
    if (diagnosticKeys.has(key) || diagnostics.length >= limits.maxDiagnostics) return;
    diagnosticKeys.add(key);
    diagnostics.push({ code, message, nodeId: node?.id || null, classType: node?.classType || null, role });
  };
  // Without the UI workflow every socket type is inferred from input names,
  // so every result is one evidence level weaker (Section 4).
  const inferred = !workflow;
  if (inferred) {
    diagnose('TYPES_INFERRED', 'No UI workflow was embedded; socket types were inferred from input names');
  }

  const origin = {
    kind: clamp(options.origin?.kind, limits.maxScalarLength) || 'unknown',
    carrier: clamp(options.origin?.carrier, limits.maxScalarLength) || 'json',
    metadataKey: clamp(options.origin?.metadataKey, limits.maxScalarLength) || located.metadataKey,
    graphFormat: workflow ? 'api+ui' : 'api',
    resolution: 'partial',
    reader: 'type-flow',
  };

  const selected = selectOutput(nodes, types, reader, options.fileName);
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
  const stageNodes = [...reachable.entries()]
    .map(([id, distance]) => ({ node: nodes.get(id), distance }))
    .filter(({ node }) => isSamplerStage(node, reader, types))
    .sort((a, b) => b.distance - a.distance || naturalCompare(a.node.id, b.node.id))
    .slice(0, limits.maxSamplerStages);

  // The stage's own conditioning and model, or its guider's.
  const guiderOf = (node) => reader.producerOf(node.inputs[reader.inputOfType(node, 'GUIDER')?.name]);
  const inputsFor = (node) => {
    const guider = reader.consumes(node, 'GUIDER') ? guiderOf(node) : null;
    const owner = guider && isPlainObject(guider.inputs) ? guider : node;
    const pick = (predicate) =>
      reader.inputRefs(owner).filter(({ name, ref }) => predicate(name, types.link(owner.id, name, ref)?.type));
    return {
      owner,
      guider,
      model: pick((_, type) => type === 'MODEL')[0] || null,
      positive: pick((name, type) => type === 'CONDITIONING' && !/neg/i.test(name)),
      negative: pick((name, type) => type === 'CONDITIONING' && /neg/i.test(name)),
    };
  };

  // Section 5: settings from the stage and the nodes feeding its helper inputs.
  const readSetting = (stage, names) => {
    const helpers = reader
      .inputRefs(stage)
      .filter(({ name, ref }) => ['NOISE', 'SIGMAS', 'SAMPLER', 'GUIDER'].includes(
        types.link(stage.id, name, ref)?.type
      ))
      .map(({ ref }) => nodes.get(ref.nodeId));
    const helperChain = [];
    for (const helper of helpers) {
      // A wrapper around the noise or sigmas (an equirect wrap) passes its own
      // NOISE/SIGMAS input on; follow those, one level at a time.
      let current = helper;
      for (let depth = 0; current && depth < 4; depth += 1) {
        helperChain.push(current);
        const inner = reader
          .inputRefs(current)
          .find(({ name, ref }) => ['NOISE', 'SIGMAS', 'SAMPLER'].includes(
            types.link(current.id, name, ref)?.type
          ));
        current = inner ? nodes.get(inner.ref.nodeId) : null;
      }
    }
    for (const node of [stage, ...helperChain]) {
      for (const name of names) {
        if (node.inputs[name] === undefined) continue;
        const resolved = reader.resolve(node.inputs[name]);
        if (resolved && 'value' in resolved) {
          return { value: resolved.value, derived: resolved.hops > 0 || node !== stage };
        }
      }
    }
    return null;
  };

  const models = [];
  const loras = [];
  const vaes = [];
  const textEncoders = [];
  const promptFragments = [];
  const seenFragments = new Set();
  const seenAssets = new Set();

  const addAsset = (bucket, kind, name, node) => {
    const clean = clamp(name, limits.maxScalarLength);
    const key = `${kind}:${node.id}:${clean}`;
    if (!clean || seenAssets.has(key) || bucket.length >= limits.maxAssetsPerKind) return;
    seenAssets.add(key);
    bucket.push({ name: clean, kind, nodeId: node.id });
  };

  // Section 3: roots of MODEL / VAE / CLIP chains, and LoRA patches on them.
  const traceChain = (startRef, type, onRoot, onPatch) => {
    const visited = new Set();
    let ref = startRef;
    for (let depth = 0; ref && depth < limits.maxTraversalDepth; depth += 1) {
      if (visited.has(ref.nodeId)) return;
      visited.add(ref.nodeId);
      const node = nodes.get(ref.nodeId);
      const through = reader.passThroughInput(node);
      if (through) {
        if (!through.ref) return;
        ref = through.ref;
        continue;
      }
      const next = reader.inputOfType(node, type);
      if (!next) {
        onRoot(node);
        return;
      }
      onPatch?.(node);
      ref = next.ref;
    }
  };

  const seenLoraNodes = new Set();
  const collectLoras = (node) => {
    if (seenLoraNodes.has(node.id)) return;
    seenLoraNodes.add(node.id);
    for (const [name, value] of Object.entries(node.inputs)) {
      if (isPlainObject(value) && typeof value.lora === 'string' && value.lora) {
        const strength = Number(value.strength ?? value.strengthModel);
        if (value.on === false || strength === 0) continue;
        if (loras.length < limits.maxAssetsPerKind) {
          loras.push({
            name: clamp(value.lora, limits.maxScalarLength),
            nodeId: node.id,
            strengthModel: Number.isFinite(strength) ? strength : null,
            strengthClip: null,
            appliedTo: ['model'],
          });
        }
      } else if (/lora/i.test(name) && isModelFile(value)) {
        const strengthKey = Object.keys(node.inputs).find((key) => /strength(_model)?$/i.test(key));
        const strength = strengthKey !== undefined ? Number(node.inputs[strengthKey]) : null;
        if (strength === 0) continue;
        if (loras.length < limits.maxAssetsPerKind) {
          loras.push({
            name: clamp(value, limits.maxScalarLength),
            nodeId: node.id,
            strengthModel: Number.isFinite(strength) ? strength : null,
            strengthClip: Number.isFinite(Number(node.inputs.strength_clip))
              ? Number(node.inputs.strength_clip)
              : null,
            appliedTo: ['model'],
          });
        }
      }
    }
  };

  const modelFilesOf = (node) =>
    Object.values(node.inputs).filter((value) => isModelFile(value));

  // Section 3: prompt text upstream of a conditioning input.
  // Nodes whose text can reach a conditioning input. A node that passes a
  // positive/negative pair through (its output slot named like one of its
  // inputs) is followed only along the matching input, so a positive walk
  // never enters the negative branch.
  const promptReach = (startRef) => {
    const reached = new Set();
    const queue = [startRef];
    while (queue.length && reached.size < limits.maxTraversalVisits) {
      const { nodeId, slot } = queue.shift();
      const node = nodes.get(nodeId);
      const slotName = slot === null ? null : types.outputName(nodeId, slot);
      const firstVisit = !reached.has(nodeId);
      reached.add(nodeId);
      let refs = reader
        .inputRefs(node)
        .filter(({ name, ref }) => !NON_PROMPT_TYPES.has(types.link(node.id, name, ref)?.type));
      if (slotName && refs.some(({ name }) => name === slotName)) {
        refs = refs.filter(({ name }) => name === slotName);
      } else if (!firstVisit) {
        continue;
      }
      for (const { ref } of refs) queue.push({ nodeId: ref.nodeId, slot: ref.slot });
    }
    return reached;
  };

  // A text field reached from both positive and negative (a negative made by
  // zeroing the positive, say) is the positive prompt; `claimed` records
  // which fields the positive walks already own.
  const claimed = new Set();
  const collectPrompt = (entry, role) => {
    const reach = promptReach(entry.ref);
    for (const id of [...reach].sort(naturalCompare)) {
      const source = nodes.get(id);
      for (const [field, value] of Object.entries(source.inputs)) {
        if (typeof value !== 'string' || wordCount(value) < MIN_PROMPT_WORDS) continue;
        if (MEDIA_EXTENSIONS.has(extensionOf(value)) || isModelFile(value)) continue;
        if (isJsonContainer(value)) continue;
        const fieldKey = `${id}:${field}`;
        if (role === 'positive') claimed.add(fieldKey);
        else if (claimed.has(fieldKey)) continue;
        const text = clamp(value, limits.maxPromptLength);
        const key = `${role}:${id}:${field}`;
        if (seenFragments.has(key) || promptFragments.length >= limits.maxPromptFragments) continue;
        seenFragments.add(key);
        promptFragments.push({
          role,
          text,
          nodeId: id,
          classType: source.classType,
          field,
          composition: 'type-flow',
          confidence: inferred ? 'candidate' : 'exact',
        });
      }
    }
  };

  const negativeInputs = [];
  const samplerStages = stageNodes.map(({ node, distance }) => {
    const settings = {};
    for (const [key, names] of Object.entries(SETTING_NAMES)) {
      settings[key] = readSetting(node, names);
    }
    const scalarText = (entry) =>
      entry && entry.value !== null && entry.value !== undefined
        ? clamp(entry.value, limits.maxScalarLength)
        : null;
    const numberOrText = (entry) => {
      if (!entry) return null;
      return typeof entry.value === 'number' ? entry.value : scalarText(entry);
    };
    const parts = inputsFor(node);
    if (parts.model) {
      traceChain(
        parts.model.ref,
        'MODEL',
        (root) => modelFilesOf(root).forEach((name) => addAsset(models, 'model', name, root)),
        collectLoras
      );
    }
    parts.positive.forEach((entry) => collectPrompt(entry, 'positive'));
    negativeInputs.push(...parts.negative);
    return {
      nodeId: node.id,
      classType: node.classType,
      role: 'contributor',
      seed: scalarText(settings.seed),
      steps: numberOrText(settings.steps),
      cfg: numberOrText(settings.cfg),
      sampler: scalarText(settings.sampler),
      scheduler: scalarText(settings.scheduler),
      denoise: numberOrText(settings.denoise),
      startStep: numberOrText(settings.startStep),
      endStep: numberOrText(settings.endStep),
      distanceToOutput: distance,
    };
  });

  negativeInputs.forEach((entry) => collectPrompt(entry, 'negative'));

  const nearest = samplerStages.length
    ? Math.min(...samplerStages.map((stage) => stage.distanceToOutput))
    : null;
  const nearestStages = samplerStages.filter((stage) => stage.distanceToOutput === nearest);
  if (nearestStages.length === 1) nearestStages[0].role = 'final';
  if (!samplerStages.length) {
    diagnose(
      'SAMPLER_NOT_FOUND',
      'No node outputs a LATENT from a LATENT with a model and conditioning, a guider, or noise and sigmas',
      selected.node
    );
  }

  // VAE and text encoder: roots of the VAE and CLIP chains reachable from the
  // output. This replaces a list of decode classes.
  for (const id of [...reachable.keys()].sort(naturalCompare)) {
    const node = nodes.get(id);
    for (const { name, ref } of reader.inputRefs(node)) {
      const type = types.link(node.id, name, ref)?.type;
      if (type === 'VAE') {
        traceChain(ref, 'VAE', (root) => modelFilesOf(root).forEach((file) => addAsset(vaes, 'vae', file, root)));
      } else if (type === 'CLIP') {
        traceChain(ref, 'CLIP', (root) =>
          modelFilesOf(root).forEach((file) => addAsset(textEncoders, 'text-encoder', file, root))
        );
      }
    }
  }

  const sourceInputs = [];
  for (const id of [...reachable.keys()].sort(naturalCompare)) {
    const node = nodes.get(id);
    if (reader.inputRefs(node).some(({ name, ref }) =>
      ['IMAGE', 'VIDEO', 'AUDIO'].includes(types.link(node.id, name, ref)?.type)
    )) {
      continue;
    }
    for (const value of Object.values(node.inputs)) {
      const kind = typeof value === 'string' ? MEDIA_EXTENSIONS.get(extensionOf(value)) : null;
      if (kind && sourceInputs.length < limits.maxAssetsPerKind) {
        sourceInputs.push({ name: clamp(value, limits.maxScalarLength), kind, nodeId: id, classType: node.classType });
      }
    }
  }

  const positive = promptFragments.filter((fragment) => fragment.role === 'positive');
  const negative = promptFragments.filter((fragment) => fragment.role === 'negative');
  if (positive.length > 1) {
    diagnose('PROMPT_COMPOSED', 'The prompt is composed from several text fields; they are shown as fragments');
  }
  const finalStage = samplerStages.find((stage) => stage.role === 'final') || samplerStages.at(-1) || null;
  const modelNames = [...new Set(models.map((asset) => asset.name))];
  const sourceImages = [...new Set(sourceInputs.filter((source) => source.kind === 'image').map((source) => source.name))];
  const partial = inferred || diagnostics.length > 0 || nearestStages.length > 1 || positive.length > 1;

  return {
    ...empty,
    origin: { ...origin, resolution: partial ? 'partial' : 'traced' },
    output: { nodeId: selected.node.id, classType: selected.node.classType, match: selected.match },
    positivePrompt: positive.length === 1 ? positive[0].text : null,
    negativePrompt: negative.length === 1 ? negative[0].text : null,
    promptFragments,
    samplerStages,
    assets: { models, vaes, textEncoders, loras },
    sourceInputs,
    diagnostics,
    prompt: positive.length === 1 ? positive[0].text : null,
    seed: finalStage?.seed || null,
    model: modelNames[0] || null,
    models: modelNames,
    sampler: finalStage?.sampler || null,
    samplers: [...new Set(samplerStages.flatMap((stage) => [stage.sampler, stage.scheduler]).filter(Boolean))],
    sourceImage: sourceImages[0] || null,
    sourceImages,
  };
}

module.exports = {
  INPUT_NAME_TYPES,
  isSamplerStage,
  parseComfyTypeFlow,
};
