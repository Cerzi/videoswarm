const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  computeGenerationKeys,
  deriveGenerationKeyParts,
  deriveResourceNames,
  deriveSearchTexts,
} = require("./generation-key");
const { isIsoBmffPath, readIsoBmffEmbeddedPayload } = require("./container-tags");

// Similar-prompt stacks (docs/architecture/prompt-stacks.md, Section 7).
//
// Exact prompt stacks need identical prompt text, but runs of one idea are
// often reworded between runs. This finds which prompt keys' prompts share
// most of their words; the renderer stacks neighbouring clips with them.
// Prompt text never leaves this module: words are kept as numbered sets in
// memory only, and callers send and receive prompt keys.

const PROMPT_SIMILARITY_LIMITS = Object.freeze({
  maxKeys: 20_000,
  maxCachedKeys: 20_000,
  maxDictionaryWords: 1_000_000,
  instancesPerKey: 3,
  minWords: 4,
  // A text in this share of the groups, beside this many different other
  // texts (a shared negative prompt, a style suffix), says nothing about
  // which idea a clip is. One prompt over several input clips is not that.
  boilerplateFraction: 0.25,
  minBoilerplateGroups: 3,
  minBoilerplateCompanions: 3,
  // Reads and pairing give the event loop back this often.
  yieldEvery: 16,
  clusterSlice: 256,
  // Prompts alike, per prompt; the closest are kept.
  maxNeighbours: 64,
});

const WORD = /[\p{L}\p{N}]+/gu;
const EPSILON = 1e-9;

/** Numbers words as it meets them; a text becomes a sorted set of numbers. */
function createWordDictionary() {
  const ids = new Map();
  const known = []; // id -> word
  return {
    /** The number of exactly this word, as a set, empty when unknown. */
    idsExactly(word) {
      const id = ids.get(word);
      return id === undefined ? new Set() : new Set([id]);
    },
    /** The numbers of every known word starting with `prefix`. */
    idsStartingWith(prefix) {
      const found = new Set();
      if (!prefix) return found;
      known.forEach((word, id) => {
        if (word.startsWith(prefix)) found.add(id);
      });
      return found;
    },
    /** A text's word numbers in order, repeats included, for phrases. */
    sequenceOf(text) {
      const sequence = [];
      for (const match of String(text).matchAll(WORD)) {
        sequence.push(this.idOfToken(match[0].toLowerCase()));
      }
      return Int32Array.from(sequence);
    },
    idsOf(text) {
      return Int32Array.from(new Set(this.sequenceOf(text))).sort();
    },
    /** The number of one whole token, such as a model file name. */
    idOfToken(token) {
      let id = ids.get(token);
      if (id === undefined) {
        id = ids.size;
        ids.set(token, id);
        known.push(token);
      }
      return id;
    },
    get size() {
      return ids.size;
    },
    clear() {
      ids.clear();
      known.length = 0;
    },
  };
}

const MAX_QUERY_TERMS = 16;

// A term: an optional leading "-", then words in quotes (to the next quote,
// or the end while one is still being typed) or a run without spaces.
const QUERY_TERM = /(-?)(?:"([^"]*)"?|(\S+))/gu;
const MAX_PHRASE_WORDS = 16;

/**
 * A prompt search query as `{ include, exclude }` terms, lowercased, to find
 * and, after a leading `-`, to rule out:
 * - `{ word, exact: false }`: a word matching the starts of words ("danc"
 *   finds "dancing"). "dance-floor" is two such words.
 * - `{ word, exact: true }`: one word in quotes, matching only itself ("pan"
 *   finds "pan", not "panda").
 * - `{ phrase: [words] }`: several words in quotes, matching them whole and
 *   in that order within one text ("golden hour").
 */
function parsePromptQuery(query) {
  const include = new Map();
  const exclude = new Map();
  for (const match of String(query || "").toLowerCase().matchAll(QUERY_TERM)) {
    const quoted = match[2] !== undefined;
    const target = match[1] === "-" ? exclude : include;
    const words = [...(quoted ? match[2] : match[3]).matchAll(WORD)].map((word) => word[0]);
    if (quoted && words.length > 1) {
      const phrase = words.slice(0, MAX_PHRASE_WORDS);
      const key = `"${phrase.join(" ")}`;
      if (!target.has(key)) target.set(key, { phrase });
      continue;
    }
    for (const word of words) {
      const key = `${quoted ? "=" : "^"}${word}`;
      if (!target.has(key)) target.set(key, { word, exact: quoted });
    }
  }
  return {
    include: [...include.values()].slice(0, MAX_QUERY_TERMS),
    exclude: [...exclude.values()].slice(0, MAX_QUERY_TERMS),
  };
}

/** Whether `sequence` holds `phrase` (word numbers) as a consecutive run. */
function containsRun(sequence, phrase) {
  const last = sequence.length - phrase.length;
  for (let start = 0; start <= last; start += 1) {
    let at = 0;
    while (at < phrase.length && sequence[start + at] === phrase[at]) at += 1;
    if (at === phrase.length) return true;
  }
  return false;
}

function hash(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function unionOf(arrays) {
  if (arrays.length === 1) return arrays[0];
  const all = new Int32Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    all.set(array, offset);
    offset += array.length;
  }
  all.sort();
  let length = 0;
  for (let index = 0; index < all.length; index += 1) {
    if (index === 0 || all[index] !== all[index - 1]) all[length++] = all[index];
  }
  return all.subarray(0, length);
}

// Words two sorted sets share, or -1 once they cannot reach `needed`.
function sharedWords(a, b, needed) {
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (shared + Math.min(a.length - i, b.length - j) < needed) return -1;
    if (a[i] === b[j]) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (a[i] < b[j]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return shared >= needed ? shared : -1;
}

/**
 * Pairs of prompt keys whose prompts share at least `threshold` of their
 * words (Jaccard similarity of the word sets).
 *
 * `groups` are `{ key, media, texts: [{ id, words }] }`, where `media` names
 * the input media (with any cut start) and `texts` are the prompt's long
 * texts, each a sorted Int32Array of word numbers from one dictionary. Only
 * prompts over the same input media pair: the same words over another source
 * clip or segment are another shot.
 *
 * This only says which prompts are alike. Which clips stack is decided by the
 * renderer, from neighbours in the grid's order (prompt-stacks.md, Section 7).
 *
 * A generator, so the caller can give the event loop back between slices;
 * its return value is a Map of key -> keys alike, closest first, at most
 * `maxNeighbours` each.
 */
function* similarPromptPairsInSlices(groups, options = {}) {
  const limits = { ...PROMPT_SIMILARITY_LIMITS, ...options };
  const threshold = Math.min(1, Math.max(0.05, Number(options.threshold) || 0.8));
  const readable = (Array.isArray(groups) ? groups : []).filter(
    (group) => group?.key && Array.isArray(group.texts)
  );

  const textFrequency = new Map();
  const companions = new Map(); // text id -> the other texts beside it
  for (const group of readable) {
    const ids = [...new Set(group.texts.map((text) => text.id))].sort();
    for (const id of ids) {
      textFrequency.set(id, (textFrequency.get(id) || 0) + 1);
      if (!companions.has(id)) companions.set(id, new Set());
      const seen = companions.get(id);
      if (seen.size < limits.minBoilerplateCompanions) {
        seen.add(ids.filter((other) => other !== id).join(","));
      }
    }
  }
  const boilerplateAt = Math.max(
    limits.minBoilerplateGroups,
    Math.ceil(readable.length * limits.boilerplateFraction)
  );
  const isBoilerplate = (id) =>
    textFrequency.get(id) >= boilerplateAt &&
    companions.get(id).size >= limits.minBoilerplateCompanions;

  const profiles = [];
  let maxWord = -1;
  for (const group of readable) {
    const kept = group.texts.filter((text) => !isBoilerplate(text.id));
    if (kept.length === 0) continue;
    const words = unionOf(kept.map((text) => text.words));
    if (words.length < limits.minWords) continue;
    maxWord = Math.max(maxWord, words[words.length - 1]);
    profiles.push({ key: group.key, media: String(group.media || ""), words });
  }
  // Smallest first, so every indexed set is no larger than the one probing.
  profiles.sort(
    (a, b) =>
      a.words.length - b.words.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  yield;

  // Prefix filtering (as in PPJoin): with words renumbered in one global
  // order, rarest first, two sets sharing `threshold` of their words also
  // share a word among each one's first `size - ceil(threshold * size) + 1`.
  // Only those rare words are indexed and probed, and a candidate is dropped
  // as soon as the words left cannot make up the overlap it needs. This finds
  // every close pair without comparing each prompt with every other.
  const frequency = new Int32Array(maxWord + 1);
  for (const profile of profiles) {
    for (const word of profile.words) frequency[word] += 1;
  }
  const present = [];
  for (let word = 0; word <= maxWord; word += 1) if (frequency[word] > 0) present.push(word);
  present.sort((a, b) => frequency[a] - frequency[b] || a - b);
  const rank = new Int32Array(maxWord + 1);
  present.forEach((word, index) => {
    rank[word] = index;
  });
  const sets = profiles.map((profile) => {
    const set = new Int32Array(profile.words.length);
    for (let index = 0; index < set.length; index += 1) set[index] = rank[profile.words[index]];
    return set.sort();
  });
  const prefixLength = (size) => size - Math.ceil(threshold * size - EPSILON) + 1;
  // The overlap two sets of these sizes need for `threshold`.
  const overlapNeeded = (a, b) => Math.ceil((threshold / (1 + threshold)) * (a + b) - EPSILON);
  yield;

  const alike = new Map(); // profile index -> [{ index, similarity }]
  const addPair = (a, b, similarity) => {
    if (!alike.has(a)) alike.set(a, []);
    if (!alike.has(b)) alike.set(b, []);
    alike.get(a).push({ index: b, similarity });
    alike.get(b).push({ index: a, similarity });
  };
  const postings = new Map(); // word -> [profile index, position, ...]
  const overlap = new Int32Array(profiles.length);
  const touched = [];
  for (let probe = 0; probe < profiles.length; probe += 1) {
    if (probe > 0 && probe % limits.clusterSlice === 0) yield;
    const set = sets[probe];
    const size = set.length;
    const minSize = Math.ceil(threshold * size - EPSILON);
    const prefix = prefixLength(size);
    for (let position = 0; position < prefix; position += 1) {
      const list = postings.get(set[position]);
      if (!list) continue;
      for (let at = 0; at < list.length; at += 2) {
        const other = list[at];
        if (overlap[other] < 0) continue; // already ruled out
        const otherSize = sets[other].length;
        if (otherSize < minSize) continue;
        const reachable =
          overlap[other] + 1 + Math.min(size - position - 1, otherSize - list[at + 1] - 1);
        if (overlap[other] === 0) touched.push(other);
        overlap[other] = reachable < overlapNeeded(size, otherSize) ? -1 : overlap[other] + 1;
      }
    }
    for (const other of touched) {
      const seen = overlap[other];
      overlap[other] = 0;
      if (seen <= 0 || profiles[other].media !== profiles[probe].media) continue;
      const otherSet = sets[other];
      const shared = sharedWords(set, otherSet, overlapNeeded(size, otherSet.length));
      if (shared < 0) continue;
      addPair(probe, other, shared / (size + otherSet.length - shared));
    }
    touched.length = 0;
    for (let position = 0; position < prefix; position += 1) {
      const word = set[position];
      if (!postings.has(word)) postings.set(word, []);
      postings.get(word).push(probe, position);
    }
  }

  const result = new Map();
  for (const [index, pairs] of alike) {
    pairs.sort(
      (a, b) =>
        b.similarity - a.similarity ||
        (profiles[a.index].key < profiles[b.index].key ? -1 : 1)
    );
    result.set(
      profiles[index].key,
      pairs.slice(0, limits.maxNeighbours).map((pair) => profiles[pair.index].key)
    );
  }
  return result;
}

/** similarPromptPairsInSlices, run to the end at once. */
function similarPromptPairs(groups, options) {
  const steps = similarPromptPairsInSlices(groups, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function defaultYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

class PromptSimilarityService {
  constructor(options = {}) {
    this.limits = { ...PROMPT_SIMILARITY_LIMITS, ...(options.limits || {}) };
    this.fsPromises = options.fsPromises || fs.promises;
    this.readIsoPayload = options.readIsoPayload || readIsoBmffEmbeddedPayload;
    this.yieldToEventLoop = options.yieldToEventLoop || defaultYield;
    this.dictionary = createWordDictionary();
    // promptKey -> { media, texts: [{ id, words }], searchWords, features }
    // or null (no readable clip). Memory only.
    this.cache = new Map();
    this.inFlight = new Map();
    this.ticket = 0;
    this.searchTicket = 0;
    this.epoch = 0;
  }

  _remember(key, entry) {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.limits.maxCachedKeys) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  // The prompt's long texts and input media, from one present clip with this
  // prompt key.
  async _readPrompt(key, store, assertActive) {
    const instances = store.listPresentInstancesForPromptKey(
      key,
      this.limits.instancesPerKey
    );
    for (const instance of instances) {
      assertActive?.();
      const filePath = instance.absolutePath;
      if (typeof filePath !== "string" || !isIsoBmffPath(filePath)) continue;
      try {
        const [realRoot, realFile] = await Promise.all([
          this.fsPromises.realpath(instance.rootPath).then(path.resolve, () => null),
          this.fsPromises.realpath(filePath).then(path.resolve, () => null),
        ]);
        if (!realRoot || !realFile || !isInside(realRoot, realFile)) continue;
        const result = await this.readIsoPayload(filePath, {
          size: instance.size,
          mtimeMs: instance.mtimeMs,
        });
        if (result?.status !== "found") continue;
        const prompt = result.payload?.prompt;
        // The file must still hold the prompt this key was made from.
        if (computeGenerationKeys(prompt).promptKey !== key) continue;
        const parts = deriveGenerationKeyParts(prompt);
        if (!parts) continue;
        // Search reads every text but negative prompts, short ones included.
        const searchable = (deriveSearchTexts(prompt) || []).filter((text) => !text.negative);
        // Each positive text in word order, for phrases, and its words as a
        // set, for everything else.
        const searchSequences = searchable.map((text) => this.dictionary.sequenceOf(text.text));
        const searchWords = new Set(searchSequences.flatMap((sequence) => [...sequence]));
        // Tag suggestions also learn from the weight files the graph loads.
        // A leading NUL keeps them apart from words, which never contain one.
        const features = new Set(searchWords);
        for (const name of deriveResourceNames(prompt) || []) {
          features.add(this.dictionary.idOfToken(`\u0000${name}`));
        }
        return {
          media: hash(parts.media.join("\n")),
          texts: parts.texts.map((text) => ({
            id: hash(text),
            words: this.dictionary.idsOf(text),
          })),
          searchWords,
          searchSequences,
          features: Int32Array.from(features).sort(),
        };
      } catch {
        // Try the next instance.
      }
    }
    return null;
  }

  async _promptFor(key, store, assertActive) {
    if (this.cache.has(key)) {
      const entry = this.cache.get(key);
      this._remember(key, entry);
      return entry;
    }
    if (!this.inFlight.has(key)) {
      const epoch = this.epoch;
      const pending = this._readPrompt(key, store, assertActive)
        .then((entry) => {
          if (epoch === this.epoch) this._remember(key, entry);
          return entry;
        })
        .finally(() => {
          if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
        });
      this.inFlight.set(key, pending);
    }
    return this.inFlight.get(key);
  }

  /**
   * `promptKeys` are one collection's prompt keys. Returns an object mapping
   * each prompt key that has alike prompts to their keys, or null when a
   * newer request superseded this one.
   */
  async similarPrompts({ store, promptKeys, threshold, assertActive }) {
    if (this.dictionary.size > this.limits.maxDictionaryWords) this.clear();
    const ticket = ++this.ticket;
    const current = async () => {
      await this.yieldToEventLoop();
      assertActive?.();
      return ticket === this.ticket;
    };
    const list = (Array.isArray(promptKeys) ? promptKeys : []).slice(0, this.limits.maxKeys);
    const groups = [];
    for (let index = 0; index < list.length; index += 1) {
      const promptKey = list[index];
      const prompt = await this._promptFor(promptKey, store, assertActive);
      assertActive?.();
      if (ticket !== this.ticket) return null;
      if (prompt) groups.push({ key: promptKey, ...prompt });
      if ((index + 1) % this.limits.yieldEvery === 0 && !(await current())) return null;
    }
    const steps = similarPromptPairsInSlices(groups, {
      threshold,
      clusterSlice: this.limits.clusterSlice,
    });
    for (;;) {
      const step = steps.next();
      if (step.done) return Object.fromEntries(step.value);
      if (!(await current())) return null;
    }
  }

  /**
   * The prompt keys among `promptKeys` whose positive prompts contain every
   * word of `query` (by word start) and none of its `-words`. Returns
   * `{ matches, unread }`, or null when a newer request superseded this one.
   */
  async searchPrompts({ store, promptKeys, query, assertActive }) {
    if (this.dictionary.size > this.limits.maxDictionaryWords) this.clear();
    const terms = parsePromptQuery(query);
    const ticket = ++this.searchTicket;
    const list = (Array.isArray(promptKeys) ? promptKeys : []).slice(0, this.limits.maxKeys);
    const read = [];
    let unread = 0;
    for (let index = 0; index < list.length; index += 1) {
      const prompt = await this._promptFor(list[index], store, assertActive);
      assertActive?.();
      if (ticket !== this.searchTicket) return null;
      if (prompt?.searchWords) read.push([list[index], prompt]);
      else unread += 1;
      if ((index + 1) % this.limits.yieldEvery === 0) {
        await this.yieldToEventLoop();
        assertActive?.();
        if (ticket !== this.searchTicket) return null;
      }
    }
    if (!terms.include.length && !terms.exclude.length) return { matches: [], unread };
    const has = (words, ids) => {
      for (const id of ids.size < words.size ? ids : words) {
        if ((ids.size < words.size ? words : ids).has(id)) return true;
      }
      return false;
    };
    // Each term becomes a test of one prompt. A phrase's words are looked up
    // whole; one never seen matches nothing. Its word set rules most prompts
    // out before any text is scanned in order.
    const testOf = (term) => {
      if (term.phrase) {
        const ids = term.phrase.map((word) => this.dictionary.idsExactly(word));
        if (ids.some((found) => found.size === 0)) return () => false;
        const run = Int32Array.from(ids.map((found) => found.values().next().value));
        return (prompt) =>
          [...run].every((id) => prompt.searchWords.has(id)) &&
          (prompt.searchSequences || []).some((sequence) => containsRun(sequence, run));
      }
      const ids = term.exact
        ? this.dictionary.idsExactly(term.word)
        : this.dictionary.idsStartingWith(term.word);
      return (prompt) => has(prompt.searchWords, ids);
    };
    const include = terms.include.map(testOf);
    const exclude = terms.exclude.map(testOf);
    const matches = [];
    for (const [key, prompt] of read) {
      if (include.every((test) => test(prompt)) && !exclude.some((test) => test(prompt))) {
        matches.push(key);
      }
    }
    return { matches, unread };
  }

  /**
   * Each prompt key's features for tag suggestions
   * (prompt-search-and-tag-suggestions.md): the words of its positive prompts
   * and the weight files its graph loads, as sorted numbers. Keys without a
   * readable clip map to null. Returns `{ epoch, features }`, or null when the
   * numbering was reset while reading, so numbers from before mean nothing.
   */
  async promptFeatures(promptKeys, { store, assertActive } = {}) {
    if (this.dictionary.size > this.limits.maxDictionaryWords) this.clear();
    const epoch = this.epoch;
    const list = (Array.isArray(promptKeys) ? promptKeys : []).slice(0, this.limits.maxKeys);
    const features = new Map();
    for (let index = 0; index < list.length; index += 1) {
      const prompt = await this._promptFor(list[index], store, assertActive);
      assertActive?.();
      if (epoch !== this.epoch) return null;
      features.set(list[index], prompt?.features || null);
      if ((index + 1) % this.limits.yieldEvery === 0) {
        await this.yieldToEventLoop();
        assertActive?.();
        if (epoch !== this.epoch) return null;
      }
    }
    return { epoch, features };
  }

  // Profile switches clear the cache: whether a key has a readable clip
  // depends on the profile's library.
  clear() {
    this.ticket += 1;
    this.searchTicket += 1;
    this.epoch += 1;
    this.cache.clear();
    this.inFlight.clear();
    this.dictionary.clear();
  }
}

function createPromptSimilarityService(options) {
  return new PromptSimilarityService(options);
}

module.exports = {
  PROMPT_SIMILARITY_LIMITS,
  PromptSimilarityService,
  similarPromptPairs,
  similarPromptPairsInSlices,
  createPromptSimilarityService,
  createWordDictionary,
  parsePromptQuery,
};
