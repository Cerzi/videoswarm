const { replaceNonFiniteJsonTokens } = require('./json-non-finite');

// ComfyUI graphs read and written without losing 64-bit seeds. A re-render
// submits the draft's graph again, so a seed above 2^53 must come back out as
// the same digits: integers too large for a double are read as BigInt and
// written as raw JSON numbers. Everything else is plain JSON. Python's NaN and
// Infinity are read as null, the tolerant retry the Generation panel uses.

const INT_LITERAL = /^-?\d+$/;

function reviveInteger(key, value, context) {
  if (typeof value !== 'number' || Number.isSafeInteger(value) || !Number.isInteger(value)) {
    return value;
  }
  const source = context?.source;
  return typeof source === 'string' && INT_LITERAL.test(source) ? BigInt(source) : value;
}

function parseComfyGraphJson(text) {
  const source = String(text ?? '');
  try {
    return JSON.parse(source, reviveInteger);
  } catch (strictError) {
    try {
      return JSON.parse(replaceNonFiniteJsonTokens(source), reviveInteger);
    } catch {
      throw strictError;
    }
  }
}

function stringifyComfyGraphJson(value, space) {
  return JSON.stringify(
    value,
    (key, entry) => (typeof entry === 'bigint' ? JSON.rawJSON(entry.toString()) : entry),
    space
  );
}

module.exports = { parseComfyGraphJson, stringifyComfyGraphJson };
