import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  PromptSimilarityService,
  similarPromptPairs,
  similarPromptPairsInSlices,
  createWordDictionary,
  parsePromptQuery,
} = require("../prompt-similarity");
const { computeGenerationKeys } = require("../generation-key");

const BASE = "a quiet harbour at dawn with fishing boats and gulls over calm water";

const dictionary = createWordDictionary();

function group(key, ...texts) {
  return {
    key,
    texts: texts.map((text) => ({ id: `id:${text}`, words: dictionary.idsOf(text) })),
  };
}

function reworded(text, replacements) {
  let result = text;
  for (const [from, to] of replacements) result = result.replace(from, to);
  return result;
}

const pairsOf = (alike) => Object.fromEntries([...alike].map(([key, keys]) => [key, [...keys].sort()]));

describe("similarPromptPairs", () => {
  it("pairs reworded prompts both ways and leaves unrelated ones out", () => {
    const alike = similarPromptPairs(
      [
        group("pk-a", BASE),
        group("pk-b", reworded(BASE, [["gulls", "terns"]])),
        group("pk-c", "neon city street at night in heavy rain with reflections"),
      ],
      { threshold: 0.8 }
    );
    expect(pairsOf(alike)).toEqual({ "pk-a": ["pk-b"], "pk-b": ["pk-a"] });
  });

  it("respects the threshold", () => {
    const changed = reworded(BASE, [
      ["quiet", "busy"],
      ["dawn", "dusk"],
      ["calm", "rough"],
    ]);
    const groups = [group("pk-a", BASE), group("pk-b", changed)];
    expect(similarPromptPairs(groups, { threshold: 0.8 }).size).toBe(0);
    expect(pairsOf(similarPromptPairs(groups, { threshold: 0.6 }))["pk-b"]).toEqual(["pk-a"]);
  });

  it("finds exactly the pairs a direct comparison finds", () => {
    const words = BASE.split(" ");
    const groups = Array.from({ length: 30 }, (_, index) =>
      group(
        `pk-${String(index).padStart(2, "0")}`,
        words.map((word, at) => ((at * 7 + index) % 11 < index % 5 ? `${word}${index}` : word)).join(" ")
      )
    );
    const threshold = 0.7;
    const expected = {};
    const sets = groups.map((entry) => new Set(entry.texts[0].words));
    for (let a = 0; a < groups.length; a += 1) {
      for (let b = 0; b < groups.length; b += 1) {
        if (a === b) continue;
        const shared = [...sets[a]].filter((word) => sets[b].has(word)).length;
        if (shared / (sets[a].size + sets[b].size - shared) >= threshold) {
          (expected[groups[a].key] ||= []).push(groups[b].key);
        }
      }
    }
    Object.values(expected).forEach((keys) => keys.sort());
    expect(Object.keys(expected).length).toBeGreaterThan(3);
    expect(pairsOf(similarPromptPairs(groups, { threshold }))).toEqual(expected);
  });

  it("ignores a text shared by many prompts", () => {
    const negative = "blurry low quality watermark text distorted extra limbs";
    const groups = [
      group("pk-1", "red fox running through snow", negative),
      group("pk-2", "old man reading on a park bench", negative),
      group("pk-3", "spaceship landing on a desert planet", negative),
      group("pk-4", "children flying kites on a beach", negative),
    ];
    expect(similarPromptPairs(groups, { threshold: 0.7 }).size).toBe(0);
  });

  it("pairs only prompts over the same input media", () => {
    const withMedia = (key, media) => ({ ...group(key, BASE), media });
    const alike = similarPromptPairs(
      [
        withMedia("pk-a", "clip.mp4@in_time=0"),
        withMedia("pk-b", "clip.mp4@in_time=30"),
        withMedia("pk-c", "clip.mp4@in_time=0"),
      ],
      { threshold: 0.8 }
    );
    expect(pairsOf(alike)).toEqual({ "pk-a": ["pk-c"], "pk-c": ["pk-a"] });
  });

  it("numbers each word once, ignoring case and punctuation", () => {
    const words = createWordDictionary();
    expect([...words.idsOf("A cat, a CAT!")]).toEqual([0, 1]);
    expect([...words.idsOf("the cat")]).toEqual([1, 2]);
  });

  it("gives the same answer in slices as at once", () => {
    const groups = Array.from({ length: 40 }, (_, index) =>
      group(`pk-${String(index).padStart(2, "0")}`, `${BASE} variant${index % 5}`)
    );
    const steps = similarPromptPairsInSlices(groups, { threshold: 0.8, clusterSlice: 4 });
    let slices = 0;
    let step = steps.next();
    while (!step.done) {
      slices += 1;
      step = steps.next();
    }
    expect(slices).toBeGreaterThan(5);
    expect(pairsOf(step.value)).toEqual(pairsOf(similarPromptPairs(groups, { threshold: 0.8 })));
    expect(step.value.size).toBe(40);
  });

  it("leaves very short prompts out", () => {
    expect(similarPromptPairs([group("pk-a", "a cat"), group("pk-b", "a cat")], { threshold: 0.8 }).size).toBe(0);
  });
});

function promptFor(text) {
  return JSON.stringify({
    1: { class_type: "CLIPTextEncode", inputs: { text, clip: ["4", 1] } },
    2: { class_type: "KSampler", inputs: { seed: 7, steps: 20, positive: ["1", 0] } },
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
  });
}

function createLibrary(prompts) {
  const byKey = new Map();
  prompts.forEach((prompt, index) => {
    const key = computeGenerationKeys(prompt).promptKey;
    byKey.set(key, {
      absolutePath: `/library/clip-${index}.mp4`,
      rootPath: "/library",
      size: 100,
      mtimeMs: 1000,
      prompt,
    });
  });
  const store = {
    listPresentInstancesForPromptKey: vi.fn((key) =>
      byKey.has(key) ? [byKey.get(key)] : []
    ),
  };
  const byPath = new Map([...byKey.values()].map((row) => [row.absolutePath, row]));
  const readIsoPayload = vi.fn(async (filePath) => ({
    status: "found",
    payload: { prompt: byPath.get(filePath).prompt },
  }));
  const fsPromises = { realpath: vi.fn(async (target) => target) };
  return { keys: [...byKey.keys()], store, readIsoPayload, fsPromises };
}

describe("PromptSimilarityService", () => {
  const close = promptFor(BASE);
  const closer = promptFor(reworded(BASE, [["gulls", "terns"]]));
  const far = promptFor("neon city street at night in heavy rain with reflections");

  function service(library, extra = {}) {
    return new PromptSimilarityService({
      fsPromises: library.fsPromises,
      readIsoPayload: library.readIsoPayload,
      yieldToEventLoop: async () => {},
      ...extra,
    });
  }

  it("returns prompt keys only and reads each prompt once", async () => {
    const library = createLibrary([close, closer, far]);
    const similarity = service(library);
    const [keyA, keyB, keyC] = library.keys;
    const promptKeys = [keyA, keyB, keyC];
    const alike = await similarity.similarPrompts({
      store: library.store,
      promptKeys,
      threshold: 0.8,
    });
    expect(alike).toEqual({ [keyA]: [keyB], [keyB]: [keyA] });
    expect(JSON.stringify(alike)).not.toContain("harbour");

    await similarity.similarPrompts({ store: library.store, promptKeys, threshold: 0.7 });
    expect(library.readIsoPayload).toHaveBeenCalledTimes(3);
  });

  it("scores how alike candidates are to one prompt, keys only", async () => {
    const library = createLibrary([close, closer, far]);
    const similarity = service(library);
    const [keyA, keyB, keyC] = library.keys;
    const scores = await similarity.alikeScores({
      store: library.store,
      promptKey: keyA,
      candidateKeys: [keyB, keyC, keyA, "pk-unreadable"],
    });
    expect([...scores.keys()].sort()).toEqual([keyB, keyC].sort());
    expect(scores.get(keyB)).toBeGreaterThan(0.8);
    expect(scores.get(keyC)).toBeLessThan(scores.get(keyB));
    expect(JSON.stringify([...scores])).not.toContain("harbour");
    // Bounded, and nothing at all for a prompt that cannot be read.
    expect((await similarity.alikeScores({ store: library.store, promptKey: keyA, candidateKeys: [keyB, keyC], limit: 1 })).size).toBe(1);
    expect((await similarity.alikeScores({ store: library.store, promptKey: "pk-unreadable", candidateKeys: [keyB] })).size).toBe(0);
  });

  it("skips a file outside its root and a file whose prompt changed", async () => {
    const library = createLibrary([close, closer]);
    const [keyA, keyB] = library.keys;
    library.fsPromises.realpath.mockImplementation(async (target) =>
      target.endsWith("clip-1.mp4") ? "/elsewhere/clip-1.mp4" : target
    );
    const promptKeys = [keyA, keyB];
    expect(
      await service(library).similarPrompts({ store: library.store, promptKeys, threshold: 0.8 })
    ).toEqual({});

    const edited = createLibrary([close, closer]);
    edited.readIsoPayload.mockImplementation(async () => ({
      status: "found",
      payload: { prompt: far },
    }));
    expect(
      await service(edited).similarPrompts({ store: edited.store, promptKeys, threshold: 0.8 })
    ).toEqual({});
  });

  it("stops a request superseded by a newer one", async () => {
    const library = createLibrary([close, closer]);
    const [keyA, keyB] = library.keys;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const similarity = service(library, {
      limits: { yieldEvery: 1 },
      yieldToEventLoop: () => gate,
    });
    const first = similarity.similarPrompts({
      store: library.store,
      promptKeys: [keyA, keyB],
      threshold: 0.8,
    });
    await vi.waitFor(() => expect(library.readIsoPayload).toHaveBeenCalled());
    similarity.clear();
    release();
    expect(await first).toBeNull();
  });

  it("stops when the profile context ends", async () => {
    const library = createLibrary([close]);
    const assertActive = vi.fn(() => {
      throw new Error("inactive");
    });
    await expect(
      service(library).similarPrompts({
        store: library.store,
        promptKeys: [library.keys[0]],
        threshold: 0.8,
        assertActive,
      })
    ).rejects.toThrow("inactive");
  });
});

describe("prompt search", () => {
  function promptWithNegative(positive, negative) {
    return JSON.stringify({
      1: { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["4", 1] } },
      2: { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["4", 1] } },
      3: { class_type: "KSampler", inputs: { seed: 7, steps: 20, positive: ["1", 0], negative: ["2", 0] } },
      4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
    });
  }

  it("parses words to find and -words to rule out, quoted ones exactly", () => {
    const starts = (word) => ({ word, exact: false });
    const exactly = (word) => ({ word, exact: true });
    expect(parsePromptQuery("  Dance -Night  dance-floor ")).toEqual({
      include: [starts("dance"), starts("floor")],
      exclude: [starts("night")],
    });
    expect(parsePromptQuery('"Pan" -"pan-am" "golden hour" pan')).toEqual({
      include: [exactly("pan"), { phrase: ["golden", "hour"] }, starts("pan")],
      exclude: [{ phrase: ["pan", "am"] }],
    });
    // A quote still being typed already counts.
    expect(parsePromptQuery('city "pan')).toEqual({
      include: [starts("city"), exactly("pan")],
      exclude: [],
    });
    expect(parsePromptQuery("")).toEqual({ include: [], exclude: [] });
  });

  it("finds prompts by word starts, all words, minus excluded ones, never by negatives", async () => {
    const negative = "blurry low quality watermark";
    const library = createLibrary([
      promptWithNegative("a woman dancing on a beach at night", negative),
      promptWithNegative("a woman dancing in a studio at noon", negative),
      promptWithNegative("an old lighthouse on a cliff in fog", negative),
      promptWithNegative("a sleeping panda in a bamboo forest", negative),
      promptWithNegative("a wheat field at golden hour with wind", negative),
      promptWithNegative("the last hour of golden evening light", negative),
    ]);
    const [beach, studio, lighthouse, panda, field, evening] = library.keys;
    const search = new PromptSimilarityService({
      fsPromises: library.fsPromises,
      readIsoPayload: library.readIsoPayload,
      yieldToEventLoop: async () => {},
    });
    const find = async (query) =>
      (await search.searchPrompts({ store: library.store, promptKeys: library.keys, query })).matches.sort();

    expect(await find("danc")).toEqual([beach, studio].sort());
    expect(await find("dancing night")).toEqual([beach]);
    expect(await find("woman -beach")).toEqual([studio]);
    expect(await find("lighthouse")).toEqual([lighthouse]);
    expect(await find("blurry")).toEqual([]);
    expect(await find("")).toEqual([]);
    // In quotes, a word matches only itself: "pan" is not "panda".
    expect(await find("pan")).toEqual([panda]);
    expect(await find('"pan"')).toEqual([]);
    expect(await find('"panda" -"pan"')).toEqual([panda]);
    expect(await find('"panda" -pan')).toEqual([]);
    expect(await find('"woman" -"studi"')).toEqual([beach, studio].sort());
    // Several words in quotes are a phrase: whole words, in that order.
    expect(await find("golden hour")).toEqual([field, evening].sort());
    expect(await find('"golden hour"')).toEqual([field]);
    expect(await find('"hour golden"')).toEqual([]);
    expect(await find('"golden hou"')).toEqual([]);
    expect(await find('golden -"golden hour"')).toEqual([evening]);
    // A phrase is matched within one text, never across into the negative
    // prompt.
    expect(await find('"with wind blurry"')).toEqual([]);
    // Prompts are read once; later searches are lookups.
    expect(library.readIsoPayload).toHaveBeenCalledTimes(6);
  });
});
