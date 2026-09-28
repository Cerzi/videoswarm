import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { REVIEW_SORT_KEYS } = require("../review-view-definition");
const { SortKey } = await import("../../src/sorting/sorting.js");

describe("saved sort keys", () => {
  it("accepts every sort the renderer offers, resolution included", () => {
    for (const key of Object.values(SortKey)) expect(REVIEW_SORT_KEYS.has(key)).toBe(true);
  });

  it("is what the settings normaliser checks against", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    expect(source).toContain("const sortKey = REVIEW_SORT_KEYS.has(source.sortKey)");
  });
});
