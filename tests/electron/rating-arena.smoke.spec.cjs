const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

/**
 * The rating arena in the real app (docs/architecture/rating-arena.md): a
 * first round of unrated clips, a Place round that moves on once New is
 * rated, Undo bringing that round back, and the summary on leaving.
 */
const pill = (page) => page.locator(".video-item .video-item-versions--label");

test("rating arena: first round, place, undo and leave", async () => {
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 5, "arena-clips");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  const bar = () => page.getByRole("toolbar", { name: "Rating arena" });

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(5);

    await page.getByRole("button", { name: "Arena", exact: true }).click();
    // Nothing rated yet: three clips to rate from scratch.
    await expect(bar()).toContainText("First ratings");
    await expect(bar()).toContainText("Round 1 · 5 unrated left");
    await expect(page.locator(".video-item")).toHaveCount(3);
    await expect(page.locator(".video-item").first()).toHaveClass(/selected/);
    await page.keyboard.press("3");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("5");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("1");

    // Rated 1, 3 and 5: the next round places an unrated clip among them.
    await expect(bar()).toContainText("Round 2 · 2 unrated left");
    await expect(bar()).toContainText("Where does New go?");
    await expect(bar()).toContainText("3 placed");
    await expect(page.locator(".video-item")).toHaveCount(4);
    await expect(pill(page)).toHaveText(["New", "1★", "3★", "5★"]);
    await page.keyboard.press("4");
    await expect(bar()).toContainText("Round 3 · 1 unrated left");

    // Undo brings that round back with New unrated again.
    await page.keyboard.press("z");
    await expect(bar()).toContainText("Round 2");
    await expect(pill(page).first()).toHaveText("New");
    await expect(bar()).toContainText("2 unrated left");
    await page.keyboard.press("2");
    await expect(bar()).toContainText("Round 3 · 1 unrated left");

    // Backspace trashes nothing here; Esc leaves with a summary.
    await page.keyboard.press("Backspace");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(bar()).toHaveCount(0);
    await expect(page.locator(".video-item")).toHaveCount(5);
    const summary = page.getByRole("dialog", { name: "Arena session done" });
    await expect(summary).toContainText("Rounds2");
    await expect(summary).toContainText("Placed4");
    await page.keyboard.press("Escape");
    await expect(summary).toHaveCount(0);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
