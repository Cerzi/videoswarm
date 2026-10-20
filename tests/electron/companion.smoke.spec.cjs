const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");
const { createFakeCompanion } = require("../../main/__tests__/helpers/fakeCompanion.cjs");

/**
 * Companion apps in the real app, against two fake ones on loopback
 * (docs/architecture/companion-app.md): connecting both, a chip from each,
 * sending a clip to one through the dry-run dialog, and hiding clips already
 * sent. Clips are the fixture's own; it never talks to a real companion.
 */

const card = (page, filename) => page.locator(`.video-item[data-filename="${filename}"]`);

test("companion apps: a chip from each, send through the dry run, hide what was sent", async () => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const fake = createFakeCompanion();
  const url = await fake.start();
  const editor = createFakeCompanion({
    description: {
      protocol: 1,
      name: "Fake editor",
      actions: [{ id: "cut", label: "Cut", send: "Send to the cut" }],
    },
  });
  const editorUrl = await editor.start();
  const folderPath = createVideoFolder(tempRoot, 5, "companion-clips");
  const pathOf = (index) => path.join(folderPath, `clip-000${index}.mp4`);
  fake.state.clips.set(pathOf(0), {
    kind: "render",
    chip: { label: "Polishing #1", tone: "progress" },
    actions: { polish: { phase: "under-way", why: "First in line" }, enlarge: { phase: "not-sent", why: "" } },
  });
  editor.state.clips.set(pathOf(0), {
    kind: "render",
    chip: { label: "In a cut", tone: "done" },
    actions: { cut: { phase: "done", why: "Used in a cut" } },
  });
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(card(page, "clip-0002.mp4")).toBeVisible();

    const saved = await page.evaluate(
      (addresses) =>
        window.electronAPI.companion.setConnections(
          addresses.map((address) => ({ enabled: true, url: address }))
        ),
      [url, editorUrl]
    );
    expect(saved).toEqual([
      { id: "c1", enabled: true, url },
      { id: "c2", enabled: true, url: editorUrl },
    ]);

    // Each app's chip is its own label, with its name and reasons as a tooltip.
    const chips = card(page, "clip-0000.mp4").locator(".video-item-companion");
    await expect(chips).toHaveText(["Polishing #1", "In a cut"]);
    await expect(chips.first()).toHaveAttribute(
      "title",
      "Fake companion\nPolish: First in line\nEnlarge: Not sent"
    );
    await expect(chips.nth(1)).toHaveAttribute("title", "Fake editor\nCut: Used in a cut");
    await expect(card(page, "clip-0001.mp4").locator(".video-item-companion")).toHaveCount(0);
    const lookup = fake.state.requests.find((request) => request.path === "/api/lookup");
    expect(lookup.body.paths.sort()).toEqual([0, 1, 2, 3, 4].map(pathOf).sort());
    expect(lookup.host).toMatch(/^127\.0\.0\.1:\d+$/u);

    // Send two clips, one of which the app would skip: the dialog opens on
    // the dry run to say so, then sends the other, its stars going with it.
    fake.state.plan = (action, filePath) =>
      filePath === pathOf(0)
        ? { result: "skipped", why: "Already in line" }
        : { result: "sent", why: "", estimate: 60 };
    await card(page, "clip-0001.mp4").click();
    await page.keyboard.press("4");
    await expect(card(page, "clip-0001.mp4").locator(".video-item-rating")).toBeVisible();
    await card(page, "clip-0000.mp4").click({ modifiers: ["Control"] });
    await card(page, "clip-0001.mp4").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: /Send to the cut · Fake editor/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /Send to polish · Fake companion \(2 selected\)/ }).click();
    const dialog = page.getByRole("dialog", { name: "Send to polish" });
    await expect(dialog.getByText("1 will be sent")).toBeVisible();
    await dialog.getByRole("button", { name: "Send 1" }).click();
    await expect(dialog.getByText("Sent 1")).toBeVisible();
    const sends = fake.state.requests.filter((request) => request.path === "/api/send");
    // The one-click dry run, the dialog's own, then the send.
    expect(sends.map((request) => request.body.dry_run)).toEqual([true, true, false]);
    expect(sends[0].body.ratings).toEqual({ [pathOf(1)]: 4 });
    expect(sends.at(-1).body).toEqual({
      action: "polish",
      paths: [pathOf(1)],
      ratings: { [pathOf(1)]: 4 },
      dry_run: false,
      again: false,
      client: "videoswarm",
    });
    // The other app was not sent anything.
    expect(editor.state.requests.filter((request) => request.path === "/api/send")).toEqual([]);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(card(page, "clip-0001.mp4").locator(".video-item-companion")).toHaveText("polish waiting");
    fake.state.plan = null;

    // One click on a card: the app's quick action, sent at once, no dialog.
    await card(page, "clip-0002.mp4").hover();
    await card(page, "clip-0002.mp4").getByRole("button", { name: "Polish" }).click();
    await expect(page.getByText("Polish: sent 1 clip (≈ 1 min)")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Send to polish" })).toHaveCount(0);
    await expect(card(page, "clip-0002.mp4").locator(".video-item-companion")).toHaveText("polish waiting");
    // Sent: no button any more.
    await page.mouse.move(0, 0);
    await card(page, "clip-0002.mp4").hover();
    await expect(card(page, "clip-0002.mp4").getByRole("button", { name: "Polish" })).toHaveCount(0);

    // In fullscreen: the rail shows the clip's button with its key, and
    // Shift+1 (by physical key) sends the clip on screen and accepts it.
    await card(page, "clip-0004.mp4").dblclick();
    const modal = page.locator(".fullscreen-modal");
    await expect(modal.locator(".fullscreen-review__title")).toHaveText("clip-0004.mp4");
    const rail = modal.getByRole("complementary", { name: "Review controls" });
    const railButton = rail.getByRole("button", { name: "Polish" });
    await expect(railButton.locator("kbd")).toHaveText("⇧1");
    const realSends = () =>
      fake.state.requests.filter((request) => request.path === "/api/send" && !request.body.dry_run);
    expect(realSends()).toHaveLength(2);
    await page.keyboard.press("Shift+Digit1");
    await expect.poll(() => realSends().length).toBe(3);
    expect(realSends().at(-1).body).toMatchObject({ action: "polish", paths: [pathOf(4)] });
    await expect(railButton).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(
      card(page, "clip-0004.mp4").locator('.video-item-review[title="Review state: Accept"]')
    ).toBeVisible();

    // A path the renderer was never shown cannot be sent.
    const refused = await page.evaluate(() =>
      window.electronAPI.companion.send({ companionId: "c1", action: "polish", instanceIds: [999_999] })
    );
    expect(refused).toEqual({ success: true, dryRun: false, results: {} });

    // Hide clips already sent: only the untouched clip stays.
    await page.getByRole("button", { name: /^(Open filters|Filters)/ }).first().click();
    await page.getByRole("checkbox", { name: "Hide clips already sent to Fake companion" }).check();
    await expect(card(page, "clip-0000.mp4")).toHaveCount(0);
    await expect(card(page, "clip-0001.mp4")).toHaveCount(0);
    await expect(card(page, "clip-0002.mp4")).toHaveCount(0);
    await expect(card(page, "clip-0004.mp4")).toHaveCount(0);
    await expect(card(page, "clip-0003.mp4")).toBeVisible();

    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    await fake.stop();
    await editor.stop();
    context.cleanupFiles();
  }
});
