import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  applyRecipe,
  learnRecipe,
  matchRecipe,
  pairFromRequeueTags,
} = require("../comfy-recipe");
const { parseComfyGraphJson, stringifyComfyGraphJson } = require("../comfy-graph-json");

// Acceptance from real data: finals of the standalone comfy-requeue app carry
// both graphs - their own prompt and workflow, and the draft's in the requeue
// tag. The fixtures are those graphs reduced (UI layout dropped, the final's
// workflow stored as a patch of the draft's) and sanitized (prompt text,
// media, model names, output prefixes and hashes replaced consistently).
//   omni-01..07     Omni v2.1 finals at 1.5 MP, 35 steps (omni-03 and
//                   omni-07 are the Hotel Fun drafts; omni-03 rendered its
//                   references at 1.0 MP rather than 0.5)
//   longform-01, 03 long-form hybrid finals, single pass
//   longform-02     long-form hybrid, two-pass and post-processed; its
//                   prompt is the restamped one-pass graph
const FIXTURES = path.join(__dirname, "fixtures", "recipes");

function loadFixture(name) {
  const fixture = parseComfyGraphJson(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
  const finalWorkflow = structuredClone(fixture.draft.workflow);
  for (const node of finalWorkflow.nodes) {
    Object.assign(node, fixture.final.workflow.patchOfDraft[node.id] || {});
  }
  return { ...fixture, final: { prompt: fixture.final.prompt, workflow: finalWorkflow } };
}

const reversed = (pair) => ({ label: `${pair.label} reversed`, draft: pair.final, final: pair.draft });
const saveNode = (prompt) => Object.values(prompt).find((node) => node.class_type === "SaveVideo");
const text = (value) => stringifyComfyGraphJson(value);

// Where a result differs from the real final: `id` for a node on one side
// only, `id.input` for an input.
function promptDifferences(result, final) {
  const found = [];
  for (const id of new Set([...Object.keys(result), ...Object.keys(final)])) {
    if (!result[id] || !final[id]) {
      found.push(id);
      continue;
    }
    if (result[id].class_type !== final[id].class_type || text(result[id]._meta) !== text(final[id]._meta)) {
      found.push(`${id}.class`);
    }
    for (const input of new Set([...Object.keys(result[id].inputs), ...Object.keys(final[id].inputs)])) {
      if (text(result[id].inputs[input]) !== text(final[id].inputs[input])) found.push(`${id}.${input}`);
    }
  }
  return found.sort();
}

// What ComfyUI reads when the final is dropped on its canvas: node modes,
// positional widgets and links.
function workflowDifferences(result, final) {
  const found = [];
  const finalNodes = new Map(final.nodes.map((node) => [node.id, node]));
  for (const node of result.nodes) {
    const other = finalNodes.get(node.id);
    if (node.mode !== other.mode) found.push(`${node.id}.mode`);
    if (text(node.widgets_values) !== text(other.widgets_values)) found.push(`${node.id}.widgets`);
  }
  if (text(result.links) !== text(final.links)) found.push("links");
  return found.sort();
}

function applyAs(recipe, pair, options = {}) {
  const result = applyRecipe(recipe, pair.draft, {
    filenamePrefix: saveNode(pair.final.prompt).inputs.filename_prefix,
    ...options,
  });
  expect(result.error).toBeUndefined();
  return result;
}

const OMNI_EXAMPLES = ["omni-01", "omni-02", "omni-03"];
const OMNI_HELD_OUT = ["omni-04", "omni-05", "omni-06", "omni-07"];
const LONGFORM_EXAMPLES = ["longform-01", "longform-02"];

describe("recipes learned from real comfy-requeue finals", () => {
  const omni = learnRecipe(OMNI_EXAMPLES.map(loadFixture), { name: "Omni quality" }).recipe;
  const longform = learnRecipe(LONGFORM_EXAMPLES.map(loadFixture), { name: "Long-form quality" }).recipe;

  it("learns the Omni recipe with no workflow knowledge", () => {
    const summary = omni.ops.map((op) => `${op.status} ${op.id}`);
    expect(summary).toEqual([
      "constant remove:667",
      "constant set:124:steps",
      "constant set:801:output_megapixels",
      "constant set:801:ref_image_megapixels",
      "varies set:801:slot_overrides",
    ]);
    const remove = omni.ops[0];
    expect(remove.class).toBe("LoraLoaderModelOnly");
    // The bypass and its rewiring are one operation, not a remove and a set.
    expect(remove.consumers).toEqual([
      expect.objectContaining({ node: "941", input: "any_01", action: "through", through: "model" }),
    ]);
    expect(omni.ops[1]).toMatchObject({ to: 35, effects: [{ class: "BasicScheduler", from: 8, to: 35 }] });
    expect(omni.ops[3].to).toBe(1.5);
    // The references went 0.5 -> 1.5 and 1.0 -> 1.5: one target, a constant.
    expect(omni.ops[3].evidence).toEqual({ pairs: 3, changed: 3 });
    // Varies per clip: kept at the draft's value, never one pair's value.
    const overrides = omni.ops[4];
    expect(overrides.to).toBeNull();
    expect(overrides.perPair).toHaveLength(3);
    expect(overrides.candidates[0]).toMatchObject({ kind: "lift-overrides", fits: true });
    expect(omni.ignored).toEqual([
      expect.objectContaining({ node: "957", input: "filename_prefix", reason: "output-name" }),
    ]);
    expect(omni.uiOps.map((op) => `${op.status} ${op.id}`)).toEqual([
      "constant ui-mode:620",
      "constant ui-mode:930",
      "constant ui-mode:950",
      "constant ui-mode:951",
      "constant ui-mode:952",
      "constant ui-widget:950:0",
      "constant ui-widget:952:0",
    ]);
  });

  // The only inputs allowed to differ from the real final are the ones the
  // learner flagged as varying per clip; for these drafts, that is the slot
  // overrides wherever the draft had one to clear.
  const OMNI_EXPECTED = {
    "omni-04": ["801.slot_overrides"],
    "omni-05": ["801.slot_overrides"],
    "omni-06": ["801.slot_overrides"],
    "omni-07": [],
  };

  it.each(OMNI_HELD_OUT)("reproduces the held-out Omni final %s", (name) => {
    const pair = loadFixture(name);
    expect(matchRecipe(omni, pair.draft).matched).toBe(true);
    const kept = applyAs(omni, pair);
    expect(kept.kept).toEqual(["set:801:slot_overrides"]);
    expect(promptDifferences(kept.prompt, pair.final.prompt)).toEqual(OMNI_EXPECTED[name]);
    for (const difference of OMNI_EXPECTED[name]) {
      const [node, input] = difference.split(".");
      expect(omni.ops.find((op) => op.node === node && op.input === input).status).toBe("varies");
    }

    // With the offered rule chosen, the result is the final exactly.
    const ruled = applyAs(omni, pair, {
      choices: {
        "set:801:slot_overrides": { candidate: "lift-overrides:set:801:ref_image_megapixels" },
      },
    });
    expect(text(ruled.prompt)).toBe(text(pair.final.prompt));
    expect(ruled.workflowIssue).toBeNull();
    expect(workflowDifferences(ruled.workflow, pair.final.workflow)).toEqual([]);
  });

  it("learns the long-form recipe and keeps its per-clip RTX decision out of it", () => {
    expect(longform.ops.map((op) => `${op.status} ${op.id}`)).toEqual([
      "constant remove:3",
      "constant remove:11",
      "constant remove:12",
      "varies remove:43",
      "constant set:35:output_megapixels",
      "constant set:35:ref_image_megapixels",
      "constant set:35:slot_overrides",
      "constant set:38:value",
      "constant set:39:value",
      "varies set:43:resize_type.scale",
    ]);
    // Muting the TURBO PATH group drops each Any Switch's turbo input.
    expect(longform.ops[0].consumers).toEqual([
      expect.objectContaining({ node: "40", input: "any_01", action: "drop" }),
    ]);
    expect(longform.ops[0].uiMode).toBe(2);
    expect(longform.ops[7].effects.map((effect) => `${effect.class}.${effect.input} ${effect.from}->${effect.to}`)).toEqual([
      "H3HybridWindows.total_steps 8->35",
      "KSamplerAdvanced.steps 8->35",
      "KSamplerAdvanced.steps 8->35",
      "KSamplerAdvanced.end_at_step 8->35",
    ]);
  });

  it("offers the switch point's rules without guessing one", () => {
    const switchPoint = longform.ops.find((op) => op.id === "set:39:value");
    expect(switchPoint.to).toBe(27);
    const fits = Object.fromEntries(switchPoint.candidates.map((entry) => [entry.kind, entry.fits]));
    // 27 of 35 is the quality preset's 19/25, not the draft's 6/8.
    expect(fits).toEqual({ ratio: true, "preset-ratio": true, "draft-ratio": false });
    expect(longform.ops.find((op) => op.id === "set:38:value").candidates).toEqual([]);

    const pair = loadFixture("longform-03");
    const at = (steps, candidate) =>
      applyAs(longform, pair, {
        settings: { "set:38:value": steps },
        choices: candidate ? { "set:39:value": { candidate } } : {},
      }).prompt["39"].inputs.value;
    expect(at(35, "preset-ratio:set:38:value")).toBe(27);
    expect(at(50, "preset-ratio:set:38:value")).toBe(38);
    expect(at(50, "draft-ratio:set:38:value")).toBe(38);
    expect(at(50, "ratio:set:38:value")).toBe(39);
    // Unchosen, a constant stays the example's value whatever the steps.
    expect(at(50)).toBe(27);
  });

  it("reproduces the held-out long-form final apart from the RTX decision it flagged", () => {
    const pair = loadFixture("longform-03");
    expect(matchRecipe(longform, pair.draft).matched).toBe(true);
    const kept = applyAs(longform, pair);
    expect(kept.kept).toEqual(["remove:43", "set:43:resize_type.scale"]);
    // That final removed the RTX upscale (its scale was not above 1 at the
    // new size); the recipe keeps it, and RIFE still reads from it.
    expect(promptDifferences(kept.prompt, pair.final.prompt)).toEqual(["43", "44.images"]);
    expect(workflowDifferences(kept.workflow, pair.final.workflow)).toEqual(["43.mode"]);

    const removed = applyAs(longform, pair, { choices: { "remove:43": { apply: true } } });
    expect(text(removed.prompt)).toBe(text(pair.final.prompt));
    expect(workflowDifferences(removed.workflow, pair.final.workflow)).toEqual([]);
  });

  it("learns from a two-pass final, whose prompt is the restamped one-pass graph", () => {
    const pair = loadFixture("longform-02");
    const result = applyAs(longform, pair, { choices: { "set:43:resize_type.scale": { value: 1.172 } } });
    expect(text(result.prompt)).toBe(text(pair.final.prompt));
  });

  it("matches drafts to their own workflow's recipe only, naming what is missing", () => {
    for (const name of [...OMNI_EXAMPLES, ...OMNI_HELD_OUT]) {
      expect(matchRecipe(omni, loadFixture(name).draft).matched).toBe(true);
      const other = matchRecipe(longform, loadFixture(name).draft);
      expect(other.matched).toBe(false);
      expect(other.reason).toMatch(/of its nodes match/);
    }
    // Close enough by fingerprint is not enough: every target must be there.
    const draft = structuredClone(loadFixture("omni-04").draft);
    delete draft.prompt["667"];
    expect(matchRecipe(omni, draft)).toMatchObject({
      matched: false,
      reason: "No LoraLoaderModelOnly at node 667",
    });
    draft.prompt["667"] = { class_type: "UNETLoader", inputs: { unet_name: "model-01.safetensors" } };
    expect(matchRecipe(omni, draft).reason).toBe(
      "Node 667 is a UNETLoader, not the LoraLoaderModelOnly the recipe changes"
    );
  });

  it("adds nodes back from the draft's UI graph, where they sit muted or bypassed", () => {
    // Reversed, the long-form finals are drafts whose TURBO PATH nodes and RTX
    // upscale are disabled: the recipe must rebuild them from the UI graph.
    const examples = ["longform-01", "longform-03"].map((name) => reversed(loadFixture(name)));
    const { recipe } = learnRecipe(examples);
    expect(recipe.ops.filter((op) => op.kind === "add").map((op) => op.id)).toEqual([
      "add:3",
      "add:11",
      "add:12",
      "add:43",
    ]);
    for (const pair of examples) {
      const result = applyAs(recipe, pair);
      expect(text(result.prompt)).toBe(text(pair.final.prompt));
      expect(workflowDifferences(result.workflow, pair.final.workflow)).toEqual([]);
    }
  });

  it("refuses a _nopost fallback final, and mixed workflows", () => {
    const [first, second] = OMNI_EXAMPLES.map(loadFixture);
    const fallback = { ...second, label: "HybridNative_Ref2VA_00006_final_1.5mp_35st_nopost_00001_.mp4" };
    expect(learnRecipe([first, fallback]).error).toMatchObject({ code: "RECIPE_FALLBACK_EXAMPLE", pair: 1 });
    const renderPass = { ...second, provenance: { passes: "two", phase: "render" } };
    expect(learnRecipe([first, renderPass]).error.code).toBe("RECIPE_FALLBACK_EXAMPLE");
    expect(learnRecipe([first, loadFixture("longform-01")]).error.code).toBe("RECIPE_DIFFERENT_WORKFLOWS");
    expect(learnRecipe([first]).error.code).toBe("RECIPE_TOO_FEW_PAIRS");
  });

  it("reads a pair from a final's container tags", () => {
    const fixture = loadFixture("longform-02");
    const tags = {
      prompt: text(fixture.final.prompt),
      workflow: text(fixture.final.workflow),
      requeue: text({
        passes: "two",
        phase: "post",
        source_prompt: fixture.draft.prompt,
        source_workflow: fixture.draft.workflow,
      }),
    };
    const { pair } = pairFromRequeueTags(tags, "HybridNative_Ref2VA_00007_final_1.5mp_35st_00001_.mp4");
    expect(pair.draft.prompt).toEqual(fixture.draft.prompt);
    expect(learnRecipe([pair, loadFixture("longform-01")]).recipe.ops).toHaveLength(10);

    expect(
      pairFromRequeueTags(tags, "HybridNative_Ref2VA_00006_final_1.5mp_35st_nopost_00001_.mp4").error.code
    ).toBe("RECIPE_FALLBACK_EXAMPLE");
    const renderOnly = { ...tags, requeue: text({ passes: "two", phase: "render", source_prompt: {} }) };
    expect(pairFromRequeueTags(renderOnly, "render.mp4").error.code).toBe("RECIPE_FALLBACK_EXAMPLE");
    expect(pairFromRequeueTags({ prompt: "{}" }, "draft.mp4").error.code).toBe("RECIPE_NOT_A_FINAL");
  });
});
