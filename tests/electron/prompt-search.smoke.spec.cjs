const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { writeTaggedVideo } = require("./helpers/videoFixture.cjs");

/**
 * Prompt search in the real app (prompt-search-and-tag-suggestions.md): clips
 * with made-up prompts, searched from Filters › Prompt. A word only in the
 * negative prompt finds nothing.
 */

function promptFor(positive, seed) {
  return JSON.stringify({
    1: { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["4", 1] } },
    2: { class_type: "CLIPTextEncode", inputs: { text: "blurry low quality watermark", clip: ["4", 1] } },
    3: { class_type: "KSampler", inputs: { seed, steps: 20, positive: ["1", 0], negative: ["2", 0] } },
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  });
}

const card = (page, filename) => page.locator(`.video-item[data-filename="${filename}"]`);

test("prompt search: words in the positive prompt narrow the grid", async () => {
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = path.join(tempRoot, "prompt-clips");
  fs.mkdirSync(folderPath, { recursive: true });
  const prompts = [
    "a lighthouse on a cliff at dusk",
    "a woman dancing on a beach at night",
    "a woman dancing in a quiet studio",
  ];
  prompts.forEach((text, index) =>
    writeTaggedVideo(path.join(folderPath, `clip-${index}.mp4`), { prompt: promptFor(text, 10 + index) }, index)
  );
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(3);
    await page.getByRole("button", { name: /^(Open filters|Filters)/ }).first().click();
    const field = page.getByRole("searchbox", { name: "Words in the prompt" });

    // Prompt keys are read in the background; the search waits for them.
    await field.fill("danc");
    await expect(page.locator(".video-item")).toHaveCount(2, { timeout: 30_000 });
    await expect(card(page, "clip-0.mp4")).toHaveCount(0);

    await field.fill("danc -beach");
    await expect(page.locator(".video-item")).toHaveCount(1);
    await expect(card(page, "clip-2.mp4")).toBeVisible();

    await field.fill("blurry");
    await expect(page.locator(".video-item")).toHaveCount(0);

    await field.fill("");
    await expect(page.locator(".video-item")).toHaveCount(3);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
