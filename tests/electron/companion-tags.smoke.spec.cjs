const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");
const {
  createFakeCompanion,
  DEFAULT_DESCRIPTION,
} = require("../../main/__tests__/helpers/fakeCompanion.cjs");

/**
 * A companion app's own tags for clips (docs/architecture/companion-app.md),
 * in the real app against a fake app: the chip's tooltip, Details, the tag
 * filter with its type-ahead, and prompt search finding them. Made-up names;
 * it never talks to a real companion.
 */

const card = (page, filename) => page.locator(`.video-item[data-filename="${filename}"]`);
const shown = async (page) =>
  (await page.locator(".video-item").evaluateAll((items) => items.map((item) => item.dataset.filename))).sort();

test("companion tags: tooltip, Details, filter and search", async () => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const fake = createFakeCompanion({
    description: { ...DEFAULT_DESCRIPTION, tags: { label: "Characters", hint: "Who a render was cast with" } },
  });
  const url = await fake.start();
  const folderPath = createVideoFolder(tempRoot, 4, "tagged-clips");
  const pathOf = (index) => path.join(folderPath, `clip-000${index}.mp4`);
  const answer = (tags) => ({
    kind: "render",
    chip: { label: "Ready", tone: "info" },
    actions: { polish: { phase: "not-sent", why: "" }, enlarge: { phase: "not-sent", why: "" } },
    tags,
  });
  fake.state.clips.set(pathOf(0), answer(["Alba Varga"]));
  fake.state.clips.set(pathOf(1), answer(["Bram"]));
  fake.state.clips.set(pathOf(2), answer(["Alba Varga", "Bram"]));
  fake.state.clips.set(pathOf(3), answer(undefined));
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(card(page, "clip-0003.mp4")).toBeVisible();
    await page.evaluate((address) =>
      window.electronAPI.companion.setConnections([{ enabled: true, url: address }]), url);

    // The chip's tooltip names them under what the app calls them.
    const chip = card(page, "clip-0002.mp4").locator(".video-item-companion");
    await expect(chip).toHaveAttribute("title", /Characters: Alba Varga, Bram$/u);

    // Details lists them under the app's name.
    await card(page, "clip-0002.mp4").click();
    const inDetails = page.getByRole("list", { name: "Characters from Fake companion" });
    await expect(inDetails).toContainText("Alba Varga");
    await expect(inDetails).toContainText("Bram");

    // The filter: type-ahead over the tags answered so far, any or all.
    await page.getByRole("button", { name: /^(Open filters|Filters)/ }).first().click();
    const tagInput = page.getByRole("searchbox", { name: "Filter by Characters" });
    await tagInput.fill("var");
    await page.getByRole("option", { name: "Alba Varga" }).click();
    await expect.poll(() => shown(page)).toEqual(["clip-0000.mp4", "clip-0002.mp4"]);
    await tagInput.fill("br");
    await tagInput.press("Enter");
    await expect.poll(() => shown(page)).toEqual(["clip-0000.mp4", "clip-0001.mp4", "clip-0002.mp4"]);
    await page.getByRole("group", { name: "Match Characters" }).getByRole("button", { name: "All" }).click();
    await expect.poll(() => shown(page)).toEqual(["clip-0002.mp4"]);
    await page.getByRole("button", { name: "Alba Varga ×", exact: true }).click();
    await page.getByRole("button", { name: "Bram ×", exact: true }).click();
    await expect.poll(() => shown(page)).toHaveLength(4);

    // Prompt words find them too; the fixture's clips carry no prompts.
    await page.getByRole("searchbox", { name: "Words in the prompt" }).fill("alba -bram");
    await expect.poll(() => shown(page), { timeout: 10_000 }).toEqual(["clip-0000.mp4"]);

    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    await fake.stop();
    context.cleanupFiles();
  }
});
