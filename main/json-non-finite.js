// Python's json module writes NaN, Infinity and -Infinity, and ComfyUI's API
// prompt carries them (for example `"is_changed": [NaN]`). Strict JSON.parse
// rejects the whole document over a field nothing reads, so callers retry
// with this: every such token outside a string literal becomes `null`, and
// string contents - including a prompt that says "NaN" - are left untouched.
// It is only a retry path; well-formed JSON never goes through it.
function replaceNonFiniteJsonTokens(source) {
  const text = String(source ?? "");
  let output = "";
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === "\\" ? 2 : 1;
      }
      index += 1;
      continue;
    }
    const token = text.startsWith("NaN", index)
      ? "NaN"
      : text.startsWith("-Infinity", index)
        ? "-Infinity"
        : text.startsWith("Infinity", index)
          ? "Infinity"
          : null;
    if (token) {
      output += `${text.slice(start, index)}null`;
      index += token.length;
      start = index;
      continue;
    }
    index += 1;
  }
  return output + text.slice(start);
}

module.exports = { replaceNonFiniteJsonTokens };
