const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

/**
 * Review passes in the real app (docs/architecture/review-passes.md): the
 * selection frozen into a pass, progress counting the pass, leaving it and
 * resuming it from the sidebar, finishing it, and a pass over everything
 * shown started with Shift+R.
 */
const card = (page, name) => page.locator(`.video-item[data-filename="${name}"]`);

test("review pass: freeze, decide, leave, resume and finish", async () => {
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 5, "pass-clips");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  const bar = () => page.getByRole("toolbar", { name: "Review pass" });

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(5);

    // Three clips selected: a pass of just those.
    await card(page, "clip-0001.mp4").click();
    await card(page, "clip-0003.mp4").click({ modifiers: ["Control"] });
    await card(page, "clip-0004.mp4").click({ modifiers: ["Control"] });
    await page.getByRole("button", { name: /Review 3 selected/ }).click();
    await expect(bar()).toContainText("3 selected clips · 0 of 3 decided");
    await expect(page.locator(".video-item")).toHaveCount(3);

    // The pass starts on its first clip.
    await expect(card(page, "clip-0001.mp4")).toHaveClass(/selected/);
    await page.keyboard.press("a");
    await expect(bar()).toContainText("1 of 3 decided");

    // Leave it: the folder is back, and the pass waits in the sidebar.
    await bar().getByRole("button", { name: /Exit pass/ }).click();
    await expect(page.locator(".video-item")).toHaveCount(5);
    await page.getByRole("tab", { name: "Library" }).click();
    const resume = page.getByRole("list", { name: "Review passes" }).getByTitle("Resume reviewing 3 selected clips");
    await expect(resume).toContainText("1 / 3");
    await resume.click();
    await expect(bar()).toContainText("1 of 3 decided");
    await expect(page.locator(".video-item")).toHaveCount(3);

    // Faster than a person: these cards were last clicked moments ago, and
    // a second click within the card's 300 ms would be a double-click.
    await page.waitForTimeout(350);
    for (const name of ["clip-0003.mp4", "clip-0004.mp4"]) {
      await card(page, name).click();
      await page.keyboard.press("a");
    }
    await expect(bar()).toContainText("all 3 decided");
    await bar().getByRole("button", { name: /Exit pass/ }).click();
    // Finished: no longer listed to resume.
    await page.getByRole("tab", { name: "Library" }).click();
    await expect(page.getByRole("list", { name: "Review passes" })).toHaveCount(0);

    // Shift+R with nothing selected: everything shown, decisions counted.
    await page.keyboard.press("Escape");
    await page.locator(".video-item").first().hover();
    await page.keyboard.press("Shift+R");
    await expect(bar()).toContainText("3 of 5 decided");
    await expect(page.locator(".video-item")).toHaveCount(5);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
