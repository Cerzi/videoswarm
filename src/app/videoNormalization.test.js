import { normalizeVideoFromMain } from "./videoNormalization";

describe("normalizeVideoFromMain", () => {
  it("returns sanitized video data", () => {
    const result = normalizeVideoFromMain({
      fingerprint: "abc",
      rating: 4.7,
      tags: ["A", "a", "", null],
      dimensions: { width: 1920.2, height: 1080.6 },
    });

    expect(result.rating).toBe(5);
    expect(result.tags).toEqual(["A", "a"].map((t) => t.trim()).filter(Boolean).slice(0, 2));
    expect(result.dimensions).toEqual({
      width: 1920,
      height: 1081,
      aspectRatio: expect.any(Number),
    });
    expect(result.aspectRatio).toBeCloseTo(result.dimensions.aspectRatio, 5);
  });

  it("handles missing values gracefully", () => {
    const result = normalizeVideoFromMain({ rating: "nope", tags: "nope" });
    expect(result.rating).toBeNull();
    expect(result.tags).toEqual([]);
  });
});
