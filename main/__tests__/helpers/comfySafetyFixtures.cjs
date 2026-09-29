/* global __dirname, structuredClone */
// Fixtures for the "never silently wrong" checks (main/comfy-safety.js):
//   safety/v2v-01.json         a real V2V hybrid draft's API prompt (from
//                              comfy-requeue's tests/v2v_turbo.json), sanitized
//                              like the recipe fixtures: models, media, hashes,
//                              the save prefix and project name replaced;
//                              classes, links, titles and numbers kept. It has
//                              no UI workflow, as V2V renders embed subgraphs.
//   safety/longform-layout.json the long-form workflow's canvas layout (group
//                              titles and boxes, node positions) from another
//                              real draft of the same workflow file; the recipe
//                              fixtures dropped the layout.
const fs = require("fs");
const path = require("path");
const { learnRecipe } = require("../../comfy-recipe");
const { parseComfyGraphJson } = require("../../comfy-graph-json");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const read = (...parts) => parseComfyGraphJson(fs.readFileSync(path.join(FIXTURES, ...parts), "utf8"));

// A recipe fixture with the final's UI workflow rebuilt from its patch.
function loadRecipeFixture(name) {
  const fixture = read("recipes", `${name}.json`);
  const finalWorkflow = structuredClone(fixture.draft.workflow);
  for (const node of finalWorkflow.nodes) Object.assign(node, fixture.final.workflow.patchOfDraft[node.id] || {});
  return { ...fixture, final: { prompt: fixture.final.prompt, workflow: finalWorkflow } };
}

const v2vDraft = () => structuredClone(read("safety", "v2v-01.json").draft);

// The long-form draft with its workflow's layout put back.
function withLongformLayout(draft) {
  const layout = read("safety", "longform-layout.json");
  const workflow = structuredClone(draft.workflow);
  workflow.groups = layout.groups;
  for (const node of workflow.nodes) {
    if (layout.positions[node.id]) node.pos = layout.positions[node.id];
  }
  return { prompt: draft.prompt, workflow };
}

// What the learner would make of two hand-made V2V finals: the acceleration
// LoRA bypassed, steps 8 -> 35 and switch 6 -> 27, and the Composer's frames
// up to 0.9 MP. It keeps each draft's SAM3 clicks and its continuation save,
// which is what the checks exist to catch.
function v2vRecipe() {
  const pair = (seed, megapixels) => {
    const draft = v2vDraft();
    draft.prompt["18"].inputs.value = seed;
    draft.prompt["76"].inputs.output_megapixels = megapixels;
    const final = structuredClone(draft);
    final.prompt["76"].inputs.output_megapixels = 0.9;
    final.prompt["85:19"].inputs.value = 35;
    final.prompt["85:20"].inputs.value = 27;
    delete final.prompt["80:13"];
    final.prompt["80:14"].inputs.model = ["80:12", 0];
    return { label: `v2v-${seed}`, draft, final };
  };
  const learned = learnRecipe([pair(1, 0.5), pair(2, 0.6)], { name: "V2V quality" });
  if (learned.error) throw new Error(learned.error.message);
  return learned.recipe;
}

// Node definitions with every class the prompts use installed, and the save
// and preview classes marked as outputs, as ComfyUI marks them.
function nodeInfoFor(prompts, outputs = ["SaveVideo", "H3HybridSaveRun", "PreviewAny", "PreviewImage"]) {
  const info = {};
  for (const prompt of prompts) {
    for (const node of Object.values(prompt)) {
      info[node.class_type] = { input: { required: {} }, output_node: outputs.includes(node.class_type) };
    }
  }
  return info;
}

module.exports = { loadRecipeFixture, nodeInfoFor, v2vDraft, v2vRecipe, withLongformLayout };
