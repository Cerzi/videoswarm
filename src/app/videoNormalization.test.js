import { normalizeVideoFromMain } from "./videoNormalization";

describe("normalizeVideoFromMain", () => {
  it("returns sanitized video data", () => {
    const result = normalizeVideoFromMain({
      fingerprint: "abc",
      rating: 4.7,
      tags: ["A", "a", "", null],
      reviewState: " PICK ",
      hasAudio: true,
      dimensions: { width: 1920.2, height: 1080.6 },
    });

    expect(result.rating).toBe(5);
    expect(result.reviewState).toBe("pick");
    expect(result.hasAudio).toBe(true);
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
    expect(result.reviewState).toBe("unreviewed");
    expect(result.hasAudio).toBeNull();
  });

  it("preserves valid video timing metadata", () => {
    const result = normalizeVideoFromMain({
      dimensions: {
        width: 1920,
        height: 1080,
        durationMs: 12_345.6,
        frameRate: 29.97,
      },
    });

    expect(result.dimensions).toMatchObject({
      durationMs: 12_345.6,
      frameRate: 29.97,
    });
  });

  it("only accepts authoritative boolean audio-stream metadata", () => {
    expect(normalizeVideoFromMain({ hasAudio: false }).hasAudio).toBe(false);
    expect(normalizeVideoFromMain({ hasAudio: 1 }).hasAudio).toBeNull();
    expect(normalizeVideoFromMain({ hasAudio: "true" }).hasAudio).toBeNull();
  });

  it("expands compact native cache identity fields", () => {
    const result = normalizeVideoFromMain({
      id: "/library/clip.mp4",
      name: "clip.mp4",
      isElectronFile: true,
      dimensions: { width: 640, height: 360 },
    });

    expect(result).toMatchObject({
      fullPath: "/library/clip.mp4",
      basename: "clip.mp4",
      fingerprint: null,
      tags: [],
      rating: null,
      reviewState: "unreviewed",
      aspectRatio: 640 / 360,
    });
  });
});
