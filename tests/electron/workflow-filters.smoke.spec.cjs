const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { writeTaggedVideo, writeVideo } = require("./helpers/videoFixture.cjs");

/**
 * Workflow filters in the real app (docs/architecture/workflow-filters.md):
 * workflows are read in the background with generation keys, and Filters ›
 * Workflow keeps the clips whose workflow uses or leaves out some words, or
 * ran enough steps. A clip without a workflow is hidden while one is set.
 */

const workflow = ({ lora, steps, seed }) =>
  JSON.stringify({
    1: { class_type: "CLIPTextEncode", inputs: { text: "a lantern floating over a dark lake" } },
    2: { class_type: "AcmeLoraLoader", inputs: { lora_name: `loras/${lora}.safetensors` } },
    3: { class_type: "AcmeSampler", inputs: { seed, steps, positive: ["1", 0] } },
  });

test("workflow filters: leave out a LoRA, keep one, and bound the steps", async () => {
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folder = path.join(tempRoot, "workflow-clips");
  fs.mkdirSync(folder, { recursive: true });
  writeTaggedVideo(path.join(folder, "fast.mp4"), { prompt: workflow({ lora: "Acme_Turbo_Lora", steps: 6, seed: 1 }) }, 1);
  writeTaggedVideo(path.join(folder, "full.mp4"), { prompt: workflow({ lora: "Acme_Style_Lora", steps: 30, seed: 2 }) }, 2);
  writeVideo(path.join(folder, "plain.mp4"), 3);
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  const names = () =>
    page.locator(".video-item").evaluateAll((items) => items.map((item) => item.dataset.filename).sort());

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folder);
    await expect(page.locator(".video-item")).toHaveCount(3);
    await page.getByRole("button", { name: /^(Open filters|Filters)/ }).first().click();

    const leaveOut = page.getByRole("searchbox", { name: "Words the workflow leaves out" });
    await leaveOut.fill("turbo");
    // Once the workflows are read: the full run only.
    await expect.poll(names, { timeout: 30_000 }).toEqual(["full.mp4"]);
    await leaveOut.fill("");

    await page.getByRole("searchbox", { name: "Words the workflow uses" }).fill("TURBO lora");
    await expect.poll(names, { timeout: 15_000 }).toEqual(["fast.mp4"]);
    await page.getByRole("searchbox", { name: "Words the workflow uses" }).fill("");

    await page
      .getByRole("group", { name: "Minimum steps" })
      .getByRole("button", { name: "≥ 20" })
      .click();
    await expect.poll(names, { timeout: 15_000 }).toEqual(["full.mp4"]);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
