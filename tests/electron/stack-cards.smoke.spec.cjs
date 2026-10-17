const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { writeTaggedVideo } = require("./helpers/videoFixture.cjs");

/**
 * Stack cards in the real app (docs/architecture/prompt-stacks.md, Section 8):
 * runs of one made-up prompt stack together, main grabs their first frames
 * with ffmpeg, and the card shows a strip of stills that opens the stack at a
 * clip. Needs ffmpeg on PATH, as stills do in the app.
 */

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function promptFor(seed) {
  return JSON.stringify({
    1: { class_type: "CLIPTextEncode", inputs: { text: "a lighthouse on a cliff at dusk with waves", clip: ["4", 1] } },
    2: { class_type: "KSampler", inputs: { seed, steps: 20, cfg: 6, positive: ["1", 0] } },
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  });
}

test("stack cards: a strip of first-frame stills that opens the stack at a clip", async () => {
  test.skip(!hasFfmpeg, "ffmpeg is not on PATH");
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = path.join(tempRoot, "stack-clips");
  fs.mkdirSync(folderPath, { recursive: true });
  for (let index = 0; index < 6; index += 1) {
    writeTaggedVideo(
      path.join(folderPath, `run-${index}.mp4`),
      { prompt: promptFor(100 + index) },
      index
    );
  }
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(6);
    // Prompt keys are read in the background once the folder settles.
    await page.keyboard.press("g");
    await expect(page.locator(".video-item")).toHaveCount(1, { timeout: 30_000 });

    const strip = page.locator(".video-item-stack-strip");
    await expect(strip).toBeVisible({ timeout: 30_000 });
    await expect(strip.locator(".video-item-stack-still img")).toHaveCount(3, { timeout: 30_000 });
    await expect(strip.getByRole("button", { name: "+2" })).toBeVisible();
    const src = await strip.locator(".video-item-stack-still img").first().getAttribute("src");
    expect(src).toMatch(/^data:image\/jpeg;base64,/u);

    // Hovering a still plays that clip over the header, and leaving stops it.
    await strip.getByRole("button", { name: "Open the stack at this clip" }).first().hover();
    await expect(page.locator(".video-item-stack-peek.is-playing")).toHaveCount(1, { timeout: 15_000 });
    await page.mouse.move(0, 0);
    await expect(page.locator(".video-item-stack-peek")).toHaveCount(0);

    await strip.getByRole("button", { name: "Open the stack at this clip" }).nth(1).click();
    await expect(page.locator(".video-item")).toHaveCount(6);
    await expect(page.locator(".video-item.selected")).toHaveCount(1);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
