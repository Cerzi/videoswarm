import { describe, expect, it } from "vitest";
import { orderSelectedFingerprints } from "../selectionOrder";

const video = (id, fingerprint) => ({ id, fingerprint });

describe("orderSelectedFingerprints", () => {
  const collection = [
    video("a", "fp-a"),
    video("b", "fp-b"),
    video("c", "fp-c"),
    video("d", "fp-d"),
  ];

  it("reads the sort order rather than the click order", () => {
    // Clicked d, then a, then c. The grid shows a, c, d.
    const clicked = new Set(["d", "a", "c"]);
    expect(orderSelectedFingerprints(collection, clicked)).toEqual([
      "fp-a",
      "fp-c",
      "fp-d",
    ]);
  });

  it("gives the same answer twice for the same grid and selection", () => {
    const first = orderSelectedFingerprints(collection, new Set(["c", "a"]));
    const second = orderSelectedFingerprints(collection, new Set(["a", "c"]));
    expect(first).toEqual(second);
  });

  it("follows the collection when the sort changes", () => {
    const reversed = collection.slice().reverse();
    expect(orderSelectedFingerprints(reversed, new Set(["a", "c"]))).toEqual([
      "fp-c",
      "fp-a",
    ]);
  });

  it("collapses identical content and skips unindexed clips", () => {
    const withDuplicate = [
      video("a", "fp-a"),
      video("copy-of-a", "fp-a"),
      video("unindexed", null),
      video("b", "fp-b"),
    ];
    expect(
      orderSelectedFingerprints(
        withDuplicate,
        new Set(["a", "copy-of-a", "unindexed", "b"])
      )
    ).toEqual(["fp-a", "fp-b"]);
  });

  it("returns nothing for an empty grid or an empty selection", () => {
    expect(orderSelectedFingerprints([], new Set(["a"]))).toEqual([]);
    expect(orderSelectedFingerprints(collection, new Set())).toEqual([]);
    expect(orderSelectedFingerprints(collection, null)).toEqual([]);
    expect(orderSelectedFingerprints(null, new Set(["a"]))).toEqual([]);
  });

  it("accepts a plain array of ids", () => {
    expect(orderSelectedFingerprints(collection, ["c", "b"])).toEqual([
      "fp-b",
      "fp-c",
    ]);
  });
});
