import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { applyRecipe, learnRecipe } = require("../comfy-recipe");
const { parseComfyGraphJson, stringifyComfyGraphJson } = require("../comfy-graph-json");
const { createMemoryComfyQueueStore } = require("../comfy-queue-store");
const { createComfyRunner, finalPrefix, knobSummary } = require("../comfy-runner");
const { createComfyClient } = require("../comfy-client");
const { createFakeComfyUi, historyEntry } = require("./helpers/fakeComfyUi.cjs");

// The runner against a fake ComfyUI, with the Omni recipe learned in Phase 1
// and the real (sanitized) Omni drafts of its acceptance fixtures. Ported
// from the standalone comfy-requeue app's runner tests.
const FIXTURES = path.join(__dirname, "fixtures", "recipes");
const load = (name) => parseComfyGraphJson(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
const OMNI = ["omni-01", "omni-02", "omni-03"].map((name) => {
  const fixture = load(name);
  const finalWorkflow = structuredClone(fixture.draft.workflow);
  for (const node of finalWorkflow.nodes) Object.assign(node, fixture.final.workflow.patchOfDraft[node.id] || {});
  return { label: name, draft: fixture.draft, final: { prompt: fixture.final.prompt, workflow: finalWorkflow } };
});
const RECIPE = learnRecipe(OMNI).recipe;
const DRAFTS = Object.fromEntries(["omni-04", "omni-05", "omni-06", "omni-07"].map((name) => [name, load(name).draft]));

// Node definitions for everything the fixtures use: every class installed,
// the saves marked as outputs, and the loaders listing the input folder and
// LoRAs the drafts name.
function nodeInfo() {
  const text = fs.readdirSync(FIXTURES).map((file) => fs.readFileSync(path.join(FIXTURES, file), "utf8")).join("\n");
  const media = [...new Set(text.match(/media-\d+\.[a-z0-9]+/g))];
  const models = [...new Set(text.match(/model-\d+\.safetensors/g))];
  const info = {};
  for (const draft of [...Object.values(DRAFTS), ...OMNI.map((pair) => pair.final)]) {
    for (const node of Object.values(draft.prompt)) {
      info[node.class_type] = { input: { required: {} }, output_node: node.class_type === "SaveVideo" };
    }
  }
  info.LoadImage = { input: { required: { image: [media] } } };
  info.LoadVideo = { input: { required: { file: ["COMBO", { options: media }] } } };
  info.LoraLoaderModelOnly = { input: { required: { lora_name: [models] } } };
  return info;
}

describe("comfy runner", () => {
  let comfy;
  let outputDir;
  let store;
  let recipeId;
  let clock;
  let events;
  let connection;
  let drafts;
  let runners;

  beforeEach(async () => {
    comfy = createFakeComfyUi({ info: nodeInfo() });
    await comfy.listen();
    outputDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-comfy-output-")));
    clock = 1_000;
    store = createMemoryComfyQueueStore({ now: () => clock });
    recipeId = store.saveRecipe({ name: "Omni quality", recipe: RECIPE }).id;
    events = [];
    connection = { enabled: true, url: comfy.url, outputDir };
    drafts = new Map();
    runners = [];
  });

  afterEach(async () => {
    await Promise.all(runners.map((runner) => runner.dispose()));
    await comfy.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  function newRunner() {
    const runner = createComfyRunner({
      store,
      getConnection: () => connection,
      readDraft: async (draftPath) => {
        if (!drafts.has(draftPath)) throw new Error(`no file at ${draftPath}`);
        return drafts.get(draftPath);
      },
      createClient: (url) => createComfyClient({ url, now: () => clock }),
      now: () => clock,
      setTimer: () => null,
      clearTimer: () => {},
      emit: (event) => events.push(event),
      logger: { warn: () => {} },
    });
    runners.push(runner);
    return runner;
  }

  // A draft in ComfyUI's output folder, read back as the given fixture.
  function draft(name, fixture = "omni-04", { seed } = {}) {
    const draftPath = path.join(outputDir, "H3", "2026-09-26", `${name}_00001_.mp4`);
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, "mp4");
    const graphs = structuredClone(DRAFTS[fixture]);
    if (seed !== undefined) {
      const noise = Object.values(graphs.prompt).find((node) => "noise_seed" in node.inputs);
      noise.inputs.noise_seed = seed;
    }
    drafts.set(draftPath, graphs);
    return { fingerprint: `fp-${name}`, draftPath };
  }

  const stateOf = (runner, clip) => runner.snapshot().items.find((item) => item.draftPath === clip.draftPath);
  const ticks = async (runner, count) => {
    for (let index = 0; index < count; index += 1) await runner.tick();
  };

  it("sends one clip: the recipe applied, its final beside the draft, and the provenance tag", async () => {
    const runner = newRunner();
    const clip = draft("213533");
    runner.addClips({ clips: [clip], recipeId, knobs: {} });
    await runner.tick();
    expect(stateOf(runner, clip).state).toBe("ready");
    expect(comfy.state.posted).toEqual([]); // nothing runs before Start

    await runner.start();
    expect(comfy.state.posted).toHaveLength(1);
    const posted = comfy.state.posted[0];
    expect(Object.keys(posted)).toEqual(["prompt", "extra_data"]); // no client_id
    const prefix = "H3/2026-09-26/213533_00001_final_omni-quality";
    const expected = applyRecipe(RECIPE, drafts.get(clip.draftPath), { filenamePrefix: prefix });
    expect(posted.prompt).toEqual(JSON.parse(stringifyComfyGraphJson(expected.prompt)));
    const pnginfo = posted.extra_data.extra_pnginfo;
    expect(pnginfo.workflow.nodes).toHaveLength(expected.workflow.nodes.length);
    expect(pnginfo.requeue).toMatchObject({
      source_path: "H3/2026-09-26/213533_00001_.mp4",
      recipe: { id: recipeId, name: "Omni quality" },
      settings: {},
      choices: {},
      passes: "single",
      phase: "single",
      videoswarm: { fingerprint: "fp-213533" },
    });
    expect(pnginfo.requeue.source_prompt).toEqual(JSON.parse(stringifyComfyGraphJson(drafts.get(clip.draftPath).prompt)));
    expect(pnginfo.requeue.source_prompt["667"].class_type).toBe("LoraLoaderModelOnly"); // the draft's graph, turbo LoRA and all
    expect(stateOf(runner, clip)).toMatchObject({ state: "waiting", attempts: 1 });

    comfy.startNext();
    await runner.tick();
    expect(stateOf(runner, clip).state).toBe("rendering");

    comfy.finish("p1", historyEntry({ file: { filename: "213533_00001_final_omni-quality_00001_.mp4", subfolder: "H3/2026-09-26" } }));
    await runner.tick();
    const finalPath = path.join(outputDir, "H3", "2026-09-26", "213533_00001_final_omni-quality_00001_.mp4");
    expect(stateOf(runner, clip)).toMatchObject({ state: "done", finalPath, seconds: 60 });
    expect(runner.history()).toEqual([
      expect.objectContaining({ fingerprint: "fp-213533", finalPath, recipeName: "Omni quality", seconds: 60 }),
    ]);
    await runner.tick();
    expect(runner.snapshot().running).toBe(false);
    expect(events.map((event) => event.reason)).toEqual(expect.arrayContaining(["queued", "rendering", "done", "finished"]));
  });

  it("names the final in the draft's own save folder when the draft is outside the output folder", () => {
    expect(
      finalPrefix({ draftPath: "/elsewhere/keepers/213533_00001_.mp4", outputDir, draftPrompt: { 9: { inputs: { filename_prefix: "H3/2026-09-26/213533" } } }, label: "q" })
    ).toBe("H3/2026-09-26/213533_00001_final_q");
    expect(finalPrefix({ draftPath: "/elsewhere/a_.mp4", outputDir: null, draftPrompt: { 9: { inputs: { filename_prefix: "../../etc/x" } } }, label: "q" })).toBe("a_final_q");
    expect(knobSummary({ name: "Omni Quality!", recipe: RECIPE }, { settings: { "set:124:steps": 50 } })).toBe("omni-quality_steps50");
  });

  it("runs in the page order, one at a time", async () => {
    const runner = newRunner();
    const clips = [draft("first", "omni-04"), draft("second", "omni-05"), draft("third", "omni-06")];
    clips.forEach((clip) => {
      runner.addClips({ clips: [clip], recipeId, knobs: {} });
      clock += 1;
    });
    const order = () => runner.snapshot().items.filter((item) => item.position).sort((a, b) => a.position - b.position).map((item) => path.basename(item.draftPath));
    expect(order()).toEqual(["first_00001_.mp4", "second_00001_.mp4", "third_00001_.mp4"]);
    runner.setOrder("last-added");
    expect(order()).toEqual(["third_00001_.mp4", "second_00001_.mp4", "first_00001_.mp4"]);
    // Until Phase 4's estimates, the estimate orders fall back to added order.
    runner.setOrder("longest");
    expect(order()).toEqual(["first_00001_.mp4", "second_00001_.mp4", "third_00001_.mp4"]);
    expect(() => runner.setOrder("random")).toThrow(/Unknown order/);

    runner.setOrder("last-added");
    await runner.start();
    await ticks(runner, 2);
    expect(comfy.state.posted).toHaveLength(1);
    expect(comfy.state.posted[0].prompt["957"].inputs.filename_prefix).toBe("H3/2026-09-26/third_00001_final_omni-quality");
  });

  it("stop withdraws a prompt that has not started and lets a rendering one finish", async () => {
    const runner = newRunner();
    const [first, second] = [draft("first", "omni-04"), draft("second", "omni-05")];
    runner.addClips({ clips: [first, second], recipeId, knobs: {} });
    await runner.start();
    await runner.stop();
    expect(comfy.state.deleted).toEqual(["p1"]);
    expect(stateOf(runner, first)).toMatchObject({ state: "ready" });

    await runner.start();
    comfy.startNext();
    await runner.tick();
    expect(stateOf(runner, first).state).toBe("rendering");
    await runner.stop();
    expect(comfy.state.deleted).toEqual(["p1"]);
    expect(runner.isActive()).toBe(true); // still rendering
    comfy.finish("p2", historyEntry({ file: { filename: "x.mp4", subfolder: "H3/2026-09-26" } }));
    await runner.tick();
    expect(stateOf(runner, first).state).toBe("done");
    expect(stateOf(runner, second).state).toBe("ready"); // stopped: nothing new is sent
    expect(comfy.state.posted).toHaveLength(2);
    expect(runner.isActive()).toBe(false);
  });

  it("fails a prompt ComfyUI lost and goes on with the queue", async () => {
    const runner = newRunner();
    const [first, later] = [draft("first", "omni-04"), draft("later", "omni-05")];
    runner.addClips({ clips: [first, later], recipeId, knobs: {} });
    await runner.start();
    comfy.startNext();
    await runner.tick();
    comfy.crash();
    await ticks(runner, 2);
    expect(stateOf(runner, first).state).toBe("rendering");
    await runner.tick();
    expect(stateOf(runner, first)).toMatchObject({ state: "failed", detail: "ComfyUI stopped during it (crashed or restarted?)" });
    expect(stateOf(runner, later).state).toBe("waiting");
    expect(comfy.state.posted).toHaveLength(2);
  });

  it("waits while ComfyUI is down, and new clips still show up", async () => {
    const runner = newRunner();
    const first = draft("first");
    runner.addClips({ clips: [first], recipeId, knobs: {} });
    await runner.start();
    comfy.state.down = true;
    await ticks(runner, 5);
    expect(runner.snapshot().comfyUp).toBe(false);
    expect(stateOf(runner, first).state).toBe("waiting");
    const late = draft("late", "omni-05");
    runner.addClips({ clips: [late], recipeId, knobs: {} });
    expect(stateOf(runner, late).state).toBe("ready");
    comfy.state.down = false;
    await runner.tick();
    expect(runner.snapshot().comfyUp).toBe(true);
    expect(stateOf(runner, first).state).toBe("waiting");
  });

  it("adopts its own prompt still on ComfyUI's queue after a restart", async () => {
    const before = newRunner();
    const clip = draft("213533");
    before.addClips({ clips: [clip], recipeId, knobs: {} });
    await before.start();
    comfy.startNext();
    await before.dispose();
    // The app quit before it saved the prompt id.
    const item = store.listQueueItems()[0];
    store.updateQueueItem(item.id, { state: "ready", promptId: null });

    const after = newRunner();
    await after.resume();
    expect(stateOf(after, clip)).toMatchObject({ state: "rendering" });
    expect(store.getQueueItem(item.id).promptId).toBe("p1");
    expect(after.snapshot().running).toBe(true);
    expect(comfy.state.posted).toHaveLength(1);
    // A prompt someone else queued is left alone.
    comfy.state.pending.push({ id: "theirs", prompt: {}, extra: { extra_pnginfo: { requeue: { source_prompt: {} } } } });
    const third = newRunner();
    await third.resume();
    expect(store.listQueueItems().map((entry) => entry.promptId)).toEqual(["p1"]);
  });

  it("holds a draft already rendered with the same recipe and settings, until asked again", async () => {
    const runner = newRunner();
    const clip = draft("213533");
    store.addFinal({ fingerprint: clip.fingerprint, draftPath: clip.draftPath, finalPath: path.join(outputDir, "old_final.mp4"), recipeId, knobs: {} });
    const result = runner.addClips({ clips: [clip], recipeId, knobs: {} });
    expect(result.held).toHaveLength(1);
    expect(stateOf(runner, clip)).toMatchObject({ state: "held", finalPath: path.join(outputDir, "old_final.mp4"), detail: "Rendered before with this recipe → old_final.mp4" });
    await runner.start();
    expect(comfy.state.posted).toEqual([]);
    // Other settings are another render.
    const other = runner.addClips({ clips: [clip], recipeId, knobs: { settings: { "set:124:steps": 50 } } });
    expect(other.added).toHaveLength(1);
    expect(runner.renderAgain(result.held[0])).toBe(true);
    expect(stateOf(runner, clip)).toBeTruthy();
    expect(store.getQueueItem(result.held[0]).state).toBe("ready");
  });

  it("runs the same draft queued twice once", async () => {
    const runner = newRunner();
    const clip = draft("213533");
    const twin = { fingerprint: clip.fingerprint, draftPath: clip.draftPath };
    const first = runner.addClips({ clips: [clip, twin], recipeId, knobs: {} });
    expect(first.added).toHaveLength(1);
    expect(first.duplicates).toEqual(first.added);
    const again = runner.addClips({ clips: [clip], recipeId, knobs: { choices: {}, settings: {} } });
    expect(again).toEqual({ added: [], duplicates: first.added, held: [] });
    await runner.start();
    await ticks(runner, 2);
    expect(comfy.state.posted).toHaveLength(1);
  });

  it("blocks a clip whose LoRA or reference file is missing, and never queues it", async () => {
    const runner = newRunner();
    const clip = draft("lora", "omni-04");
    const lora = Object.values(drafts.get(clip.draftPath).prompt).find((node) => node.class_type === "Power Lora Loader (rgthree)");
    lora.inputs.lora_1.on = true;
    const reference = draft("reference", "omni-05");
    const composer = drafts.get(reference.draftPath).prompt["801"];
    const slots = JSON.parse(composer.inputs.slot_filenames);
    slots[1] = "deleted-reference.png";
    composer.inputs.slot_filenames = JSON.stringify(slots);
    const fine = draft("fine", "omni-06");
    comfy.state.info.LoraLoaderModelOnly.input.required.lora_name[0] =
      comfy.state.info.LoraLoaderModelOnly.input.required.lora_name[0].filter((name) => name !== lora.inputs.lora_1.lora);

    runner.addClips({ clips: [clip, reference, fine], recipeId, knobs: {} });
    await runner.tick();
    expect(stateOf(runner, clip)).toMatchObject({ state: "blocked", detail: `Missing LoRA: ${lora.inputs.lora_1.lora}` });
    expect(stateOf(runner, clip).problems).toEqual([expect.objectContaining({ code: "COMFY_OPTION_MISSING" })]);
    expect(stateOf(runner, reference).detail).toBe(
      "MiniMaxH3Ref2VAComposer slot_filenames names deleted-reference.png, which is not in ComfyUI's input folder"
    );
    await runner.start();
    await ticks(runner, 2);
    expect(comfy.state.posted).toHaveLength(1);
    expect(comfy.state.posted[0].prompt["957"].inputs.filename_prefix).toContain("fine_00001_final");

    // Installing the LoRA unblocks the clip at the next check.
    comfy.state.info.LoraLoaderModelOnly.input.required.lora_name[0].push(lora.inputs.lora_1.lora);
    clock += 61_000;
    await runner.tick();
    expect(stateOf(runner, clip).state).toBe("ready");
  });

  it("fails out of memory and other errors with their reason, without retrying", async () => {
    const runner = newRunner();
    const [first, second, third] = [draft("a", "omni-04"), draft("b", "omni-05"), draft("c", "omni-06")];
    runner.addClips({ clips: [first, second, third], recipeId, knobs: {} });
    await runner.start();
    comfy.finish("p1", historyEntry({ ok: false, nodeType: "SamplerCustomAdvanced", message: "CUDA error: out of memory" }));
    await runner.tick();
    expect(stateOf(runner, first)).toMatchObject({ state: "failed", detail: "Out of memory in SamplerCustomAdvanced: CUDA error: out of memory" });
    // ComfyUI's own validation refuses the next one when it is sent.
    comfy.state.refuse = { error: { message: "Prompt outputs failed validation" }, node_errors: {} };
    comfy.finish("p2", historyEntry({ ok: false, nodeType: "VAEDecode", message: "shape mismatch" }));
    await runner.tick();
    expect(stateOf(runner, second)).toMatchObject({ state: "failed", detail: "VAEDecode: shape mismatch" });
    expect(stateOf(runner, third)).toMatchObject({ state: "failed", detail: "ComfyUI refused it: Prompt outputs failed validation" });
    expect(comfy.state.posted).toHaveLength(2);
    // Retrying is the user's decision.
    comfy.state.refuse = null;
    expect(runner.retry(stateOf(runner, third).id)).toBe(true);
    expect(runner.snapshot().running).toBe(false); // the queue had finished
    await runner.start();
    expect(stateOf(runner, third).state).toBe("waiting");
  });

  it("does nothing while the connection is off, and never talks to ComfyUI", async () => {
    connection = { enabled: false, url: comfy.url, outputDir };
    const runner = newRunner();
    runner.addClips({ clips: [draft("a")], recipeId, knobs: {} });
    await runner.start();
    await runner.resume();
    expect(comfy.state.requests).toEqual([]);
    expect(runner.snapshot()).toMatchObject({ enabled: false, running: false, comfyUp: null });
  });
});
