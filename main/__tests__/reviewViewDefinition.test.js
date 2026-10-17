import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { normalizeReviewViewDefinition } = require("../review-view-definition");

const view = (overrides = {}) => ({
  version: 1,
  filters: { includeTags: ["keeper"], reviewFilter: "any" },
  sort: { key: "name", dir: "asc" },
  scope: { mode: "current-folder" },
  ...overrides,
});
const saved = (input) => normalizeReviewViewDefinition(input, { includeScope: true });

describe("saved view search scope", () => {
  it("defaults to the open folder, so views saved before the axis mean the same", () => {
    expect(saved(view()).searchScope).toBe("folder");
    expect(saved(view({ searchScope: "somewhere" })).searchScope).toBe("folder");
  });

  it("keeps a library scope whatever narrows it, nothing included", () => {
    expect(saved(view({ searchScope: "library" })).searchScope).toBe("library");
    expect(
      saved(view({ searchScope: "library", filters: { includeTags: [], excludeTags: ["x"] } })).searchScope
    ).toBe("library");
  });

  it("keeps prompt words and a tag clips might be", () => {
    expect(saved(view({ filters: { promptQuery: " lighthouse " } })).filters.promptQuery).toBe("lighthouse");
    expect(saved(view({ filters: { mightBe: " dance " } })).filters.mightBe).toBe("dance");
    expect(saved(view()).filters).not.toHaveProperty("mightBe");
  });

  it("is not part of a review checkpoint's view", () => {
    expect(normalizeReviewViewDefinition(view({ searchScope: "library" }))).not.toHaveProperty("searchScope");
  });
});

describe("saved view companion filters", () => {
  it("keeps well-formed companion filters and the hide-sent switch", () => {
    const filters = saved(
      view({
        filters: {
          companionFilters: {
            polish: "not-sent",
            "c2/upscale": "done",
            enlarge: "sideways",
            "Bad Id": "sent",
          },
          companionHideSent: true,
        },
      })
    ).filters;
    // A plain action id is from when a profile had one companion: the first.
    expect(filters.companionFilters).toEqual({ "c1/polish": "not-sent", "c2/upscale": "done" });
    expect(filters.companionHideSent).toBe(true);
  });

  it("leaves a view without them exactly as before", () => {
    const filters = saved(view({ filters: { companionFilters: {}, companionHideSent: false } })).filters;
    expect(filters).not.toHaveProperty("companionFilters");
    expect(filters).not.toHaveProperty("companionHideSent");
  });
});
