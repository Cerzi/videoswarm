const crypto = require("crypto");

// Tag suggestions (docs/architecture/prompt-search-and-tag-suggestions.md,
// Section 2).
//
// For each tag the user has applied to enough clips, learn which prompt words
// and weight files go with it, and suggest it for clips that do not carry it
// yet. Plain counting (naive Bayes over word sets) on data the app already
// reads: no network and no model files. Prompt words stay numbered in memory
// (prompt-similarity.js); callers send catalog rows or prompt keys and get
// back tag names.
//
// - A prompt, not a clip, is one example: a batch of twenty clips from one
//   prompt must not outvote everything else.
// - A prompt is an example of a tag when one of its clips carries the tag or
//   a tag under it, and an example against it when one of its clips carries
//   other tags and none of these, or the user turned the suggestion down.
//   Clips with no tags say nothing: the user may simply not have got to them.
// - Each tag is tried on prompts held back from its learning (five folds, by
//   prompt) and suggested only above the score at which it was right at least
//   8 times in 10 there. Tags a prompt cannot tell, such as "keeper", fail
//   this and are never suggested.

const TAG_SUGGESTION_LIMITS = Object.freeze({
  // Prompts with the tag, and tagged prompts without it.
  minExamples: 10,
  minCounterExamples: 10,
  // On held-back prompts, at the score a suggestion needs.
  minPrecision: 0.8,
  minHits: 3,
  folds: 5,
  // A feature counts once this many of the prompts learned from have it,
  // and only when chance would lean it this far toward or away from the tag
  // at most this often (a one-sided Fisher exact test). Libraries have tens
  // of thousands of words; most that sit on a few tagged prompts do so by
  // chance, and naive Bayes trusts each of them.
  minSupport: 2,
  maxChance: 0.001,
  smoothing: 1,
  maxSuggestions: 3,
  maxTrainingKeys: 20_000,
  maxTags: 200,
  maxTagDepth: 8,
});

function defaultYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The tag tree from `{ id, name, parentId }` rows. */
function buildTagTree(tags, maxDepth = TAG_SUGGESTION_LIMITS.maxTagDepth) {
  const parentOf = new Map();
  const names = new Map();
  for (const tag of Array.isArray(tags) ? tags : []) {
    names.set(tag.id, tag.name);
    if (tag.parentId != null && tag.parentId !== tag.id) parentOf.set(tag.id, tag.parentId);
  }
  const ancestors = new Map();
  /** The tags above `id`, nearest first. */
  const ancestorsOf = (id) => {
    if (ancestors.has(id)) return ancestors.get(id);
    const found = [];
    const seen = new Set([id]);
    let current = parentOf.get(id);
    while (current != null && !seen.has(current) && found.length < maxDepth) {
      found.push(current);
      seen.add(current);
      current = parentOf.get(current);
    }
    ancestors.set(id, found);
    return found;
  };
  /** Every tag a clip with these tags counts under: each, and all above it. */
  const memberOf = (tagIds) => {
    const member = new Set();
    for (const id of tagIds) {
      member.add(id);
      for (const above of ancestorsOf(id)) member.add(above);
    }
    return member;
  };
  return { names, ancestorsOf, memberOf };
}

/**
 * Examples for each tag from the library's tags and turned-down suggestions.
 * `links` and `dismissals` are `{ promptKey, fingerprint, tagId }` rows of
 * present clips. Returns the tags with at least `minExamples` prompts, most
 * first: `{ tagId, positives, negatives }` with arrays of prompt keys.
 */
function collectTagExamples({ links, dismissals, tree, limits = TAG_SUGGESTION_LIMITS }) {
  const clips = new Map();
  const clipOf = ({ promptKey, fingerprint }) => {
    let clip = clips.get(fingerprint);
    if (!clip) {
      clip = { key: promptKey, own: new Set(), dismissed: new Set() };
      clips.set(fingerprint, clip);
    }
    return clip;
  };
  for (const row of links || []) clipOf(row).own.add(row.tagId);
  for (const row of dismissals || []) clipOf(row).dismissed.add(row.tagId);

  const positives = new Map();
  for (const clip of clips.values()) {
    for (const tagId of tree.memberOf(clip.own)) {
      if (!positives.has(tagId)) positives.set(tagId, new Set());
      positives.get(tagId).add(clip.key);
    }
  }
  const eligible = [...positives]
    .filter(([, keys]) => keys.size >= limits.minExamples)
    .sort((a, b) => b[1].size - a[1].size || a[0] - b[0])
    .slice(0, limits.maxTags);

  return eligible.map(([tagId, withTag]) => {
    const above = new Set(tree.ancestorsOf(tagId));
    const against = new Set();
    for (const clip of clips.values()) {
      if (withTag.has(clip.key)) continue;
      if (clip.dismissed.has(tagId)) {
        against.add(clip.key);
        continue;
      }
      if (clip.own.size === 0) continue;
      // A clip tagged only "dance" says nothing about "bellydance".
      let vague = false;
      for (const id of clip.own) {
        if (above.has(id)) {
          vague = true;
          break;
        }
      }
      if (!vague) against.add(clip.key);
    }
    return { tagId, positives: [...withTag].sort(), negatives: [...against].sort() };
  });
}

/** A prompt key's fold, by a hash of the key, so each prompt keeps its fold. */
function foldOfKey(key, folds = TAG_SUGGESTION_LIMITS.folds) {
  const text = String(key);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % folds;
}

function logFactorials(count) {
  const table = new Float64Array(count + 1);
  for (let index = 2; index <= count; index += 1) {
    table[index] = table[index - 1] + Math.log(index);
  }
  return table;
}

/**
 * How likely chance alone would put a feature on at least `withTag` (or, for
 * a feature leaning away, at most `withTag`) of `withAll` prompts with a tag,
 * given it is on `withTag + against` of all of them: a one-sided Fisher exact
 * test. Stops summing once the answer is clearly above `limit`.
 */
function chanceOfLeaning(withTag, against, withAll, againstAll, logFactorial, limit) {
  const total = withAll + againstAll;
  const present = withTag + against;
  const choose = (n, k) => logFactorial[n] - logFactorial[k] - logFactorial[n - k];
  const denominator = choose(total, present);
  const term = (x) => Math.exp(choose(withAll, x) + choose(againstAll, present - x) - denominator);
  const leansToward = withTag * total >= present * withAll;
  const from = leansToward ? withTag : Math.max(0, present - againstAll);
  const to = leansToward ? Math.min(present, withAll) : withTag;
  let chance = 0;
  // Sum from the observed count outward, where terms shrink.
  if (leansToward) {
    for (let x = from; x <= to; x += 1) {
      const value = term(x);
      chance += value;
      if (chance > limit || value < chance * 1e-9) break;
    }
  } else {
    for (let x = to; x >= from; x -= 1) {
      const value = term(x);
      chance += value;
      if (chance > limit || value < chance * 1e-9) break;
    }
  }
  return chance;
}

/**
 * One tag's model from its example prompts. `featuresOf(key)` returns a
 * prompt's sorted feature numbers, or nothing when it could not be read.
 * Returns `{ usable: false, examples }` when held-back prompts never reach the
 * precision asked for, and otherwise
 * `{ usable: true, examples, prior, weights, threshold, precision, recall }`.
 */
function trainTagModel({
  positives,
  negatives,
  featuresOf,
  foldOf = foldOfKey,
  limits = TAG_SUGGESTION_LIMITS,
}) {
  const folds = limits.folds;
  const alpha = limits.smoothing;
  // The features these examples use, numbered from zero.
  const local = new Map();
  const rows = [];
  const add = (key, positive) => {
    const features = featuresOf(key);
    if (!features || features.length === 0) return;
    const mapped = new Int32Array(features.length);
    for (let index = 0; index < features.length; index += 1) {
      let id = local.get(features[index]);
      if (id === undefined) {
        id = local.size;
        local.set(features[index], id);
      }
      mapped[index] = id;
    }
    rows.push({ features: mapped, fold: foldOf(key, folds), positive });
  };
  for (const key of positives) add(key, true);
  for (const key of negatives) add(key, false);

  const size = local.size;
  const withCounts = new Int32Array(size * folds);
  const againstCounts = new Int32Array(size * folds);
  const withPerFold = new Int32Array(folds);
  const againstPerFold = new Int32Array(folds);
  for (const row of rows) {
    const counts = row.positive ? withCounts : againstCounts;
    (row.positive ? withPerFold : againstPerFold)[row.fold] += 1;
    for (const feature of row.features) counts[feature * folds + row.fold] += 1;
  }
  const sum = (array) => array.reduce((total, value) => total + value, 0);
  const examples = sum(withPerFold);
  const counterExamples = sum(againstPerFold);
  if (examples < limits.minExamples || counterExamples < limits.minCounterExamples) {
    return { usable: false, examples };
  }
  const withTotal = new Int32Array(size);
  const againstTotal = new Int32Array(size);
  for (let feature = 0; feature < size; feature += 1) {
    for (let fold = 0; fold < folds; fold += 1) {
      withTotal[feature] += withCounts[feature * folds + fold];
      againstTotal[feature] += againstCounts[feature * folds + fold];
    }
  }
  // A feature seen too rarely in what was learned from, or no more often
  // with the tag than chance would put it there, carries no weight; so a word
  // unseen in learning cannot shift a held-back score either.
  const logFactorial = logFactorials(examples + counterExamples);
  const weight = (withTag, against, withAll, againstAll) =>
    withTag + against < limits.minSupport ||
    chanceOfLeaning(withTag, against, withAll, againstAll, logFactorial, limits.maxChance) >
      limits.maxChance
      ? 0
      : Math.log((withTag + alpha) / (withAll + 2 * alpha)) -
        Math.log((against + alpha) / (againstAll + 2 * alpha));

  const scored = rows.map((row) => {
    const fold = row.fold;
    const withAll = examples - withPerFold[fold];
    const againstAll = counterExamples - againstPerFold[fold];
    let score = Math.log((withAll + alpha) / (againstAll + alpha));
    for (const feature of row.features) {
      const at = feature * folds + fold;
      score += weight(
        withTotal[feature] - withCounts[at],
        againstTotal[feature] - againstCounts[at],
        withAll,
        againstAll
      );
    }
    return { score, positive: row.positive };
  });
  scored.sort((a, b) => b.score - a.score);

  // The lowest score at which held-back suggestions were still right often
  // enough: as many suggestions as that precision allows. Only a score that
  // finds another example can be chosen; going lower without one would only
  // add wrong suggestions while precision stays above the bar. Any bar
  // between that score and the next lower one is as right on held-back
  // prompts, so it sits halfway, leaving new prompts room on both sides.
  let hits = 0;
  let misses = 0;
  let chosen = null;
  for (let index = 0; index < scored.length; ) {
    const score = scored[index].score;
    let found = false;
    while (index < scored.length && scored[index].score === score) {
      if (scored[index].positive) {
        hits += 1;
        found = true;
      } else {
        misses += 1;
      }
      index += 1;
    }
    const precision = hits / (hits + misses);
    if (found && hits >= limits.minHits && precision >= limits.minPrecision) {
      const next = index < scored.length ? scored[index].score : score;
      chosen = { threshold: (score + next) / 2, precision, recall: hits / examples };
    }
  }
  if (!chosen) return { usable: false, examples };

  const weights = new Map();
  for (const [feature, id] of local) {
    const value = weight(withTotal[id], againstTotal[id], examples, counterExamples);
    if (value !== 0) weights.set(feature, value);
  }
  return {
    usable: true,
    examples,
    prior: Math.log((examples + alpha) / (counterExamples + alpha)),
    weights,
    ...chosen,
  };
}

function scoreFeatures(model, features) {
  let score = model.prior;
  for (const feature of features) {
    const value = model.weights.get(feature);
    if (value !== undefined) score += value;
  }
  return score;
}

/**
 * Suggestions for clips: the usable tags whose score passes, that the clip
 * does not already count under and whose suggestion it has not turned down,
 * strongest first and at most `maxSuggestions`. A tag is left out when one
 * under it is suggested too, which says more.
 * `targets` are `{ id, promptKey, tagIds, dismissedTagIds }`.
 * Returns a Map of target id to `[{ tagId, name, precision }]`.
 */
function suggestForTargets({ models, tree, targets, featuresOf, limits = TAG_SUGGESTION_LIMITS }) {
  const found = new Map();
  const scores = new Map();
  for (const target of targets) {
    if (!target.promptKey) continue;
    const features = featuresOf(target.promptKey);
    if (!features) continue;
    let byTag = scores.get(target.promptKey);
    if (!byTag) {
      byTag = [];
      for (const [tagId, model] of models) {
        const score = scoreFeatures(model, features);
        if (score >= model.threshold) byTag.push({ tagId, model, margin: score - model.threshold });
      }
      scores.set(target.promptKey, byTag);
    }
    if (byTag.length === 0) continue;
    const member = tree.memberOf(target.tagIds || []);
    const dismissed = new Set(target.dismissedTagIds || []);
    const open = byTag.filter((entry) => !member.has(entry.tagId) && !dismissed.has(entry.tagId));
    const below = new Set(open.flatMap((entry) => tree.ancestorsOf(entry.tagId)));
    const chosen = open
      .filter((entry) => !below.has(entry.tagId))
      .sort((a, b) => b.margin - a.margin || a.tagId - b.tagId)
      .slice(0, limits.maxSuggestions)
      .map((entry) => ({
        tagId: entry.tagId,
        name: tree.names.get(entry.tagId),
        precision: entry.model.precision,
      }));
    if (chosen.length) found.set(target.id, chosen);
  }
  return found;
}

function signatureOf(labels, epoch) {
  const hash = crypto.createHash("sha256");
  hash.update(`epoch:${epoch}\n`);
  for (const tag of labels.tags) hash.update(`t${tag.id}:${tag.parentId ?? ""}:${tag.name}\n`);
  for (const row of labels.links) hash.update(`l${row.promptKey}:${row.fingerprint}:${row.tagId}\n`);
  for (const row of labels.dismissals) hash.update(`d${row.promptKey}:${row.fingerprint}:${row.tagId}\n`);
  return hash.digest("hex");
}

class TagSuggestionService {
  constructor(options = {}) {
    if (!options.promptService) throw new TypeError("A prompt service is required");
    this.promptService = options.promptService;
    this.limits = { ...TAG_SUGGESTION_LIMITS, ...(options.limits || {}) };
    this.yieldToEventLoop = options.yieldToEventLoop || defaultYield;
    // The last models learned, and learning under way. Memory only.
    this.learned = null;
    this.learning = null;
    this.generation = 0;
  }

  /**
   * The models for the library's current tags, learning them first when the
   * tags, turned-down suggestions or prompt numbering changed. Shared by
   * concurrent callers.
   */
  async models({ store, assertActive }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const labels = store.getTagSuggestionLabels();
      const epoch = this.promptService.epoch;
      const signature = signatureOf(labels, epoch);
      if (this.learned?.signature === signature) return this.learned;
      if (this.learning?.signature !== signature) {
        const generation = this.generation;
        const promise = this._learn({ labels, signature, store, assertActive }).then(
          (learned) => {
            if (learned && generation === this.generation) this.learned = learned;
            return learned;
          }
        );
        const settle = () => {
          if (this.learning?.promise === promise) this.learning = null;
        };
        promise.then(settle, settle);
        this.learning = { signature, promise };
      }
      const learned = await this.learning.promise;
      if (learned) return learned;
      // Prompt numbering was reset while reading: learn again from scratch.
    }
    return { signature: null, epoch: null, models: new Map(), status: [], tree: buildTagTree([]) };
  }

  async _learn({ labels, signature, store, assertActive }) {
    const tree = buildTagTree(labels.tags, this.limits.maxTagDepth);
    const examples = collectTagExamples({
      links: labels.links,
      dismissals: labels.dismissals,
      tree,
      limits: this.limits,
    });
    const keys = new Set();
    for (const { positives, negatives } of examples) {
      for (const key of positives) keys.add(key);
      for (const key of negatives) keys.add(key);
    }
    const read = await this.promptService.promptFeatures(
      [...keys].sort().slice(0, this.limits.maxTrainingKeys),
      { store, assertActive }
    );
    if (!read) return null;
    const featuresOf = (key) => read.features.get(key) || null;
    const models = new Map();
    const status = [];
    for (const example of examples) {
      const model = trainTagModel({ ...example, featuresOf, limits: this.limits });
      status.push({
        name: tree.names.get(example.tagId),
        examples: model.examples,
        usable: model.usable,
        precision: model.usable ? model.precision : null,
        recall: model.usable ? model.recall : null,
      });
      if (model.usable) models.set(example.tagId, model);
      await this.yieldToEventLoop();
      assertActive?.();
    }
    status.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { signature, epoch: read.epoch, models, status, tree };
  }

  async _features(promptKeys, { store, assertActive, epoch }) {
    const read = await this.promptService.promptFeatures(promptKeys, { store, assertActive });
    if (!read || read.epoch !== epoch) return null;
    return (key) => read.features.get(key) || null;
  }

  /** Which tags can be suggested, and which have examples but cannot. */
  async status({ store, assertActive }) {
    const learned = await this.models({ store, assertActive });
    return learned.status;
  }

  /**
   * Suggestions for catalog rows: `{ [instanceId]: [{ tag, precision }] }`,
   * or null when the prompt numbering was reset while reading.
   */
  async suggest({ store, instanceIds, assertActive }) {
    const learned = await this.models({ store, assertActive });
    const suggestions = {};
    if (learned.models.size === 0) return suggestions;
    const targets = store.getTagSuggestionTargets(instanceIds);
    const keys = [...new Set(targets.map((target) => target.promptKey).filter(Boolean))];
    const featuresOf = await this._features(keys, { store, assertActive, epoch: learned.epoch });
    if (!featuresOf) return null;
    const found = suggestForTargets({
      models: learned.models,
      tree: learned.tree,
      targets: targets.map((target) => ({ ...target, id: target.instanceId })),
      featuresOf,
      limits: this.limits,
    });
    for (const [instanceId, list] of found) {
      suggestions[instanceId] = list.map(({ name, precision }) => ({ tag: name, precision }));
    }
    return suggestions;
  }

  _modelNamed(learned, tagName) {
    const wanted = String(tagName || "").trim().toLowerCase();
    for (const [tagId, model] of learned.models) {
      if (String(learned.tree.names.get(tagId)).toLowerCase() === wanted) return { tagId, model };
    }
    return null;
  }

  /**
   * Catalog rows among `instanceIds` that might be `tagName`: suggested it,
   * not counting under it already and not having turned it down. Returns
   * `{ usable, matches }`, or null when the prompt numbering was reset.
   */
  async mightBe({ store, instanceIds, tagName, assertActive }) {
    const learned = await this.models({ store, assertActive });
    const named = this._modelNamed(learned, tagName);
    if (!named) return { usable: false, matches: [] };
    const targets = store.getTagSuggestionTargets(instanceIds);
    const keys = [...new Set(targets.map((target) => target.promptKey).filter(Boolean))];
    const featuresOf = await this._features(keys, { store, assertActive, epoch: learned.epoch });
    if (!featuresOf) return null;
    const passes = new Map();
    const matches = [];
    for (const target of targets) {
      if (!target.promptKey) continue;
      if (!passes.has(target.promptKey)) {
        const features = featuresOf(target.promptKey);
        passes.set(
          target.promptKey,
          Boolean(features) && scoreFeatures(named.model, features) >= named.model.threshold
        );
      }
      if (!passes.get(target.promptKey)) continue;
      if (learned.tree.memberOf(target.tagIds || []).has(named.tagId)) continue;
      if ((target.dismissedTagIds || []).includes(named.tagId)) continue;
      matches.push(target.instanceId);
    }
    return { usable: true, matches };
  }

  /**
   * Prompt keys among `promptKeys` whose prompts might be `tagName`, for a
   * library search; clips already under the tag or that turned it down are
   * left out by the search itself. Returns `{ usable, matches }`, or null.
   */
  async mightBeKeys({ store, promptKeys, tagName, assertActive }) {
    const learned = await this.models({ store, assertActive });
    const named = this._modelNamed(learned, tagName);
    if (!named) return { usable: false, matches: [] };
    const featuresOf = await this._features(promptKeys, {
      store,
      assertActive,
      epoch: learned.epoch,
    });
    if (!featuresOf) return null;
    const matches = promptKeys.filter((key) => {
      const features = featuresOf(key);
      return Boolean(features) && scoreFeatures(named.model, features) >= named.model.threshold;
    });
    return { usable: true, matches };
  }

  // Profile switches forget everything learned.
  clear() {
    this.generation += 1;
    this.learned = null;
    this.learning = null;
  }
}

function createTagSuggestionService(options) {
  return new TagSuggestionService(options);
}

module.exports = {
  TAG_SUGGESTION_LIMITS,
  TagSuggestionService,
  buildTagTree,
  chanceOfLeaning,
  collectTagExamples,
  createTagSuggestionService,
  foldOfKey,
  scoreFeatures,
  suggestForTargets,
  trainTagModel,
};
