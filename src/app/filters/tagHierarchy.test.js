import { describe, expect, it } from "vitest";
import { buildTagHierarchy, formatTagPath, tagsMatch } from "./tagHierarchy";

const tags = [
  { name: "Dance", parent: null },
  { name: "latin", parent: "dance" },
  { name: "Bellydance", parent: "Latin" },
  { name: "tap", parent: "dance" },
  { name: "outdoor", parent: null },
];

describe("tag hierarchy", () => {
  it("expands a tag to itself and everything under it, case-insensitively", () => {
    const hierarchy = buildTagHierarchy(tags);
    expect([...hierarchy.expand("DANCE")].sort()).toEqual([
      "bellydance",
      "dance",
      "latin",
      "tap",
    ]);
    expect([...hierarchy.expand("latin")].sort()).toEqual(["bellydance", "latin"]);
    expect([...hierarchy.expand("unknown")]).toEqual(["unknown"]);
    expect(hierarchy.hasHierarchy).toBe(true);
  });

  it("matches a clip through the tags under a requested one", () => {
    const hierarchy = buildTagHierarchy(tags);
    expect(tagsMatch(["bellydance"], "dance", hierarchy)).toBe(true);
    expect(tagsMatch(["outdoor"], "dance", hierarchy)).toBe(false);
    expect(tagsMatch(["dance"], "bellydance", hierarchy)).toBe(false);
  });

  it("names a tag's path and survives a cycle in the data", () => {
    const hierarchy = buildTagHierarchy(tags);
    expect(formatTagPath("bellydance", hierarchy)).toBe("Dance › latin › Bellydance");
    expect(hierarchy.parentOf("tap")).toBe("Dance");
    expect(hierarchy.childrenOf("dance").sort()).toEqual(["latin", "tap"]);

    const cyclic = buildTagHierarchy([
      { name: "a", parent: "b" },
      { name: "b", parent: "a" },
    ]);
    expect(formatTagPath("a", cyclic)).toBe("b › a");
    expect([...cyclic.expand("a")].sort()).toEqual(["a", "b"]);
  });
});
