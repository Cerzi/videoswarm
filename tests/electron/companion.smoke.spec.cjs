const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");
const { createFakeCompanion } = require("../../main/__tests__/helpers/fakeCompanion.cjs");

/**
 * A companion app in the real app, against a fake one on loopback
 * (docs/architecture/companion-app.md): connecting, chips from lookups,
 * sending a clip through the dry-run dialog, and hiding clips already sent.
 * Clips are the fixture's own; it never talks to a real companion.
 */

const card = (page, filename) => page.locator(`.video-item[data-filename="${filename}"]`);

test("companion app: chips, send through the dry run, hide what was sent", async () => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const fake = createFakeCompanion();
  const url = await fake.start();
  const folderPath = createVideoFolder(tempRoot, 3, "companion-clips");
  const pathOf = (index) => path.join(folderPath, `clip-000${index}.mp4`);
  fake.state.clips.set(pathOf(0), {
    kind: "render",
    chip: { label: "Polishing #1", tone: "progress" },
    actions: { polish: { phase: "under-way", why: "First in line" }, enlarge: { phase: "not-sent", why: "" } },
  });
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(card(page, "clip-0002.mp4")).toBeVisible();

    const saved = await page.evaluate(
      (address) => window.electronAPI.companion.setConnection({ enabled: true, url: address }),
      url
    );
    expect(saved).toEqual({ enabled: true, url });

    // The chip is the companion's own label, with its reasons as a tooltip.
    const chip = card(page, "clip-0000.mp4").locator(".video-item-companion");
    await expect(chip).toHaveText("Polishing #1");
    await expect(chip).toHaveAttribute("title", "Polish: First in line\nEnlarge: Not sent");
    await expect(card(page, "clip-0001.mp4").locator(".video-item-companion")).toHaveCount(0);
    const lookup = fake.state.requests.find((request) => request.path === "/api/lookup");
    expect(lookup.body.paths.sort()).toEqual([0, 1, 2].map(pathOf).sort());
    expect(lookup.host).toMatch(/^127\.0\.0\.1:\d+$/u);

    // Send one clip: the dialog opens on the dry run, then sends.
    await card(page, "clip-0001.mp4").click();
    await card(page, "clip-0001.mp4").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Send to polish/ }).click();
    const dialog = page.getByRole("dialog", { name: "Send to polish" });
    await expect(dialog.getByText("1 will be sent")).toBeVisible();
    await dialog.getByRole("button", { name: "Send 1" }).click();
    await expect(dialog.getByText("Sent 1")).toBeVisible();
    const sends = fake.state.requests.filter((request) => request.path === "/api/send");
    expect(sends.map((request) => request.body.dry_run)).toEqual([true, false]);
    expect(sends[1].body).toEqual({ action: "polish", paths: [pathOf(1)], dry_run: false, again: false });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(card(page, "clip-0001.mp4").locator(".video-item-companion")).toHaveText("polish waiting");

    // A path the renderer was never shown cannot be sent.
    const refused = await page.evaluate(() =>
      window.electronAPI.companion.send({ action: "polish", instanceIds: [999_999] })
    );
    expect(refused).toEqual({ success: true, dryRun: false, results: {} });

    // Hide clips already sent: only the untouched clip stays.
    await page.getByRole("button", { name: /^(Open filters|Filters)/ }).first().click();
    await page.getByRole("checkbox", { name: "Hide clips already sent" }).check();
    await expect(card(page, "clip-0000.mp4")).toHaveCount(0);
    await expect(card(page, "clip-0001.mp4")).toHaveCount(0);
    await expect(card(page, "clip-0002.mp4")).toBeVisible();

    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    await fake.stop();
    context.cleanupFiles();
  }
});
