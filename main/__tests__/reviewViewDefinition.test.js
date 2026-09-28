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

  it("keeps a library scope only when an include tag defines the search", () => {
    expect(saved(view({ searchScope: "library" })).searchScope).toBe("library");
    expect(
      saved(view({ searchScope: "library", filters: { includeTags: [], excludeTags: ["x"] } })).searchScope
    ).toBe("folder");
  });

  it("is not part of a review checkpoint's view", () => {
    expect(normalizeReviewViewDefinition(view({ searchScope: "library" }))).not.toHaveProperty("searchScope");
  });
});
