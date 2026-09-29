const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

// Everything here lives in the launch helper's temporary workspace: the
// library, the export folders and the profile. Nothing outside it is read
// or written.

async function stubFolderPicker(electronApp, folderPath) {
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
    });
  }, folderPath);
}

const card = (page, filename) =>
  page.locator(`.video-item[data-filename="${filename}"]`);

async function sequenceNames(page) {
  return page
    .locator(".sequence-panel__list .sequence-panel__name")
    .allTextContents();
}

test("clip sequences: add, reorder, export a numbered copy and one video, renumber", async ({ browserName: _browserName }, testInfo) => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 4, "story-clips");
  const copyDestination = path.join(tempRoot, "numbered-copy");
  const videoDestination = path.join(tempRoot, "one-video");
  fs.mkdirSync(copyDestination);
  fs.mkdirSync(videoDestination);
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await page.evaluate(() => {
      window.__sequenceSmokeMilestones = [];
      window.addEventListener("videoswarm:folder-performance", (event) => {
        window.__sequenceSmokeMilestones.push(event.detail?.milestone);
      });
    });
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(card(page, "clip-0003.mp4")).toBeVisible();
    // Clips are added by fingerprint, so wait until the scan has indexed them.
    await expect
      .poll(() => page.evaluate(() => window.__sequenceSmokeMilestones))
      .toContain("scan-complete");

    const gridOrder = await page
      .locator(".video-item")
      .evaluateAll((items) => items.map((item) => item.dataset.filename));

    // Click order 3 then 0; the sequence takes the grid's order instead.
    await card(page, "clip-0003.mp4").click();
    await card(page, "clip-0000.mp4").click({ modifiers: ["Control"] });
    await page.keyboard.press("b");

    const sequencesTab = page.getByRole("tab", { name: /^Sequences/ });
    await expect(sequencesTab).toHaveAttribute("aria-selected", "true");
    const firstTwo = gridOrder.filter((name) =>
      ["clip-0003.mp4", "clip-0000.mp4"].includes(name)
    );
    await expect.poll(() => sequenceNames(page)).toEqual(firstTwo);

    // A single clip from the context menu.
    await card(page, "clip-0001.mp4").click();
    await card(page, "clip-0001.mp4").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Add to sequence/ }).click();
    await expect.poll(() => sequenceNames(page)).toEqual([...firstTwo, "clip-0001.mp4"]);

    // Reorder inside the panel with ordinary drag and drop: last to first.
    const entries = page.locator(".sequence-panel__list > li");
    await entries.nth(2).dragTo(entries.nth(0));
    await expect.poll(() => sequenceNames(page)).toEqual([
      "clip-0001.mp4",
      ...firstTwo,
    ]);
    // And with the keyboard: move the new last entry up one.
    await entries.nth(2).focus();
    await page.keyboard.press("Alt+ArrowUp");
    const ordered = ["clip-0001.mp4", firstTwo[1], firstTwo[0]];
    await expect.poll(() => sequenceNames(page)).toEqual(ordered);
    await expect(sequencesTab).toHaveAccessibleName(/3 clips in the sequence/);

    // Screenshots for a person to look at; test-results/ is not committed.
    const shots = path.join(context.projectRoot, "test-results");
    fs.mkdirSync(shots, { recursive: true });
    await page.locator(".workspace-sidebar").screenshot({
      path: path.join(shots, "sequences-panel.png"),
    });
    await page.screenshot({ path: path.join(shots, "sequences-window.png") });

    // Numbered copy into a temporary folder.
    await stubFolderPicker(electronApp, copyDestination);
    await page.getByRole("button", { name: "Sequence file actions" }).click();
    await page.getByRole("menuitem", { name: "Copy as numbered files…" }).click();
    const copyDialog = page.getByRole("dialog", { name: "Copy as numbered files" });
    await copyDialog.getByRole("button", { name: "Choose folder…" }).click();
    await expect(copyDialog.getByRole("list", { name: "Names in the destination" })).toBeVisible();
    await copyDialog.getByRole("button", { name: "Copy 3 files" }).click();
    await expect(copyDialog.getByText("Numbered copy complete")).toBeVisible();
    const expectedCopies = ordered.map(
      (name, index) => `${String((index + 1) * 10).padStart(3, "0")}_${name}`
    );
    expect(fs.readdirSync(copyDestination).sort()).toEqual(
      [...expectedCopies, "concat.txt"].sort()
    );
    expectedCopies.forEach((copyName, index) => {
      expect(
        fs.readFileSync(path.join(copyDestination, copyName)).equals(
          fs.readFileSync(path.join(folderPath, ordered[index]))
        )
      ).toBe(true);
    });
    const concatLines = fs
      .readFileSync(path.join(copyDestination, "concat.txt"), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("file "));
    expect(concatLines).toEqual(expectedCopies.map((name) => `file '${name}'`));
    await copyDialog.getByRole("button", { name: "Done" }).click();

    // Running it again into the same folder is refused, not overwritten.
    await page.getByRole("button", { name: "Sequence file actions" }).click();
    await page.getByRole("menuitem", { name: "Copy as numbered files…" }).click();
    await copyDialog.getByRole("button", { name: "Choose folder…" }).click();
    await expect(copyDialog.getByText(/choose an empty folder/)).toBeVisible();
    await expect(copyDialog.getByRole("button", { name: "Copy 3 files" })).toBeDisabled();
    await copyDialog.getByRole("button", { name: "Cancel" }).click();

    // One video, where ffmpeg is installed.
    await page.getByRole("button", { name: "Sequence file actions" }).click();
    const oneVideo = page.getByRole("menuitem", { name: "Export as one video…" });
    if (await oneVideo.isEnabled()) {
      await stubFolderPicker(electronApp, videoDestination);
      await oneVideo.click();
      const videoDialog = page.getByRole("dialog", { name: "Export as one video" });
      await videoDialog.getByRole("button", { name: "Choose folder…" }).click();
      await videoDialog.getByRole("button", { name: /^(Export|Re-encode and export)$/ }).click();
      await expect(videoDialog.getByText("Export complete")).toBeVisible({ timeout: 45_000 });
      expect(fs.readdirSync(videoDestination)).toEqual(["Sequence 1.mp4"]);
      await videoDialog.getByRole("button", { name: "Done" }).click();
    } else {
      await page.keyboard.press("Escape");
      testInfo.annotations.push({ type: "skipped", description: "ffmpeg absent: one-video export not exercised" });
    }

    // Renumber the originals in place, after confirming the listed renames.
    await page.getByRole("button", { name: "Sequence file actions" }).click();
    await page.getByRole("menuitem", { name: "Rename originals to this order…" }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename originals to this order" });
    await expect(renameDialog.getByText("010_clip-0001.mp4")).toBeVisible();
    await page.screenshot({ path: path.join(shots, "sequences-renumber-dialog.png") });
    await renameDialog.getByRole("button", { name: "Rename 3 files" }).click();
    await expect(renameDialog).toBeHidden();
    expect(fs.readdirSync(folderPath).sort()).toEqual(
      [...expectedCopies, "clip-0002.mp4"].sort()
    );
    // The sequence follows its clips to their new names, none missing.
    await expect.poll(() => sequenceNames(page)).toEqual(expectedCopies);
    await expect(page.locator(".sequence-panel__warning")).toHaveCount(0);

    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
