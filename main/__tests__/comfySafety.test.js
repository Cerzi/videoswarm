import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { applyRecipe, learnRecipe } = require("../comfy-recipe");
const {
  UNDERSTOOD_CLASSES,
  absolutePathsIn,
  assessRerender,
  changedInputs,
  heldProblems,
  literalDataInputs,
} = require("../comfy-safety");
const { loadRecipeFixture, nodeInfoFor, v2vDraft, v2vRecipe, withLongformLayout } = require("./helpers/comfySafetyFixtures.cjs");

// "Never silently wrong" (comfy-queue-integration.md, Section 10): every
// clip is declared quality mode, a known family, or held for review with a
// reason. The V2V hybrid is the case that motivated it; the Omni and
// long-form recipes are the known families that must not be held.

const V2V_RECIPE = v2vRecipe();
const OMNI = learnRecipe(["omni-01", "omni-02", "omni-03"].map(loadRecipeFixture)).recipe;
const LONGFORM = learnRecipe(["longform-01", "longform-02"].map(loadRecipeFixture)).recipe;

function applied(recipe, draft, options = {}) {
  const result = applyRecipe(recipe, draft, { filenamePrefix: "clips/final", ...options });
  expect(result.error).toBeUndefined();
  return result.prompt;
}

function assess(draft, prompt, extra = {}) {
  return assessRerender({ draft, prompt, info: nodeInfoFor([draft.prompt, prompt]), ...extra });
}

describe("the V2V hybrid", () => {
  it("is held because its SAM3 clicks depend on the frame size the recipe changes", () => {
    const draft = v2vDraft();
    const review = assess(draft, applied(V2V_RECIPE, draft));
    expect(review.bucket).toBe("review");
    expect(review.held).toBe(true);
    const dependency = review.holds.filter((hold) => hold.code === "COMFY_HOLD_DEPENDENCY");
    expect(dependency.map((hold) => hold.id)).toEqual(["dependency:97:PointsEditor"]);
    // The path from the changed input to the node carrying the clicks.
    expect(dependency[0].path).toEqual([
      { node: "76", class: "MiniMaxH3Ref2VAComposer", input: "output_megapixels" },
      { node: "131", class: "ComfyMathExpression", input: "values.a" },
      { node: "97", class: "PointsEditor", input: "width" },
    ]);
    expect(dependency[0].message).toBe(
      "Changing output_megapixels on MiniMaxH3Ref2VAComposer #76 reaches PointsEditor #97 (width) through " +
        "ComfyMathExpression #131. PointsEditor is not a node the engine understands, and it carries literal data " +
        "(points_store, coordinates, neg_coordinates) written for the draft that nothing would adjust to the change"
    );
    expect(dependency[0].confirmable).toBe(true);
  });

  it("is caught without knowing what a PointsEditor is", () => {
    expect(UNDERSTOOD_CLASSES).not.toContain("PointsEditor");
    const source = fs.readFileSync(path.join(__dirname, "..", "comfy-safety.js"), "utf8");
    expect(source).not.toMatch(/PointsEditor|H3Hybrid|MiniMax/u);
  });

  it("is not held by the dependency check for steps or the LoRA alone", () => {
    const draft = v2vDraft();
    const prompt = structuredClone(draft.prompt);
    prompt["85:19"].inputs.value = 35;
    prompt["85:20"].inputs.value = 27;
    delete prompt["80:13"];
    prompt["80:14"].inputs.model = ["80:12", 0];
    const review = assess(draft, prompt);
    expect(review.changes.map((change) => `${change.kind} ${change.node}.${change.input}`)).toEqual([
      "link 80:14.model",
      "value 85:19.value",
      "value 85:20.value",
    ]);
    expect(review.holds.map((hold) => hold.code)).toEqual(["COMFY_HOLD_SAVE_NODE"]);
  });

  it("flags the continuation save, and not a plain SaveVideo in its place", () => {
    const draft = v2vDraft();
    const review = assess(draft, applied(V2V_RECIPE, draft));
    const save = review.holds.find((hold) => hold.code === "COMFY_HOLD_SAVE_NODE");
    expect(save).toMatchObject({ id: "save:82:68:H3HybridSaveRun", node: "82:68", confirmable: true, confirmed: false });
    expect(save.message).toBe(
      "The final would be saved by H3HybridSaveRun #82:68, not a plain SaveVideo. A save node can do more than save " +
        "(register a run, continue a project), and every final would do it too"
    );

    // As comfy-requeue's convert_v2v does: a plain SaveVideo, its previews gone.
    const swapped = structuredClone(draft.prompt);
    const inputs = swapped["82:68"].inputs;
    swapped["82:68"] = {
      class_type: "SaveVideo",
      inputs: Object.fromEntries(Object.entries(inputs).filter(([name]) => !["latent", "run", "project", "prior"].includes(name))),
    };
    delete swapped["69"];
    expect(assess(draft, swapped).holds).toEqual([]);
  });

  it("refuses a continuation run, which no confirmation can pass", () => {
    const draft = v2vDraft();
    draft.prompt["4"].inputs.accepted_chunks = 2;
    const prompt = applied(V2V_RECIPE, draft);
    const holdIds = assess(draft, prompt).holds.map((hold) => hold.id);
    const review = assess(draft, prompt, { confirmed: holdIds });
    expect(review.held).toBe(true);
    const refused = review.holds.find((hold) => hold.code === "COMFY_REFUSED_CONTINUATION");
    expect(refused).toMatchObject({ node: "4", confirmable: false, confirmed: false });
    expect(refused.message).toBe("A continuation run: H3HybridRunPlan #4 has accepted_chunks 2. Only a fresh run can be re-rendered");
    // Refusals come first among what stops the clip.
    expect(heldProblems(review).map((problem) => problem.code)).toEqual(["COMFY_REFUSED_CONTINUATION"]);
  });

  it("runs once a person confirms each hold by its id", () => {
    const draft = v2vDraft();
    const prompt = applied(V2V_RECIPE, draft);
    const first = assess(draft, prompt, { confirmed: ["save:82:68:H3HybridSaveRun"] });
    expect(first.held).toBe(true);
    expect(heldProblems(first)).toEqual([
      expect.objectContaining({ code: "COMFY_HOLD_DEPENDENCY", hold: "dependency:97:PointsEditor", confirmable: true }),
    ]);
    const both = assess(draft, prompt, { confirmed: ["save:82:68:H3HybridSaveRun", "dependency:97:PointsEditor", "junk"] });
    expect(both).toMatchObject({ bucket: "review", held: false });
    expect(heldProblems(both)).toEqual([]);
  });

  it("blocks a source video that no longer exists outside ComfyUI's input folder", () => {
    const draft = v2vDraft();
    draft.prompt["1"].inputs.value = "/gone/source.mp4";
    draft.prompt["92"].inputs.video = "/gone/source.mp4";
    const prompt = applied(V2V_RECIPE, draft);
    const info = nodeInfoFor([prompt]);
    expect(absolutePathsIn(prompt, info)).toEqual(["/gone/source.mp4"]);
    const missing = assessRerender({ draft, prompt, info, pathExists: () => false }).holds.filter(
      (hold) => hold.code === "COMFY_INPUT_PATH_MISSING"
    );
    expect(missing.map((hold) => [hold.message, hold.confirmable])).toEqual([
      ["PrimitiveStringMultiline #1 value names /gone/source.mp4, which no longer exists", false],
      ["VHS_LoadVideoFFmpegPath #92 video names /gone/source.mp4, which no longer exists", false],
    ]);
    // Present, or unknown: not flagged.
    for (const pathExists of [() => true, () => undefined, null]) {
      expect(assessRerender({ draft, prompt, info, pathExists }).holds.some((hold) => hold.code === "COMFY_INPUT_PATH_MISSING")).toBe(false);
    }
  });
});

describe("the known families", () => {
  it.each(["omni-04", "omni-05", "omni-06", "omni-07"])("passes the Omni draft %s with no holds", (name) => {
    const { draft } = loadRecipeFixture(name);
    for (const choices of [{}, { "set:801:slot_overrides": { candidate: "lift-overrides:set:801:ref_image_megapixels" } }]) {
      const review = assess(draft, applied(OMNI, draft, { choices }));
      expect(review).toMatchObject({ bucket: "known", held: false, declared: null, holds: [] });
      expect(review.changes.map((change) => `${change.node}.${change.input}`)).toEqual(
        expect.arrayContaining(["124.steps", "801.output_megapixels", "801.ref_image_megapixels", "941.any_01"])
      );
    }
  });

  it("passes the long-form draft with no holds, removing its RTX upscale or not", () => {
    const { draft } = loadRecipeFixture("longform-03");
    for (const choices of [{}, { "remove:43": { apply: true } }, { "set:43:resize_type.scale": { value: 1.172 } }]) {
      const review = assess(draft, applied(LONGFORM, draft, { choices, settings: { "set:38:value": 50 } }));
      expect(review).toMatchObject({ bucket: "known", held: false, holds: [] });
    }
  });

  it("classifies the long-form as declared quality mode from its TURBO PATH group", () => {
    const draft = withLongformLayout(loadRecipeFixture("longform-03").draft);
    const review = assess(draft, applied(LONGFORM, draft));
    expect(review).toMatchObject({
      bucket: "declared",
      held: false,
      holds: [],
      declared: {
        group: "TURBO PATH — right-click > Set Group Nodes to Never for the 25-step quality run",
        nodes: ["3", "11", "12"],
      },
    });
    // A recipe that leaves the group alone does not flip the declared switch.
    const kept = structuredClone(applied(LONGFORM, draft));
    kept["3"] = draft.prompt["3"];
    expect(assess(draft, kept).bucket).toBe("known");
    // The Omni's switchboard groups are not titled as a quality switch.
    const omni = withLongformLayout(loadRecipeFixture("longform-03").draft);
    omni.workflow.groups = omni.workflow.groups.filter((group) => !group.title.startsWith("TURBO PATH"));
    expect(assess(omni, applied(LONGFORM, omni)).bucket).toBe("known");
  });

  it("still holds a declared-mode draft when the dependency check trips", () => {
    const draft = withLongformLayout(loadRecipeFixture("longform-03").draft);
    const prompt = applied(LONGFORM, draft);
    // A node carrying coordinates fed by the composer's size.
    draft.prompt["900"] = { class_type: "Mask Editor", inputs: { width: ["35", 4], points: "[[10,20],[30,40]]" } };
    prompt["900"] = structuredClone(draft.prompt["900"]);
    prompt["29"].inputs.mask_hint = ["900", 0];
    draft.prompt["29"].inputs.mask_hint = ["900", 0];
    const review = assess(draft, prompt);
    expect(review.bucket).toBe("review");
    expect(review.holds.map((hold) => hold.id)).toEqual(["dependency:900:Mask Editor"]);
    expect(review.declared).not.toBeNull();
  });
});

describe("the dependency check", () => {
  // loader -> scheduler -> sampler -> overlay(literal data) -> save
  function graph() {
    return {
      1: { class_type: "PrimitiveInt", inputs: { value: 8 } },
      2: { class_type: "BasicScheduler", inputs: { steps: ["1", 0], scheduler: "simple" } },
      3: { class_type: "SamplerCustomAdvanced", inputs: { sigmas: ["2", 0] } },
      4: { class_type: "VAEDecode", inputs: { samples: ["3", 0] } },
      5: { class_type: "Text Overlay", inputs: { images: ["4", 0], boxes: '[{"x":12,"y":40}]', font: "sans" } },
      6: { class_type: "SaveVideo", inputs: { video: ["5", 0], filename_prefix: "clips/a" } },
      // Dead: nothing saves it, so ComfyUI never runs it.
      7: { class_type: "Text Overlay", inputs: { images: ["4", 0], boxes: '[{"x":1}]' } },
    };
  }

  it("holds a change that reaches unknown literal data anywhere downstream, and ignores dead nodes", () => {
    const draft = { prompt: graph() };
    const prompt = graph();
    prompt["1"].inputs.value = 35;
    const review = assessRerender({ draft, prompt, info: nodeInfoFor([prompt]) });
    expect(review.holds.map((hold) => hold.id)).toEqual(["dependency:5:Text Overlay"]);
    expect(review.holds[0].path.map((step) => `${step.node}.${step.input}`)).toEqual(["1.value", "2.steps", "3.sigmas", "4.samples", "5.images"]);
  });

  it("does not judge the node whose own setting changed, and passes understood classes", () => {
    const draft = { prompt: graph() };
    const prompt = graph();
    prompt["5"].inputs.font = "serif"; // the overlay's own setting: nothing downstream carries data
    expect(assessRerender({ draft, prompt, info: nodeInfoFor([prompt]) }).holds).toEqual([]);
    // A rewired input is judged on the node itself.
    const rewired = graph();
    rewired["5"].inputs.images = ["3", 0];
    expect(assessRerender({ draft, prompt: rewired, info: nodeInfoFor([rewired]) }).holds[0].message).toBe(
      "Rewiring images on Text Overlay #5. Text Overlay is not a node the engine understands, and it carries literal data " +
        "(boxes) written for the draft that nothing would adjust to the change"
    );
    // Understood: the same literal data on a known loader does not hold.
    const known = graph();
    known["5"].class_type = "Power Lora Loader (rgthree)";
    const knownDraft = { prompt: structuredClone(known) };
    known["1"].inputs.value = 35;
    expect(assessRerender({ draft: knownDraft, prompt: known, info: nodeInfoFor([known]) }).holds).toEqual([]);
  });

  it("reads literal data: JSON with something in it, and non-zero pixel geometry", () => {
    expect(
      literalDataInputs({
        inputs: {
          empty: "[{}]",
          none: "[]",
          switches: "[false,true]",
          points: '{"positive":[{"x":1,"y":2}]}',
          list: [1, 2, 3],
          pair: [1, 2], // a link, as ComfyUI reads it
          x: 0,
          y: 12,
          width: 832,
          strength: 0.5,
          link: ["1", 0],
          filename_prefix: "[1]",
          text: "[Shot 1] a person walks",
        },
      })
    ).toEqual(["points", "list", "y", "width"]);
  });

  it("lists what changed, ignoring the output name the runner sets", () => {
    const draft = graph();
    const prompt = graph();
    prompt["6"].inputs.filename_prefix = "clips/a_final";
    prompt["8"] = { class_type: "RIFEInterpolation", inputs: { images: ["5", 0] } };
    prompt["6"].inputs.video = ["8", 0];
    delete prompt["7"];
    expect(changedInputs(draft, prompt)).toEqual([
      { node: "6", class: "SaveVideo", input: "video", kind: "link" },
      { node: "8", class: "RIFEInterpolation", input: null, kind: "node" },
    ]);
  });
});

describe("red flags", () => {
  const base = () => ({
    1: { class_type: "VAEDecode", inputs: { samples: ["9", 0] } },
    2: { class_type: "SaveVideo", inputs: { video: ["1", 0], filename_prefix: "clips/a" } },
    9: { class_type: "EmptyLatent", inputs: { width: 832 } },
  });

  it("flags a node that writes files, and a resume switch", () => {
    const prompt = base();
    prompt["3"] = { class_type: "Frame Dumper", inputs: { images: ["1", 0], output_dir: "/tmp/frames" } };
    prompt["4"] = { class_type: "Chunk Planner", inputs: { images: ["1", 0], resume: ["5", 0] } };
    prompt["5"] = { class_type: "PrimitiveBoolean", inputs: { value: true } };
    const info = { ...nodeInfoFor([prompt]), "Frame Dumper": { output_node: true }, "Chunk Planner": { output_node: true } };
    const review = assessRerender({ draft: { prompt }, prompt, info });
    expect(review.holds.map((hold) => [hold.code, hold.confirmable])).toEqual([
      ["COMFY_HOLD_WRITES_FILES", true],
      ["COMFY_REFUSED_CONTINUATION", false],
    ]);
    expect(review.holds[0].message).toBe("Frame Dumper #3 writes files (output_dir), and the re-render would write them again");
  });

  it("holds when there is no prompt at all", () => {
    expect(assessRerender({ draft: { prompt: base() }, prompt: null })).toMatchObject({ bucket: "review", held: true });
  });
});
