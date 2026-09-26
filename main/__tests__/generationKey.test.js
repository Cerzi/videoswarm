import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  GENERATION_KEY_LIMITS,
  computeGenerationKey,
  deriveGenerationKeyParts,
  isGenerationKey,
} = require("../generation-key");

const fixtureDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "generation-key"
);

// Reduced copies of real ComfyUI API prompts. Topology, seeds and the
// equality structure of every string are preserved; prompt text, paths,
// model names and hashes are placeholders. Several contain Python's NaN,
// exactly as ComfyUI writes it.
function fixture(name) {
  return fs.readFileSync(path.join(fixtureDirectory, `${name}.prompt.txt`), "utf8");
}

const TEXT_A = "a quiet harbour at dawn with fishing boats";
const TEXT_B = "slow camera push toward the lighthouse";

function graph(nodes) {
  return JSON.stringify(nodes);
}

function samplerGraph({ seed = 42, text = TEXT_A, extra = {} } = {}) {
  return graph({
    1: { class_type: "CLIPTextEncode", inputs: { text, clip: ["4", 1] } },
    2: {
      class_type: "KSampler",
      inputs: { seed, steps: 20, cfg: 6.5, positive: ["1", 0] },
    },
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
    ...extra,
  });
}

describe("generation key fixtures", () => {
  const keyOf = (name) => computeGenerationKey(fixture(name));

  it("groups a draft with its two re-renders", () => {
    const keys = ["draft-rerender-1", "draft-rerender-2", "draft-rerender-3"].map(keyOf);
    expect(isGenerationKey(keys[0])).toBe(true);
    expect(new Set(keys).size).toBe(1);
  });

  it("groups a settings sweep", () => {
    const keys = ["settings-sweep-1", "settings-sweep-2", "settings-sweep-3"].map(keyOf);
    expect(isGenerationKey(keys[0])).toBe(true);
    expect(new Set(keys).size).toBe(1);
  });

  it("groups V2V runs through a one-hop PrimitiveInt seed and keeps their media", () => {
    const keys = ["v2v-one-hop-1", "v2v-one-hop-2"].map(keyOf);
    expect(isGenerationKey(keys[0])).toBe(true);
    expect(keys[1]).toBe(keys[0]);
    const parts = deriveGenerationKeyParts(fixture("v2v-one-hop-1"));
    expect(parts.seeds).toEqual(["123"]);
    expect(parts.media).toEqual(["source-a.mp4", "source-b.webm"]);
  });

  it("does not key a seedless processing workflow", () => {
    expect(keyOf("seedless-masking-1")).toBeNull();
  });

  it("keeps the three sets apart", () => {
    const keys = new Set(
      ["draft-rerender-1", "settings-sweep-1", "v2v-one-hop-1"].map(keyOf)
    );
    expect(keys.size).toBe(3);
  });

  it("counts a seed reached directly and through the hop once", () => {
    const parts = deriveGenerationKeyParts(fixture("draft-rerender-1"));
    expect(parts.seeds).toEqual(["806024583300336"]);
  });
});

describe("computeGenerationKey seeds", () => {
  it("requires a seed and a text", () => {
    expect(computeGenerationKey(samplerGraph())).toMatch(/^gk1-[0-9a-f]{32}$/);
    expect(computeGenerationKey(samplerGraph({ text: "too short here" }))).toBeNull();
    expect(
      computeGenerationKey(
        graph({ 1: { class_type: "CLIPTextEncode", inputs: { text: TEXT_A } } })
      )
    ).toBeNull();
  });

  it("matches seed input names case-insensitively", () => {
    const upper = graph({
      1: { class_type: "Custom", inputs: { Noise_SEED: 7, prompt: TEXT_A } },
    });
    expect(deriveGenerationKeyParts(upper).seeds).toEqual(["7"]);
  });

  it("keeps 64-bit seeds exact beyond the safe integer range", () => {
    const low = '{"1":{"inputs":{"seed":18446744073709551614,"t":"' + TEXT_A + '"}}}';
    const high = '{"1":{"inputs":{"seed":18446744073709551615,"t":"' + TEXT_A + '"}}}';
    expect(deriveGenerationKeyParts(high).seeds).toEqual(["18446744073709551615"]);
    expect(computeGenerationKey(low)).not.toBe(computeGenerationKey(high));
  });

  it("follows exactly one hop to a node with a sole integer literal", () => {
    const hop = samplerGraph({
      seed: ["9", 0],
      extra: { 9: { class_type: "PrimitiveInt", inputs: { value: 1234 } } },
    });
    expect(deriveGenerationKeyParts(hop).seeds).toEqual(["1234"]);
    expect(computeGenerationKey(hop)).toBe(computeGenerationKey(samplerGraph({ seed: 1234 })));
  });

  it("ignores a hop to a node with zero or several integer literals", () => {
    const several = samplerGraph({
      seed: ["9", 0],
      extra: { 9: { class_type: "Mixer", inputs: { a: 1, b: 2 } } },
    });
    const none = samplerGraph({
      seed: ["9", 0],
      extra: { 9: { class_type: "Floaty", inputs: { value: 1.5, other: ["4", 0] } } },
    });
    expect(computeGenerationKey(several)).toBeNull();
    expect(computeGenerationKey(none)).toBeNull();
  });

  it("does not follow a second hop", () => {
    const twoHops = samplerGraph({
      seed: ["9", 0],
      extra: {
        9: { class_type: "Passthrough", inputs: { value: ["10", 0] } },
        10: { class_type: "PrimitiveInt", inputs: { value: 5 } },
      },
    });
    expect(computeGenerationKey(twoHops)).toBeNull();
  });

  it("treats floats, booleans and strings in seed inputs as absent", () => {
    for (const seed of [1.5, true, "42", null]) {
      expect(computeGenerationKey(samplerGraph({ seed }))).toBeNull();
    }
    expect(computeGenerationKey('{"1":{"inputs":{"seed":42.0,"t":"' + TEXT_A + '"}}}')).toBeNull();
  });
});

describe("computeGenerationKey texts and media", () => {
  it("normalizes whitespace and case in texts", () => {
    const spaced = samplerGraph({ text: `  A QUIET harbour\n at   dawn\twith fishing boats ` });
    expect(computeGenerationKey(spaced)).toBe(computeGenerationKey(samplerGraph()));
  });

  it("finds text in any node regardless of class or input name", () => {
    const custom = graph({
      5: { class_type: "SomeComposer", inputs: { detailed_description: TEXT_A, seed: 42 } },
    });
    expect(computeGenerationKey(custom)).toBe(
      computeGenerationKey(
        graph({ 1: { class_type: "X", inputs: { anything: TEXT_A, noise_seed: 42 } } })
      )
    );
  });

  it("is independent of node ids, order and non-identity settings", () => {
    const reordered = graph({
      20: { class_type: "KSampler", inputs: { steps: 40, cfg: 3, seed: 42 } },
      10: { class_type: "Encode", inputs: { text: TEXT_A } },
      30: { class_type: "UNETLoader", inputs: { unet_name: "other.safetensors" } },
    });
    expect(computeGenerationKey(reordered)).toBe(computeGenerationKey(samplerGraph()));
  });

  it("separates different texts and different seeds", () => {
    const base = computeGenerationKey(samplerGraph());
    expect(computeGenerationKey(samplerGraph({ text: TEXT_B }))).not.toBe(base);
    expect(computeGenerationKey(samplerGraph({ seed: 43 }))).not.toBe(base);
  });

  it("keeps runs with the same prompt but different input media apart", () => {
    const withSource = (value) =>
      samplerGraph({ extra: { 7: { class_type: "LoadVideo", inputs: { video: value } } } });
    const a = computeGenerationKey(withSource("inputs/clip one.mp4"));
    expect(a).toBe(computeGenerationKey(withSource("C:\\elsewhere\\clip one.mp4")));
    expect(computeGenerationKey(withSource("inputs/clip two.mp4"))).not.toBe(a);
    expect(deriveGenerationKeyParts(withSource("x/Photo.JPEG")).media).toEqual(["Photo.JPEG"]);
  });

  it("never counts a media path as text", () => {
    const parts = deriveGenerationKeyParts(
      samplerGraph({
        extra: { 7: { class_type: "Load", inputs: { video: "my long holiday video file.mp4" } } },
      })
    );
    expect(parts.texts).toEqual([TEXT_A]);
    expect(parts.media).toEqual(["my long holiday video file.mp4"]);
  });

  it("ignores nested objects and linked inputs when collecting text", () => {
    const nested = samplerGraph({
      extra: { 8: { class_type: "Lora", inputs: { lora_1: { note: TEXT_B }, list: [TEXT_B] } } },
    });
    expect(computeGenerationKey(nested)).toBe(computeGenerationKey(samplerGraph()));
  });
});

describe("computeGenerationKey is total", () => {
  it("accepts Python NaN and Infinity outside strings and leaves strings alone", () => {
    const withNaN =
      '{"1":{"inputs":{"seed":42,"t":"' +
      TEXT_A +
      '","bad":NaN,"worse":-Infinity,"note":"NaN Infinity are words here"},"is_changed":[NaN]}}';
    const parts = deriveGenerationKeyParts(withNaN);
    expect(parts.seeds).toEqual(["42"]);
    expect(parts.texts).toContain("nan infinity are words here");
  });

  it("unwraps a double-stringified payload and a prompt envelope", () => {
    const direct = samplerGraph();
    expect(computeGenerationKey(JSON.stringify(direct))).toBe(computeGenerationKey(direct));
    const envelope = JSON.stringify({ prompt: JSON.parse(direct), workflow: { nodes: [] } });
    expect(computeGenerationKey(envelope)).toBe(computeGenerationKey(direct));
    const stringEnvelope = JSON.stringify({ prompt: direct });
    expect(computeGenerationKey(stringEnvelope)).toBe(computeGenerationKey(direct));
  });

  it("rejects an already-parsed object, whose integers are no longer exact", () => {
    expect(computeGenerationKey(JSON.parse(samplerGraph()))).toBeNull();
  });

  it("returns null for malformed and hostile shapes without throwing", () => {
    const hostile = [
      undefined,
      null,
      "",
      "   ",
      "not json",
      '{"1":',
      "[]",
      "42",
      '"just a string"',
      '{"1": null, "2": 5, "3": {"inputs": null}, "4": {"inputs": [1, 2]}}',
      '{"__proto__": {"inputs": {"seed": 1, "t": "' + TEXT_A + '"}}}',
      123,
      [],
      new Map(),
      JSON.stringify(JSON.stringify(JSON.stringify(JSON.parse(samplerGraph())))),
    ];
    for (const value of hostile) {
      expect(() => computeGenerationKey(value)).not.toThrow();
    }
    expect(computeGenerationKey('{"1":')).toBeNull();
    expect(computeGenerationKey(new Map())).toBeNull();
  });

  it("returns null when a bound is exceeded rather than keying a truncated graph", () => {
    const wide = {};
    for (let index = 0; index <= GENERATION_KEY_LIMITS.maxNodes; index += 1) {
      wide[index] = { inputs: { seed: 1, text: TEXT_A } };
    }
    expect(computeGenerationKey(JSON.stringify(wide))).toBeNull();
    expect(
      computeGenerationKey(samplerGraph(), { maxPayloadBytes: 16 })
    ).toBeNull();
    const manySeeds = {};
    for (let index = 0; index < 5; index += 1) {
      manySeeds[index] = { inputs: { seed: index, text: TEXT_A } };
    }
    expect(computeGenerationKey(JSON.stringify(manySeeds), { maxSeeds: 4 })).toBeNull();
    expect(computeGenerationKey(JSON.stringify(manySeeds))).not.toBeNull();
  });

  it("recognizes only well-formed keys", () => {
    expect(isGenerationKey(computeGenerationKey(samplerGraph()))).toBe(true);
    for (const value of [null, "", "gk1-xyz", "gk2-" + "0".repeat(32), "gk1-" + "A".repeat(32)]) {
      expect(isGenerationKey(value)).toBe(false);
    }
  });
});
