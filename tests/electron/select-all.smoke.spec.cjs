const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

/**
 * Ctrl+A in the real app: every clip the grid shows is selected, the status
 * line counts them, Esc clears them, and a text field keeps Ctrl+A for its
 * own text.
 */
test("select all: every clip, counted in the status line, cleared by Esc", async () => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 6, "select-all-clips");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(6);

    await page.locator(".video-item").first().click();
    await page.keyboard.press("Control+a");
    await expect(page.locator(".video-item.selected")).toHaveCount(6);
    await expect(page.locator(".debug-info").getByText("6 selected")).toBeVisible();
    // The page's own text was not selected.
    expect(await page.evaluate(() => window.getSelection().toString())).toBe("");

    await page.keyboard.press("Escape");
    await expect(page.locator(".video-item.selected")).toHaveCount(0);
    await expect(page.locator(".debug-info").getByText(/selected/)).toHaveCount(0);

    // In a text field, Ctrl+A selects its text, not the clips.
    await page.getByRole("button", { name: /^(Open filters|Filters)/ }).first().click();
    const words = page.getByRole("searchbox", { name: "Words in the prompt" });
    await words.fill("lantern");
    await words.press("Control+a");
    await expect(page.locator(".video-item.selected")).toHaveCount(0);
    expect(await words.evaluate((input) => input.selectionEnd - input.selectionStart)).toBe(7);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
