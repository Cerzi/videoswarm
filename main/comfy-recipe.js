const { DEFAULT_COMFY_GENERATION_LIMITS, isPlainObject } = require('./comfy-payload');
const {
  OUTPUT_EXACT_NAMES,
  OUTPUT_PREFIX_NAMES,
  isSavingNode,
  readComfyGraph,
} = require('./comfy-generation-parser');
const { parseComfyGraphJson } = require('./comfy-graph-json');

// Re-render recipes learned from examples: the difference between drafts and
// their quality versions, replayed on another draft of the same workflow.
// Pure functions over ComfyUI graphs - no network, no files. A recipe never
// encodes what "quality" means; it only repeats what its example pairs show.
// See docs/architecture/comfy-queue-integration.md.
//
// Operations target API node ids with their class, because node ids are
// stable across every render of one workflow file:
//   remove  - a node the quality version drops, with how each consumer is
//             rewired (through one of its inputs, as a bypass does, or
//             dropped, as a mute leaves an Any Switch input);
//   add     - a node only the quality version has, rebuilt from the draft's
//             own UI graph where it sits there bypassed or muted;
//   set     - an input's new value;
//   ui-mode / ui-widget - UI-only changes, so the result reopens as rendered.
// Identity - seeds, prompt text, input media, output names - is never part
// of a recipe. An operation whose target value differs across the example
// pairs "varies per clip": it is kept at the draft's value unless the user
// picks a value or one of the candidate rules offered for it.

const RECIPE_KIND = 'videoswarm.comfy-recipe';
const RECIPE_VERSION = 1;
const DEFAULT_RECIPE_LIMITS = Object.freeze({
  minPairs: 2,
  maxPairs: 16,
  minSimilarity: 0.8,
  maxOps: 512,
  maxEffects: 8,
});

// LiteGraph node modes: 0 always, 2 never (muted), 4 bypassed.
const DISABLED_MODES = new Set([2, 4]);
const OUTPUT_NAMES = new Set([...OUTPUT_EXACT_NAMES, ...OUTPUT_PREFIX_NAMES]);
const MEDIA_FILE =
  /[^\s"'\\/,[\]]+\.(png|jpe?g|webp|gif|bmp|tiff?|exr|mp4|mov|webm|mkv|avi|m4v|wav|mp3|flac|ogg|m4a)\b/i;
const SEED_NAME = /(^|_)seed$/i;
const TEXT_NAME = /(^|_)(text|prompt)s?$/i;
const MIN_PROMPT_WORDS = 4;
// A fallback final rendered without its post-processing, as the standalone
// app names them (`..._final_1.5mp_35st_nopost_00001_.mp4`).
const NOPOST_NAME = /_nopost(?=[_.-]|$)/i;

class ComfyRecipeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComfyRecipeError';
    this.code = code;
  }
}

const failure = (code, message, extra = {}) => ({ error: { code, message, ...extra } });

// --- values ----------------------------------------------------------------

function isLink(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === 'string' || typeof value[0] === 'number') &&
    Number.isInteger(value[1])
  );
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => deepEqual(entry, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

const clone = (value) => (value === undefined ? undefined : structuredClone(value));
const compareIds = (left, right) =>
  String(left).localeCompare(String(right), 'en', { numeric: true });

function wordCount(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).length;
}

function looksLikeJson(value) {
  const text = String(value).trim();
  return (text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'));
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// --- reading one side of a pair ------------------------------------------------

function parseGraphValue(value, what) {
  if (typeof value === 'string') {
    try {
      return parseComfyGraphJson(value);
    } catch {
      throw new ComfyRecipeError('RECIPE_UNREADABLE', `The ${what} is not valid JSON`);
    }
  }
  return value ?? null;
}

// One graph, read with the Generation panel's socket typing: which nodes an
// output depends on, and what a switch, reroute or primitive carries.
function openGraph(side, limits) {
  if (!isPlainObject(side)) {
    throw new ComfyRecipeError('RECIPE_UNREADABLE', 'Expected an API prompt and optional workflow');
  }
  const prompt = parseGraphValue(side.prompt, 'API prompt');
  if (!isPlainObject(prompt)) {
    throw new ComfyRecipeError('RECIPE_UNREADABLE', 'No ComfyUI API prompt');
  }
  const workflowValue = parseGraphValue(side.workflow, 'UI workflow');
  const workflow = isPlainObject(workflowValue) && Array.isArray(workflowValue.nodes) ? workflowValue : null;
  let read;
  try {
    read = readComfyGraph(prompt, workflow, limits);
  } catch (error) {
    throw new ComfyRecipeError(error.code || 'RECIPE_UNREADABLE', error.message);
  }
  const { nodes, reader } = read;
  if (!nodes.size) throw new ComfyRecipeError('RECIPE_UNREADABLE', 'The API prompt has no nodes');

  const outputs = [...nodes.values()].filter((node) => isSavingNode(node, reader)).map((node) => node.id);
  const live = new Set();
  const stack = [...outputs];
  while (stack.length) {
    const id = stack.pop();
    if (live.has(id) || !nodes.has(id)) continue;
    live.add(id);
    for (const value of Object.values(nodes.get(id).inputs)) {
      if (isLink(value)) stack.push(String(value[0]));
    }
  }

  const isLiteralSource = (node) => {
    const values = Object.values(node.inputs);
    return (
      values.every((value) => !isLink(value)) &&
      values.filter((value) => value !== null && typeof value !== 'object').length === 1
    );
  };

  // Follow a value through pass-through nodes and one-literal primitives, as
  // the Generation panel does, remembering the nodes it went through.
  const trace = (value) => {
    const via = [];
    let current = value;
    for (let hops = 0; hops <= limits.maxTraversalDepth; hops += 1) {
      if (!isLink(current)) return { literal: current, via };
      const id = String(current[0]);
      const node = nodes.get(id);
      if (!node || via.includes(id)) return { unresolved: true, via };
      const through = reader.passThroughInput(node);
      if (through) {
        via.push(id);
        current = node.inputs[through.name];
        continue;
      }
      if (isLiteralSource(node)) {
        via.push(id);
        return {
          literal: Object.values(node.inputs).find((entry) => entry !== null && typeof entry !== 'object'),
          via,
        };
      }
      return { source: { nodeId: id, slot: current[1] }, via };
    }
    return { unresolved: true, via };
  };

  // Where each node's output ends up: the inputs of real (not pass-through)
  // nodes whose value is traced through it.
  let uses = null;
  const usesOf = (id) => {
    if (!uses) {
      uses = new Map();
      for (const node of nodes.values()) {
        if (!live.has(node.id) || reader.passThroughInput(node)) continue;
        for (const [input, value] of Object.entries(node.inputs)) {
          if (!isLink(value)) continue;
          for (const passed of trace(value).via) {
            if (!uses.has(passed)) uses.set(passed, []);
            uses.get(passed).push({ node: node.id, input });
          }
        }
      }
    }
    return uses.get(id) || [];
  };

  const consumersOf = (id) => {
    const found = [];
    for (const node of nodes.values()) {
      for (const [input, value] of Object.entries(node.inputs)) {
        if (isLink(value) && String(value[0]) === id) found.push({ node: node.id, input, slot: value[1] });
      }
    }
    return found;
  };

  const uiNodes = new Map();
  for (const node of workflow?.nodes || []) {
    if (isPlainObject(node) && node.id !== undefined) uiNodes.set(String(node.id), node);
  }

  return {
    prompt,
    workflow,
    nodes,
    reader,
    live,
    outputs,
    trace,
    usesOf,
    consumersOf,
    uiNodes,
    isLiteralSource,
  };
}

function classOf(graph, id) {
  return graph.nodes.get(id)?.classType ?? null;
}

// --- identity ------------------------------------------------------------------

// Why an input is part of what makes this generation this one, or null.
function identityReason(graph, nodeId, input, value, depth = 0) {
  if (OUTPUT_NAMES.has(input)) return 'output-name';
  if (SEED_NAME.test(input)) return 'seed';
  if (typeof value === 'string') {
    if (MEDIA_FILE.test(value)) return 'input-media';
    if (TEXT_NAME.test(input)) return 'text';
    if (wordCount(value) >= MIN_PROMPT_WORDS && !looksLikeJson(value)) return 'text';
  }
  // A primitive holding a seed or a prompt is identity through what it feeds.
  const node = graph.nodes.get(nodeId);
  if (depth === 0 && value !== undefined && !isLink(value) && node && graph.isLiteralSource(node)) {
    for (const use of graph.usesOf(nodeId)) {
      const reason = identityReason(graph, use.node, use.input, undefined, depth + 1);
      if (reason) return reason;
    }
  }
  return null;
}

// --- one pair ------------------------------------------------------------------

function fingerprintOf(graph) {
  return [...graph.nodes.values()].map((node) => `${node.id}:${node.classType}`).sort(compareIds);
}

function similarity(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const entry of a) if (b.has(entry)) shared += 1;
  const union = a.size + b.size - shared;
  return union ? shared / union : 1;
}

// The difference between a draft and its quality version, as operations.
function diffPair(draft, final) {
  const mapped = new Map(); // added id in the final -> the removed draft id it replaces
  const mapLinks = (value) => {
    if (isLink(value)) {
      const id = String(value[0]);
      return [mapped.get(id) ?? id, value[1]];
    }
    return value;
  };

  // Identity must match: a final with another seed or prompt is not a
  // re-render of this draft.
  const identityChanges = [];
  for (const id of draft.live) {
    const classType = classOf(draft, id);
    if (classOf(final, id) !== classType) continue;
    const before = draft.nodes.get(id).inputs;
    const after = final.nodes.get(id).inputs;
    for (const input of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (deepEqual(before[input], after[input])) continue;
      const reason =
        identityReason(draft, id, input, before[input]) || identityReason(final, id, input, after[input]);
      if (!reason) continue;
      if (reason !== 'output-name') {
        return failure(
          'RECIPE_NOT_SAME_GENERATION',
          `the final changes the ${reason} at ${classType} #${id}, so it is not a re-render of this draft`
        );
      }
      identityChanges.push({ node: id, class: classType, input, reason });
    }
  }

  const removed = [...draft.live].filter((id) => classOf(final, id) !== classOf(draft, id)).sort(compareIds);
  const added = [...final.live].filter((id) => classOf(draft, id) !== classOf(final, id)).sort(compareIds);

  // A node that vanished alongside an identical one that appeared is the same
  // node under a new id, not a change. Identical means the same class and the
  // same inputs once switches and primitives are followed to what they carry.
  const canonical = (graph, value) => {
    const traced = graph.trace(value);
    if (traced.source) return { source: [mapped.get(traced.source.nodeId) ?? traced.source.nodeId, traced.source.slot] };
    if (traced.unresolved) return { raw: mapLinks(value) };
    return { literal: traced.literal };
  };
  const sameNode = (removedId, addedId) => {
    const before = draft.nodes.get(removedId);
    const after = final.nodes.get(addedId);
    if (before.classType !== after.classType) return false;
    const names = new Set([...Object.keys(before.inputs), ...Object.keys(after.inputs)]);
    return [...names].every((name) =>
      deepEqual(canonical(draft, before.inputs[name]), canonical(final, after.inputs[name]))
    );
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const addedId of added) {
      if (mapped.has(addedId)) continue;
      const twin = removed.find(
        (removedId) => ![...mapped.values()].includes(removedId) && removedId !== addedId && sameNode(removedId, addedId)
      );
      if (twin) {
        mapped.set(addedId, twin);
        changed = true;
      }
    }
  }
  const swapped = new Set(mapped.values());
  const ops = [];

  const removals = new Map();
  for (const id of removed) {
    if (swapped.has(id)) continue;
    const node = draft.nodes.get(id);
    const consumers = [];
    for (const use of draft.consumersOf(id)) {
      if (!draft.live.has(use.node) || classOf(final, use.node) !== classOf(draft, use.node)) continue;
      const after = mapLinks(final.nodes.get(use.node).inputs[use.input]);
      let action = 'rewired';
      let through = null;
      if (after === undefined) {
        action = 'drop';
      } else if (isLink(after)) {
        through = Object.keys(node.inputs).find((input) => deepEqual(mapLinks(node.inputs[input]), after)) || null;
        if (through) action = 'through';
      }
      consumers.push({ node: use.node, class: classOf(draft, use.node), input: use.input, slot: use.slot, action, through });
    }
    const op = {
      kind: 'remove',
      node: id,
      class: node.classType,
      consumers: consumers.sort((a, b) => compareIds(a.node, b.node) || a.input.localeCompare(b.input)),
      uiMode: final.uiNodes.get(id)?.mode ?? null,
    };
    removals.set(id, op);
    ops.push(op);
  }

  for (const id of added) {
    if (mapped.has(id)) continue;
    const node = final.nodes.get(id);
    const inputs = {};
    for (const [input, value] of Object.entries(node.inputs)) inputs[input] = clone(mapLinks(value));
    const spec = { inputs };
    if (isPlainObject(final.prompt[id]?._meta)) spec._meta = clone(final.prompt[id]._meta);
    ops.push({ kind: 'add', node: id, class: node.classType, spec, uiMode: final.uiNodes.get(id)?.mode ?? 0 });
  }

  const ignored = [...identityChanges];
  const touched = new Set([...removed, ...added]);
  for (const id of [...new Set([...draft.live, ...final.live])].sort(compareIds)) {
    if (touched.has(id) || classOf(draft, id) !== classOf(final, id)) continue;
    const before = draft.nodes.get(id).inputs;
    const after = final.nodes.get(id).inputs;
    for (const input of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const from = before[input];
      const to = mapLinks(after[input]);
      if (deepEqual(from, to)) continue;
      if (identityReason(draft, id, input, from) || identityReason(final, id, input, after[input])) continue;
      // A consumer of a removed node rewired the way the removal implies is
      // part of that removal, not a change of its own.
      if (isLink(from) && removals.has(String(from[0]))) {
        const use = removals
          .get(String(from[0]))
          .consumers.find((consumer) => consumer.node === id && consumer.input === input);
        if (use && use.action !== 'rewired') continue;
      }
      // Rewired to something that carries the same thing: no change.
      if (from !== undefined && to !== undefined && deepEqual(canonical(draft, from), canonical(final, after[input]))) {
        continue;
      }
      const op = {
        kind: 'set',
        node: id,
        class: classOf(draft, id),
        input,
        from: clone(from),
        to: clone(to),
        unset: to === undefined,
        effects: effectsOf(draft, final, id, input),
      };
      // A new input goes where the example has it, before the same neighbour.
      if (from === undefined) {
        const order = Object.keys(after);
        op.before = order.slice(order.indexOf(input) + 1).find((name) => Object.hasOwn(before, name)) ?? null;
      }
      ops.push(op);
    }
  }

  // A pass-through node added only to carry what was already carried (a new
  // reroute) is dropped along with the rewiring it came with.
  const linkedTo = new Set(
    ops.filter((op) => op.kind === 'set' && isLink(op.to)).map((op) => String(op.to[0]))
  );
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index];
    if (op.kind === 'add' && !linkedTo.has(op.node) && final.reader.passThroughInput(final.nodes.get(op.node))) {
      ops.splice(index, 1);
    }
  }

  // UI-only changes: node modes and widget values the API prompt does not
  // show. Nodes the API ops touch get their mode from those ops, and widgets
  // of nodes in the final API prompt follow its values when applied.
  if (draft.workflow && final.workflow) {
    const opNodes = new Set(ops.filter((op) => op.kind !== 'set').map((op) => op.node));
    for (const [id, before] of draft.uiNodes) {
      const after = final.uiNodes.get(id);
      if (!after || after.type !== before.type || opNodes.has(id)) continue;
      if (after.mode !== before.mode) {
        ops.push({ kind: 'ui-mode', node: id, type: before.type, mode: after.mode });
      }
      const named = isPlainObject(after.widgets_values_named);
      if (named && final.nodes.has(id)) continue;
      const beforeValues = Array.isArray(before.widgets_values) ? before.widgets_values : [];
      const afterValues = Array.isArray(after.widgets_values) ? after.widgets_values : [];
      for (let index = 0; index < Math.max(beforeValues.length, afterValues.length); index += 1) {
        const value = afterValues[index];
        if (deepEqual(beforeValues[index], value) || index >= afterValues.length) continue;
        const name = named ? Object.keys(after.widgets_values_named)[index] ?? '' : '';
        if (identityReason(final, id, name, value)) continue;
        ops.push({ kind: 'ui-widget', node: id, type: before.type, index, value: clone(value) });
      }
    }
  }

  return { ops, ignored };
}

// What a changed input changes in the render: the inputs of real nodes it
// reaches (a primitive's consumers, or the input itself), rendered before and
// after with switches and primitives followed.
function effectsOf(draft, final, id, input) {
  const node = final.nodes.get(id);
  const targets = node && final.isLiteralSource(node) ? final.usesOf(id) : [{ node: id, input }];
  return targets.slice(0, DEFAULT_RECIPE_LIMITS.maxEffects).map((target) => {
    const before = draft.nodes.get(target.node)?.inputs[target.input];
    const after = final.nodes.get(target.node)?.inputs[target.input];
    const rendered = (graph, value) => {
      if (value === undefined) return null;
      const traced = graph.trace(value);
      return traced.source || traced.unresolved ? null : traced.literal;
    };
    return {
      node: target.node,
      class: classOf(final, target.node),
      input: target.input,
      from: rendered(draft, before),
      to: rendered(final, after),
    };
  });
}

// --- learning ----------------------------------------------------------------

const opKey = (op) => {
  if (op.kind === 'set') return `set:${op.node}:${op.input}`;
  if (op.kind === 'ui-widget') return `ui-widget:${op.node}:${op.index}`;
  return `${op.kind}:${op.node}`;
};

const REMOVED = Object.freeze({ removed: true });
const ABSENT = Object.freeze({ absent: true });
const wrap = (value) => (value === undefined ? ABSENT : { value: clone(value) });

function pairLabel(pair, index) {
  return typeof pair?.label === 'string' && pair.label ? pair.label : `pair ${index + 1}`;
}

// A two-pass final whose provenance says it is only the render pass, or a
// file named as the no-post-processing fallback.
function isFallbackExample(pair, label) {
  const provenance = isPlainObject(pair?.provenance) ? pair.provenance : null;
  return NOPOST_NAME.test(label) || (provenance?.passes === 'two' && provenance?.phase === 'render');
}

// Learn a recipe from two or more (draft, quality) pairs of one workflow.
// @returns {{ recipe }} or {{ error: { code, message, pair? } }}
function learnRecipe(pairs, options = {}) {
  const limits = { ...DEFAULT_COMFY_GENERATION_LIMITS, ...DEFAULT_RECIPE_LIMITS, ...(options.limits || {}) };
  if (!Array.isArray(pairs) || pairs.length < limits.minPairs) {
    return failure(
      'RECIPE_TOO_FEW_PAIRS',
      `A recipe needs at least ${limits.minPairs} example pairs, so what varies per clip can be told apart`
    );
  }
  if (pairs.length > limits.maxPairs) {
    return failure('RECIPE_TOO_MANY_PAIRS', `A recipe is learned from at most ${limits.maxPairs} pairs`);
  }

  const examples = [];
  for (const [index, pair] of pairs.entries()) {
    const label = pairLabel(pair, index);
    if (isFallbackExample(pair, label)) {
      return failure(
        'RECIPE_FALLBACK_EXAMPLE',
        `${label} is a fallback final without post-processing; it mixes the recipe with per-clip fallbacks`,
        { pair: index }
      );
    }
    let draft;
    let final;
    try {
      draft = openGraph(pair?.draft, limits);
      final = openGraph(pair?.final, limits);
    } catch (error) {
      return failure(error.code || 'RECIPE_UNREADABLE', `${label}: ${error.message}`, { pair: index });
    }
    const diff = diffPair(draft, final);
    if (diff.error) return failure(diff.error.code, `${label}: ${diff.error.message}`, { pair: index });
    examples.push({ label, draft, final, diff, fingerprint: fingerprintOf(draft) });
  }

  for (const [index, example] of examples.entries()) {
    if (index === 0) continue;
    const closest = Math.max(...examples.slice(0, index).map((other) => similarity(other.fingerprint, example.fingerprint)));
    if (closest < limits.minSimilarity) {
      return failure(
        'RECIPE_DIFFERENT_WORKFLOWS',
        `${example.label} is not the same workflow as the other examples (${Math.round(closest * 100)}% of nodes shared)`,
        { pair: index }
      );
    }
  }

  const groups = new Map();
  examples.forEach((example, index) => {
    for (const op of example.diff.ops) {
      const key = opKey(op);
      if (!groups.has(key)) groups.set(key, { key, template: op, byPair: new Map() });
      groups.get(key).byPair.set(index, op);
    }
  });
  if (groups.size > limits.maxOps) {
    return failure('RECIPE_TOO_LARGE', `The examples differ in more than ${limits.maxOps} places`);
  }

  const ops = [];
  for (const group of [...groups.values()].sort((a, b) => compareOps(a.template, b.template))) {
    ops.push(combine(group, examples));
  }
  for (const op of ops) {
    if (op.kind === 'set') op.candidates = candidatesFor(op, ops, examples);
  }

  const ignored = new Map();
  for (const example of examples) {
    for (const entry of example.diff.ignored) ignored.set(`${entry.node}:${entry.input}`, entry);
  }

  return {
    recipe: {
      kind: RECIPE_KIND,
      version: RECIPE_VERSION,
      name: typeof options.name === 'string' ? options.name : '',
      learnedFrom: examples.map((example) => example.label),
      minSimilarity: limits.minSimilarity,
      fingerprints: examples.map((example) => example.fingerprint),
      ops: ops.filter((op) => !op.kind.startsWith('ui-')),
      uiOps: ops.filter((op) => op.kind.startsWith('ui-')),
      ignored: [...ignored.values()].sort((a, b) => compareIds(a.node, b.node)),
    },
  };
}

const KIND_ORDER = ['remove', 'add', 'set', 'ui-mode', 'ui-widget'];
function compareOps(left, right) {
  return (
    KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind) ||
    compareIds(left.node, right.node) ||
    String(left.input ?? left.index ?? '').localeCompare(String(right.input ?? right.index ?? ''), 'en', { numeric: true })
  );
}

// One operation across every example: a constant when every pair it applies
// to ends at the same value, otherwise one that varies per clip.
function combine(group, examples) {
  const { template, byPair } = group;
  const id = group.key;
  const applicable = [];
  examples.forEach((example, index) => {
    const { draft, final } = example;
    let applies;
    let from;
    let to;
    if (template.kind === 'remove') {
      applies = classOf(draft, template.node) === template.class && draft.live.has(template.node);
      to = byPair.has(index) ? REMOVED : { kept: true };
    } else if (template.kind === 'add') {
      applies = !draft.nodes.has(template.node) || byPair.has(index);
      to = byPair.has(index) ? { added: true } : ABSENT;
    } else if (template.kind === 'set') {
      applies = classOf(draft, template.node) === template.class;
      from = wrap(draft.nodes.get(template.node)?.inputs[template.input]);
      to =
        classOf(final, template.node) === template.class
          ? byPair.has(index)
            ? wrap(byPair.get(index).unset ? undefined : byPair.get(index).to)
            : wrap(final.nodes.get(template.node).inputs[template.input])
          : REMOVED;
    } else {
      const before = draft.uiNodes.get(template.node);
      const after = final.uiNodes.get(template.node);
      applies = Boolean(draft.workflow && final.workflow && before?.type === template.type);
      const read = (node) =>
        template.kind === 'ui-mode' ? node?.mode : node?.widgets_values?.[template.index];
      from = wrap(read(before));
      to = after?.type === template.type ? wrap(read(after)) : REMOVED;
    }
    if (applies) applicable.push({ index, label: example.label, from, to });
  });

  const changed = applicable.filter((entry) => byPair.has(entry.index)).length;
  let constant = applicable.length > 0 && applicable.every((entry) => deepEqual(entry.to, applicable[0].to));
  const op = { id, ...clone(template) };
  if (template.kind === 'remove') {
    // Every pair must also rewire its consumers the same way.
    const shapes = [...byPair.values()].map((entry) => JSON.stringify(entry.consumers));
    if (new Set(shapes).size > 1) constant = false;
  }
  if (template.kind === 'add') {
    const specs = [...byPair.values()].map((entry) => entry.spec.inputs);
    op.variesInputs = Object.keys(template.spec.inputs).filter(
      (input) => !specs.every((inputs) => deepEqual(inputs[input], specs[0][input]))
    );
  }
  if (template.kind === 'set') {
    op.to = constant ? clone(applicable[0].to.value) : null;
    op.unset = constant && applicable[0].to === ABSENT;
  }
  if (template.kind === 'ui-mode') op.mode = constant ? applicable[0].to.value : null;
  if (template.kind === 'ui-widget') op.value = constant ? clone(applicable[0].to.value) : null;
  op.status = constant ? 'constant' : 'varies';
  op.evidence = { pairs: applicable.length, changed };
  if (!constant) {
    op.perPair = applicable.map(({ label, from, to }) => ({ label, ...(from ? { from } : {}), to }));
  }
  return op;
}

// --- candidate rules -------------------------------------------------------------

function roundLike(values) {
  const integers = values.every((value) => Number.isInteger(value));
  return (value) => (integers ? Math.round(value) : Math.round(value * 1000) / 1000);
}

const close = (left, right) => isNumber(left) && isNumber(right) && Math.abs(left - right) < 1e-9;

// Per-slot overrides as the MiniMax composer writes them: a JSON array whose
// entries are a number, null, or an object with an `mp` beside other
// settings. Once a slot's global is raised to `after`, an override above the
// old global and no higher than the new one would only hold that slot back,
// so it is cleared. Returns the value unchanged when it is not such a list.
function liftOverrides(raw, before, after) {
  if (typeof raw !== 'string' || !isNumber(before) || !isNumber(after) || after <= before) return raw;
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(entries)) return raw;
  let changed = false;
  const lifted = entries.map((entry) => {
    const mp = isPlainObject(entry) ? entry.mp : entry;
    if (!isNumber(mp) || !(before < mp && mp <= after)) return entry;
    changed = true;
    if (!isPlainObject(entry)) return null;
    const { mp: _cleared, ...rest } = entry;
    return Object.keys(rest).length ? rest : null;
  });
  return changed ? JSON.stringify(lifted) : raw;
}

function isOverrideList(value) {
  if (typeof value !== 'string' || !value.trim().startsWith('[')) return false;
  try {
    const entries = JSON.parse(value);
    return (
      Array.isArray(entries) &&
      entries.every((entry) => entry === null || isNumber(entry) || (isPlainObject(entry) && (entry.mp === undefined || isNumber(entry.mp))))
    );
  } catch {
    return false;
  }
}

// Rules offered for an input, each checked against every example pair. They
// are offers: nothing is applied unless the user picks one.
//   ratio        - a fixed share of another setting (the switch point is
//                  27/35 of steps);
//   preset-ratio - the draft graph's own ratio between the two settings
//                  (19/25 of steps, the quality preset it carries);
//   draft-ratio  - the ratio the draft rendered with (6/8 of steps);
//   lift-overrides - per-slot overrides cleared up to a sibling's new value.
function candidatesFor(op, ops, examples) {
  const candidates = [];
  const pairValues = (other) =>
    examples.map(({ draft, final }) => ({
      draftValue: draft.nodes.get(other.node)?.inputs[other.input],
      finalValue: final.nodes.get(other.node)?.inputs[other.input],
      rendered: renderedValue(draft, other),
    }));
  const mine = pairValues(op);
  const others = ops.filter((other) => other !== op && other.kind === 'set');
  const effectNodes = (entry) => new Set([entry.node, ...(entry.effects || []).map((effect) => effect.node)]);
  const related = (other) => {
    const theirs = effectNodes(other);
    return [...effectNodes(op)].some((node) => theirs.has(node));
  };

  const numeric = mine.every((entry) => isNumber(entry.draftValue) || entry.draftValue === undefined) &&
    mine.some((entry) => isNumber(entry.finalValue));
  if (numeric) {
    const round = roundLike(
      mine.flatMap((entry) => [entry.draftValue, entry.finalValue]).filter(isNumber)
    );
    for (const other of others) {
      if (other.status !== 'constant' || !isNumber(other.to) || !related(other)) continue;
      // A dependent is a share of what it follows, so the larger setting leads.
      if (op.status === 'constant' && isNumber(op.to) && Math.abs(op.to) > Math.abs(other.to)) continue;
      const theirs = pairValues(other);
      const check = (compute) =>
        mine.every((entry, index) => {
          if (entry.finalValue === undefined) return true;
          const value = compute(entry, theirs[index]);
          return isNumber(value) && close(round(value), entry.finalValue);
        });
      const label = other.effects?.[0]?.input || other.input;
      if (op.status === 'constant' && isNumber(op.to)) {
        const ratio = op.to / other.to;
        candidates.push({
          id: `ratio:${other.id}`,
          kind: 'ratio',
          of: other.id,
          ratio,
          label: `${op.to}/${other.to} of ${label}`,
          fits: check((entry, their) => their.finalValue * ratio),
        });
      }
      const first = mine[0];
      const theirFirst = theirs[0];
      if (isNumber(first.draftValue) && isNumber(theirFirst.draftValue) && theirFirst.draftValue !== 0) {
        candidates.push({
          id: `preset-ratio:${other.id}`,
          kind: 'preset-ratio',
          of: other.id,
          label: `the draft's own ${first.draftValue}/${theirFirst.draftValue} of ${label}`,
          fits: check((entry, their) =>
            isNumber(entry.draftValue) && isNumber(their.draftValue) && their.draftValue !== 0
              ? (entry.draftValue / their.draftValue) * their.finalValue
              : null
          ),
        });
      }
      if (
        isNumber(first.rendered) &&
        isNumber(theirFirst.rendered) &&
        theirFirst.rendered !== 0 &&
        (first.rendered !== first.draftValue || theirFirst.rendered !== theirFirst.draftValue)
      ) {
        candidates.push({
          id: `draft-ratio:${other.id}`,
          kind: 'draft-ratio',
          of: other.id,
          label: `the rendered ${first.rendered}/${theirFirst.rendered} of ${label}`,
          fits: check((entry, their) =>
            isNumber(entry.rendered) && isNumber(their.rendered) && their.rendered !== 0
              ? (entry.rendered / their.rendered) * their.finalValue
              : null
          ),
        });
      }
    }
  }

  if (mine.some((entry) => isOverrideList(entry.draftValue))) {
    for (const other of others) {
      if (other.node !== op.node) continue;
      const theirs = pairValues(other);
      if (!theirs.some((entry) => isNumber(entry.finalValue))) continue;
      candidates.push({
        id: `lift-overrides:${other.id}`,
        kind: 'lift-overrides',
        of: other.id,
        label: `overrides above the old ${other.input} and up to the new one cleared`,
        fits: mine.every((entry, index) => {
          if (entry.finalValue === undefined) return true;
          const lifted = liftOverrides(entry.draftValue, theirs[index].draftValue, theirs[index].finalValue);
          return lifted === entry.finalValue || jsonEqual(lifted, entry.finalValue);
        }),
      });
    }
  }

  return candidates.sort((a, b) => Number(b.fits) - Number(a.fits));
}

function jsonEqual(left, right) {
  try {
    return deepEqual(JSON.parse(left), JSON.parse(right));
  } catch {
    return false;
  }
}

// What a set op's first effect rendered with in this draft.
function renderedValue(graph, op) {
  const effect = op.effects?.[0] || { node: op.node, input: op.input };
  const value = graph.nodes.get(effect.node)?.inputs[effect.input];
  if (value === undefined) return undefined;
  const traced = graph.trace(value);
  return traced.source || traced.unresolved ? undefined : traced.literal;
}

// --- matching -------------------------------------------------------------------

function checkRecipe(recipe) {
  if (!isPlainObject(recipe) || recipe.kind !== RECIPE_KIND || recipe.version !== RECIPE_VERSION) {
    return 'Not a recipe this version of Video Swarm can read';
  }
  if (!Array.isArray(recipe.ops) || !Array.isArray(recipe.fingerprints)) return 'The recipe is incomplete';
  return null;
}

function matchGraph(recipe, draft) {
  const fingerprint = fingerprintOf(draft);
  const score = Math.max(0, ...recipe.fingerprints.map((entry) => similarity(entry, fingerprint)));
  const minimum = isNumber(recipe.minSimilarity) ? recipe.minSimilarity : DEFAULT_RECIPE_LIMITS.minSimilarity;
  if (score < minimum) {
    return {
      matched: false,
      similarity: score,
      reason: `Not the recipe's workflow: ${Math.round(score * 100)}% of its nodes match`,
    };
  }
  const removing = new Set(recipe.ops.filter((op) => op.kind === 'remove').map((op) => op.node));
  const adding = new Set(recipe.ops.filter((op) => op.kind === 'add').map((op) => op.node));
  for (const op of recipe.ops) {
    const actual = classOf(draft, op.node);
    if (op.kind === 'add') {
      if (actual !== null && !removing.has(op.node)) {
        return { matched: false, similarity: score, reason: `Node ${op.node} is already a ${actual}; the recipe adds a ${op.class} there` };
      }
      for (const value of Object.values(op.spec.inputs)) {
        const target = isLink(value) ? String(value[0]) : null;
        if (target && !draft.nodes.has(target) && !adding.has(target)) {
          return { matched: false, similarity: score, reason: `The ${op.class} the recipe adds takes input from node ${target}, which this workflow does not have` };
        }
      }
      continue;
    }
    if (actual === null) {
      return { matched: false, similarity: score, reason: `No ${op.class} at node ${op.node}` };
    }
    if (actual !== op.class) {
      return { matched: false, similarity: score, reason: `Node ${op.node} is a ${actual}, not the ${op.class} the recipe changes` };
    }
  }
  return { matched: true, similarity: score, reason: null };
}

// Whether a recipe fits a draft, and if not, which node is missing or wrong.
function matchRecipe(recipe, draftSide, options = {}) {
  const invalid = checkRecipe(recipe);
  if (invalid) return { matched: false, similarity: 0, reason: invalid };
  const limits = { ...DEFAULT_COMFY_GENERATION_LIMITS, ...DEFAULT_RECIPE_LIMITS, ...(options.limits || {}) };
  let draft;
  try {
    draft = openGraph(draftSide, limits);
  } catch (error) {
    return { matched: false, similarity: 0, reason: error.message };
  }
  return matchGraph(recipe, draft);
}

// --- applying -------------------------------------------------------------------

function uiLinks(workflow) {
  const links = new Map();
  for (const link of workflow?.links || []) {
    if (Array.isArray(link) && link.length >= 5) {
      links.set(link[0], { origin: String(link[1]), slot: link[2] });
    } else if (isPlainObject(link) && link.id !== undefined) {
      links.set(link.id, { origin: String(link.origin_id), slot: link.origin_slot });
    }
  }
  return links;
}

// Decide every operation's value for this draft: constants as learned,
// settings where the user changed one, and varying ones kept at the draft's
// value unless a value or candidate rule was chosen.
function decide(recipe, draft, options) {
  const choices = isPlainObject(options.choices) ? options.choices : {};
  const settings = isPlainObject(options.settings) ? options.settings : {};
  const byId = new Map([...recipe.ops, ...(recipe.uiOps || [])].map((op) => [op.id, op]));
  const decided = new Map();

  const valueOf = (op, stack = []) => {
    if (decided.has(op.id)) return decided.get(op.id);
    if (stack.includes(op.id)) throw new ComfyRecipeError('RECIPE_RULE_CYCLE', `Rules for ${op.id} depend on each other`);
    const choice = isPlainObject(choices[op.id]) ? choices[op.id] : {};
    let result = { apply: op.status === 'constant' };
    if (choice.keep) {
      result = { apply: false };
    } else if (op.kind === 'remove' || op.kind === 'add') {
      result = { apply: op.status === 'constant' || choice.apply === true };
    } else if (op.kind === 'set' || op.kind === 'ui-widget' || op.kind === 'ui-mode') {
      const learned = op.kind === 'set' ? op.to : op.kind === 'ui-mode' ? op.mode : op.value;
      if (Object.hasOwn(choice, 'value')) {
        result = { apply: true, value: clone(choice.value) };
      } else if (choice.candidate && op.kind === 'set') {
        result = { apply: true, value: fromCandidate(op, choice.candidate, stack) };
      } else if (op.status === 'constant' && Object.hasOwn(settings, op.id)) {
        result = { apply: true, value: clone(settings[op.id]) };
      } else if (op.status === 'constant') {
        result = { apply: true, value: clone(learned), unset: Boolean(op.unset) };
      } else {
        result = { apply: false };
      }
    }
    decided.set(op.id, result);
    return result;
  };

  const fromCandidate = (op, candidateId, stack) => {
    const candidate = (op.candidates || []).find((entry) => entry.id === candidateId);
    const other = candidate && byId.get(candidate.of);
    if (!candidate || !other) {
      throw new ComfyRecipeError('RECIPE_UNKNOWN_RULE', `${op.id} has no rule ${candidateId}`);
    }
    const otherDecision = valueOf(other, [...stack, op.id]);
    const otherDraft = draft.nodes.get(other.node)?.inputs[other.input];
    const otherValue = otherDecision.apply ? otherDecision.value : otherDraft;
    const draftValue = draft.nodes.get(op.node)?.inputs[op.input];
    const round = roundLike([draftValue, op.to, ...(op.perPair || []).map((entry) => entry.to?.value)].filter(isNumber));
    let value = null;
    if (candidate.kind === 'ratio') value = round(otherValue * candidate.ratio);
    if (candidate.kind === 'preset-ratio' && isNumber(draftValue) && isNumber(otherDraft) && otherDraft !== 0) {
      value = round((draftValue / otherDraft) * otherValue);
    }
    if (candidate.kind === 'draft-ratio') {
      const mine = renderedValue(draft, op);
      const theirs = renderedValue(draft, other);
      if (isNumber(mine) && isNumber(theirs) && theirs !== 0) value = round((mine / theirs) * otherValue);
    }
    if (candidate.kind === 'lift-overrides') value = liftOverrides(draftValue, otherDraft, otherValue);
    if (value === null || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new ComfyRecipeError('RECIPE_RULE_UNUSABLE', `The rule ${candidate.label} cannot be worked out for this draft`);
    }
    return value;
  };

  for (const op of byId.values()) valueOf(op);
  return decided;
}

function setInput(node, input, value, before) {
  if (Object.hasOwn(node.inputs, input) || !before || !Object.hasOwn(node.inputs, before)) {
    node.inputs[input] = value;
    return;
  }
  const entries = Object.entries(node.inputs);
  const at = entries.findIndex(([name]) => name === before);
  entries.splice(at, 0, [input, value]);
  node.inputs = Object.fromEntries(entries);
}

function rewireRemoval(prompt, op, removedInputs) {
  for (const [id, node] of Object.entries(prompt)) {
    if (!isPlainObject(node?.inputs)) continue;
    for (const [input, value] of Object.entries(node.inputs)) {
      if (!isLink(value) || String(value[0]) !== op.node) continue;
      const recorded = op.consumers.find((entry) => entry.node === id && entry.input === input);
      const sameSlot = op.consumers.filter((entry) => entry.slot === value[1] && entry.action !== 'rewired');
      const uniform =
        sameSlot.length && sameSlot.every((entry) => entry.action === sameSlot[0].action && entry.through === sameSlot[0].through)
          ? sameSlot[0]
          : null;
      const rule = recorded && recorded.action !== 'rewired' ? recorded : uniform;
      if (recorded?.action === 'rewired') continue; // a set op carries it
      if (!rule) {
        throw new ComfyRecipeError(
          'RECIPE_REWIRE_UNKNOWN',
          `Cannot tell how to rewire ${node.class_type} #${id} (${input}) when removing ${op.class} #${op.node}`
        );
      }
      if (rule.action === 'drop') {
        delete node.inputs[input];
      } else {
        const upstream = removedInputs[rule.through];
        if (upstream === undefined) {
          throw new ComfyRecipeError(
            'RECIPE_REWIRE_UNKNOWN',
            `${op.class} #${op.node} has no ${rule.through} input to pass through`
          );
        }
        node.inputs[input] = clone(upstream);
      }
    }
  }
}

// Rebuild an added node from the draft's UI graph, where it sits bypassed or
// muted: its widgets from widgets_values_named (the API's own input names),
// its links from the UI links. Only inputs the example's node had are kept.
function rebuildFromUi(op, draft, prompt) {
  const uiNode = draft.uiNodes.get(op.node);
  if (!uiNode || uiNode.type !== op.class || !DISABLED_MODES.has(uiNode.mode)) return null;
  const named = isPlainObject(uiNode.widgets_values_named) ? uiNode.widgets_values_named : null;
  if (!named && Array.isArray(uiNode.widgets_values) && uiNode.widgets_values.length) return null;
  const links = uiLinks(draft.workflow);
  const inputs = {};
  for (const input of Object.keys(op.spec.inputs)) {
    if (named && Object.hasOwn(named, input)) inputs[input] = clone(named[input]);
  }
  for (const slot of Array.isArray(uiNode.inputs) ? uiNode.inputs : []) {
    const link = links.get(slot?.link);
    if (!link || !Object.hasOwn(op.spec.inputs, slot.name)) continue;
    if (!Object.hasOwn(prompt, link.origin)) return { pending: link.origin };
    inputs[slot.name] = [link.origin, link.slot];
  }
  for (const [input, value] of Object.entries(op.spec.inputs)) {
    if (Object.hasOwn(inputs, input)) continue;
    if (op.variesInputs?.includes(input) || isLink(value)) {
      throw new ComfyRecipeError(
        'RECIPE_ADD_UNKNOWN',
        `Cannot rebuild ${op.class} #${op.node}: its ${input} is not in the draft's UI graph`
      );
    }
    inputs[input] = clone(value);
  }
  return { node: { inputs, class_type: op.class, _meta: clone(op.spec._meta) || { title: uiNode.title || op.class } } };
}

function addNode(op, draft, prompt) {
  const rebuilt = rebuildFromUi(op, draft, prompt);
  if (rebuilt) return rebuilt;
  if (op.variesInputs?.length) {
    throw new ComfyRecipeError(
      'RECIPE_ADD_UNKNOWN',
      `Cannot add ${op.class} #${op.node}: its ${op.variesInputs[0]} differs between the examples and the draft does not have the node`
    );
  }
  for (const value of Object.values(op.spec.inputs)) {
    if (isLink(value) && !Object.hasOwn(prompt, String(value[0]))) return { pending: String(value[0]) };
  }
  const node = { inputs: clone(op.spec.inputs), class_type: op.class };
  if (op.spec._meta) node._meta = clone(op.spec._meta);
  return { node };
}

function applyUi(recipe, draft, prompt, decided, applied) {
  if (!draft.workflow) return { workflow: null, issue: 'The draft has no UI workflow' };
  const workflow = clone(draft.workflow);
  const nodes = new Map();
  for (const node of workflow.nodes) {
    if (isPlainObject(node) && node.id !== undefined) nodes.set(String(node.id), node);
  }
  const setWidget = (node, index, value, previous) => {
    node.widgets_values[index] = clone(value);
    const named = node.widgets_values_named;
    const key = isPlainObject(named) ? Object.keys(named)[index] : undefined;
    if (key !== undefined && deepEqual(named[key], previous)) named[key] = clone(value);
  };

  for (const op of recipe.uiOps || []) {
    const decision = decided.get(op.id);
    if (!decision?.apply) continue;
    const node = nodes.get(op.node);
    if (!node || node.type !== op.type) {
      return { workflow: null, issue: `The UI workflow has no ${op.type} at node ${op.node}` };
    }
    if (op.kind === 'ui-mode') node.mode = decision.value;
    if (op.kind === 'ui-widget') {
      if (!Array.isArray(node.widgets_values) || op.index >= node.widgets_values.length) {
        return { workflow: null, issue: `${op.type} #${op.node} has no widget ${op.index} in the UI workflow` };
      }
      setWidget(node, op.index, decision.value, node.widgets_values[op.index]);
    }
  }
  for (const op of recipe.ops) {
    if (!applied.has(op.id) || (op.kind !== 'remove' && op.kind !== 'add')) continue;
    const node = nodes.get(op.node);
    if (node && node.type === op.class && op.uiMode !== null && op.uiMode !== undefined) node.mode = op.uiMode;
  }
  // Widgets follow the API prompt wherever the node names its widgets and
  // its positional widget still holds the draft's value, so per-clip values
  // (a rule's result, a changed setting) show in the UI too. The named copy
  // only says which slot is which: the standalone app left it stale on
  // primitives, so it is not required to agree.
  for (const [id, after] of Object.entries(prompt)) {
    const before = draft.prompt[id];
    const node = nodes.get(id);
    if (!before || !node || node.type !== after.class_type || !isPlainObject(node.widgets_values_named)) continue;
    const keys = Object.keys(node.widgets_values_named);
    for (const [input, value] of Object.entries(after.inputs || {})) {
      const previous = before.inputs?.[input];
      if (isLink(value) || deepEqual(previous, value)) continue;
      const index = keys.indexOf(input);
      const original = draft.uiNodes.get(id);
      if (
        index < 0 ||
        !Array.isArray(node.widgets_values) ||
        index >= node.widgets_values.length ||
        !deepEqual(original?.widgets_values?.[index], previous)
      ) {
        continue;
      }
      setWidget(node, index, value, node.widgets_values[index]);
      node.widgets_values_named[input] = clone(value);
    }
  }
  return { workflow, issue: null };
}

// Apply a recipe to a draft: the API prompt to queue, and the UI workflow
// with the example's node modes and changed widgets so the result reopens as
// it rendered. The draft is never modified.
// @returns {{ prompt, workflow, workflowIssue, applied, kept, values }} or {{ error }}
function applyRecipe(recipe, draftSide, options = {}) {
  const invalid = checkRecipe(recipe);
  if (invalid) return failure('RECIPE_INVALID', invalid);
  const limits = { ...DEFAULT_COMFY_GENERATION_LIMITS, ...DEFAULT_RECIPE_LIMITS, ...(options.limits || {}) };
  let draft;
  try {
    draft = openGraph(draftSide, limits);
  } catch (error) {
    return failure(error.code || 'RECIPE_UNREADABLE', error.message);
  }
  const match = matchGraph(recipe, draft);
  if (!match.matched) return failure('RECIPE_NO_MATCH', match.reason);

  try {
    const decided = decide(recipe, draft, options);
    const prompt = clone(draft.prompt);
    const applied = new Set();
    const values = {};

    for (const op of recipe.ops) {
      if (op.kind !== 'remove' || !decided.get(op.id).apply) continue;
      const removedInputs = prompt[op.node].inputs;
      delete prompt[op.node];
      rewireRemoval(prompt, op, removedInputs);
      applied.add(op.id);
    }
    const pending = recipe.ops.filter((op) => op.kind === 'add' && decided.get(op.id).apply);
    while (pending.length) {
      const before = pending.length;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const result = addNode(pending[index], draft, prompt);
        if (result.pending) continue;
        prompt[pending[index].node] = result.node;
        applied.add(pending[index].id);
        pending.splice(index, 1);
      }
      if (pending.length === before) {
        throw new ComfyRecipeError(
          'RECIPE_ADD_UNKNOWN',
          `Cannot add ${pending[0].class} #${pending[0].node}: what feeds it is missing`
        );
      }
    }
    for (const op of recipe.ops) {
      if (op.kind !== 'set') continue;
      const decision = decided.get(op.id);
      if (!decision.apply) continue;
      const node = prompt[op.node];
      if (!node) {
        throw new ComfyRecipeError('RECIPE_TARGET_REMOVED', `${op.class} #${op.node} was removed before its ${op.input} could be set`);
      }
      if (decision.unset) {
        delete node.inputs[op.input];
      } else {
        if (isLink(decision.value) && !Object.hasOwn(prompt, String(decision.value[0]))) {
          throw new ComfyRecipeError(
            'RECIPE_TARGET_MISSING',
            `${op.class} #${op.node} (${op.input}) would take input from node ${decision.value[0]}, which is not in the result`
          );
        }
        setInput(node, op.input, clone(decision.value), op.before);
      }
      values[op.id] = clone(decision.value);
      applied.add(op.id);
    }
    if (typeof options.filenamePrefix === 'string' && options.filenamePrefix) {
      for (const id of draft.outputs) {
        const inputs = prompt[id]?.inputs;
        for (const name of OUTPUT_PREFIX_NAMES) {
          if (typeof inputs?.[name] === 'string') inputs[name] = options.filenamePrefix;
        }
      }
    }
    for (const op of recipe.uiOps || []) if (decided.get(op.id)?.apply) applied.add(op.id);

    const ui = applyUi(recipe, draft, prompt, decided, applied);
    const kept = [...recipe.ops, ...(recipe.uiOps || [])]
      .filter((op) => op.status === 'varies' && !applied.has(op.id))
      .map((op) => op.id);
    return {
      prompt,
      workflow: ui.workflow,
      workflowIssue: ui.issue,
      applied: [...applied],
      kept,
      values,
    };
  } catch (error) {
    if (error instanceof ComfyRecipeError) return failure(error.code, error.message);
    throw error;
  }
}

// --- example sources ------------------------------------------------------------

// A pair from a standalone comfy-requeue final: its own `prompt` and
// `workflow` tags, and the draft's graphs in its `requeue` provenance tag.
// @param tags the container's format tags (ffprobe `format.tags`)
function pairFromRequeueTags(tags, label = '') {
  if (!isPlainObject(tags) || typeof tags.prompt !== 'string' || typeof tags.requeue !== 'string') {
    return failure('RECIPE_NOT_A_FINAL', `${label || 'This file'} carries no requeue provenance`);
  }
  let provenance;
  try {
    provenance = parseComfyGraphJson(tags.requeue);
  } catch {
    return failure('RECIPE_NOT_A_FINAL', `${label || 'This file'} has an unreadable requeue tag`);
  }
  if (!isPlainObject(provenance) || !provenance.source_prompt) {
    return failure('RECIPE_NOT_A_FINAL', `${label || 'This file'} does not carry its draft's prompt`);
  }
  const pair = {
    label,
    provenance: { passes: provenance.passes ?? null, phase: provenance.phase ?? null },
    draft: { prompt: provenance.source_prompt, workflow: provenance.source_workflow ?? null },
    final: { prompt: tags.prompt, workflow: tags.workflow ?? null },
  };
  if (isFallbackExample(pair, label)) {
    return failure(
      'RECIPE_FALLBACK_EXAMPLE',
      `${label || 'This file'} is a fallback final without post-processing; it mixes the recipe with per-clip fallbacks`
    );
  }
  return { pair };
}

module.exports = {
  ComfyRecipeError,
  DEFAULT_RECIPE_LIMITS,
  RECIPE_KIND,
  RECIPE_VERSION,
  applyRecipe,
  learnRecipe,
  liftOverrides,
  matchRecipe,
  pairFromRequeueTags,
};
