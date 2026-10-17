import { describe, expect, it } from "vitest";
import { chooseStackFaces, frameDistance } from "./stackFaces";

const clip = (id, extra = {}) => ({ id, reviewState: "unreviewed", rating: null, createdMs: 1, ...extra });
// Fingerprints by how many low bits are set: distance is the difference.
const bits = (count) => (count === 0 ? 0n : (1n << BigInt(count)) - 1n).toString(16).padStart(16, "0");

describe("frameDistance", () => {
  it("counts differing bits", () => {
    expect(frameDistance(bits(0), bits(0))).toBe(0);
    expect(frameDistance(bits(0), bits(5))).toBe(5);
    expect(frameDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });
});

describe("chooseStackFaces", () => {
  const members = ["a", "b", "c", "d", "e", "f", "g"].map((id) => clip(id));
  const hashes = { a: bits(0), b: bits(30), c: bits(31), d: bits(32), e: bits(33), f: bits(34), g: bits(64) };
  const hashOf = (video) => hashes[video.id];

  it("heads an undecided stack with its most typical clip", () => {
    expect(chooseStackFaces(members, hashOf).cover.id).toBe("d");
  });

  it("fills the strip with the clips that differ most, in run order", () => {
    const { cover, strip } = chooseStackFaces(members, hashOf);
    expect(cover.id).toBe("d");
    // a and g are furthest from d and from each other; then the next widest.
    expect(strip.map((video) => video.id)).toEqual(["a", "b", "g"]);
  });

  it("heads with the best clip once anything is picked or rated", () => {
    const decided = members.map((video) => (video.id === "e" ? { ...video, rating: 4 } : video));
    expect(chooseStackFaces(decided, hashOf).cover.id).toBe("e");
  });

  it("spreads the strip across the run until fingerprints arrive", () => {
    const { cover, strip } = chooseStackFaces(members, () => null);
    // Undecided, equal clips: the review rule keeps the first as cover.
    expect(cover.id).toBe("a");
    expect(strip.map((video) => video.id)).toEqual(["c", "e", "g"]);
  });

  it("shows fewer stills than three when the stack is small", () => {
    const pair = [clip("a"), clip("b")];
    const { strip } = chooseStackFaces(pair, hashOf);
    expect(strip).toHaveLength(1);
  });
});
