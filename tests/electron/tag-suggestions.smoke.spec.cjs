const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { writeTaggedVideo } = require("./helpers/videoFixture.cjs");

/**
 * Tag suggestions in the real app (prompt-search-and-tag-suggestions.md,
 * Section 2): clips with made-up prompts are tagged through Details, main
 * learns which words go with each tag, and an untagged clip is offered the
 * tag, then found by Filters › Might be and ruled out from the context menu.
 */

const FILLER = [
  "soft", "light", "wide", "shot", "slow", "motion", "warm", "colour", "film", "grain",
  "close", "up", "golden", "hour", "evening", "morning", "bright", "calm", "quiet", "detail",
];

function promptFor(subject, index) {
  const words = [subject, ...Array.from({ length: 6 }, (_, at) => FILLER[(index * 7 + at * 3) % FILLER.length])];
  return JSON.stringify({
    1: { class_type: "CLIPTextEncode", inputs: { text: words.join(" "), clip: ["4", 1] } },
    3: { class_type: "KSampler", inputs: { seed: 1000 + index, steps: 20, positive: ["1", 0] } },
    4: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  });
}

const card = (page, filename) => page.locator(`.video-item[data-filename="${filename}"]`);

async function tagRange(page, first, last, tag, count) {
  await card(page, first).click();
  await card(page, last).click({ modifiers: ["Shift"] });
  await expect(page.locator(".video-item.selected")).toHaveCount(count);
  const input = page.getByPlaceholder("Add tag and press Enter");
  if (!(await input.isVisible())) {
    await card(page, last).click({ button: "right" });
    await page.getByRole("menuitem", { name: /Open details/ }).click();
  }
  await input.fill(tag);
  await input.press("Enter");
  await expect(page.locator(".metadata-panel__chip", { hasText: `#${tag}` }).first()).toBeVisible();
}

test("tag suggestions: an untagged clip is offered a learned tag and found by Might be", async () => {
  test.setTimeout(120_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = path.join(tempRoot, "tag-suggest-clips");
  fs.mkdirSync(folderPath, { recursive: true });
  let token = 0;
  const write = (name, prompt) =>
    writeTaggedVideo(path.join(folderPath, name), { prompt }, (token += 1));
  for (let index = 0; index < 12; index += 1) {
    const at = String(index).padStart(2, "0");
    write(`a-dance-${at}.mp4`, promptFor(`dancing ${["ballet", "tango", "salsa"][index % 3]}`, index));
    write(`b-sea-${at}.mp4`, promptFor(`ocean ${["waves", "harbour", "boats"][index % 3]}`, 50 + index));
  }
  write("c-new-dance-0.mp4", promptFor("dancing waltz", 100));
  write("c-new-dance-1.mp4", promptFor("dancing jive", 101));
  write("c-new-sea.mp4", promptFor("ocean cliffs", 102));
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.getByText("27 clips")).toBeVisible();
    // The grid draws only what is on screen: zoom out until every card is.
    for (let step = 0; step < 6; step += 1) await page.keyboard.press("-");
    await expect(page.locator(".video-item")).toHaveCount(27);

    // Details opens docked and follows the selection from then on.
    await tagRange(page, "a-dance-00.mp4", "a-dance-11.mp4", "dance", 12);
    await tagRange(page, "b-sea-00.mp4", "b-sea-11.mp4", "sea", 12);

    // Details offers the learned tag for an untagged clip. Prompt keys are
    // read in the background, so this can take a moment.
    await card(page, "c-new-dance-0.mp4").click();
    const suggested = page.getByRole("button", { name: "Add suggested tag dance" });
    await expect(suggested).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("button", { name: "Add suggested tag sea" })).toHaveCount(0);
    await suggested.click();
    await expect(page.locator(".metadata-panel__chip", { hasText: "#dance" })).toBeVisible();
    await expect(suggested).toHaveCount(0);

    // Filters › Might be: the other untagged dance clip, and nothing else.
    await page.getByRole("button", { name: /^(Open filters|Filters)/ }).first().click();
    const select = page.getByRole("combobox", { name: "Might be tagged" });
    await expect(select.locator("option", { hasText: "dance" })).toHaveCount(1, { timeout: 45_000 });
    await select.selectOption("dance");
    await expect(page.locator(".video-item")).toHaveCount(1, { timeout: 30_000 });
    await expect(card(page, "c-new-dance-1.mp4")).toBeVisible();

    // Ruled out from the context menu, it leaves the filter.
    await page.keyboard.press("Escape");
    await card(page, "c-new-dance-1.mp4").click({ button: "right" });
    await page.getByRole("menuitem", { name: /Not “dance”/ }).click();
    await expect(page.locator(".video-item")).toHaveCount(0);
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
