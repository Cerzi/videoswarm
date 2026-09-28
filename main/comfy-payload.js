const { replaceNonFiniteJsonTokens } = require('./json-non-finite');

// Locating and decoding a ComfyUI API graph inside an embedded tag, a VHS
// envelope or a sidecar, under shared byte, depth and node budgets. Shared by
// the generation reader (comfy-generation-parser.js); interpretation of the
// graph lives there.

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
  } catch (strictError) {
    // ComfyUI writes Python's NaN/Infinity into API prompts. Non-finite
    // tokens are replaced before unsafe integers are quoted, because the
    // integer scanner would otherwise read the sign of -Infinity as a number.
    try {
      parsed = JSON.parse(
        quoteUnsafeJsonIntegers(replaceNonFiniteJsonTokens(source))
      );
    } catch {
      throw new ComfyGenerationParserError(
        'COMFY_INVALID_JSON',
        `Generation metadata is not valid JSON: ${
          strictError?.message || strictError
        }`
      );
    }
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

module.exports = {
  DEFAULT_COMFY_GENERATION_LIMITS,
  ComfyGenerationParserError,
  findComfyApiGraph,
  inspectBoundedShape,
  isComfyApiGraph,
  isPlainObject,
  parseBoundedJson,
  quoteUnsafeJsonIntegers,
};
