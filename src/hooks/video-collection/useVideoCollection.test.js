// src/hooks/video-collection/useVideoCollection.test.js
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import useVideoCollection from "./useVideoCollection";

const makeVideos = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `v${i}` }));

describe("useVideoCollection (full DOM)", () => {
  it("returns all videos and preserves logical ordering", () => {
    const videos = makeVideos(10);

    const { result } = renderHook(() =>
      useVideoCollection({
        videos,
      })
    );

    expect(result.current.videosToRender.length).toBe(10);
    expect(result.current.stats.total).toBe(10);
    expect(result.current.stats.rendered).toBe(10);
    expect(result.current.logicalOrder.slice(0, 3)).toEqual(["v0", "v1", "v2"]);
    expect(result.current.idToIndex.get("v5")).toBe(5);
  });

  it("exposes playback orchestration helpers", () => {
    const videos = makeVideos(3);
    const { result } = renderHook(() =>
      useVideoCollection({
        videos,
        loadedVideos: new Set(["v0", "v1"]),
        visibleVideos: new Set(["v0"]),
      })
    );

    expect(typeof result.current.canLoadVideo).toBe("function");
    expect(typeof result.current.isVideoPlaying).toBe("function");
    expect(result.current.stats.total).toBe(3);
  });
});
