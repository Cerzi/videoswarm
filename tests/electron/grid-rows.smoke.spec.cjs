const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

/**
 * View › Layout › Rows of equal height in the real app: every card in the
 * grid shares one height, and cards read left to right in sort order.
 */
test("grid rows: cards share one height and read in sort order", async () => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 8, "row-clips");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(8);

    await page.getByRole("button", { name: /^View/ }).first().click();
    await page.getByRole("menuitemradio", { name: "Rows of equal height" }).click();

    await expect
      .poll(async () => {
        const boxes = await page.locator(".video-item").evaluateAll((items) =>
          items.map((item) => {
            const rect = item.getBoundingClientRect();
            return { name: item.dataset.filename, top: Math.round(rect.top), left: Math.round(rect.left), height: Math.round(rect.height) };
          })
        );
        return new Set(boxes.map((box) => box.height)).size;
      })
      .toBe(1);

    const boxes = await page.locator(".video-item").evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { name: item.dataset.filename, top: Math.round(rect.top), left: Math.round(rect.left) };
      })
    );
    const reading = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left).map((box) => box.name);
    expect(reading).toEqual([...reading].sort());
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
