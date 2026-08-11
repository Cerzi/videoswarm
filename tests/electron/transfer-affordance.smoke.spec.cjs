const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");

/**
 * The transfer panel's affordances have now read backwards twice, and both
 * times the markup was correct - the cascade was not. `.review-results-action
 * button` is a class plus a type, so it quietly outranks any control styled by
 * a single class of its own, and it paints with the primary action fill.
 *
 * jsdom cannot catch this: it does not implement specificity, and it reported
 * the unselected pill as correctly unstyled while a real engine painted it
 * solid green. So this renders the real stylesheet in a real browser and reads
 * back what the user would actually see.
 */

const CSS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "src",
  "components",
  "ProcessReviewResultsDialog.css"
);

const ACCENT = "rgb(81, 207, 102)";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

function panelMarkup(css) {
  return `<!doctype html><html><head>
<style>:root{--color-accent:#51cf66;} body{background:#15181a;}</style>
<style>${css}</style>
</head><body>
<article class="review-results-action review-results-action--copy">
  <div class="review-results-destination">
    <button class="review-results-copy-actions__secondary" id="choose-destination">Choose destination</button>
  </div>
  <div class="review-results-layout">
    <span class="review-results-layout__caption">Layout</span>
    <button class="review-results-layout__option is-active" id="layout-selected">Keep folders</button>
    <button class="review-results-layout__option" id="layout-unselected">Flat</button>
  </div>
  <div class="review-results-recent-destinations"><ul><li>
    <button id="recent-destination">/recent/path</button>
  </li></ul></div>
  <div class="review-results-transfer-actions">
    <button class="review-results-transfer-actions__move" id="action-move">Move</button>
    <button id="action-copy">Copy</button>
  </div>
</article></body></html>`;
}

const fillOf = (page, id) =>
  page.$eval("#" + id, (el) => getComputedStyle(el).backgroundColor);

test.describe("transfer panel affordances", () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(panelMarkup(fs.readFileSync(CSS_PATH, "utf8")));
  });

  test("fills the layout option that is selected, not the other one", async ({
    page,
  }) => {
    const selected = await fillOf(page, "layout-selected");
    const unselected = await fillOf(page, "layout-unselected");

    expect(selected).not.toBe(unselected);
    // The regression: the unselected pill was painted with the primary action
    // fill, so the control read as though the other option were chosen.
    expect(unselected).not.toBe(ACCENT);
    expect(await page.$eval("#layout-selected", (el) => getComputedStyle(el).color))
      .toBe("rgb(255, 255, 255)");
  });

  test("gives the primary action fill to the transfer button alone", async ({
    page,
  }) => {
    const ids = await page.$$eval("button", (els) => els.map((el) => el.id));
    const wearingAccent = [];
    for (const id of ids) {
      if ((await fillOf(page, id)) === ACCENT) wearingAccent.push(id);
    }
    // A setting wearing the action fill is what makes a panel read backwards.
    expect(wearingAccent).toEqual(["action-copy"]);
  });

  test("keeps Move outlined so it never looks like the chosen option", async ({
    page,
  }) => {
    expect(await fillOf(page, "action-move")).toBe(TRANSPARENT);
  });
});
