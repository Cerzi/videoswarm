import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  PromptSimilarityService,
  clusterSimilarPrompts,
  clusterSimilarPromptsInSlices,
  createWordDictionary,
} = require("../prompt-similarity");
const { computeGenerationKeys } = require("../generation-key");

const BASE = "a quiet harbour at dawn with fishing boats and gulls over calm water";

const dictionary = createWordDictionary();

function group(key, count, ...texts) {
  return {
    key,
    count,
    texts: texts.map((text) => ({ id: `id:${text}`, words: dictionary.idsOf(text) })),
  };
}

function reworded(text, replacements) {
  let result = text;
  for (const [from, to] of replacements) result = result.replace(from, to);
  return result;
}

describe("clusterSimilarPrompts", () => {
  it("joins reworded runs to the largest close prompt", () => {
    const joined = clusterSimilarPrompts(
      [
        group("pk-small", 1, reworded(BASE, [["gulls", "terns"]])),
        group("pk-big", 5, BASE),
        group("pk-other", 2, "neon city street at night in heavy rain with reflections"),
      ],
      { threshold: 0.8 }
    );
    expect(Object.fromEntries(joined)).toEqual({ "pk-small": "pk-big" });
  });

  it("respects the threshold", () => {
    const changed = reworded(BASE, [
      ["quiet", "busy"],
      ["dawn", "dusk"],
      ["calm", "rough"],
    ]);
    const groups = [group("pk-a", 3, BASE), group("pk-b", 1, changed)];
    expect(clusterSimilarPrompts(groups, { threshold: 0.8 }).size).toBe(0);
    expect(clusterSimilarPrompts(groups, { threshold: 0.6 }).get("pk-b")).toBe("pk-a");
  });

  it("never chains a run of small edits through joined prompts", () => {
    const words = BASE.split(" ");
    const steps = [0, 1, 2, 3].map((offset) =>
      words.map((word, index) => (index < offset * 2 ? `${word}x` : word)).join(" ")
    );
    const joined = clusterSimilarPrompts(
      steps.map((text, index) => group(`pk-${index}`, 10 - index, text)),
      { threshold: 0.7 }
    );
    // Step 1 is close to step 0 and step 3 to step 2, but step 3 never
    // reaches step 0 through them.
    expect(joined.get("pk-1")).toBe("pk-0");
    expect(joined.get("pk-3")).toBe("pk-2");
    for (const anchor of joined.values()) expect(joined.has(anchor)).toBe(false);
  });

  it("ignores a text shared by many prompts", () => {
    const negative = "blurry low quality watermark text distorted extra limbs";
    const groups = [
      group("pk-1", 1, "red fox running through snow", negative),
      group("pk-2", 1, "old man reading on a park bench", negative),
      group("pk-3", 1, "spaceship landing on a desert planet", negative),
      group("pk-4", 1, "children flying kites on a beach", negative),
    ];
    expect(clusterSimilarPrompts(groups, { threshold: 0.7 }).size).toBe(0);
  });

  it("joins only prompts over the same input media", () => {
    const withMedia = (key, count, media) => ({ ...group(key, count, BASE), media });
    const joined = clusterSimilarPrompts(
      [
        withMedia("pk-a", 3, "clip.mp4@in_time=0"),
        withMedia("pk-b", 1, "clip.mp4@in_time=30"),
        withMedia("pk-c", 1, "clip.mp4@in_time=0"),
      ],
      { threshold: 0.8 }
    );
    expect(Object.fromEntries(joined)).toEqual({ "pk-c": "pk-a" });
  });

  it("numbers each word once, ignoring case and punctuation", () => {
    const words = createWordDictionary();
    expect([...words.idsOf("A cat, a CAT!")]).toEqual([0, 1]);
    expect([...words.idsOf("the cat")]).toEqual([1, 2]);
  });

  it("gives the same answer in slices as at once", () => {
    const groups = Array.from({ length: 40 }, (_, index) =>
      group(`pk-${String(index).padStart(2, "0")}`, 40 - index, `${BASE} variant${index % 5}`)
    );
    const steps = clusterSimilarPromptsInSlices(groups, { threshold: 0.8, clusterSlice: 4 });
    let slices = 0;
    let step = steps.next();
    while (!step.done) {
      slices += 1;
      step = steps.next();
    }
    expect(slices).toBeGreaterThan(5);
    expect(step.value).toEqual(clusterSimilarPrompts(groups, { threshold: 0.8 }));
    expect(step.value.size).toBe(39);
  });

  it("leaves very short prompts on their own keys", () => {
    const joined = clusterSimilarPrompts(
      [group("pk-a", 2, "a cat"), group("pk-b", 1, "a cat")],
      { threshold: 0.8 }
    );
    expect(joined.size).toBe(0);
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
    const entries = [
      { promptKey: keyA, count: 4 },
      { promptKey: keyB, count: 1 },
      { promptKey: keyC, count: 2 },
    ];
    const groups = await similarity.similarGroups({
      store: library.store,
      entries,
      threshold: 0.8,
    });
    expect(groups).toEqual({ [keyB]: keyA });
    expect(JSON.stringify(groups)).not.toContain("harbour");

    await similarity.similarGroups({ store: library.store, entries, threshold: 0.7 });
    expect(library.readIsoPayload).toHaveBeenCalledTimes(3);
  });

  it("skips a file outside its root and a file whose prompt changed", async () => {
    const library = createLibrary([close, closer]);
    const [keyA, keyB] = library.keys;
    library.fsPromises.realpath.mockImplementation(async (target) =>
      target.endsWith("clip-1.mp4") ? "/elsewhere/clip-1.mp4" : target
    );
    const entries = [
      { promptKey: keyA, count: 4 },
      { promptKey: keyB, count: 1 },
    ];
    expect(
      await service(library).similarGroups({ store: library.store, entries, threshold: 0.8 })
    ).toEqual({});

    const edited = createLibrary([close, closer]);
    edited.readIsoPayload.mockImplementation(async () => ({
      status: "found",
      payload: { prompt: far },
    }));
    expect(
      await service(edited).similarGroups({ store: edited.store, entries, threshold: 0.8 })
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
    const entries = [
      { promptKey: keyA, count: 4 },
      { promptKey: keyB, count: 1 },
    ];
    const first = similarity.similarGroups({ store: library.store, entries, threshold: 0.8 });
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
      service(library).similarGroups({
        store: library.store,
        entries: [{ promptKey: library.keys[0], count: 1 }],
        threshold: 0.8,
        assertActive,
      })
    ).rejects.toThrow("inactive");
  });
});
