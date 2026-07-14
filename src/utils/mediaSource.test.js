import { describe, expect, it } from "vitest";
import {
  getOpaqueMediaSource,
  getWebMediaSource,
  normalizeOpaqueMediaSource,
} from "./mediaSource";

describe("opaque renderer media sources", () => {
  it.each([
    "file:///private/clip.mp4",
    "https://example.com/clip.mp4",
    "videoswarm-media://other/1",
    "videoswarm-media://user:pass@instance/1",
    "videoswarm-media://instance/1#fragment",
  ])("rejects a source outside the native media boundary: %s", (sourceUrl) => {
    expect(normalizeOpaqueMediaSource(sourceUrl)).toBeNull();
  });

  it("accepts versioned instance and proxy sources", () => {
    expect(
      getOpaqueMediaSource({
        sourceUrl: "videoswarm-media://instance/7?v=10-20&g=3",
      })
    ).toBe("videoswarm-media://instance/7?v=10-20&g=3");
    expect(
      normalizeOpaqueMediaSource(
        "videoswarm-media://proxy/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      )
    ).toBe(
      "videoswarm-media://proxy/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("allows ordinary web sources but never a native path fallback", () => {
    expect(
      getWebMediaSource({ isElectronFile: false, fullPath: "/media/clip.mp4" })
    ).toBe("/media/clip.mp4");
    expect(
      getWebMediaSource({ isElectronFile: true, fullPath: "/media/clip.mp4" })
    ).toBeNull();
  });
});
