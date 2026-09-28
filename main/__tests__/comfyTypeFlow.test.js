import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseComfyGenerationPayload } = require("../comfy-generation-parser");
const parseComfyTypeFlow = parseComfyGenerationPayload;

// Reduced copies of real renders: API prompt and UI workflow, with graph
// topology, socket types, links, modes, subgraph definitions, seeds and
// numbers kept, and prompt text, paths, model names and free-form strings
// replaced (model files keep their extension; the output prefix maps to the
// fixture's fileName). The prompts keep ComfyUI's NaN.
function fixture(name) {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "type-flow",
    `${name}.payload.json`
  );
  const { fileName, ...payload } = JSON.parse(fs.readFileSync(file, "utf8"));
  return { payload, fileName };
}

function read(name) {
  const { payload, fileName } = fixture(name);
  return parseComfyTypeFlow(payload, { fileName, origin: { kind: "embedded" } });
}

const finalStage = (result) => result.samplerStages.find((stage) => stage.role === "final");
const positiveFields = (result) =>
  result.promptFragments.filter((fragment) => fragment.role === "positive").map((fragment) => fragment.field);

describe("type-flow reader on reduced real renders", () => {
  it("reads a MiniMax H3 Omni draft, whose composer and seed node no allow-list knew", () => {
    const result = read("omni-draft");
    expect(result.output).toMatchObject({ classType: "SaveVideo", match: "filename-prefix" });
    expect(result.samplerStages).toHaveLength(1);
    expect(finalStage(result)).toMatchObject({
      classType: "SamplerCustomAdvanced",
      seed: "636321965386398",
      steps: 8,
      sampler: "res_multistep",
      scheduler: "simple",
    });
    expect(result.seed).toBe("636321965386398");
    expect(result.models).toHaveLength(1);
    expect(result.assets.loras.map((lora) => lora.strengthModel)).toEqual([1, 0.49, 1.03]);
    // The composer's text fields, as fragments: nothing is concatenated.
    expect(positiveFields(result)).toEqual([
      "subject_definitions",
      "summary",
      "retention_analysis",
      "detailed_description",
      "overall_soundscape",
      "non_diegetic_music",
    ]);
    expect(result.prompt).toBeNull();
    // The composer holds several fields and turns them into one prompt at run
    // time: candidates, and the result is partial.
    expect(result.promptFragments.every((fragment) => fragment.confidence === "candidate")).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["PROMPT_COMPOSED", "PROMPT_CANDIDATE"]);
  });

  it("reads both stages of the long-form hybrid, each with its own seed", () => {
    const result = read("longform-draft");
    expect(result.samplerStages.map((stage) => [stage.role, stage.startStep, stage.endStep, stage.steps])).toEqual([
      ["contributor", 0, 6, 8],
      ["final", 6, 8, 8],
    ]);
    expect(result.samplerStages.map((stage) => stage.seed)).toEqual(["166200072176391", "123"]);
    expect(result.seed).toBe("123");
    // H3HybridWindows takes a custom MMH3_COND_SET, not CONDITIONING, and the
    // multi-prompt node takes no MODEL: neither is a sampler stage.
    expect(result.samplerStages.every((stage) => stage.classType === "KSamplerAdvanced")).toBe(true);
    expect(result.assets.loras).toHaveLength(2);
    // The negative is the positive zeroed; its text stays positive only.
    expect(result.promptFragments.some((fragment) => fragment.role === "negative")).toBe(false);
  });

  it("finds a custom save node by its VIDEO input and file name", () => {
    const result = read("v2v-hybrid");
    expect(result.output).toMatchObject({ classType: "H3HybridSaveRun", match: "filename-prefix" });
    expect(result.seed).toBe("123");
    expect(result.models).toHaveLength(1);
    expect(result.sourceInputs.length).toBeGreaterThan(0);
  });

  it("types subgraph inner nodes and keeps a conditioning pair's branches apart", () => {
    const result = read("ltx-outpaint-subgraphs");
    expect(result.samplerStages.every((stage) => stage.nodeId.includes(":"))).toBe(true);
    expect(result.seed).toBe("42");
    expect(result.models).toHaveLength(1);
    // Positive and negative leave one node on two slots named "positive" and
    // "negative". This render's positive text is empty; its only text feeds
    // the negative encoder and must not be read as the prompt.
    expect(result.prompt).toBeNull();
    expect(result.negativePrompt).toEqual(expect.any(String));
    expect(result.promptFragments.map((fragment) => fragment.role)).toEqual(["negative"]);
    expect(result.origin).toMatchObject({ typeEvidence: "declared", resolution: "traced" });
  });

  it("falls back to conventional input names when no UI workflow was embedded", () => {
    const result = read("vr180-no-workflow");
    expect(result.output.classType).toBe("VHS_VideoCombine");
    expect(finalStage(result)).toMatchObject({ seed: "4242", steps: 20 });
    expect(result.models).toHaveLength(1);
    // Types came from input names; that is recorded, and the composer's
    // fields are candidates exactly as with a workflow.
    expect(result.origin).toMatchObject({ typeEvidence: "inferred", resolution: "partial" });
    // `audio_vae` is typed as a VAE by its name, so the audio VAE is a VAE and
    // not a text encoder the prompt walk happened to reach.
    expect(result.assets.vaes).toHaveLength(2);
    expect(result.assets.textEncoders).toHaveLength(1);
    expect(result.promptFragments.every((fragment) => fragment.confidence === "candidate")).toBe(true);
  });

  it("returns the result shape the generation-metadata service persists", () => {
    expect(Object.keys(read("vr180-no-workflow")).sort()).toEqual([
      "assets", "diagnostics", "generationRun", "model", "models", "negativePrompt",
      "origin", "output", "positivePrompt", "prompt", "promptFragments", "provider",
      "sampler", "samplerStages", "samplers", "seed", "sourceImage", "sourceImages",
      "sourceInputs",
    ]);
  });
});

// Minimal typed graphs for single rules.
function uiNode(id, inputs, outputs) {
  return {
    id,
    type: "X",
    mode: 0,
    inputs: inputs.map(([name, type]) => ({ name, type })),
    outputs: outputs.map((type) => ({ name: type, type })),
  };
}

function coreGraph(overrides = {}) {
  return {
    1: { class_type: "CustomLoader", inputs: { ckpt: "base.safetensors" } },
    2: { class_type: "CustomText", inputs: { words: "a quiet harbour at dawn" } },
    3: { class_type: "EmptyThing", inputs: { width: 512, height: 512 } },
    4: {
      class_type: "MySampler",
      inputs: { model: ["1", 0], positive: ["2", 0], latent_image: ["3", 0], seed: 7, steps: 12 },
    },
    5: { class_type: "MyDecode", inputs: { samples: ["4", 0] } },
    6: { class_type: "MySave", inputs: { images: ["5", 0], filename_prefix: "out/clip" } },
    ...overrides,
  };
}

const coreWorkflow = () => ({
  nodes: [
    uiNode(1, [["ckpt", "COMBO"]], ["MODEL"]),
    uiNode(2, [["words", "STRING"]], ["CONDITIONING"]),
    uiNode(3, [["width", "INT"], ["height", "INT"]], ["LATENT"]),
    uiNode(4, [["model", "MODEL"], ["positive", "CONDITIONING"], ["latent_image", "LATENT"], ["seed", "INT"], ["steps", "INT"]], ["LATENT"]),
    uiNode(5, [["samples", "LATENT"]], ["IMAGE"]),
    uiNode(6, [["images", "IMAGE"], ["filename_prefix", "STRING"]], []),
  ],
  links: [],
});

const readGraph = (graph, workflow = coreWorkflow(), fileName = "clip_00001_.mp4") =>
  parseComfyTypeFlow({ prompt: JSON.stringify(graph), workflow: JSON.stringify(workflow) }, { fileName });

describe("type-flow rules", () => {
  it("reads roles from socket types alone, whatever the classes are called", () => {
    const result = readGraph(coreGraph());
    expect(result.output.classType).toBe("MySave");
    expect(finalStage(result)).toMatchObject({ classType: "MySampler", seed: "7", steps: 12 });
    expect(result.models).toEqual(["base.safetensors"]);
    expect(result.prompt).toBe("a quiet harbour at dawn");
    expect(result.origin.resolution).toBe("traced");
  });

  it("rejects a LATENT-producing node without model and conditioning, guider, or noise and sigmas", () => {
    const graph = coreGraph({
      4: { class_type: "Planner", inputs: { model: ["1", 0], latent_image: ["3", 0] } },
    });
    const workflow = coreWorkflow();
    workflow.nodes[3] = uiNode(4, [["model", "MODEL"], ["latent_image", "LATENT"]], ["LATENT", "MODEL"]);
    const result = readGraph(graph, workflow);
    expect(result.samplerStages).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("SAMPLER_NOT_FOUND");
  });

  it("follows an any-switch to its first connected input and a conditional switch to its branch", () => {
    const graph = coreGraph({
      7: { class_type: "Any Switch (rgthree)", inputs: { any_02: ["1", 0], any_03: ["8", 0] } },
      8: { class_type: "OtherLoader", inputs: { ckpt: "other.safetensors" } },
      9: { class_type: "PrimitiveBoolean", inputs: { value: false } },
      10: { class_type: "PrimitiveInt", inputs: { value: 30 } },
      11: { class_type: "PrimitiveInt", inputs: { value: 8 } },
      12: { class_type: "LazySwitchKJ", inputs: { switch: ["9", 0], on_false: ["10", 0], on_true: ["11", 0] } },
    });
    graph[4].inputs.model = ["7", 0];
    graph[4].inputs.steps = ["12", 0];
    const result = readGraph(graph, { nodes: [], links: [] });
    expect(result.models).toEqual(["base.safetensors"]);
    expect(finalStage(result).steps).toBe(30);
  });

  it("leaves a value unresolved when a conditional switch's selector cannot be resolved", () => {
    const graph = coreGraph({
      9: { class_type: "CompareSomething", inputs: { a: ["3", 0], b: 4 } },
      12: { class_type: "LazySwitchKJ", inputs: { switch: ["9", 0], on_false: 30, on_true: 8 } },
    });
    graph[4].inputs.steps = ["12", 0];
    expect(finalStage(readGraph(graph)).steps).toBeNull();
  });

  it("prefers a concrete link type over a switch's '*' output", () => {
    const graph = coreGraph({
      7: { class_type: "Any Switch (rgthree)", inputs: { any_01: ["5", 0] } },
    });
    graph[6].inputs = { video: ["7", 0], filename_prefix: "out/clip" };
    const workflow = coreWorkflow();
    workflow.nodes.push(uiNode(7, [["any_01", "*"]], ["*"]));
    workflow.nodes[5] = uiNode(6, [["video", "VIDEO"], ["filename_prefix", "STRING"]], []);
    expect(readGraph(graph, workflow).output?.classType).toBe("MySave");
  });

  it("keeps prose that starts with a bracket and drops JSON held in a string", () => {
    const graph = coreGraph({
      2: {
        class_type: "Composer",
        inputs: { summary: "[Shot 1] a quiet harbour at dawn", files: '["a b.png", "c d.png"]' },
      },
    });
    expect(readGraph(graph).promptFragments.map((fragment) => fragment.field)).toEqual(["summary"]);
  });

  it("is bounded and rejects malformed payloads", () => {
    expect(() => parseComfyTypeFlow("{not json", {})).toThrowError(
      expect.objectContaining({ code: "COMFY_INVALID_JSON" })
    );
    expect(parseComfyTypeFlow({ prompt: "{}" }, {})).toBeNull();
    const result = readGraph(coreGraph(), coreWorkflow(), "clip_00001_.mp4");
    expect(result).not.toBeNull();
    const many = coreGraph();
    for (let index = 100; index < 140; index += 1) {
      many[index] = { class_type: "Noise", inputs: { value: index } };
    }
    expect(() =>
      parseComfyTypeFlow({ prompt: JSON.stringify(many) }, { limits: { maxGraphNodes: 8 } })
    ).toThrowError(expect.objectContaining({ code: "COMFY_GRAPH_NODE_LIMIT" }));
  });
});
