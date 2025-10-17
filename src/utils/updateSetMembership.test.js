import { describe, it, expect } from "vitest";
import { updateSetMembership, removeManyFromSet } from "./updateSetMembership";

describe("updateSetMembership", () => {
  it("returns the same Set when membership already matches", () => {
    const original = new Set(["a", "b"]);
    const resultAdd = updateSetMembership(original, "a", true);
    const resultRemove = updateSetMembership(original, "c", false);
    expect(resultAdd).toBe(original);
    expect(resultRemove).toBe(original);
  });

  it("adds or removes items when membership changes", () => {
    const original = new Set(["a"]);
    const added = updateSetMembership(original, "b", true);
    expect(added).not.toBe(original);
    expect(Array.from(added)).toEqual(["a", "b"]);

    const removed = updateSetMembership(added, "a", false);
    expect(removed).not.toBe(added);
    expect(Array.from(removed)).toEqual(["b"]);
  });

  it("throws if the first argument is not a Set", () => {
    expect(() => updateSetMembership([], "a", true)).toThrow(TypeError);
  });
});

describe("removeManyFromSet", () => {
  it("returns the original set when nothing is removed", () => {
    const original = new Set([1, 2, 3]);
    const result = removeManyFromSet(original, [4, 5]);
    expect(result).toBe(original);
  });

  it("removes any provided ids and returns a new set when mutated", () => {
    const original = new Set([1, 2, 3]);
    const result = removeManyFromSet(original, [2, 4]);
    expect(result).not.toBe(original);
    expect(Array.from(result)).toEqual([1, 3]);
  });

  it("throws when the first argument is not a Set", () => {
    expect(() => removeManyFromSet({}, [1])).toThrow(TypeError);
  });
});
