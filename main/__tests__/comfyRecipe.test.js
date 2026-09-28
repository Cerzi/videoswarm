import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { applyRecipe, learnRecipe, liftOverrides, matchRecipe } = require("../comfy-recipe");
const { parseComfyGraphJson, stringifyComfyGraphJson } = require("../comfy-graph-json");

// A small graph in the shape recipes care about: a model through an optional
// LoRA and an Any Switch, a steps primitive, a sampler, a save.
function graph({
  seed = 7,
  text = "a red fox runs through snow",
  steps = 8,
  lora = true,
  image = "portrait.png",
  prefix = "clips/draft",
  cfg = 1,
  extra = {},
} = {}) {
  const prompt = {
    1: { class_type: "UNETLoader", inputs: { unet_name: "base.safetensors" } },
    3: { class_type: "PrimitiveInt", inputs: { value: steps } },
    4: { class_type: "Any Switch (rgthree)", inputs: { any_01: ["2", 0], any_02: ["1", 0] } },
    5: { class_type: "CLIPTextEncode", inputs: { text, clip: ["9", 0] } },
    6: { class_type: "LoadImage", inputs: { image } },
    7: {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: ["3", 0],
        cfg,
        model: ["4", 0],
        positive: ["5", 0],
        latent_image: ["6", 0],
      },
    },
    8: { class_type: "SaveVideo", inputs: { filename_prefix: prefix, video: ["7", 0] } },
    9: { class_type: "CLIPLoader", inputs: { clip_name: "te.safetensors" } },
    ...extra,
  };
  if (lora) {
    prompt[2] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { lora_name: "turbo.safetensors", strength_model: 1, model: ["1", 0] },
    };
  } else {
    delete prompt[4].inputs.any_01;
  }
  return { prompt };
}

const pair = (label, draft, final) => ({ label, draft, final });

describe("learnRecipe", () => {
  it("learns a removal with its rewiring as one operation, and a set", () => {
    const { recipe } = learnRecipe([
      pair("a", graph({ seed: 1 }), graph({ seed: 1, lora: false, steps: 30, prefix: "clips/a_final" })),
      pair("b", graph({ seed: 2 }), graph({ seed: 2, lora: false, steps: 30, prefix: "clips/b_final" })),
    ]);
    expect(recipe.ops.map((op) => `${op.status} ${op.id}`)).toEqual([
      "constant remove:2",
      "constant set:3:value",
    ]);
    expect(recipe.ops[0].consumers).toEqual([
      expect.objectContaining({ node: "4", input: "any_01", action: "drop" }),
    ]);
    expect(recipe.ops[1]).toMatchObject({
      to: 30,
      effects: [{ node: "7", class: "KSampler", input: "steps", from: 8, to: 30 }],
    });
    expect(recipe.ignored.map((entry) => entry.reason)).toEqual(["output-name"]);
  });

  it("flags a value that differs across pairs as varying per clip, never adopting one", () => {
    const { recipe } = learnRecipe([
      pair("a", graph({ cfg: 1 }), graph({ cfg: 4 })),
      pair("b", graph({ cfg: 1 }), graph({ cfg: 6 })),
    ]);
    const [op] = recipe.ops;
    expect(op).toMatchObject({ id: "set:7:cfg", status: "varies", to: null });
    expect(op.perPair).toEqual([
      { label: "a", from: { value: 1 }, to: { value: 4 } },
      { label: "b", from: { value: 1 }, to: { value: 6 } },
    ]);
    const draft = graph({ cfg: 2 });
    const kept = applyRecipe(recipe, draft);
    expect(kept.prompt["7"].inputs.cfg).toBe(2);
    expect(kept.kept).toEqual(["set:7:cfg"]);
    const chosen = applyRecipe(recipe, draft, { choices: { "set:7:cfg": { value: 5 } } });
    expect(chosen.prompt["7"].inputs.cfg).toBe(5);
  });

  it("treats a node that moved to a new id, or a new reroute, as no change", () => {
    const moved = graph({
      lora: false,
      extra: {
        12: { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "turbo.safetensors", strength_model: 1, model: ["1", 0] } },
        13: { class_type: "Reroute", inputs: { input: ["5", 0] } },
      },
    });
    moved.prompt[4].inputs = { any_01: ["12", 0], any_02: ["1", 0] };
    moved.prompt[7].inputs.positive = ["13", 0];
    // A reroute is pass-through by its declared `*` sockets, as ComfyUI's UI
    // graph types it; an untyped one-input node is not assumed to be one.
    moved.workflow = {
      nodes: [{ id: 13, type: "Reroute", mode: 0, inputs: [{ name: "input", type: "*", link: 1 }], outputs: [{ name: "", type: "*" }] }],
      links: [[1, 5, 0, 13, 0, "*"]],
    };
    const result = learnRecipe([pair("a", graph(), moved), pair("b", graph(), moved)]);
    expect(result.recipe.ops).toEqual([]);
  });

  it("refuses pairs that are not re-renders of one generation", () => {
    const changedSeed = learnRecipe([
      pair("a", graph({ seed: 1 }), graph({ seed: 2 })),
      pair("b", graph(), graph()),
    ]);
    expect(changedSeed.error).toMatchObject({ code: "RECIPE_NOT_SAME_GENERATION", pair: 0 });
    expect(changedSeed.error.message).toMatch(/seed at KSampler #7/);
    const changedText = learnRecipe([
      pair("a", graph(), graph({ text: "a blue fox runs through snow" })),
      pair("b", graph(), graph()),
    ]);
    expect(changedText.error.message).toMatch(/text at CLIPTextEncode #5/);
    const changedImage = learnRecipe([pair("a", graph(), graph({ image: "other.png" })), pair("b", graph(), graph())]);
    expect(changedImage.error.message).toMatch(/input-media/);
  });

  it("treats a primitive holding the seed as identity", () => {
    const withSeed = (seed) => {
      const side = graph({ extra: { 20: { class_type: "PrimitiveInt", inputs: { value: seed } } } });
      side.prompt[7].inputs.seed = ["20", 0];
      return side;
    };
    const result = learnRecipe([pair("a", withSeed(1), withSeed(2)), pair("b", withSeed(1), withSeed(1))]);
    expect(result.error.code).toBe("RECIPE_NOT_SAME_GENERATION");
  });

  it("refuses unreadable, fallback and too-few examples", () => {
    expect(learnRecipe([pair("a", graph(), graph())]).error.code).toBe("RECIPE_TOO_FEW_PAIRS");
    expect(learnRecipe([pair("a", { prompt: "{nope" }, graph()), pair("b", graph(), graph())]).error).toMatchObject({
      code: "RECIPE_UNREADABLE",
      pair: 0,
    });
    expect(
      learnRecipe([pair("x_final_1.5mp_35st_nopost_00001_.mp4", graph(), graph()), pair("b", graph(), graph())]).error
        .code
    ).toBe("RECIPE_FALLBACK_EXAMPLE");
    // "nopost" inside another word is not the fallback marker.
    expect(learnRecipe([pair("nopostcard.mp4", graph(), graph()), pair("b", graph(), graph())]).error).toBeUndefined();
  });

  it("offers ratio rules for a setting that shares a node with another", () => {
    const withSwitch = (steps, at) => {
      const side = graph({ steps, extra: { 21: { class_type: "PrimitiveInt", inputs: { value: at } } } });
      side.prompt[7].inputs.end_at_step = ["21", 0];
      return side;
    };
    const { recipe } = learnRecipe([
      pair("a", withSwitch(8, 6), withSwitch(36, 27)),
      pair("b", withSwitch(8, 6), withSwitch(36, 27)),
    ]);
    const switchPoint = recipe.ops.find((op) => op.id === "set:21:value");
    expect(switchPoint.candidates.map((entry) => [entry.kind, entry.fits])).toEqual([
      ["ratio", true],
      ["preset-ratio", true],
    ]);
    const result = applyRecipe(recipe, withSwitch(8, 6), {
      settings: { "set:3:value": 48 },
      choices: { "set:21:value": { candidate: "ratio:set:3:value" } },
    });
    expect(result.prompt["21"].inputs.value).toBe(36);
    expect(result.values).toEqual({ "set:3:value": 48, "set:21:value": 36 });
    expect(applyRecipe(recipe, withSwitch(8, 6), { choices: { "set:21:value": { candidate: "nope" } } }).error.code).toBe(
      "RECIPE_UNKNOWN_RULE"
    );
  });
});

describe("applyRecipe", () => {
  const learned = () =>
    learnRecipe([
      pair("a", graph(), graph({ lora: false, steps: 30 })),
      pair("b", graph(), graph({ lora: false, steps: 30 })),
    ]).recipe;

  it("leaves the draft untouched and sets the output prefix only when asked", () => {
    const draft = graph();
    const before = JSON.stringify(draft);
    const result = applyRecipe(learned(), draft, { filenamePrefix: "clips/draft_final" });
    expect(JSON.stringify(draft)).toBe(before);
    expect(result.prompt["2"]).toBeUndefined();
    expect(result.prompt["4"].inputs).toEqual({ any_02: ["1", 0] });
    expect(result.prompt["8"].inputs.filename_prefix).toBe("clips/draft_final");
    expect(applyRecipe(learned(), draft).prompt["8"].inputs.filename_prefix).toBe("clips/draft");
    expect(result.workflow).toBeNull();
    expect(result.workflowIssue).toBe("The draft has no UI workflow");
  });

  it("keeps 64-bit seeds exact through a JSON round trip", () => {
    const text = stringifyComfyGraphJson(graph()).replace('"seed":7', '"seed":18446744073709551615');
    const result = applyRecipe(learned(), parseComfyGraphJson(text));
    expect(stringifyComfyGraphJson(result.prompt)).toContain('"seed":18446744073709551615');
    // A draft given as JSON text is read the same way.
    const fromText = applyRecipe(learned(), {
      prompt: JSON.stringify(graph().prompt).replace('"seed":7', '"seed":18446744073709551615'),
    });
    expect(stringifyComfyGraphJson(fromText.prompt)).toContain('"seed":18446744073709551615');
  });

  it("refuses a draft of another workflow or with a missing target, naming it", () => {
    const recipe = learned();
    const other = { prompt: { 1: { class_type: "Other", inputs: {} }, 2: { class_type: "SaveVideo", inputs: {} } } };
    expect(matchRecipe(recipe, other).reason).toMatch(/of its nodes match/);
    expect(applyRecipe(recipe, other).error.code).toBe("RECIPE_NO_MATCH");
    const renamed = graph();
    renamed.prompt[3].class_type = "PrimitiveFloat";
    expect(matchRecipe(recipe, renamed).reason).toBe(
      "Node 3 is a PrimitiveFloat, not the PrimitiveInt the recipe changes"
    );
    expect(matchRecipe({ kind: "something" }, graph()).reason).toMatch(/Not a recipe/);
  });

  it("refuses to rewire a consumer the examples never showed", () => {
    const recipe = learned();
    const draft = graph({ extra: { 30: { class_type: "ModelPatch", inputs: { model: ["2", 1] } } } });
    expect(applyRecipe(recipe, draft).error.code).toBe("RECIPE_REWIRE_UNKNOWN");
  });

  it("adds a node from the draft's UI graph, keeping only the example's inputs", () => {
    const ui = (mode, steps) => ({
      nodes: [
        { id: 2, type: "LoraLoaderModelOnly", mode, inputs: [{ name: "model", type: "MODEL", link: 1 }], outputs: [{ name: "MODEL", type: "MODEL" }],
          widgets_values: ["turbo.safetensors", 0.5], widgets_values_named: { lora_name: "turbo.safetensors", strength_model: 0.5 } },
        { id: 3, type: "PrimitiveInt", mode: 0, widgets_values: [steps, "fixed"], widgets_values_named: { value: steps, fixed: "fixed" } },
      ],
      links: [[1, 1, 0, 2, 0, "MODEL"]],
    });
    const draftOf = () => ({ ...graph({ lora: false, steps: 30 }), workflow: ui(4, 30) });
    const finalOf = () => ({ ...graph({ steps: 8 }), workflow: ui(0, 8) });
    const { recipe } = learnRecipe([pair("a", draftOf(), finalOf()), pair("b", draftOf(), finalOf())]);
    expect(recipe.ops.map((op) => op.id)).toEqual(["add:2", "set:3:value", "set:4:any_01"]);
    const result = applyRecipe(recipe, draftOf());
    // Rebuilt from the UI graph: its own strength, not the example's.
    expect(result.prompt["2"].inputs).toEqual({ lora_name: "turbo.safetensors", strength_model: 0.5, model: ["1", 0] });
    // The switch input goes back where the example has it, before any_02.
    expect(Object.keys(result.prompt["4"].inputs)).toEqual(["any_01", "any_02"]);
    expect(result.workflow.nodes[0].mode).toBe(0);
    expect(result.workflow.nodes[1].widgets_values).toEqual([8, "fixed"]);
    expect(result.workflow.nodes[1].widgets_values_named.value).toBe(8);

    // Without a UI graph the example's node spec is used.
    const bare = applyRecipe(recipe, { prompt: draftOf().prompt });
    expect(bare.prompt["2"].inputs.strength_model).toBe(1);
  });
});

describe("liftOverrides", () => {
  it("clears overrides above the old global up to the new one", () => {
    expect(liftOverrides("[0.85,null,0.2,1.2,2]", 0.5, 1.5)).toBe("[null,null,0.2,null,2]");
    expect(liftOverrides('[{"mp":0.9,"crop":1},{"mp":0.9}]', 0.5, 1.5)).toBe('[{"crop":1},null]');
    expect(liftOverrides("[0.2]", 0.5, 1.5)).toBe("[0.2]");
    expect(liftOverrides("not json", 0.5, 1.5)).toBe("not json");
    expect(liftOverrides("[0.9]", 1.5, 1.0)).toBe("[0.9]");
  });
});
