// Checks before a prompt is queued, against ComfyUI's node definitions: what
// would stop it, or quietly change it, found without queueing it. Ported from
// the standalone comfy-requeue app's problems_in(), with nothing keyed to a
// node class. Inputs are judged only on nodes an output depends on: renders
// carry inert leftovers ComfyUI never validates or runs. Whether each class is
// installed is checked on every node, as ComfyUI does.
// See docs/architecture/comfy-queue-integration.md, Section 5.

const OUTPUT_NAMES = new Set(['filename_prefix', 'output_path', 'filename', 'file_name', 'output_filename']);
const LOADERS = [
  ['LoadImage', 'image'],
  ['LoadVideo', 'file'],
  ['LoadAudio', 'audio'],
];
const LORA_LOADERS = [
  ['LoraLoaderModelOnly', 'lora_name'],
  ['LoraLoader', 'lora_name'],
];
const MEDIA_FILE =
  /^[^\n\r"<>|?*]+\.(png|jpe?g|webp|gif|bmp|tiff?|exr|mp4|mov|webm|mkv|avi|m4v|wav|mp3|flac|ogg|m4a)$/i;
const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth|bin|sft|onnx)$/i;
const ANNOTATION = /\s*\[(input|output|temp)\]$/i;
const MAX_PROBLEMS = 64;
const MAX_FILE_NAME = 1024;

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const isLink = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  (typeof value[0] === 'string' || typeof value[0] === 'number') &&
  Number.isInteger(value[1]);

// A combo input's allowed values, in either /object_info spelling, or null.
function comboOptions(spec) {
  if (!Array.isArray(spec) || !spec.length) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === 'COMBO' && isObject(spec[1]) && Array.isArray(spec[1].options)) return spec[1].options;
  return null;
}

const requiredOf = (spec) => (isObject(spec?.input?.required) ? spec.input.required : {});
const declaredOf = (spec) => ({
  ...(isObject(spec?.input?.optional) ? spec.input.optional : {}),
  ...requiredOf(spec),
});

// The node classes whose definitions the checks need for this prompt.
function classesToCheck(prompt) {
  const classes = new Set([...LOADERS, ...LORA_LOADERS].map(([name]) => name));
  for (const node of Object.values(isObject(prompt) ? prompt : {})) {
    if (typeof node?.class_type === 'string') classes.add(node.class_type);
  }
  return [...classes];
}

// Nodes an output depends on: outputs are the classes ComfyUI marks as
// output nodes, and a node of an unknown class that nothing consumes (it
// may be an output ComfyUI no longer has).
function reachableNodes(prompt, info) {
  const consumed = new Set();
  for (const node of Object.values(prompt)) {
    for (const value of Object.values(isObject(node?.inputs) ? node.inputs : {})) {
      if (isLink(value)) consumed.add(String(value[0]));
    }
  }
  const stack = Object.entries(prompt)
    .filter(([id, node]) => {
      const spec = info[node?.class_type];
      return spec ? spec.output_node === true : !consumed.has(id);
    })
    .map(([id]) => id);
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !isObject(prompt[id])) continue;
    seen.add(id);
    for (const value of Object.values(isObject(prompt[id].inputs) ? prompt[id].inputs : {})) {
      if (isLink(value)) stack.push(String(value[0]));
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function parseJsonInput(value) {
  if (typeof value !== 'string' || value.length > 64 * 1024) return undefined;
  const text = value.trim();
  if (!((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}')))) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// File names inside a string input, each with where it sits: the whole
// string (path []), or the leaves of a JSON list or object of names (a
// composer's reference slots, path [slot] or [kind, slot]).
function fileNamesIn(value) {
  const parsed = parseJsonInput(value);
  if (parsed === undefined) {
    const text = typeof value === 'string' ? value.trim() : '';
    return MEDIA_FILE.test(text) && text.length <= MAX_FILE_NAME ? [{ name: text, path: [] }] : [];
  }
  const found = [];
  const walk = (entry, at) => {
    if (at.length > 4 || found.length > 64) return;
    if (typeof entry === 'string') {
      if (MEDIA_FILE.test(entry.trim()) && entry.length <= MAX_FILE_NAME) found.push({ name: entry.trim(), path: at });
    } else if (Array.isArray(entry)) {
      entry.forEach((item, index) => walk(item, [...at, index]));
    } else if (isObject(entry)) {
      Object.entries(entry).forEach(([key, item]) => walk(item, [...at, key]));
    }
  };
  walk(parsed, []);
  return found;
}

// Whether a sibling input switches off the slot at this position: a list
// named for bypassing holding `true` there (`slot_bypassed`), or settings
// holding `{ bypassed: true }`, `{ enabled: false }` and the like there
// (`media_settings`). A switched-off slot is not read, so its file need not
// exist.
function slotSwitchedOff(inputs, inputName, at) {
  if (!at.length) return false;
  for (const [sibling, raw] of Object.entries(inputs)) {
    if (sibling === inputName) continue;
    let entry = parseJsonInput(raw);
    for (const key of at) {
      if (entry === undefined || entry === null || typeof entry !== 'object') {
        entry = undefined;
        break;
      }
      entry = entry[key];
    }
    if (entry === true && /bypass|disable|mute/i.test(sibling)) return true;
    if (
      isObject(entry) &&
      (entry.bypassed === true || entry.disabled === true || entry.muted === true || entry.enabled === false || entry.on === false)
    ) {
      return true;
    }
  }
  return false;
}

// Everything in ComfyUI's input folder, as its own loaders list it; null
// when no loader is installed to say.
function inputFiles(info) {
  let known = false;
  const names = new Set();
  for (const [name, field] of LOADERS) {
    const options = comboOptions(requiredOf(info[name])[field]);
    if (!options) continue;
    known = true;
    options.forEach((option) => typeof option === 'string' && names.add(option));
  }
  return known ? names : null;
}

function loraFiles(info) {
  for (const [name, field] of LORA_LOADERS) {
    const options = comboOptions(requiredOf(info[name])[field]);
    if (options) return new Set(options.filter((option) => typeof option === 'string'));
  }
  return null;
}

function describeMissing(input, value) {
  if (/lora/i.test(input)) return `Missing LoRA: ${value}`;
  if (MODEL_FILE.test(value)) return `Missing model: ${value}`;
  if (MEDIA_FILE.test(value)) return `Missing input file: ${value}`;
  return `'${value}' is not an option for ${input}`;
}

// @param info node definitions by class (null for a class ComfyUI lacks)
// @returns [{ code, message, node, class }], empty when the prompt can run
function checkPrompt(prompt, info) {
  const problems = [];
  const seen = new Set();
  const add = (code, message, node, classType) => {
    if (problems.length >= MAX_PROBLEMS || seen.has(message)) return;
    seen.add(message);
    problems.push({ code, message, node, class: classType });
  };
  if (!isObject(prompt)) {
    add('COMFY_PROMPT_INVALID', 'No API prompt to check', null, null);
    return problems;
  }
  const definitions = isObject(info) ? info : {};
  const files = inputFiles(definitions);
  const loras = loraFiles(definitions);

  // ComfyUI refuses a prompt holding any class it does not have, wired to
  // an output or not, so every node is checked for that.
  for (const [id, node] of Object.entries(prompt)) {
    const classType = node?.class_type;
    if (!definitions[classType]) {
      add('COMFY_NODE_MISSING', `${classType} is not installed in ComfyUI`, id, classType);
    }
  }
  for (const id of reachableNodes(prompt, definitions)) {
    const node = prompt[id];
    const classType = node.class_type;
    const inputs = isObject(node.inputs) ? node.inputs : {};
    const spec = definitions[classType];
    if (!spec) continue;
    for (const name of Object.keys(requiredOf(spec))) {
      // Autogrow and dynamic inputs arrive as `name.sub` keys (images.image_0).
      if (!Object.keys(inputs).some((key) => key === name || key.startsWith(`${name}.`))) {
        add('COMFY_INPUT_MISSING', `${classType} needs '${name}', which this render predates`, id, classType);
      }
    }
    const declared = declaredOf(spec);
    for (const [name, value] of Object.entries(inputs)) {
      if (isLink(value) || OUTPUT_NAMES.has(name)) continue;
      const options = comboOptions(declared[name]);
      if (options) {
        if (typeof value === 'string' && !options.includes(value)) {
          add('COMFY_OPTION_MISSING', describeMissing(name, value), id, classType);
        }
        continue;
      }
      // rgthree's Power Lora Loader: { on, lora, strength } entries.
      if (isObject(value) && value.on === true && typeof value.lora === 'string' && loras && !loras.has(value.lora)) {
        add('COMFY_OPTION_MISSING', `Missing LoRA: ${value.lora}`, id, classType);
        continue;
      }
      // A string naming input files - one name, or a JSON list of them - must
      // name files in ComfyUI's input folder. A reference composer drops a
      // missing slot and renumbers the rest, so this would otherwise render
      // silently wrong rather than fail.
      if (!files) continue;
      for (const { name: raw, path: at } of fileNamesIn(value)) {
        if (/\[(output|temp)\]$/i.test(raw)) continue;
        if (slotSwitchedOff(inputs, name, at)) continue;
        const file = raw.replace(ANNOTATION, '');
        if (!files.has(file)) {
          add(
            'COMFY_INPUT_FILE_MISSING',
            `${classType} ${name} names ${file}, which is not in ComfyUI's input folder`,
            id,
            classType
          );
        }
      }
    }
  }
  return problems;
}

module.exports = { checkPrompt, classesToCheck, comboOptions, reachableNodes };
