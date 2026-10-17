const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

/**
 * View › Layout › Justified rows in the real app: the cards in a row share
 * its height, every row but the last ends at the same right edge, and cards
 * read left to right in sort order.
 */
test("grid rows: rows fill the width and read in sort order", async () => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 8, "row-clips");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(8);

    await page.getByRole("button", { name: /^View/ }).first().click();
    await page.getByRole("menuitemradio", { name: "Justified rows" }).click();
    await page.keyboard.press("Escape");
    // Large enough cards that the eight clips need more than one row.
    await page.keyboard.press("=");
    await page.keyboard.press("=");

    await expect
      .poll(async () => {
        const boxes = await page.locator(".video-item").evaluateAll((items) =>
          items.map((item) => {
            const rect = item.getBoundingClientRect();
            return { top: Math.round(rect.top), right: Math.round(rect.right), height: Math.round(rect.height) };
          })
        );
        const rows = new Map();
        for (const box of boxes) {
          if (!rows.has(box.top)) rows.set(box.top, []);
          rows.get(box.top).push(box);
        }
        const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
        return {
          rows: ordered.length > 1,
          oneHeightEach: ordered.every((row) => new Set(row.map((box) => box.height)).size === 1),
          fullRowEdges: new Set(ordered.slice(0, -1).map((row) => Math.max(...row.map((box) => box.right)))).size,
        };
      })
      .toEqual({ rows: true, oneHeightEach: true, fullRowEdges: 1 });

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
