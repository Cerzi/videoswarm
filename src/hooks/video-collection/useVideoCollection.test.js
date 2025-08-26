// src/hooks/video-collection/useVideoCollection.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useVideoCollection, { PROGRESSIVE_DEFAULTS } from "./useVideoCollection";

const makeVideos = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `v${i}` }));

describe("useVideoCollection (composite)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("progressive render count + playing state + stats (explicit config)", () => {
    const videos = makeVideos(120);

    const { result } = renderHook(() =>
      useVideoCollection({
        videos,
        progressive: {
          initial: 20,
          batchSize: 20,
          intervalMs: 1,      // tick quickly in tests
          forceInterval: true,
          pauseOnScroll: false,
          longTaskAdaptation: false,
        },
      })
    );

    // Initial progressive list length
    expect(result.current.videosToRender.length).toBe(20);
    expect(result.current.stats.total).toBe(120);
    expect(result.current.stats.rendered).toBe(20);

    // Advance one interval => add one batch
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.videosToRender.length).toBe(40);
    expect(result.current.stats.rendered).toBe(40);

    // Advance two more intervals => 80
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.videosToRender.length).toBe(80);
    expect(result.current.stats.rendered).toBe(80);
  });

  it("uses defaults when progressive not provided", () => {
    const videos = makeVideos(120);

    const { result } = renderHook(() =>
      useVideoCollection({ videos })
    );

    expect(result.current.videosToRender.length)
      .toBe(PROGRESSIVE_DEFAULTS.initial);
    expect(result.current.stats.total).toBe(120);
    expect(result.current.stats.rendered)
      .toBe(PROGRESSIVE_DEFAULTS.initial);
  });
});
