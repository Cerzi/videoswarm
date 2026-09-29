const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  createProductionAppWorkspace,
  launchProductionApp,
  chooseFolderThroughNativeDialog,
} = require("./helpers/launchApp.cjs");
const { writeVideo } = require("./helpers/videoFixture.cjs");
const { createFakeComfyUi, historyEntry } = require("../../main/__tests__/helpers/fakeComfyUi.cjs");
const { parseComfyGraphJson, stringifyComfyGraphJson } = require("../../main/comfy-graph-json.js");

/**
 * The re-render queue in the real app, against a fake ComfyUI on loopback:
 * the connection setting, learning a recipe from comfy-requeue finals,
 * queueing and sending a draft, the tray keeping the app alive while the
 * queue is active with the window closed, and the question before quitting
 * under a render. It never talks to a real ComfyUI.
 */

const FIXTURES = path.join(__dirname, "..", "..", "main", "__tests__", "fixtures", "recipes");
const load = (name) => parseComfyGraphJson(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

function box(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

const uint32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

// An MP4 carrying ComfyUI's tags as QuickTime `mdta` metadata, the way
// ComfyUI's SaveVideo writes them: the tiny fixture video with a moov-level
// meta box added, and its one chunk offset moved past it.
function writeTaggedVideo(filePath, tags, token) {
  writeVideo(filePath, token);
  const video = fs.readFileSync(filePath);
  const entries = Object.entries(tags);
  const keys = box(
    "keys",
    uint32(0),
    uint32(entries.length),
    ...entries.map(([name]) => box("mdta", Buffer.from(name, "utf8")))
  );
  const items = entries.map(([, value], index) =>
    box(uint32(index + 1).toString("latin1"), box("data", uint32(1), uint32(0), Buffer.from(value, "utf8")))
  );
  const meta = box("meta", uint32(0), box("hdlr", Buffer.alloc(8), Buffer.from("mdta"), Buffer.alloc(13)), keys, box("ilst", ...items));

  const moovAt = video.indexOf("moov") - 4;
  const moovSize = video.readUInt32BE(moovAt);
  const moov = Buffer.from(video.subarray(moovAt, moovAt + moovSize));
  const stco = moov.indexOf("stco");
  const count = moov.readUInt32BE(stco + 8);
  for (let index = 0; index < count; index += 1) {
    const at = stco + 12 + index * 4;
    moov.writeUInt32BE(moov.readUInt32BE(at) + meta.length, at);
  }
  const grown = Buffer.concat([moov, meta]);
  grown.writeUInt32BE(grown.length, 0);
  fs.writeFileSync(
    filePath,
    Buffer.concat([video.subarray(0, moovAt), grown, video.subarray(moovAt + moovSize)])
  );
}

function nodeInfo() {
  const text = fs.readdirSync(FIXTURES).map((file) => fs.readFileSync(path.join(FIXTURES, file), "utf8")).join("\n");
  const info = {};
  for (const name of fs.readdirSync(FIXTURES)) {
    const fixture = load(path.basename(name, ".json"));
    for (const node of [...Object.values(fixture.draft.prompt), ...Object.values(fixture.final.prompt)]) {
      info[node.class_type] = { input: { required: {} }, output_node: node.class_type === "SaveVideo" };
    }
  }
  info.LoadImage = { input: { required: { image: [[...new Set(text.match(/media-\d+\.[a-z0-9]+/g))]] } } };
  info.LoraLoaderModelOnly = { input: { required: { lora_name: [[...new Set(text.match(/model-\d+\.safetensors/g))]] } } };
  return info;
}

async function waitUntil(check, timeout = 15_000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test("re-render queue: connect, learn, send, stay in the tray, ask before quitting", async () => {
  test.setTimeout(120_000);
  const workspace = createProductionAppWorkspace();
  const outputDir = path.join(workspace.tempRoot, "comfy-output");
  fs.mkdirSync(outputDir, { recursive: true });

  // Three comfy-requeue finals (each carries its draft) and a draft.
  const finals = ["omni-01", "omni-02", "omni-03"].map((name, index) => {
    const fixture = load(name);
    const finalWorkflow = structuredClone(fixture.draft.workflow);
    for (const node of finalWorkflow.nodes) Object.assign(node, fixture.final.workflow.patchOfDraft[node.id] || {});
    const filePath = path.join(outputDir, `${name}_final_00001_.mp4`);
    writeTaggedVideo(filePath, {
      prompt: stringifyComfyGraphJson(fixture.final.prompt),
      workflow: stringifyComfyGraphJson(finalWorkflow),
      requeue: stringifyComfyGraphJson({
        source_prompt: fixture.draft.prompt,
        source_workflow: fixture.draft.workflow,
        passes: "single",
        phase: "single",
      }),
    }, index + 1);
    return filePath;
  });
  const draftFixture = load("omni-04");
  const draftPath = path.join(outputDir, "213533_00001_.mp4");
  writeTaggedVideo(draftPath, {
    prompt: stringifyComfyGraphJson(draftFixture.draft.prompt),
    workflow: stringifyComfyGraphJson(draftFixture.draft.workflow),
  }, 9);

  const comfy = createFakeComfyUi({ info: nodeInfo() });
  await comfy.listen();
  let context = await launchProductionApp({ workspace });
  try {
    const { electronApp, page } = context;
    await chooseFolderThroughNativeDialog(electronApp, page, outputDir);
    await page.waitForFunction(() => document.querySelector(".debug-info")?.textContent?.includes("4 clips"));

    // Off by default; only a loopback address is accepted.
    expect(await page.evaluate(() => window.electronAPI.comfyQueue.getConnection())).toMatchObject({ enabled: false });
    await expect(
      page.evaluate((dir) => window.electronAPI.comfyQueue.setConnection({ enabled: true, url: "http://example.com:8188", outputDir: dir }), outputDir)
    ).rejects.toThrow(/this computer/);
    const connection = await page.evaluate(
      ({ url, dir }) => window.electronAPI.comfyQueue.setConnection({ enabled: true, url, outputDir: dir }),
      { url: comfy.url, dir: outputDir }
    );
    expect(connection).toMatchObject({ enabled: true, url: comfy.url });
    expect(await page.evaluate(() => window.electronAPI.comfyQueue.testConnection())).toMatchObject({ ok: true });
    expect(comfy.state.requests.every((entry) => entry.startsWith("GET "))).toBe(true);

    const learned = await page.evaluate(
      (paths) => window.electronAPI.comfyQueue.recipes.learn({ name: "Omni quality", examples: paths.map((finalPath) => ({ finalPath })) }),
      finals
    );
    expect(learned.error).toBeUndefined();
    expect(learned.recipe).toMatchObject({ name: "Omni quality", operations: 5, varies: 1 });

    const added = await page.evaluate(
      ({ recipeId, fullPath }) => window.electronAPI.comfyQueue.add({ recipeId, clips: [{ fullPath }, { fullPath }] }),
      { recipeId: learned.recipe.id, fullPath: draftPath }
    );
    expect(added.added).toHaveLength(1);
    expect(added.duplicates).toHaveLength(1);
    // A path the renderer was never shown is refused.
    await expect(
      page.evaluate((recipeId) => window.electronAPI.comfyQueue.add({ recipeId, clips: [{ fullPath: "/etc/hostname" }] }), learned.recipe.id)
    ).rejects.toThrow();

    await page.evaluate(() => window.electronAPI.comfyQueue.start());
    await waitUntil(() => comfy.state.posted.length === 1);
    const posted = comfy.state.posted[0];
    expect(Object.keys(posted)).toEqual(["prompt", "extra_data"]);
    expect(posted.prompt["957"].inputs.filename_prefix).toBe("213533_00001_final_omni-quality");
    expect(posted.prompt["667"]).toBeUndefined(); // the turbo LoRA the recipe removes
    expect(posted.extra_data.extra_pnginfo.requeue).toMatchObject({ source_path: "213533_00001_.mp4", recipe: { name: "Omni quality" } });

    // With the window closed while it renders, Video Swarm stays running.
    comfy.startNext();
    await waitUntil(async () => (await page.evaluate(() => window.electronAPI.comfyQueue.list())).items[0].state === "rendering");
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await waitUntil(async () => (await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0);
    comfy.finish("p1", historyEntry({ file: { filename: "213533_00001_final_omni-quality_00001_.mp4", subfolder: "" } }));
    await new Promise((resolve) => setTimeout(resolve, 4_000)); // one poll
    expect(await electronApp.evaluate(({ app }) => app.isReady())).toBe(true);

    // Back from the tray: the render finished while the window was closed.
    const reopened = electronApp.waitForEvent("window");
    await electronApp.evaluate(({ app }) => app.emit("activate"));
    const page2 = await reopened;
    await page2.waitForLoadState("domcontentloaded");
    await page2.waitForFunction(() => Boolean(window.electronAPI?.comfyQueue));
    const done = await waitUntil(async () => {
      const list = await page2.evaluate(() => window.electronAPI.comfyQueue.list());
      return list.items[0].state === "done" ? list : null;
    });
    expect(done.items[0].finalPath).toBe(path.join(fs.realpathSync(outputDir), "213533_00001_final_omni-quality_00001_.mp4"));
    expect(await page2.evaluate(() => window.electronAPI.comfyQueue.history())).toHaveLength(1);

    // Quitting while a prompt is in ComfyUI asks first; Cancel keeps it open.
    await chooseFolderThroughNativeDialog(electronApp, page2, outputDir);
    await page2.waitForFunction(() => document.querySelector(".debug-info")?.textContent?.includes("4 clips"));
    await page2.evaluate(
      ({ recipeId, fullPath }) => window.electronAPI.comfyQueue.add({ recipeId, clips: [{ fullPath }], settings: { "set:124:steps": 50 } }),
      { recipeId: learned.recipe.id, fullPath: draftPath }
    );
    await page2.evaluate(() => window.electronAPI.comfyQueue.start());
    await waitUntil(() => comfy.state.posted.length === 2);
    expect(comfy.state.posted[1].prompt["957"].inputs.filename_prefix).toBe("213533_00001_final_omni-quality_steps50");
    await electronApp.evaluate(({ app, dialog }) => {
      globalThis.__quitQuestions = 0;
      dialog.showMessageBox = async () => {
        globalThis.__quitQuestions += 1;
        return { response: 1 };
      };
      app.quit();
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await electronApp.evaluate(() => globalThis.__quitQuestions)).toBe(1);
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    const closed = electronApp.waitForEvent("close");
    await electronApp.evaluate(({ app, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 });
      app.quit();
    });
    await closed;
    // The prompt stays in ComfyUI; nothing was withdrawn.
    expect(comfy.state.deleted).toEqual([]);

    // Next start: the prompt is still ComfyUI's, and the queue follows it.
    context = await launchProductionApp({ workspace });
    comfy.startNext();
    const list = await waitUntil(async () => {
      const snapshot = await context.page.evaluate(() => window.electronAPI?.comfyQueue?.list());
      return snapshot?.items?.find((item) => item.state === "rendering") ? snapshot : null;
    });
    expect(list.items.map((item) => item.state)).toEqual(["done", "rendering"]);
  } finally {
    // A prompt is still in ComfyUI, so quitting asks; answer Quit.
    await context.electronApp
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0 });
      })
      .catch(() => {});
    await context.electronApp.close().catch(() => {});
    await comfy.close();
    workspace.cleanup();
  }
});
