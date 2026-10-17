import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  TagSuggestionService,
  buildTagTree,
  chanceOfLeaning,
  collectTagExamples,
  scoreFeatures,
  suggestForTargets,
  trainTagModel,
} = require("../tag-suggestions");
const { PromptSimilarityService, createWordDictionary } = require("../prompt-similarity");
const { computeGenerationKeys, deriveResourceNames } = require("../generation-key");

// Made-up prompts: a topic's words plus filler drawn from a shared pool, so
// topics are told apart by their own words, not by anything else.
function random(seed) {
  // Mixed first, so neighbouring seeds give unrelated prompts.
  let state = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0;
  state = Math.imul(state ^ (state >>> 13), 0xc2b2ae35) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
const FILLER = Array.from({ length: 120 }, (_, index) => `filler${index}`);
function fillerWords(next, count) {
  return Array.from({ length: count }, () => FILLER[Math.floor(next() * FILLER.length)]);
}
const TOPICS = {
  dance: ["dancing", "dancer", "ballet", "twirl", "stage"],
  sea: ["ocean", "waves", "harbour", "boats", "gulls"],
  city: ["neon", "street", "rain", "traffic", "towers"],
};
function topicText(topic, seed) {
  const next = random(seed);
  const own = TOPICS[topic];
  const picked = [own[0], own[1 + Math.floor(next() * (own.length - 1))]];
  return [...picked, ...fillerWords(next, 8)].join(" ");
}

describe("examples", () => {
  const tree = buildTagTree([
    { id: 1, name: "dance", parentId: null },
    { id: 2, name: "bellydance", parentId: 1 },
    { id: 3, name: "sea", parentId: null },
  ]);

  it("counts a prompt once, and a tag under another toward it", () => {
    const links = [];
    for (let index = 0; index < 10; index += 1) {
      // Three clips of one prompt are one example.
      for (let clip = 0; clip < 3; clip += 1) {
        links.push({ promptKey: `pk-d${index}`, fingerprint: `fp-d${index}-${clip}`, tagId: 2 });
      }
      links.push({ promptKey: `pk-s${index}`, fingerprint: `fp-s${index}`, tagId: 3 });
    }
    const examples = collectTagExamples({ links, dismissals: [], tree });
    const byTag = new Map(examples.map((entry) => [entry.tagId, entry]));
    expect(byTag.get(1).positives).toHaveLength(10);
    expect(byTag.get(2).positives).toHaveLength(10);
    expect(byTag.get(1).negatives).toHaveLength(10);
    expect(byTag.get(3).negatives).toHaveLength(10);
  });

  it("learns against other tags and turned-down suggestions, never untagged or vaguer clips", () => {
    const links = [];
    for (let index = 0; index < 10; index += 1) {
      links.push({ promptKey: `pk-b${index}`, fingerprint: `fp-b${index}`, tagId: 2 });
    }
    // Tagged only "dance": says nothing about "bellydance".
    links.push({ promptKey: "pk-vague", fingerprint: "fp-vague", tagId: 1 });
    links.push({ promptKey: "pk-sea", fingerprint: "fp-sea", tagId: 3 });
    const dismissals = [{ promptKey: "pk-no", fingerprint: "fp-no", tagId: 2 }];
    const [belly] = collectTagExamples({ links, dismissals, tree }).filter((entry) => entry.tagId === 2);
    expect(belly.negatives).toEqual(["pk-no", "pk-sea"]);
  });

  it("leaves out tags with fewer than ten prompts", () => {
    const links = Array.from({ length: 9 }, (_, index) => ({
      promptKey: `pk-${index}`,
      fingerprint: `fp-${index}`,
      tagId: 3,
    }));
    expect(collectTagExamples({ links, dismissals: [], tree })).toEqual([]);
  });
});

describe("learning a tag", () => {
  function corpus(spec) {
    const dictionary = createWordDictionary();
    const features = new Map();
    const keys = { dance: [], other: [] };
    let seed = 1;
    for (const [topic, count] of Object.entries(spec)) {
      for (let index = 0; index < count; index += 1) {
        const key = `pk-${topic}-${index}`;
        features.set(key, dictionary.idsOf(topicText(topic, (seed += 7))));
        (topic === "dance" ? keys.dance : keys.other).push(key);
      }
    }
    return { dictionary, features, keys, featuresOf: (key) => features.get(key) || null };
  }

  it("suggests a tag its prompts give away, and checks it on held-back prompts", () => {
    const { dictionary, keys, featuresOf } = corpus({ dance: 15, sea: 10, city: 10 });
    const model = trainTagModel({ positives: keys.dance, negatives: keys.other, featuresOf });
    expect(model.usable).toBe(true);
    expect(model.precision).toBeGreaterThanOrEqual(0.8);
    expect(model.examples).toBe(15);
    const dancing = dictionary.idsOf(topicText("dance", 9001));
    const harbour = dictionary.idsOf(topicText("sea", 9002));
    expect(scoreFeatures(model, dancing)).toBeGreaterThanOrEqual(model.threshold);
    expect(scoreFeatures(model, harbour)).toBeLessThan(model.threshold);
  });

  it("refuses a tag the prompt cannot tell", () => {
    const { keys, featuresOf } = corpus({ sea: 20, city: 20 });
    // "keeper" on every other clip, whatever its prompt.
    const all = keys.other;
    const model = trainTagModel({
      positives: all.filter((_, index) => index % 2 === 0),
      negatives: all.filter((_, index) => index % 2 === 1),
      featuresOf,
    });
    expect(model).toEqual({ usable: false, examples: 20 });
  });

  it("gives words never learned from no weight", () => {
    const { dictionary, keys, featuresOf } = corpus({ dance: 15, sea: 15 });
    const model = trainTagModel({ positives: keys.dance, negatives: keys.other, featuresOf });
    const unseen = dictionary.idsOf("zebra quokka marmot");
    expect(scoreFeatures(model, unseen)).toBe(model.prior);
  });

  it("rarely suggests a tag for prompts it was not learned from, and finds most that fit", () => {
    const { dictionary, keys, featuresOf } = corpus({ dance: 15, sea: 15, city: 15 });
    const model = trainTagModel({ positives: keys.dance, negatives: keys.other, featuresOf });
    const passes = (topic, seed) =>
      scoreFeatures(model, dictionary.idsOf(topicText(topic, seed))) >= model.threshold;
    let wrong = 0;
    let found = 0;
    for (let seed = 0; seed < 100; seed += 1) {
      if (passes(seed % 2 ? "sea" : "city", 20_000 + seed)) wrong += 1;
      if (passes("dance", 30_000 + seed)) found += 1;
    }
    expect(wrong).toBeLessThanOrEqual(2);
    expect(found).toBeGreaterThanOrEqual(80);
  });

  it("measures how often chance would lean a word that far", () => {
    const table = Float64Array.from({ length: 37 }, (_, n) => {
      let total = 0;
      for (let k = 2; k <= n; k += 1) total += Math.log(k);
      return total;
    });
    // In 2 of 12 tagged prompts and none of 24 others: C(12,2)/C(36,2).
    expect(chanceOfLeaning(2, 0, 12, 24, table, 1)).toBeCloseTo(66 / 630, 10);
    // In all 12 others and none tagged leans away: C(24,12)/C(36,12).
    expect(chanceOfLeaning(0, 12, 12, 24, table, 1)).toBeCloseTo(2704156 / 1251677700, 10);
  });

  it("drops prompts it could not read and needs ten of each left", () => {
    const { keys, featuresOf } = corpus({ dance: 12, sea: 12 });
    const unread = new Set(keys.dance.slice(0, 3));
    const model = trainTagModel({
      positives: keys.dance,
      negatives: keys.other,
      featuresOf: (key) => (unread.has(key) ? null : featuresOf(key)),
    });
    expect(model).toEqual({ usable: false, examples: 9 });
  });
});

describe("suggestForTargets", () => {
  const tree = buildTagTree([
    { id: 1, name: "dance", parentId: null },
    { id: 2, name: "bellydance", parentId: 1 },
    { id: 3, name: "sea", parentId: null },
    { id: 4, name: "stage", parentId: null },
    { id: 5, name: "night", parentId: null },
  ]);
  // Each model passes for prompts carrying its feature number.
  const model = (feature, margin = 1, precision = 0.9) => ({
    prior: -1,
    weights: new Map([[feature, 1 + margin]]),
    threshold: 0,
    precision,
  });
  const models = new Map([
    [1, model(10, 1)],
    [2, model(20, 2)],
    [3, model(30, 3)],
    [4, model(40, 0.5)],
    [5, model(50, 0.25)],
  ]);
  const features = new Map([["pk-a", Int32Array.from([10, 20, 30, 40, 50])]]);
  const suggest = (target) =>
    suggestForTargets({
      models,
      tree,
      targets: [{ id: 7, promptKey: "pk-a", tagIds: [], dismissedTagIds: [], ...target }],
      featuresOf: (key) => features.get(key) || null,
    }).get(7);

  it("offers at most three, strongest first, and the more specific of two related tags", () => {
    expect(suggest({}).map((entry) => entry.name)).toEqual(["sea", "bellydance", "stage"]);
  });

  it("skips tags the clip already counts under and ones it turned down", () => {
    expect(suggest({ tagIds: [2], dismissedTagIds: [3] }).map((entry) => entry.name)).toEqual([
      "stage",
      "night",
    ]);
    // Tagged "dance": "bellydance" is still worth offering.
    expect(suggest({ tagIds: [1] }).map((entry) => entry.name)).toEqual(["sea", "bellydance", "stage"]);
  });

  it("offers nothing for a clip without a readable prompt", () => {
    expect(suggest({ promptKey: "pk-missing" })).toBeUndefined();
    expect(suggest({ promptKey: null })).toBeUndefined();
  });
});

describe("deriveResourceNames", () => {
  it("names the weight files a graph loads, without folders or extensions", () => {
    const graph = JSON.stringify({
      1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "SDXL/Base_v1.safetensors" } },
      2: { class_type: "LoraLoader", inputs: { lora_name: "styles\\Ink-Wash.safetensors", model: ["1", 0] } },
      3: { class_type: "UNETLoader", inputs: { unet_name: "wan.gguf" } },
      4: { class_type: "LoadImage", inputs: { image: "photo.png" } },
      5: { class_type: "CLIPTextEncode", inputs: { text: "a model.safetensors in a prompt" } },
    });
    expect(deriveResourceNames(graph)).toEqual(["base_v1", "ink-wash", "wan"]);
    expect(deriveResourceNames("not json")).toBeNull();
  });
});

describe("TagSuggestionService", () => {
  // A library of made-up prompts; clips are catalog rows.
  function promptGraph(text, lora = "plain") {
    return JSON.stringify({
      1: { class_type: "CLIPTextEncode", inputs: { text, clip: ["4", 1] } },
      2: { class_type: "KSampler", inputs: { seed: 7, steps: 20, positive: ["1", 0], model: ["5", 0] } },
      4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "base.safetensors" } },
      5: { class_type: "LoraLoader", inputs: { lora_name: `${lora}.safetensors`, model: ["4", 0] } },
    });
  }

  function createLibrary(clips) {
    // clips: [{ text, lora?, tags: [tagId], dismissed?: [tagId] }]
    const tags = [
      { id: 1, name: "dance", parentId: null },
      { id: 2, name: "sea", parentId: null },
      { id: 3, name: "city", parentId: null },
      { id: 4, name: "ink", parentId: null },
    ];
    const rows = clips.map((clip, index) => {
      const prompt = promptGraph(clip.text, clip.lora);
      return {
        instanceId: index + 1,
        fingerprint: `fp-${index}`,
        promptKey: computeGenerationKeys(prompt).promptKey,
        prompt,
        tagIds: [...(clip.tags || [])],
        dismissedTagIds: [...(clip.dismissed || [])],
        absolutePath: `/library/clip-${index}.mp4`,
      };
    });
    const byKey = new Map(rows.map((row) => [row.promptKey, row]));
    const byPath = new Map(rows.map((row) => [row.absolutePath, row]));
    const store = {
      listPresentInstancesForPromptKey: vi.fn((key) =>
        byKey.has(key)
          ? [{ absolutePath: byKey.get(key).absolutePath, rootPath: "/library", size: 1, mtimeMs: 1 }]
          : []
      ),
      getTagSuggestionLabels: vi.fn(() => ({
        tags,
        links: rows.flatMap((row) =>
          row.tagIds.map((tagId) => ({ promptKey: row.promptKey, fingerprint: row.fingerprint, tagId }))
        ),
        dismissals: rows.flatMap((row) =>
          row.dismissedTagIds.map((tagId) => ({
            promptKey: row.promptKey,
            fingerprint: row.fingerprint,
            tagId,
          }))
        ),
      })),
      getTagSuggestionTargets: vi.fn((ids) =>
        rows
          .filter((row) => ids.includes(row.instanceId))
          .map(({ instanceId, fingerprint, promptKey, tagIds, dismissedTagIds }) => ({
            instanceId,
            fingerprint,
            promptKey,
            tagIds: [...tagIds],
            dismissedTagIds: [...dismissedTagIds],
          }))
      ),
    };
    const readIsoPayload = vi.fn(async (filePath) => ({
      status: "found",
      payload: { prompt: byPath.get(filePath).prompt },
    }));
    const prompts = new PromptSimilarityService({
      fsPromises: { realpath: async (target) => target },
      readIsoPayload,
      yieldToEventLoop: async () => {},
    });
    const service = new TagSuggestionService({
      promptService: prompts,
      yieldToEventLoop: async () => {},
    });
    return { rows, store, readIsoPayload, prompts, service };
  }

  const TOPIC_TAG = { dance: 1, sea: 2, city: 3 };
  function taggedLibrary({ untagged = [] } = {}) {
    const clips = [];
    let seed = 100;
    for (const topic of ["dance", "sea", "city"]) {
      for (let index = 0; index < 12; index += 1) {
        clips.push({ text: topicText(topic, (seed += 13)), tags: [TOPIC_TAG[topic]] });
      }
    }
    return createLibrary([...clips, ...untagged]);
  }

  it("suggests learned tags by name for untagged clips and never sends prompt words", async () => {
    const library = taggedLibrary({
      untagged: [{ text: topicText("dance", 5001) }, { text: topicText("sea", 5002) }],
    });
    const [dancing, harbour] = library.rows.slice(-2).map((row) => row.instanceId);
    const suggestions = await library.service.suggest({
      store: library.store,
      instanceIds: [dancing, harbour, 1],
    });
    expect(suggestions[dancing].map((entry) => entry.tag)).toEqual(["dance"]);
    expect(suggestions[harbour].map((entry) => entry.tag)).toEqual(["sea"]);
    // Clip 1 already carries "dance".
    expect(suggestions[1]).toBeUndefined();
    expect(suggestions[dancing][0].precision).toBeGreaterThanOrEqual(0.8);
    const sent = JSON.stringify(suggestions);
    expect(sent).not.toMatch(/dancing|harbour|filler/u);
  });

  it("shows learning in the activity line, and a pause does not hold it", async () => {
    const library = taggedLibrary({ untagged: [{ text: topicText("dance", 7001) }] });
    const progress = vi.fn();
    const finish = vi.fn();
    const begin = vi.fn(() => ({ progress, finish }));
    library.service.activity = { begin, isPaused: () => true, whenRunnable: () => new Promise(() => {}) };
    const target = library.rows.at(-1).instanceId;
    const suggestions = await library.service.suggest({ store: library.store, instanceIds: [target] });
    expect(suggestions[target].map((entry) => entry.tag)).toEqual(["dance"]);
    expect(begin).toHaveBeenCalledWith("tag-suggestions", { total: 3 });
    expect(progress.mock.calls.map(([done]) => done)).toEqual([1, 2, 3]);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("learns once until the tags change, and relearns without reading prompts again", async () => {
    const library = taggedLibrary({ untagged: [{ text: topicText("dance", 6001) }] });
    const target = library.rows.at(-1).instanceId;
    await library.service.suggest({ store: library.store, instanceIds: [target] });
    const reads = library.readIsoPayload.mock.calls.length;
    const first = library.service.learned;
    await library.service.suggest({ store: library.store, instanceIds: [target] });
    expect(library.service.learned).toBe(first);

    library.rows.at(-1).dismissedTagIds.push(1);
    const after = await library.service.suggest({ store: library.store, instanceIds: [target] });
    expect(library.service.learned).not.toBe(first);
    expect(after[target]).toBeUndefined();
    expect(library.readIsoPayload).toHaveBeenCalledTimes(reads);
  });

  it("lists which tags can be suggested", async () => {
    const library = taggedLibrary();
    const status = await library.service.status({ store: library.store });
    expect(status.map((entry) => [entry.name, entry.usable, entry.examples])).toEqual([
      ["city", true, 12],
      ["dance", true, 12],
      ["sea", true, 12],
    ]);
  });

  it("finds rows that might be a tag, minus tagged and turned-down ones", async () => {
    const library = taggedLibrary({
      untagged: [
        { text: topicText("dance", 7001) },
        { text: topicText("dance", 7002), dismissed: [1] },
        { text: topicText("city", 7003) },
      ],
    });
    const ids = library.rows.map((row) => row.instanceId);
    const [open, turnedDown, city] = ids.slice(-3);
    const found = await library.service.mightBe({ store: library.store, instanceIds: ids, tagName: "Dance" });
    expect(found).toEqual({ usable: true, matches: [open] });
    expect(found.matches).not.toContain(turnedDown);
    expect(found.matches).not.toContain(city);

    const keys = await library.service.mightBeKeys({
      store: library.store,
      promptKeys: library.rows.map((row) => row.promptKey),
      tagName: "dance",
    });
    // A library search leaves tagged and turned-down clips to the query.
    expect(keys.matches).toContain(library.rows.at(-3).promptKey);
    expect(keys.matches).toContain(library.rows[0].promptKey);

    expect(
      await library.service.mightBe({ store: library.store, instanceIds: ids, tagName: "nope" })
    ).toEqual({ usable: false, matches: [] });
  });

  it("learns from the LoRA a graph loads", async () => {
    const clips = [];
    let seed = 300;
    for (let index = 0; index < 24; index += 1) {
      // Same kind of words either way: only the LoRA tells them apart.
      const inked = index % 2 === 0;
      clips.push({
        text: topicText(index % 3 === 0 ? "sea" : "city", (seed += 17)),
        lora: inked ? "ink-wash" : "plain",
        tags: inked ? [4] : [2],
      });
    }
    clips.push({ text: topicText("city", 8001), lora: "ink-wash" });
    const library = createLibrary(clips);
    const target = library.rows.at(-1).instanceId;
    const suggestions = await library.service.suggest({ store: library.store, instanceIds: [target] });
    expect(suggestions[target].map((entry) => entry.tag)).toEqual(["ink"]);
  });

  it("forgets what it learned when cleared", async () => {
    const library = taggedLibrary();
    await library.service.status({ store: library.store });
    expect(library.service.learned).not.toBeNull();
    library.service.clear();
    expect(library.service.learned).toBeNull();
  });

  it("stops when the profile context ends", async () => {
    const library = taggedLibrary();
    const ended = Object.assign(new Error("Profile changed"), { code: "PROFILE_CHANGED" });
    await expect(
      library.service.status({
        store: library.store,
        assertActive: () => {
          throw ended;
        },
      })
    ).rejects.toBe(ended);
    expect(library.service.learned).toBeNull();
    expect(library.service.learning).toBeNull();
  });
});
