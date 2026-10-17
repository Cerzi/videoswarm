const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

/**
 * The status line's background work note in the real app
 * (docs/architecture/background-activity.md): a pause reaches main and
 * shows in the line until resumed from its panel.
 */
test("background activity: a pause shows in the status line until resumed", async () => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 3, "activity-clips");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(3);
    // Idle: nothing in the status line.
    await expect(page.locator(".background-activity")).toHaveCount(0);

    await page.evaluate(() => window.electronAPI.activity.setPaused(true));
    const chip = page.getByRole("button", { name: /Background work paused/ });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByRole("dialog", { name: "Background work" })).toBeVisible();
    await page.getByRole("button", { name: "Resume" }).click();

    await expect.poll(() => page.evaluate(() => window.electronAPI.activity.get())).toMatchObject({ paused: false });
    await page.keyboard.press("Escape");
    await expect(page.locator(".background-activity")).toHaveCount(0);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
