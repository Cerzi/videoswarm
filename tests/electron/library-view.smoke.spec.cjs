const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

/**
 * A smart view for the entire library: Filters › Entire library closes the
 * folder, and the side panel with its + stays, so the view can be saved and
 * searches the library wherever it is applied.
 */
test("library view: save a smart view while searching the entire library", async () => {
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 2, "library-clips");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(2);
    await page.getByRole("button", { name: /^(Open filters|Filters)/ }).first().click();
    await page.getByRole("group", { name: "Search scope" }).getByRole("button", { name: "Entire library" }).click();
    await page.keyboard.press("Escape");

    const save = page.getByRole("button", { name: "Save current smart view" });
    await expect(save).toBeVisible();
    await save.click();
    await page.getByRole("textbox", { name: "Smart view name" }).fill("Everything");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Everything Library", exact: true })).toBeVisible();

    const views = await page.evaluate(() => window.electronAPI.library.listSavedViews());
    const list = Array.isArray(views) ? views : views?.views || [];
    expect(list.find((view) => view.name === "Everything")?.definition?.searchScope).toBe("library");
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
