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

  it("keeps frame rate, steps and workflow words, and only when set", () => {
    const filters = saved(
      view({
        filters: {
          minFrameRate: "24",
          maxFrameRate: 0,
          minSteps: 12.4,
          workflowInclude: " upscale ",
          workflowExclude: "turbo",
          versionFilter: "supersedes",
        },
      })
    ).filters;
    expect(filters).toMatchObject({
      minFrameRate: 24,
      minSteps: 12,
      workflowInclude: "upscale",
      workflowExclude: "turbo",
      versionFilter: "supersedes",
    });
    expect(filters).not.toHaveProperty("maxFrameRate");
    expect(saved(view()).filters).not.toHaveProperty("workflowInclude");
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
            "c3/finish": "not-done",
            enlarge: "sideways",
            "Bad Id": "sent",
          },
          companionHideSent: true,
        },
      })
    ).filters;
    // A plain action id is from when a profile had one companion: the first.
    expect(filters.companionFilters).toEqual({
      "c1/polish": "not-sent",
      "c2/upscale": "done",
      "c3/finish": "not-done",
    });
    // The old single switch is the first app's; the list is one per app.
    expect(filters.companionHideSent).toEqual(["c1"]);
    expect(
      saved(view({ filters: { companionHideSent: ["c3", "c1", "c3", "nope"] } })).filters.companionHideSent
    ).toEqual(["c1", "c3"]);
  });

  it("leaves a view without them exactly as before", () => {
    const filters = saved(view({ filters: { companionFilters: {}, companionHideSent: false } })).filters;
    expect(filters).not.toHaveProperty("companionFilters");
    expect(filters).not.toHaveProperty("companionHideSent");
  });
});
