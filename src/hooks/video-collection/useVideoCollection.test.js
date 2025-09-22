// src/hooks/video-collection/useVideoCollection.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const performCleanup = vi.fn(() => []);
  const canLoadVideo = vi.fn(() => true);
  const limits = { maxLoaded: 999, maxConcurrentLoading: 64 };
  const memoryStatus = {
    currentMemoryMB: 512,
    memoryPressure: 25,
    isNearLimit: false,
    safetyMarginMB: 512,
  };
  const reportPlayerCreationFailure = vi.fn();
  const playingSet = new Set();
  const markHover = vi.fn();
  const reportPlayError = vi.fn();
  const reportStarted = vi.fn();

  return {
    performCleanup,
    canLoadVideo,
    limits,
    memoryStatus,
    reportPlayerCreationFailure,
    playingSet,
    markHover,
    reportPlayError,
    reportStarted,
  };
});

vi.mock("./useVideoResourceManager", () => ({
  __esModule: true,
  default: vi.fn(() => ({
    canLoadVideo: mocks.canLoadVideo,
    performCleanup: mocks.performCleanup,
    limits: mocks.limits,
    memoryStatus: mocks.memoryStatus,
    reportPlayerCreationFailure: mocks.reportPlayerCreationFailure,
  })),
}));

vi.mock("./usePlayOrchestrator", () => ({
  __esModule: true,
  default: vi.fn(() => ({
    playingSet: mocks.playingSet,
    markHover: mocks.markHover,
    reportPlayError: mocks.reportPlayError,
    reportStarted: mocks.reportStarted,
  })),
}));

import useVideoCollection, { PROGRESSIVE_DEFAULTS } from "./useVideoCollection";

const makeVideos = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `v${i}`, name: `v${i}` }));

describe("useVideoCollection (composite)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.performCleanup.mockReset();
    mocks.canLoadVideo.mockReset();
    mocks.reportPlayerCreationFailure.mockReset();
    mocks.markHover.mockReset();
    mocks.reportPlayError.mockReset();
    mocks.reportStarted.mockReset();
    mocks.playingSet.clear();
    mocks.limits.maxLoaded = 999;
    mocks.limits.maxConcurrentLoading = 64;
    mocks.performCleanup.mockReturnValue([]);
    mocks.canLoadVideo.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

    const { result } = renderHook(() => useVideoCollection({ videos }));

    expect(result.current.videosToRender.length).toBe(
      PROGRESSIVE_DEFAULTS.initial
    );
    expect(result.current.stats.total).toBe(120);
    expect(result.current.stats.rendered).toBe(
      PROGRESSIVE_DEFAULTS.initial
    );
  });

  it("exposes eviction victims from performCleanup", async () => {
    const videos = makeVideos(10);
    const victimsQueue = [["v3", "v4"], []];
    mocks.performCleanup.mockImplementation(() => victimsQueue.shift() || []);

    const { result, rerender } = renderHook(
      ({ loadedIds, visibleIds }) =>
        useVideoCollection({
          videos,
          loadedVideos: new Set(loadedIds),
          visibleVideos: new Set(visibleIds),
          progressive: {
            initial: 10,
            batchSize: 10,
            intervalMs: 1,
            forceInterval: true,
            pauseOnScroll: false,
            longTaskAdaptation: false,
          },
        }),
      {
        initialProps: {
          loadedIds: ["v1", "v2", "v3", "v4"],
          visibleIds: ["v1"],
        },
      }
    );

    await act(async () => {});
    expect(result.current.evictionVictims).toEqual(["v3", "v4"]);

    rerender({ loadedIds: ["v1", "v2"], visibleIds: ["v1"] });
    await act(async () => {});
    expect(result.current.evictionVictims).toEqual([]);
  });
});
