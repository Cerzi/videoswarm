const { reachableNodes } = require('./comfy-checks');
const { stringifyComfyGraphJson } = require('./comfy-graph-json');

// Never silently wrong: whether a re-render may be sent as the recipe made it,
// judged on the draft and the prompt the recipe produced for it. Pure: no
// network and no files (whether a path exists is asked of the caller).
// See docs/architecture/comfy-queue-integration.md, Section 10.
//
// A diff shows what changed, not why. The danger is in how inputs relate
// (the V2V hybrid's SAM3 clicks are in pixels of a frame whose size the
// recipe changes) and in what nodes do beyond the render (a save node that
// registers a continuation run). So every clip lands in one bucket:
//   declared - the workflow declares its own quality switch (a group titled
//              to be set to Never for the quality run) and the recipe flips
//              exactly that, with nothing else held;
//   known    - a recipe matched the draft and nothing below holds it;
//   review   - held, with a reason per hold. A person (or, later, an adapter)
//              confirms a hold by its id; refusals cannot be confirmed.
//
// The dependency check walks downstream from every input the recipe changes
// for this draft, through every link. It holds the clip when the change
// reaches a node the engine does not understand that carries literal data -
// a JSON list or object, a coordinate - because that data was written for the
// draft's values and nothing adjusts it. "Understood" is the explicit list
// below: node classes whose literal inputs the engine knows do not depend on
// what feeds them. A node whose own setting the recipe changes is not judged
// on its other inputs: every example pair showed that node before and after,
// and what follows the change there is an operation or a rule of the recipe.

// Node classes the engine knows are safe to feed a changed value: their
// literal inputs (model names, sampler settings, LoRA entries) do not depend
// on sizes, steps or models upstream. Nothing else is trusted with literal
// data downstream of a change.
const UNDERSTOOD_CLASSES = Object.freeze([
  // Literals and pass-through: they only carry the value on.
  'PrimitiveInt',
  'PrimitiveFloat',
  'PrimitiveBoolean',
  'PrimitiveString',
  'PrimitiveStringMultiline',
  'PrimitiveNode',
  'Reroute',
  'Any Switch (rgthree)',
  'ComfySwitchNode',
  'ComfyMathExpression',
  // Sampling.
  'KSampler',
  'KSamplerAdvanced',
  'SamplerCustom',
  'SamplerCustomAdvanced',
  'BasicScheduler',
  'BasicGuider',
  'CFGGuider',
  'RandomNoise',
  'KSamplerSelect',
  // Loaders: their literal data names files and LoRA strengths.
  'UNETLoader',
  'CheckpointLoaderSimple',
  'LoraLoader',
  'LoraLoaderModelOnly',
  'Power Lora Loader (rgthree)',
  'CLIPLoader',
  'DualCLIPLoader',
  'VAELoader',
  // Decoding, encoding and the plain save.
  'VAEDecode',
  'VAEEncode',
  'VAEDecodeTiled',
  'VAEDecodeAudio',
  'VAEEncodeAudio',
  'CreateVideo',
  'SaveVideo',
]);
const UNDERSTOOD = new Set(UNDERSTOOD_CLASSES);

const PLAIN_SAVE = 'SaveVideo';
const OUTPUT_NAMES = new Set(['filename_prefix', 'output_path', 'filename', 'file_name', 'output_filename']);
// Inputs that name somewhere a node writes, or switch writing on.
const WRITE_NAME = /^(save|output|export|write|out)_?(to_)?(path|dir|directory|folder|file|file_?name|file_?path)$/i;
const WRITE_FLAG = /^(save_output|save_to_disk|write_to_disk|save_file|write_file)$/i;
// A planner's count of work already done, or where it resumes: above zero,
// the draft continues an earlier run.
const CONTINUATION_COUNT = /(^|_)(accepted|completed|resumed|continued)(_|$)|^start_(window|chunk|segment)s?$/i;
const CONTINUATION_FLAG = /^(resume|continue|is_continuation|continuation)$/i;
// A literal number in pixels of the draft's frame: zero is the same at any
// size, anything else is not.
const GEOMETRY_NAME = /^(x|y|x\d|y\d|left|top|right|bottom|width|height|crop_[a-z_]+|offset_?[xy]|pad(ding)?(_[a-z]+)?)$/i;
// A group the workflow's author asks to switch off for the quality run.
const DECLARED_QUALITY = /\bquality\b/i;
const DECLARED_OFF = /\b(never|bypass(ed)?|mute(d)?)\b/i;
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)[^\n\r\0]*$/;
const LIMITS = Object.freeze({
  maxHolds: 32,
  maxPaths: 32,
  maxChanges: 64,
  maxPathLength: 1024,
  maxJsonLength: 256 * 1024,
  maxJsonLeaves: 10_000,
  maxTraceHops: 32,
  maxPathSteps: 512,
  maxConfirmed: 32,
  maxHoldIdLength: 200,
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLink = (value) =>
  Array.isArray(value) &&
  value.length === 2 &&
  (typeof value[0] === 'string' || typeof value[0] === 'number') &&
  Number.isInteger(value[1]);
const compareIds = (left, right) => String(left).localeCompare(String(right), 'en', { numeric: true });
const inputsOf = (node) => (isObject(node?.inputs) ? node.inputs : {});
const label = (prompt, id) => `${prompt[id]?.class_type ?? 'node'} #${id}`;

function same(left, right) {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  try {
    return stringifyComfyGraphJson(left) === stringifyComfyGraphJson(right);
  } catch {
    return false;
  }
}

function parseJsonContainer(value) {
  if (typeof value !== 'string' || value.length > LIMITS.maxJsonLength) return undefined;
  const text = value.trim();
  if (!((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}')))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Whether a list or object holds anything: a number or a non-empty string.
// `[{}]`, `[]` and a list of switches hold nothing to get wrong.
function holdsData(value) {
  let leaves = 0;
  const stack = [value];
  while (stack.length && leaves < LIMITS.maxJsonLeaves) {
    const entry = stack.pop();
    leaves += 1;
    if (typeof entry === 'number' || typeof entry === 'bigint') return true;
    if (typeof entry === 'string' && entry.trim()) return true;
    if (Array.isArray(entry)) stack.push(...entry);
    else if (isObject(entry)) stack.push(...Object.values(entry));
  }
  return false;
}

// The inputs of a node that hold literal data written for the draft: JSON
// lists and objects (inline or in a string) with something in them, and
// non-zero pixel geometry.
function literalDataInputs(node) {
  const names = [];
  for (const [name, value] of Object.entries(inputsOf(node))) {
    if (isLink(value) || OUTPUT_NAMES.has(name)) continue;
    if (value !== null && typeof value === 'object') {
      if (holdsData(value)) names.push(name);
    } else if (typeof value === 'string') {
      const parsed = parseJsonContainer(value);
      if (parsed !== undefined && holdsData(parsed)) names.push(name);
    } else if (typeof value === 'number' && value !== 0 && GEOMETRY_NAME.test(name)) {
      names.push(name);
    }
  }
  return names;
}

// Every input whose value differs between the draft and the prompt to send:
// `value` for a literal the recipe set, `link` for a rewiring (a removed or
// added node shows up as its consumers' links), `node` for a node that is new
// or of another class. Output names are the runner's, not the recipe's.
function changedInputs(draftPrompt, prompt) {
  const draft = isObject(draftPrompt) ? draftPrompt : {};
  const changes = [];
  for (const id of Object.keys(isObject(prompt) ? prompt : {}).sort(compareIds)) {
    const after = prompt[id];
    const before = draft[id];
    if (!isObject(before) || before.class_type !== after?.class_type) {
      changes.push({ node: id, class: after?.class_type ?? null, input: null, kind: 'node' });
      continue;
    }
    const was = inputsOf(before);
    const now = inputsOf(after);
    for (const input of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
      if (OUTPUT_NAMES.has(input) || same(was[input], now[input])) continue;
      const kind = isLink(was[input]) || isLink(now[input]) ? 'link' : 'value';
      changes.push({ node: id, class: after.class_type, input, kind });
    }
  }
  return changes;
}

function consumersIndex(prompt) {
  const index = new Map();
  for (const id of Object.keys(prompt).sort(compareIds)) {
    for (const [input, value] of Object.entries(inputsOf(prompt[id])).sort(([a], [b]) => a.localeCompare(b))) {
      if (!isLink(value)) continue;
      const source = String(value[0]);
      if (!index.has(source)) index.set(source, []);
      index.get(source).push({ node: id, input });
    }
  }
  return index;
}

function describeChange(change) {
  if (change.kind === 'node') return `Adding ${change.class} #${change.node}`;
  if (change.kind === 'link') return `Rewiring ${change.input} on ${change.class} #${change.node}`;
  return `Changing ${change.input} on ${change.class} #${change.node}`;
}

// Walk downstream from each change and hold the first time it reaches an
// unknown node carrying literal data, naming the path it took.
function dependencyHolds(prompt, changes, live) {
  const consumers = consumersIndex(prompt);
  const holds = new Map();
  for (const change of changes) {
    const parent = new Map();
    const queue = [];
    if (change.kind === 'value') {
      for (const use of consumers.get(change.node) || []) {
        if (parent.has(use.node)) continue;
        parent.set(use.node, { from: change.node, input: use.input });
        queue.push(use.node);
      }
    } else {
      parent.set(change.node, { from: null, input: change.input });
      queue.push(change.node);
    }
    for (let at = 0; at < queue.length; at += 1) {
      const id = queue[at];
      const node = prompt[id];
      if (live.has(id) && !holds.has(id) && !UNDERSTOOD.has(node?.class_type)) {
        const data = literalDataInputs(node);
        if (data.length) holds.set(id, dependencyHold(prompt, change, id, parent, data));
      }
      for (const use of consumers.get(id) || []) {
        if (parent.has(use.node) || use.node === change.node) continue;
        parent.set(use.node, { from: id, input: use.input });
        queue.push(use.node);
      }
    }
  }
  return [...holds.values()];
}

function dependencyHold(prompt, change, id, parent, data) {
  const steps = [];
  for (let at = id; at !== null && at !== undefined && steps.length <= LIMITS.maxPathSteps; ) {
    const step = parent.get(at);
    steps.unshift({ node: at, class: prompt[at]?.class_type ?? null, input: step?.input ?? null });
    at = step?.from ?? null;
    if (at === change.node && change.kind === 'value') {
      steps.unshift({ node: at, class: change.class, input: change.input });
      break;
    }
  }
  const through = steps.slice(1, -1).map((step) => label(prompt, step.node));
  const target = steps[steps.length - 1];
  const where = `${label(prompt, id)}${target.input ? ` (${target.input})` : ''}`;
  const route =
    steps.length === 1
      ? `${describeChange(change)}. `
      : `${describeChange(change)} reaches ${where}${through.length ? ` through ${through.join(', ')}` : ''}. `;
  return {
    id: `dependency:${id}:${prompt[id].class_type}`,
    code: 'COMFY_HOLD_DEPENDENCY',
    message:
      `${route}${prompt[id].class_type} is not a node the engine understands, and it carries literal data ` +
      `(${data.slice(0, 6).join(', ')}${data.length > 6 ? ', …' : ''}) written for the draft that nothing would adjust to the change`,
    node: id,
    class: prompt[id].class_type,
    confirmable: true,
    path: steps,
  };
}

// A literal behind a link, through primitives and pass-through nodes, or
// undefined when something computes it.
function literalBehind(prompt, value) {
  let current = value;
  for (let hops = 0; hops < LIMITS.maxTraceHops; hops += 1) {
    if (!isLink(current)) return current;
    const node = prompt[String(current[0])];
    const inputs = inputsOf(node);
    if (Object.hasOwn(inputs, 'value') && Object.keys(inputs).length === 1) {
      current = inputs.value;
    } else if (String(node?.class_type).startsWith('Any Switch')) {
      current = inputs[Object.keys(inputs).filter((key) => key.startsWith('any_')).sort()[0]];
    } else if (node?.class_type === 'Reroute') {
      current = Object.values(inputs)[0];
    } else {
      return undefined;
    }
  }
  return undefined;
}

// Structural red flags on the nodes ComfyUI would run.
function redFlags(prompt, live, pathExists) {
  const holds = [];
  for (const id of live) {
    const node = prompt[id];
    const classType = node.class_type;
    const inputs = inputsOf(node);
    const saves = Object.entries(inputs).some(([name, value]) => OUTPUT_NAMES.has(name) && typeof value === 'string');
    if (saves && classType !== PLAIN_SAVE) {
      holds.push({
        id: `save:${id}:${classType}`,
        code: 'COMFY_HOLD_SAVE_NODE',
        message:
          `The final would be saved by ${classType} #${id}, not a plain ${PLAIN_SAVE}. ` +
          'A save node can do more than save (register a run, continue a project), and every final would do it too',
        node: id,
        class: classType,
        confirmable: true,
      });
    }
    const writes = Object.entries(inputs).filter(
      ([name, value]) =>
        (WRITE_NAME.test(name) && typeof value === 'string' && value.trim() && !OUTPUT_NAMES.has(name)) ||
        (WRITE_FLAG.test(name) && value === true)
    );
    if (writes.length && !saves) {
      holds.push({
        id: `writes:${id}:${classType}`,
        code: 'COMFY_HOLD_WRITES_FILES',
        message: `${classType} #${id} writes files (${writes.map(([name]) => name).join(', ')}), and the re-render would write them again`,
        node: id,
        class: classType,
        confirmable: true,
      });
    }
    for (const [name, value] of Object.entries(inputs)) {
      const literal = literalBehind(prompt, value);
      const continues =
        (CONTINUATION_COUNT.test(name) && typeof literal === 'number' && literal > 0) ||
        (CONTINUATION_FLAG.test(name) && literal === true);
      if (continues) {
        holds.push({
          id: `continuation:${id}:${classType}`,
          code: 'COMFY_REFUSED_CONTINUATION',
          message: `A continuation run: ${classType} #${id} has ${name} ${literal}. Only a fresh run can be re-rendered`,
          node: id,
          class: classType,
          confirmable: false,
        });
        break;
      }
    }
    for (const [name, value] of Object.entries(inputs)) {
      if (typeof value !== 'string' || value.length > LIMITS.maxPathLength || !ABSOLUTE_PATH.test(value)) continue;
      if (pathExists?.(value) !== false) continue;
      holds.push({
        id: `path:${id}:${name}`,
        code: 'COMFY_INPUT_PATH_MISSING',
        message: `${classType} #${id} ${name} names ${value}, which no longer exists`,
        node: id,
        class: classType,
        confirmable: false,
      });
    }
  }
  return holds;
}

// Absolute paths the prompt reads, for the caller to check: at most
// LIMITS.maxPaths, from the nodes ComfyUI would run.
function absolutePathsIn(prompt, info) {
  if (!isObject(prompt)) return [];
  const found = new Set();
  for (const id of reachableNodes(prompt, isObject(info) ? info : {})) {
    for (const value of Object.values(inputsOf(prompt[id]))) {
      if (found.size >= LIMITS.maxPaths) return [...found];
      if (typeof value === 'string' && value.length <= LIMITS.maxPathLength && ABSOLUTE_PATH.test(value)) found.add(value);
    }
  }
  return [...found];
}

function positionOf(node) {
  const pos = node?.pos;
  if (Array.isArray(pos)) return [Number(pos[0]), Number(pos[1])];
  if (isObject(pos)) return [Number(pos[0]), Number(pos[1])];
  return null;
}

// The workflow's own quality switch, when this prompt flips it: a group
// titled to be set to Never (or bypassed, or muted) for the quality run, all
// of whose nodes in the draft are gone from the prompt to send. Membership is
// a node's position inside the group's box, as rgthree's group toggles decide.
function declaredQualitySwitch(workflow, draftPrompt, prompt) {
  if (!isObject(workflow) || !Array.isArray(workflow.groups) || !Array.isArray(workflow.nodes)) return null;
  for (const group of workflow.groups) {
    const title = typeof group?.title === 'string' ? group.title : '';
    if (!DECLARED_QUALITY.test(title) || !DECLARED_OFF.test(title)) continue;
    const box = Array.isArray(group.bounding) ? group.bounding.map(Number) : [];
    if (box.length < 4 || box.some((value) => !Number.isFinite(value))) continue;
    const [gx, gy, gw, gh] = box;
    const members = workflow.nodes
      .filter((node) => {
        const pos = positionOf(node);
        return pos && pos[0] >= gx && pos[0] <= gx + gw && pos[1] >= gy && pos[1] <= gy + gh;
      })
      .map((node) => String(node.id))
      .filter((id) => Object.hasOwn(draftPrompt, id))
      .sort(compareIds);
    if (members.length && members.every((id) => !Object.hasOwn(prompt, id))) {
      return { group: title.slice(0, 200), nodes: members };
    }
  }
  return null;
}

// Hold ids a person confirmed, cleaned: strings of a bounded length, at most
// LIMITS.maxConfirmed of them.
function normalizeConfirmed(value) {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((entry) => typeof entry === 'string' && entry && entry.length <= LIMITS.maxHoldIdLength);
  return [...new Set(ids)].slice(-LIMITS.maxConfirmed);
}

// @param draft    { prompt, workflow } of the draft
// @param prompt   the API prompt the recipe produced for it
// @param info     node definitions by class (outputs decide what runs)
// @param confirmed hold ids a person or adapter confirmed for this clip
// @param pathExists (path) => true | false | undefined (unknown)
// @returns { bucket, held, declared, changes, holds }
function assessRerender({ draft, prompt, info = {}, confirmed = [], pathExists = null } = {}) {
  const draftPrompt = isObject(draft?.prompt) ? draft.prompt : {};
  if (!isObject(prompt)) {
    return {
      bucket: 'review',
      held: true,
      declared: null,
      changes: [],
      holds: [{ id: 'prompt', code: 'COMFY_PROMPT_INVALID', message: 'No API prompt to check', node: null, class: null, confirmable: false, confirmed: false }],
    };
  }
  const live = new Set(reachableNodes(prompt, isObject(info) ? info : {}));
  const changes = changedInputs(draftPrompt, prompt);
  const accepted = new Set(normalizeConfirmed(confirmed));
  const holds = [...redFlags(prompt, live, pathExists), ...dependencyHolds(prompt, changes, live)]
    .slice(0, LIMITS.maxHolds)
    .map((hold) => ({ ...hold, confirmed: hold.confirmable && accepted.has(hold.id) }));
  const declared = declaredQualitySwitch(draft?.workflow, draftPrompt, prompt);
  return {
    bucket: holds.length ? 'review' : declared ? 'declared' : 'known',
    held: holds.some((hold) => !hold.confirmed),
    declared,
    changes: changes.slice(0, LIMITS.maxChanges),
    holds,
  };
}

// What stops the clip being sent, in the shape of the pre-queue checks:
// refusals first, then holds nobody has confirmed.
function heldProblems(assessment) {
  return (assessment?.holds || [])
    .filter((hold) => !hold.confirmed)
    .sort((a, b) => Number(a.confirmable) - Number(b.confirmable))
    .map((hold) => ({
      code: hold.code,
      message: hold.message,
      node: hold.node,
      class: hold.class,
      hold: hold.id,
      confirmable: hold.confirmable,
    }));
}

module.exports = {
  LIMITS,
  UNDERSTOOD_CLASSES,
  absolutePathsIn,
  assessRerender,
  changedInputs,
  declaredQualitySwitch,
  heldProblems,
  literalDataInputs,
  normalizeConfirmed,
};
