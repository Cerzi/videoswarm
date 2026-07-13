// src/hooks/video-collection/useVideoCollection.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useVideoCollection, { PROGRESSIVE_DEFAULTS } from "./useVideoCollection";
import { createMediaSlotScheduler } from "../../services/mediaSlotScheduler";

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

    // Full list is materialized, but progressiveVisible tracks the scheduler
    expect(result.current.videosToRender.length).toBe(120);
    expect(result.current.stats.total).toBe(120);
    expect(result.current.stats.rendered).toBe(120);
    expect(result.current.stats.progressiveVisible).toBe(20);

    // Advance one interval => add one batch
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.videosToRender.length).toBe(120);
    expect(result.current.stats.progressiveVisible).toBe(40);

    // Advance two more intervals => 80
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(result.current.videosToRender.length).toBe(120);
    expect(result.current.stats.progressiveVisible).toBe(80);
  });

  it("uses defaults when progressive not provided", () => {
    const videos = makeVideos(120);

    const { result } = renderHook(() =>
      useVideoCollection({ videos })
    );

    expect(result.current.stats.total).toBe(120);
    expect(result.current.videosToRender.length).toBe(120);
    expect(result.current.stats.rendered).toBe(120);
    expect(result.current.stats.progressiveVisible)
      .toBe(PROGRESSIVE_DEFAULTS.initial);
  });

  it("caps rendered output and stats when render limit is provided", () => {
    const videos = makeVideos(400);

    const { result, rerender } = renderHook(
      ({ limit }) =>
        useVideoCollection({
          videos,
          progressive: {
            initial: 50,
            batchSize: 50,
            intervalMs: 1,
            forceInterval: true,
            pauseOnScroll: false,
            longTaskAdaptation: false,
          },
          renderLimit: limit,
        }),
      { initialProps: { limit: 130 } }
    );

    expect(result.current.videosToRender.length).toBe(130);
    expect(result.current.stats.rendered).toBe(130);
    expect(result.current.stats.progressiveVisible).toBe(50);
    expect(result.current.stats.activationTarget).toBe(50);

    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(result.current.videosToRender.length).toBe(130);
    expect(result.current.stats.rendered).toBe(130);
    expect(result.current.stats.progressiveVisible).toBe(130);
    expect(result.current.stats.activationTarget).toBe(130);

    rerender({ limit: 80 });
    expect(result.current.videosToRender.length).toBe(80);
    expect(result.current.stats.rendered).toBe(80);
    expect(result.current.stats.progressiveVisible).toBe(80);
    expect(result.current.stats.activationTarget).toBe(80);
  });

  it("threads hover audio orchestration state through collection API", () => {
    const visibleVideos = new Set(["v1", "v2"]);
    const loadedVideos = new Set(["v1", "v2"]);

    const { result } = renderHook(() =>
      useVideoCollection({
        videos: makeVideos(2),
        visibleVideos,
        loadedVideos,
        hoverAudioEnabled: true,
      })
    );

    act(() => {
      result.current.onCardHoverAudioStart("v1");
    });
    expect(result.current.activeHoverAudioId).toBe("v1");

    act(() => {
      result.current.onCardHoverAudioStart("v2");
    });
    expect(result.current.activeHoverAudioId).toBe("v2");

    act(() => {
      result.current.onCardHoverAudioEnd("v2");
    });
    expect(result.current.activeHoverAudioId).toBe(null);
  });

  it("uses the adaptive target and Static + Hover eligibility", () => {
    const visibleVideos = new Set(["v0", "v1", "v2"]);
    const loadedVideos = new Set(["v0", "v1", "v2"]);
    const mediaScheduler = createMediaSlotScheduler({
      maxResident: 3,
      maxLoaders: 3,
      maxDecoders: 2,
    });
    for (const id of loadedVideos) {
      mediaScheduler.markLoaderReady(mediaScheduler.reserveLoader(id));
    }
    const { result } = renderHook(() =>
      useVideoCollection({
        videos: makeVideos(3),
        visibleVideos,
        loadedVideos,
        decoderTarget: 2,
        playbackMode: "static-hover",
        selectedIds: new Set(["v1"]),
        hoveredId: "v2",
        centerPriorityIds: ["v0", "v1", "v2"],
        mediaScheduler,
      })
    );

    expect(result.current.playingVideos).toEqual(new Set(["v2", "v1"]));
  });

  it("pauses progressive growth and drives media admission to zero while work is suspended", () => {
    const videos = makeVideos(100);
    const { result, rerender } = renderHook(
      ({ workSuspended }) =>
        useVideoCollection({
          videos,
          visibleVideos: new Set(["v0"]),
          loadedVideos: new Set(["v0"]),
          decoderTarget: 2,
          workSuspended,
          progressive: {
            initial: 20,
            batchSize: 20,
            intervalMs: 1,
            forceInterval: true,
            pauseOnScroll: false,
            longTaskAdaptation: false,
          },
        }),
      { initialProps: { workSuspended: true } }
    );

    expect(result.current.playingVideos.size).toBe(0);
    expect(result.current.limits).toMatchObject({
      maxLoaded: 0,
      maxConcurrentLoading: 0,
    });
    expect(result.current.stats.progressiveVisible).toBe(20);

    act(() => vi.advanceTimersByTime(10));
    expect(result.current.stats.progressiveVisible).toBe(20);

    rerender({ workSuspended: false });
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.stats.progressiveVisible).toBe(40);
  });
});
