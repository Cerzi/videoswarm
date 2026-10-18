const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { writeTaggedVideo } = require("./helpers/videoFixture.cjs");

/**
 * Versions side by side in the real app
 * (docs/architecture/generation-versions.md, Section 8): a clip whose other
 * versions live in a folder that is not open shows them all from its
 * versions pill, playable, and Esc leads back.
 */

// One made-up generation: every clip written from it is a version of it.
const PROMPT = JSON.stringify({
  1: { class_type: "CLIPTextEncode", inputs: { text: "a paper boat on a rainy street", clip: ["4", 1] } },
  2: { class_type: "KSampler", inputs: { seed: 7, steps: 20, cfg: 6, positive: ["1", 0] } },
  4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
});

test("versions view: every version side by side, from another folder too", async () => {
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const finals = path.join(tempRoot, "finals");
  const drafts = path.join(tempRoot, "drafts");
  fs.mkdirSync(finals, { recursive: true });
  fs.mkdirSync(drafts, { recursive: true });
  writeTaggedVideo(path.join(finals, "final-a.mp4"), { prompt: PROMPT }, 1);
  writeTaggedVideo(path.join(finals, "final-b.mp4"), { prompt: PROMPT }, 2);
  writeTaggedVideo(path.join(drafts, "draft.mp4"), { prompt: PROMPT }, 3);
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    // The finals are indexed first, as a library folder opened before.
    await chooseFolderThroughNativeDialog(electronApp, page, finals);
    await expect(page.locator(".video-item")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /Show the 2 versions/ }).first()).toBeVisible({
      timeout: 30_000,
    });

    await chooseFolderThroughNativeDialog(electronApp, page, drafts);
    await expect(page.locator(".video-item")).toHaveCount(1);
    const pill = page.getByRole("button", { name: /Show the 3 versions/ });
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await pill.click();

    await expect(page.getByRole("toolbar", { name: "Versions side by side" })).toContainText(
      "3 versions of this generation, best first · 2 from folders that aren't open"
    );
    await expect(page.locator(".video-item")).toHaveCount(3);
    // The versions from the other folder play.
    await expect(page.locator(".video-item video")).toHaveCount(3, { timeout: 15_000 });
    // One row, side by side.
    const tops = await page.locator(".video-item").evaluateAll((items) =>
      items.map((item) => Math.round(item.getBoundingClientRect().top))
    );
    expect(new Set(tops).size).toBe(1);
    await page.getByRole("button", { name: "Play together from the start" }).click();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("toolbar", { name: "Versions side by side" })).toHaveCount(0);
    await expect(page.locator(".video-item")).toHaveCount(1);
    await expect(page.locator(".video-item.selected")).toHaveCount(1);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
