const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");
const {
  createFakeCompanion,
  TARGET_DESCRIPTION,
} = require("../../main/__tests__/helpers/fakeCompanion.cjs");

/**
 * A companion action that sends into a target the user picks, a project
 * (docs/architecture/companion-app.md), in the real app against a fake app:
 * adding to the current project in one click and taking it back with Undo,
 * adding through the picker, and making a new project. Target ids (folder
 * paths) never reach the window. It never talks to a real companion.
 */

const card = (page, filename) => page.locator(`.video-item[data-filename="${filename}"]`);

test("companion targets: add to the current project, undo, pick one, make one", async () => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const fake = createFakeCompanion({ description: TARGET_DESCRIPTION });
  fake.state.targets = [
    { id: "/projects/demo", label: "Demo", detail: "0 clips · today", current: true },
    { id: "/projects/old-cut", label: "Old cut", detail: "2 clips · last week", current: false },
  ];
  const url = await fake.start();
  const folderPath = createVideoFolder(tempRoot, 3, "target-clips");
  const pathOf = (index) => path.join(folderPath, `clip-000${index}.mp4`);
  const requests = (pathname) => fake.state.requests.filter((request) => request.path === pathname);
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(card(page, "clip-0002.mp4")).toBeVisible();
    await page.evaluate((address) =>
      window.electronAPI.companion.setConnections([{ enabled: true, url: address }]), url);

    // The menu asks for the current project as it opens: one click adds.
    await card(page, "clip-0000.mp4").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^↗ Add to Demo$/ }).click();
    await expect(page.getByText("Added 1 clip to Demo")).toBeVisible();
    const added = requests("/api/send").filter((request) => !request.body.dry_run).at(-1);
    expect(added.body).toMatchObject({
      action: "add",
      paths: [pathOf(0)],
      target: "/projects/demo",
      client: "videoswarm",
    });
    await expect(card(page, "clip-0000.mp4").locator(".video-item-companion")).toHaveText("In Demo");

    // Undo takes back exactly that clip, from that project.
    await page.locator("#app-toast-stack").getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("Demo: took back 1 clip")).toBeVisible();
    expect(requests("/api/withdraw").at(-1).body).toEqual({
      action: "add",
      paths: [pathOf(0)],
      target: "/projects/demo",
      client: "videoswarm",
    });
    await expect(card(page, "clip-0000.mp4").locator(".video-item-companion")).toHaveCount(0);

    // The picker: current project first chosen, search, Enter adds.
    await card(page, "clip-0001.mp4").click();
    await card(page, "clip-0002.mp4").click({ modifiers: ["Control"] });
    await card(page, "clip-0002.mp4").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Add to project… \(2 selected\)/ }).click();
    const picker = page.getByRole("dialog", { name: "Add to project…" });
    await expect(picker.getByRole("option", { name: /Demo/ })).toHaveAttribute("aria-selected", "true");
    await expect(picker.getByText("0 clips · today")).toBeVisible();
    await picker.getByRole("searchbox", { name: "Search projects" }).fill("old");
    await expect(picker.getByRole("option", { name: /Old cut/ })).toHaveAttribute("aria-selected", "true");
    await expect(picker.getByText("2 will be added")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(page.getByText("Added 2 clips to Old cut")).toBeVisible();
    expect(requests("/api/send").filter((request) => !request.body.dry_run).at(-1).body).toMatchObject({
      paths: [pathOf(1), pathOf(2)].sort(),
      target: "/projects/old-cut",
    });

    // A new project, named in the picker; already-added clips stay.
    await card(page, "clip-0002.mp4").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Add to project…/ }).click();
    await picker.getByRole("option", { name: "New project…" }).click();
    await picker.getByRole("textbox", { name: "New project name" }).fill("Dunes");
    await expect(picker.getByText("2 will be added")).toBeVisible();
    await picker.getByRole("button", { name: "Add 2" }).click();
    await expect(page.getByText("Added 2 clips to Dunes")).toBeVisible();
    expect(fake.state.targets[0]).toMatchObject({ id: "/projects/Dunes", label: "Dunes" });

    // Folder paths of projects never reached the window.
    expect(await page.evaluate(() => document.body.innerHTML.includes("/projects/"))).toBe(false);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    await fake.stop();
    context.cleanupFiles();
  }
});
