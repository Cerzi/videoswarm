const path = require('path');

const DEFAULT_COMFY_GENERATION_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxJsonDepth: 32,
  maxJsonNodes: 10000,
  maxUnwrapDepth: 3,
  maxGraphNodes: 4096,
  maxGraphEdges: 16384,
  maxTraversalDepth: 128,
  maxTraversalVisits: 32768,
  maxOutputs: 32,
  maxSamplerStages: 32,
  maxPromptFragments: 64,
  maxAssetsPerKind: 64,
  maxDiagnostics: 64,
  maxScalarLength: 1024,
  maxPromptLength: 16384,
  maxPromptTotalLength: 64 * 1024,
});

const OUTPUT_ADAPTERS = new Map([
  ['VHS_VideoCombine', {
    exactNames: ['filename', 'file_name', 'output_filename'],
    prefixes: ['filename_prefix'],
  }],
  ['SaveVideo', {
    exactNames: ['filename', 'file_name', 'output_filename'],
    prefixes: ['filename_prefix'],
  }],
  ['VideoCombine', {
    exactNames: ['filename', 'file_name', 'output_filename'],
    prefixes: ['filename_prefix'],
  }],
  ['SaveWEBM', {
    exactNames: ['filename', 'file_name', 'output_filename'],
    prefixes: ['filename_prefix'],
  }],
  ['SaveAnimatedWEBP', {
    exactNames: ['filename', 'file_name', 'output_filename'],
    prefixes: ['filename_prefix'],
  }],
]);

const SAMPLER_TYPES = new Set([
  'KSampler',
  'KSamplerAdvanced',
  'SamplerCustom',
  'SamplerCustomAdvanced',
  'WanVideoSampler',
]);

const UNARY_CONDITIONING_INPUT = new Map([
  ['FluxGuidance', 'conditioning'],
  ['ConditioningSetArea', 'conditioning'],
  ['ConditioningSetAreaPercentage', 'conditioning'],
  ['ConditioningSetAreaStrength', 'conditioning'],
  ['ConditioningSetMask', 'conditioning'],
  ['ConditioningZeroOut', 'conditioning'],
  ['ConditioningSetTimestepRange', 'conditioning'],
]);

const MODEL_PASSTHROUGH_INPUT = new Map([
  ['ModelSamplingDiscrete', 'model'],
  ['ModelSamplingContinuousEDM', 'model'],
  ['ModelSamplingSD3', 'model'],
  ['ModelSamplingAuraFlow', 'model'],
  ['ModelSamplingFlux', 'model'],
  ['WanVideoSetBlockSwap', 'model'],
]);

const DECODE_TYPES = new Set(['VAEDecode', 'VAEDecodeTiled', 'WanVideoDecode']);

const PROMPT_STRING_INPUT = new Map([
  ['PrimitiveStringMultiline', 'value'],
]);

const SCALAR_NODE_INPUT = new Map([
  ['INTConstant', 'value'],
  ['Int', 'value'],
  ['Float', 'value'],
  ['Seed (rgthree)', 'seed'],
]);

class ComfyGenerationParserError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComfyGenerationParserError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clampString(value, maxLength) {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result ? result.slice(0, maxLength) : null;
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

function quoteUnsafeJsonIntegers(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    if (current === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      output += source.slice(start, index);
      continue;
    }

    if (current === '-' || (current >= '0' && current <= '9')) {
      const start = index;
      if (source[index] === '-') index += 1;
      if (source[index] === '0') {
        index += 1;
      } else {
        while (source[index] >= '0' && source[index] <= '9') index += 1;
      }
      let isInteger = true;
      if (source[index] === '.') {
        isInteger = false;
        index += 1;
        while (source[index] >= '0' && source[index] <= '9') index += 1;
      }
      if (source[index] === 'e' || source[index] === 'E') {
        isInteger = false;
        index += 1;
        if (source[index] === '+' || source[index] === '-') index += 1;
        while (source[index] >= '0' && source[index] <= '9') index += 1;
      }
      const token = source.slice(start, index);
      if (isInteger) {
        try {
          const numeric = BigInt(token);
          if (
            numeric > BigInt(Number.MAX_SAFE_INTEGER) ||
            numeric < BigInt(Number.MIN_SAFE_INTEGER)
          ) {
            output += JSON.stringify(token);
            continue;
          }
        } catch {
          // JSON.parse below provides the authoritative syntax error.
        }
      }
      output += token;
      continue;
    }

    output += current;
    index += 1;
  }
  return output;
}

function inspectBoundedShape(root, limits) {
  const stack = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  let visited = 0;

  while (stack.length) {
    const current = stack.pop();
    visited += 1;
    if (visited > limits.maxJsonNodes) {
      throw new ComfyGenerationParserError(
        'COMFY_JSON_NODE_LIMIT',
        `Generation metadata exceeds the ${limits.maxJsonNodes}-value limit`
      );
    }
    if (current.depth > limits.maxJsonDepth) {
      throw new ComfyGenerationParserError(
        'COMFY_JSON_DEPTH_LIMIT',
        `Generation metadata exceeds the maximum depth of ${limits.maxJsonDepth}`
      );
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) {
      throw new ComfyGenerationParserError(
        'COMFY_JSON_CYCLE',
        'Generation metadata contains an object cycle'
      );
    }
    seen.add(current.value);

    const depth = current.depth + 1;
    const pushChild = (value) => {
      if (visited + stack.length >= limits.maxJsonNodes) {
        throw new ComfyGenerationParserError(
          'COMFY_JSON_NODE_LIMIT',
          `Generation metadata exceeds the ${limits.maxJsonNodes}-value limit`
        );
      }
      stack.push({ value, depth });
    };
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        pushChild(current.value[index]);
      }
      continue;
    }
    for (const key in current.value) {
      if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
      pushChild(current.value[key]);
    }
  }
}

function parseBoundedJson(text, limits) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source, 'utf8') > limits.maxBytes) {
    throw new ComfyGenerationParserError(
      'COMFY_METADATA_TOO_LARGE',
      `Generation metadata exceeds the ${limits.maxBytes}-byte limit`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(quoteUnsafeJsonIntegers(source));
  } catch (error) {
    throw new ComfyGenerationParserError(
      'COMFY_INVALID_JSON',
      `Generation metadata is not valid JSON: ${error?.message || error}`
    );
  }
  inspectBoundedShape(parsed, limits);
  return parsed;
}

function isComfyApiGraph(value) {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).some((nodeId) => {
    const node = value[nodeId];
    return isPlainObject(node) &&
      typeof node.class_type === 'string' &&
      isPlainObject(node.inputs);
  });
}

function findComfyApiGraph(payload, limits) {
  const queue = [{ value: payload, depth: 0, metadataKey: null }];
  const seen = new WeakSet();
  let topLevelJsonError = null;

  while (queue.length) {
    const current = queue.shift();
    let value = current.value;
    if (typeof value === 'string') {
      if (current.depth >= limits.maxUnwrapDepth) continue;
      try {
        value = parseBoundedJson(value, limits);
      } catch (error) {
        // A non-JSON top-level string is a malformed payload. A plain string
        // nested inside an otherwise valid generic sidecar (for example
        // {"prompt":"a cat"}) is simply not an API graph and must be allowed
        // to fall through to the bounded generic parser.
        if (current.depth === 0) topLevelJsonError = error;
        continue;
      }
      queue.unshift({
        value,
        depth: current.depth + 1,
        metadataKey: current.metadataKey,
      });
      continue;
    }
    if (!isPlainObject(value)) continue;
    inspectBoundedShape(value, limits);
    if (isComfyApiGraph(value)) {
      return { graph: value, metadataKey: current.metadataKey || 'prompt' };
    }
    if (seen.has(value) || current.depth >= limits.maxUnwrapDepth) continue;
    seen.add(value);

    const candidates = [
      ['prompt', value.prompt],
      ['api_prompt', value.api_prompt],
      ['apiWorkflow', value.apiWorkflow],
      ['workflow', value.workflow],
      ['prompt', value.metadata?.prompt],
    ];
    for (const [metadataKey, candidate] of candidates) {
      if (candidate === undefined || candidate === null) continue;
      queue.push({
        value: candidate,
        depth: current.depth + 1,
        metadataKey,
      });
    }
  }

  if (typeof payload === 'string' && topLevelJsonError) throw topLevelJsonError;
  return null;
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
  entries.forEach(([rawNodeId, rawNode]) => {
    if (!isPlainObject(rawNode) || !isPlainObject(rawNode.inputs)) return;
    const classType = clampString(rawNode.class_type, limits.maxScalarLength);
    if (!classType) return;
    const nodeId = String(rawNodeId).slice(0, limits.maxScalarLength);
    nodes.set(nodeId, {
      id: nodeId,
      classType,
      inputs: rawNode.inputs,
    });
  });

  let edgeCount = 0;
  const asRef = (value) => {
    if (!Array.isArray(value) || value.length < 2) return null;
    const nodeId = String(value[0]);
    const slot = Number(value[1]);
    if (!nodes.has(nodeId) || !Number.isSafeInteger(slot) || slot < 0 || slot > 255) {
      return null;
    }
    return { nodeId, slot };
  };

  nodes.forEach((node) => {
    Object.keys(node.inputs).forEach((inputName) => {
      if (!asRef(node.inputs[inputName])) return;
      edgeCount += 1;
      if (edgeCount > limits.maxGraphEdges) {
        throw new ComfyGenerationParserError(
          'COMFY_GRAPH_EDGE_LIMIT',
          `ComfyUI graph exceeds the ${limits.maxGraphEdges}-edge limit`
        );
      }
    });
  });

  return { nodes, asRef };
}

function scalar(value, maxLength) {
  if (value === null || value === undefined || Array.isArray(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  if (typeof value === 'string') return clampString(value, maxLength);
  return value;
}

function scalarString(value, maxLength) {
  const result = scalar(value, maxLength);
  if (result === null) return null;
  const text = String(result).trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeFileName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.win32.basename(path.posix.basename(value.trim()));
}

function outputFileMatch(node, adapter, fileName, limits) {
  if (!fileName) return null;
  const target = normalizeFileName(fileName);
  if (!target) return null;
  const targetStem = target.slice(0, target.length - path.extname(target).length);

  for (const key of adapter.exactNames) {
    const candidate = normalizeFileName(scalarString(node.inputs[key], limits.maxScalarLength));
    if (candidate && candidate.toLowerCase() === target.toLowerCase()) {
      return { score: 3, match: 'exact-filename' };
    }
  }
  for (const key of adapter.prefixes) {
    const rawPrefix = scalarString(node.inputs[key], limits.maxScalarLength);
    const prefix = normalizeFileName(rawPrefix);
    if (!prefix) continue;
    const prefixStem = prefix.slice(0, prefix.length - path.extname(prefix).length);
    const normalizedPrefix = prefixStem.toLowerCase();
    const normalizedTarget = targetStem.toLowerCase();
    if (
      normalizedTarget === normalizedPrefix ||
      normalizedTarget.startsWith(`${normalizedPrefix}_`) ||
      normalizedTarget.startsWith(`${normalizedPrefix}-`)
    ) {
      return { score: 2, match: 'filename-prefix' };
    }
  }
  return null;
}

function selectOutputNode(nodes, fileName, limits) {
  const outputs = Array.from(nodes.values())
    .filter((node) => OUTPUT_ADAPTERS.has(node.classType))
    .sort((left, right) => naturalNodeCompare(left.id, right.id));
  if (outputs.length > limits.maxOutputs) {
    throw new ComfyGenerationParserError(
      'COMFY_OUTPUT_LIMIT',
      `ComfyUI graph exceeds the ${limits.maxOutputs}-output limit`
    );
  }
  if (!outputs.length) return { node: null, match: null, ambiguous: false };

  const matches = outputs
    .map((node) => ({
      node,
      result: outputFileMatch(
        node,
        OUTPUT_ADAPTERS.get(node.classType),
        fileName,
        limits
      ),
    }))
    .filter((candidate) => candidate.result);
  if (matches.length) {
    const bestScore = Math.max(...matches.map((candidate) => candidate.result.score));
    const best = matches.filter((candidate) => candidate.result.score === bestScore);
    if (best.length === 1) {
      return {
        node: best[0].node,
        match: best[0].result.match,
        ambiguous: false,
      };
    }
    return { node: null, match: null, ambiguous: true };
  }
  if (outputs.length === 1) {
    return { node: outputs[0], match: 'only-output', ambiguous: false };
  }
  return { node: null, match: null, ambiguous: true };
}

function collectReachable(outputNode, nodes, asRef, limits) {
  const distance = new Map([[outputNode.id, 0]]);
  const stack = [{ nodeId: outputNode.id, depth: 0 }];
  let visits = 0;

  while (stack.length) {
    const current = stack.pop();
    visits += 1;
    if (visits > limits.maxTraversalVisits) {
      throw new ComfyGenerationParserError(
        'COMFY_TRAVERSAL_LIMIT',
        `ComfyUI traversal exceeds the ${limits.maxTraversalVisits}-visit limit`
      );
    }
    if (current.depth > limits.maxTraversalDepth) {
      throw new ComfyGenerationParserError(
        'COMFY_TRAVERSAL_DEPTH_LIMIT',
        `ComfyUI traversal exceeds the maximum depth of ${limits.maxTraversalDepth}`
      );
    }
    const node = nodes.get(current.nodeId);
    if (!node) continue;
    Object.keys(node.inputs).forEach((inputName) => {
      const ref = asRef(node.inputs[inputName]);
      if (!ref) return;
      const nextDistance = current.depth + 1;
      const previousDistance = distance.get(ref.nodeId);
      if (previousDistance !== undefined && previousDistance <= nextDistance) return;
      distance.set(ref.nodeId, nextDistance);
      stack.push({ nodeId: ref.nodeId, depth: nextDistance });
    });
  }
  return distance;
}

function createCollector({ nodes, asRef, reachable, limits }) {
  const diagnostics = [];
  const diagnosticKeys = new Set();
  const promptFragments = [];
  const promptKeys = new Set();
  let promptLength = 0;
  const models = [];
  const vaes = [];
  const textEncoders = [];
  const loras = [];
  const sourceInputs = [];
  const assetKeys = new Set();
  const loraByKey = new Map();

  const addDiagnostic = ({ code, message, node, role = null }) => {
    const key = `${code}:${node?.id || ''}:${role || ''}`;
    if (diagnosticKeys.has(key) || diagnostics.length >= limits.maxDiagnostics) return;
    diagnosticKeys.add(key);
    diagnostics.push({
      code,
      message,
      nodeId: node?.id || null,
      classType: node?.classType || null,
      role,
    });
  };

  const addAsset = (bucket, kind, name, node, extra = {}) => {
    const cleanName = scalarString(name, limits.maxScalarLength);
    if (!cleanName || bucket.length >= limits.maxAssetsPerKind) return;
    const bucketName = bucket === models
      ? 'models'
      : bucket === vaes
        ? 'vaes'
        : 'text-encoders';
    const key = `${bucketName}:${kind}:${node?.id || ''}:${cleanName}`;
    if (assetKeys.has(key)) return;
    assetKeys.add(key);
    bucket.push({ name: cleanName, kind, nodeId: node?.id || null, ...extra });
  };

  const addLora = ({
    name,
    node,
    strengthModel = null,
    strengthClip = null,
    appliedTo = [],
  }) => {
    const cleanName = scalarString(name, limits.maxScalarLength);
    if (!cleanName) return null;
    const key = `${node?.id || ''}:${cleanName}`;
    let lora = loraByKey.get(key);
    if (!lora) {
      if (loras.length >= limits.maxAssetsPerKind) return null;
      lora = {
        name: cleanName,
        nodeId: node?.id || null,
        strengthModel,
        strengthClip,
        appliedTo: [],
      };
      loraByKey.set(key, lora);
      loras.push(lora);
    }
    appliedTo.forEach((semantic) => {
      if (semantic && !lora.appliedTo.includes(semantic)) lora.appliedTo.push(semantic);
    });
    return lora;
  };

  const addPrompt = ({
    role,
    text,
    node,
    field,
    composition,
    confidence = 'exact',
    truncated = false,
  }) => {
    const cleanText = scalarString(text, limits.maxPromptLength);
    if (!cleanText || promptFragments.length >= limits.maxPromptFragments) return;
    if (truncated || (typeof text === 'string' && text.trim().length > cleanText.length)) {
      addDiagnostic({
        code: 'PROMPT_FRAGMENT_TRUNCATED',
        message: 'Prompt text was shortened to the configured display and cache limit',
        node,
        role,
      });
    }
    if (promptLength + cleanText.length > limits.maxPromptTotalLength) {
      addDiagnostic({
        code: 'PROMPT_TOTAL_LIMIT',
        message: 'Additional prompt text was omitted because the prompt budget was reached',
        node,
        role,
      });
      return;
    }
    const key = `${role}:${node.id}:${field}:${cleanText}`;
    if (promptKeys.has(key)) return;
    promptKeys.add(key);
    promptLength += cleanText.length;
    promptFragments.push({
      role,
      text: cleanText,
      nodeId: node.id,
      classType: node.classType,
      field,
      composition,
      confidence,
    });
  };

  const traceWanLoras = (ref, visited = new Set(), depth = 0) => {
    if (!ref || depth > limits.maxTraversalDepth) return;
    const visitKey = `${ref.nodeId}:${ref.slot}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const node = nodes.get(ref.nodeId);
    if (!node) return;

    if (node.classType === 'WanVideoLoraSelect') {
      traceWanLoras(asRef(node.inputs.prev_lora), visited, depth + 1);
      const strength = scalar(node.inputs.strength, limits.maxScalarLength);
      if (strength === null || Number(strength) !== 0) {
        addLora({
          name: node.inputs.lora,
          node,
          strengthModel: strength,
          appliedTo: ['model'],
        });
      }
      return;
    }

    if (node.classType === 'WanVideoLoraSelectMulti') {
      traceWanLoras(asRef(node.inputs.prev_lora), visited, depth + 1);
      Object.keys(node.inputs)
        .map((key) => /^lora_(\d+)$/u.exec(key))
        .filter(Boolean)
        .sort((left, right) => Number(left[1]) - Number(right[1]))
        .forEach((match) => {
          const index = match[1];
          const strength = scalar(
            node.inputs[`strength_${index}`],
            limits.maxScalarLength
          );
          if (strength !== null && Number(strength) === 0) return;
          addLora({
            name: node.inputs[`lora_${index}`],
            node,
            strengthModel: strength,
            appliedTo: ['model'],
          });
        });
      return;
    }

    addDiagnostic({
      code: 'UNRESOLVED_LORA_NODE',
      message: `Could not resolve WanVideo LoRA source through ${node.classType}`,
      node,
      role: 'model',
    });
  };

  const traceAsset = (ref, semantic, visited = new Set(), depth = 0) => {
    if (!ref || depth > limits.maxTraversalDepth) return;
    const visitKey = `${semantic}:${ref.nodeId}:${ref.slot}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const node = nodes.get(ref.nodeId);
    if (!node) return;

    if (node.classType === 'LoraLoader' || node.classType === 'LoraLoaderModelOnly') {
      const upstreamKey = semantic === 'clip' ? 'clip' : 'model';
      const upstream = asRef(node.inputs[upstreamKey]);
      if (upstream) traceAsset(upstream, semantic, visited, depth + 1);
      addLora({
        name: node.inputs.lora_name,
        node,
        strengthModel: scalar(node.inputs.strength_model, limits.maxScalarLength),
        strengthClip: scalar(node.inputs.strength_clip, limits.maxScalarLength),
        appliedTo: [semantic],
      });
      return;
    }

    if (semantic === 'model' && node.classType === 'WanVideoSetLoRAs') {
      traceWanLoras(asRef(node.inputs.lora));
      traceAsset(asRef(node.inputs.model), semantic, visited, depth + 1);
      return;
    }

    if (semantic === 'model' && node.classType === 'WanVideoModelLoader') {
      addAsset(models, 'diffusion-model', node.inputs.model, node);
      traceWanLoras(asRef(node.inputs.lora));
      return;
    }

    if (node.classType === 'CheckpointLoaderSimple' || node.classType === 'CheckpointLoader') {
      const checkpoint = node.inputs.ckpt_name ?? node.inputs.checkpoint_name;
      if (semantic === 'model') {
        addAsset(models, 'checkpoint', checkpoint, node);
      } else if (semantic === 'vae') {
        addAsset(vaes, 'bundled-checkpoint', checkpoint, node);
      } else if (semantic === 'clip') {
        addAsset(textEncoders, 'bundled-checkpoint', checkpoint, node);
      }
      return;
    }

    if (semantic === 'model' && (
      node.classType === 'UNETLoader' ||
      node.classType === 'LoadDiffusionModel'
    )) {
      addAsset(
        models,
        'diffusion-model',
        node.inputs.unet_name ?? node.inputs.model_name,
        node
      );
      return;
    }
    if (semantic === 'vae' && node.classType === 'VAELoader') {
      addAsset(vaes, 'vae', node.inputs.vae_name, node);
      return;
    }
    if (semantic === 'vae' && node.classType === 'WanVideoVAELoader') {
      addAsset(vaes, 'vae', node.inputs.model_name, node);
      return;
    }
    if (semantic === 'clip' && [
      'CLIPLoader',
      'DualCLIPLoader',
      'TripleCLIPLoader',
      'QuadrupleCLIPLoader',
    ].includes(node.classType)) {
      ['clip_name', 'clip_name1', 'clip_name2', 'clip_name3', 'clip_name4']
        .forEach((key) => addAsset(textEncoders, 'text-encoder', node.inputs[key], node));
      return;
    }
    if (semantic === 'clip' && node.classType === 'LoadWanVideoT5TextEncoder') {
      addAsset(textEncoders, 'text-encoder', node.inputs.model_name, node);
      return;
    }

    const passthroughKey = semantic === 'model'
      ? MODEL_PASSTHROUGH_INPUT.get(node.classType)
      : null;
    if (passthroughKey) {
      traceAsset(asRef(node.inputs[passthroughKey]), semantic, visited, depth + 1);
      return;
    }

    const conventionalInput = asRef(node.inputs[semantic]);
    if (conventionalInput) {
      addDiagnostic({
        code: 'UNKNOWN_ASSET_TRANSFORM',
        message: `Traced through unrecognized ${semantic} node ${node.classType}`,
        node,
        role: semantic,
      });
      traceAsset(conventionalInput, semantic, visited, depth + 1);
      return;
    }

    addDiagnostic({
      code: 'UNRESOLVED_ASSET_NODE',
      message: `Could not resolve ${semantic} source through ${node.classType}`,
      node,
      role: semantic,
    });
  };

  const resolvePromptString = (
    value,
    provenance,
    state = {
      path: new Set(),
      memo: new Map(),
      visits: 0,
    },
    depth = 0
  ) => {
    if (typeof value === 'string') {
      return {
        text: value,
        truncated: value.trim().length > limits.maxPromptLength,
        ...provenance,
      };
    }
    const ref = asRef(value);
    if (!ref || depth > limits.maxTraversalDepth) return null;
    const visitKey = `${ref.nodeId}:${ref.slot}`;
    if (state.path.has(visitKey)) return null;
    if (state.memo.has(visitKey)) return state.memo.get(visitKey);
    state.visits += 1;
    if (state.visits > limits.maxTraversalVisits) return null;
    const node = nodes.get(ref.nodeId);
    if (!node) return null;
    state.path.add(visitKey);

    let result = null;
    try {
      const promptInput = PROMPT_STRING_INPUT.get(node.classType);
      if (promptInput) {
        result = resolvePromptString(
          node.inputs[promptInput],
          {
            node,
            field: promptInput,
            composition: 'string-reference',
            confidence: 'exact',
          },
          state,
          depth + 1
        );
      }
    } finally {
      state.path.delete(visitKey);
    }

    state.memo.set(visitKey, result);
    return result;
  };

  const collectPromptInput = ({ value, role, node, field, composition }) => {
    const resolved = resolvePromptString(value, {
      node,
      field,
      composition,
      confidence: 'exact',
    });
    if (resolved) {
      addPrompt({ role, ...resolved });
      return;
    }
    if (!asRef(value)) return;
    addDiagnostic({
      code: 'UNRESOLVED_DYNAMIC_PROMPT',
      message: `${field} is produced by a runtime node without a registered adapter`,
      node,
      role,
    });
  };

  const resolveConditioning = (
    ref,
    role,
    composition = 'direct',
    visited = new Set(),
    depth = 0
  ) => {
    if (!ref) return;
    if (depth > limits.maxTraversalDepth) {
      addDiagnostic({
        code: 'CONDITIONING_DEPTH_LIMIT',
        message: 'Conditioning traversal exceeded its depth limit',
        node: nodes.get(ref.nodeId),
        role,
      });
      return;
    }
    const visitKey = `${role}:${ref.nodeId}:${ref.slot}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const node = nodes.get(ref.nodeId);
    if (!node) return;

    if (node.classType === 'CLIPTextEncode') {
      collectPromptInput({
        value: node.inputs.text,
        role,
        node,
        field: 'text',
        composition,
      });
      traceAsset(asRef(node.inputs.clip), 'clip');
      return;
    }

    if (node.classType === 'CLIPTextEncodeSDXL') {
      ['text_g', 'text_l'].forEach((field) => {
        collectPromptInput({
          value: node.inputs[field],
          role,
          node,
          field,
          composition,
        });
      });
      traceAsset(asRef(node.inputs.clip), 'clip');
      return;
    }

    if (node.classType === 'WanVideoTextEncode') {
      const field = role === 'negative' ? 'negative_prompt' : 'positive_prompt';
      collectPromptInput({
        value: node.inputs[field],
        role,
        node,
        field,
        composition,
      });
      traceAsset(asRef(node.inputs.t5), 'clip');
      return;
    }

    if (node.classType === 'ConditioningCombine') {
      ['conditioning_1', 'conditioning_2'].forEach((key) => {
        resolveConditioning(
          asRef(node.inputs[key]),
          role,
          'conditioning-combine',
          visited,
          depth + 1
        );
      });
      return;
    }
    if (node.classType === 'ConditioningConcat') {
      ['conditioning_to', 'conditioning_from', 'conditioning_1', 'conditioning_2']
        .forEach((key) => {
          resolveConditioning(
            asRef(node.inputs[key]),
            role,
            'conditioning-concat',
            visited,
            depth + 1
          );
        });
      return;
    }

    const unaryInput = UNARY_CONDITIONING_INPUT.get(node.classType);
    if (unaryInput) {
      resolveConditioning(
        asRef(node.inputs[unaryInput]),
        role,
        composition,
        visited,
        depth + 1
      );
      return;
    }

    if (node.classType === 'ControlNetApplyAdvanced') {
      const inputName = ref.slot === 1 ? 'negative' : 'positive';
      resolveConditioning(
        asRef(node.inputs[inputName]),
        role,
        composition,
        visited,
        depth + 1
      );
      return;
    }
    if (node.classType === 'LTXVConditioning') {
      const inputName = ref.slot === 1 ? 'negative' : 'positive';
      resolveConditioning(
        asRef(node.inputs[inputName]),
        role,
        composition,
        visited,
        depth + 1
      );
      return;
    }

    addDiagnostic({
      code: 'UNRESOLVED_CONDITIONING_NODE',
      message: `Conditioning passes through unsupported node ${node.classType}`,
      node,
      role,
    });
  };

  const collectSources = () => {
    Array.from(reachable.keys())
      .sort(naturalNodeCompare)
      .forEach((nodeId) => {
        const node = nodes.get(nodeId);
        if (!node) return;
        let kind = null;
        let value = null;
        if (node.classType === 'LoadImage') {
          kind = 'image';
          value = node.inputs.image;
        } else if ([
          'LoadVideo',
          'VHS_LoadVideo',
          'VHS_LoadVideoPath',
        ].includes(node.classType)) {
          kind = 'video';
          value = node.inputs.video ?? node.inputs.path ?? node.inputs.filename;
        }
        const name = scalarString(value, limits.maxScalarLength);
        if (!kind || !name || sourceInputs.length >= limits.maxAssetsPerKind) return;
        sourceInputs.push({ name, kind, nodeId: node.id, classType: node.classType });
      });
  };

  return {
    diagnostics,
    promptFragments,
    models,
    vaes,
    textEncoders,
    loras,
    sourceInputs,
    addDiagnostic,
    traceAsset,
    resolveConditioning,
    collectSources,
  };
}

function firstScalar(inputs, keys, maxLength) {
  for (const key of keys) {
    const value = scalar(inputs[key], maxLength);
    if (value !== null) return value;
  }
  return null;
}

function resolveKnownScalar(
  value,
  { nodes, asRef, limits },
  visited = new Set(),
  depth = 0
) {
  const direct = scalar(value, limits.maxScalarLength);
  if (direct !== null) return direct;
  const ref = asRef(value);
  if (!ref || depth > limits.maxTraversalDepth) return null;
  const visitKey = `${ref.nodeId}:${ref.slot}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);
  const node = nodes.get(ref.nodeId);
  const field = node ? SCALAR_NODE_INPUT.get(node.classType) : null;
  if (!node || !field) return null;
  return resolveKnownScalar(
    node.inputs[field],
    { nodes, asRef, limits },
    visited,
    depth + 1
  );
}

function firstResolvedScalar(inputs, keys, context) {
  for (const key of keys) {
    const value = resolveKnownScalar(inputs[key], context);
    if (value !== null) return value;
  }
  return null;
}

function parseSamplerStage(node, { nodes, asRef, limits }) {
  const inputs = node.inputs;
  const scalarContext = { nodes, asRef, limits };
  const stage = {
    nodeId: node.id,
    classType: node.classType,
    role: 'contributor',
    seed: scalarString(
      firstResolvedScalar(inputs, ['seed', 'noise_seed'], scalarContext),
      limits.maxScalarLength
    ),
    steps: firstResolvedScalar(inputs, ['steps'], scalarContext),
    cfg: firstResolvedScalar(inputs, ['cfg'], scalarContext),
    sampler: scalarString(
      firstScalar(inputs, ['sampler_name'], limits.maxScalarLength),
      limits.maxScalarLength
    ),
    scheduler: scalarString(
      firstScalar(inputs, ['scheduler'], limits.maxScalarLength),
      limits.maxScalarLength
    ),
    denoise: firstResolvedScalar(inputs, ['denoise', 'denoise_strength'], scalarContext),
    startStep: firstResolvedScalar(inputs, ['start_at_step', 'start_step'], scalarContext),
    endStep: firstResolvedScalar(inputs, ['end_at_step', 'end_step'], scalarContext),
    modelRef: asRef(inputs.model),
    positiveRef: asRef(inputs.positive),
    negativeRef: asRef(inputs.negative),
  };

  if (node.classType === 'WanVideoSampler') {
    stage.sampler = node.classType;
    stage.positiveRef ||= asRef(inputs.text_embeds);
    stage.negativeRef ||= asRef(inputs.text_embeds);
  }

  if (node.classType === 'SamplerCustom' || node.classType === 'SamplerCustomAdvanced') {
    const noiseNode = nodes.get(asRef(inputs.noise)?.nodeId);
    if (!stage.seed && noiseNode?.classType === 'RandomNoise') {
      stage.seed = scalarString(noiseNode.inputs.noise_seed, limits.maxScalarLength);
    }

    const guiderNode = nodes.get(asRef(inputs.guider)?.nodeId);
    if (guiderNode && ['CFGGuider', 'BasicGuider', 'DualCFGGuider'].includes(
      guiderNode.classType
    )) {
      if (stage.cfg === null) stage.cfg = scalar(guiderNode.inputs.cfg, limits.maxScalarLength);
      stage.modelRef ||= asRef(guiderNode.inputs.model);
      stage.positiveRef ||= asRef(guiderNode.inputs.positive);
      stage.negativeRef ||= asRef(guiderNode.inputs.negative);
    }

    const samplerNode = nodes.get(asRef(inputs.sampler)?.nodeId);
    if (!stage.sampler && samplerNode?.classType === 'KSamplerSelect') {
      stage.sampler = scalarString(
        samplerNode.inputs.sampler_name,
        limits.maxScalarLength
      );
    }

    const schedulerNode = nodes.get(asRef(inputs.sigmas)?.nodeId);
    if (schedulerNode?.classType === 'BasicScheduler') {
      if (!stage.scheduler) {
        stage.scheduler = scalarString(
          schedulerNode.inputs.scheduler,
          limits.maxScalarLength
        );
      }
      if (stage.steps === null) {
        stage.steps = scalar(schedulerNode.inputs.steps, limits.maxScalarLength);
      }
      if (stage.denoise === null) {
        stage.denoise = scalar(schedulerNode.inputs.denoise, limits.maxScalarLength);
      }
      stage.modelRef ||= asRef(schedulerNode.inputs.model);
    }
  }

  return stage;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseComfyGenerationPayload(payload, options = {}) {
  const limits = { ...DEFAULT_COMFY_GENERATION_LIMITS, ...(options.limits || {}) };
  const located = findComfyApiGraph(payload, limits);
  if (!located) return null;
  const { nodes, asRef } = indexGraph(located.graph, limits);
  const selected = selectOutputNode(nodes, options.fileName, limits);
  const baseOrigin = isPlainObject(options.origin) ? options.origin : {};
  const origin = {
    kind: clampString(baseOrigin.kind, limits.maxScalarLength) || 'unknown',
    carrier: clampString(baseOrigin.carrier, limits.maxScalarLength) || 'json',
    metadataKey: clampString(
      baseOrigin.metadataKey,
      limits.maxScalarLength
    ) || located.metadataKey,
    graphFormat: 'api',
    resolution: 'partial',
  };

  if (!selected.node) {
    return {
      provider: 'comfyui',
      origin: { ...origin, resolution: selected.ambiguous ? 'ambiguous' : 'partial' },
      output: null,
      positivePrompt: null,
      negativePrompt: null,
      promptFragments: [],
      samplerStages: [],
      assets: { models: [], vaes: [], textEncoders: [], loras: [] },
      sourceInputs: [],
      diagnostics: [{
        code: selected.ambiguous ? 'AMBIGUOUS_OUTPUT' : 'OUTPUT_NOT_FOUND',
        message: selected.ambiguous
          ? 'Several output nodes could own this file'
          : 'No supported ComfyUI output node was found',
        nodeId: null,
        classType: null,
        role: null,
      }],
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
  }

  const reachable = collectReachable(selected.node, nodes, asRef, limits);
  const collector = createCollector({ nodes, asRef, reachable, limits });
  const samplerNodes = Array.from(reachable.entries())
    .map(([nodeId, distance]) => ({ node: nodes.get(nodeId), distance }))
    .filter(({ node }) => node && SAMPLER_TYPES.has(node.classType))
    .sort((left, right) =>
      right.distance - left.distance || naturalNodeCompare(left.node.id, right.node.id)
    );

  if (samplerNodes.length > limits.maxSamplerStages) {
    throw new ComfyGenerationParserError(
      'COMFY_SAMPLER_LIMIT',
      `ComfyUI graph exceeds the ${limits.maxSamplerStages}-sampler limit`
    );
  }
  const samplerStages = samplerNodes.map(({ node, distance }) => ({
    ...parseSamplerStage(node, { nodes, asRef, limits }),
    distanceToOutput: distance,
  }));
  const nearestDistance = samplerNodes.length
    ? Math.min(...samplerNodes.map(({ distance }) => distance))
    : null;
  const nearestCount = samplerNodes.filter(({ distance }) => distance === nearestDistance).length;
  if (nearestCount === 1) {
    const finalStage = samplerStages.find(
      (stage) => stage.distanceToOutput === nearestDistance
    );
    if (finalStage) finalStage.role = 'final';
  }

  if (!samplerStages.length) {
    collector.addDiagnostic({
      code: 'SAMPLER_NOT_FOUND',
      message: 'No supported sampler was reachable from the selected output',
      node: selected.node,
    });
  }

  [...samplerStages]
    .sort((left, right) => Number(right.role === 'final') - Number(left.role === 'final'))
    .forEach((stage) => {
      collector.resolveConditioning(stage.positiveRef, 'positive');
      collector.resolveConditioning(stage.negativeRef, 'negative');
      collector.traceAsset(stage.modelRef, 'model');
      delete stage.modelRef;
      delete stage.positiveRef;
      delete stage.negativeRef;
    });

  Array.from(reachable.keys())
    .sort(naturalNodeCompare)
    .forEach((nodeId) => {
      const node = nodes.get(nodeId);
      if (!node || !DECODE_TYPES.has(node.classType)) return;
      collector.traceAsset(asRef(node.inputs.vae), 'vae');
    });
  collector.collectSources();

  const positiveFragments = collector.promptFragments.filter(
    (fragment) => fragment.role === 'positive'
  );
  const negativeFragments = collector.promptFragments.filter(
    (fragment) => fragment.role === 'negative'
  );
  const positivePrompt = positiveFragments.length === 1
    ? positiveFragments[0].text
    : null;
  const negativePrompt = negativeFragments.length === 1
    ? negativeFragments[0].text
    : null;

  const finalStage = [...samplerStages].reverse().find((stage) => stage.role === 'final') ||
    [...samplerStages].reverse().find(Boolean) || null;
  const modelNames = uniqueStrings(collector.models.map((asset) => asset.name));
  const samplerNames = uniqueStrings(
    samplerStages.flatMap((stage) => [stage.sampler, stage.scheduler])
  );
  const sourceImages = uniqueStrings(
    collector.sourceInputs
      .filter((source) => source.kind === 'image')
      .map((source) => source.name)
  );
  const hasPartialEvidence = collector.diagnostics.length > 0 ||
    nearestCount > 1 ||
    positiveFragments.length > 1 ||
    negativeFragments.length > 1;

  return {
    provider: 'comfyui',
    origin: {
      ...origin,
      resolution: hasPartialEvidence ? 'partial' : 'traced',
    },
    output: {
      nodeId: selected.node.id,
      classType: selected.node.classType,
      match: selected.match,
    },
    positivePrompt,
    negativePrompt,
    promptFragments: collector.promptFragments,
    samplerStages,
    assets: {
      models: collector.models,
      vaes: collector.vaes,
      textEncoders: collector.textEncoders,
      loras: collector.loras,
    },
    sourceInputs: collector.sourceInputs,
    diagnostics: collector.diagnostics,
    prompt: positivePrompt,
    seed: finalStage?.seed || null,
    model: modelNames[0] || null,
    models: modelNames,
    sampler: finalStage?.sampler || null,
    samplers: samplerNames,
    sourceImage: sourceImages[0] || null,
    sourceImages,
    generationRun: null,
  };
}

module.exports = {
  DEFAULT_COMFY_GENERATION_LIMITS,
  ComfyGenerationParserError,
  quoteUnsafeJsonIntegers,
  isComfyApiGraph,
  findComfyApiGraph,
  parseComfyGenerationPayload,
};
