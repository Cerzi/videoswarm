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

  it("keeps All Motion leases stable while a stale policy target catches up", () => {
    const videos = makeVideos(3);
    const loadedVideos = new Set(["v0", "v1", "v2"]);
    const mediaScheduler = createMediaSlotScheduler({
      maxResident: 3,
      maxLoaders: 3,
      maxDecoders: 2,
    });
    for (const id of loadedVideos) {
      const loader = mediaScheduler.reserveLoader(id);
      mediaScheduler.markLoaderReady(loader);
    }

    const { result, rerender } = renderHook(
      ({ visibleVideos, centerPriorityIds }) =>
        useVideoCollection({
          videos,
          visibleVideos,
          loadedVideos,
          decoderTarget: 2,
          activationTarget: 4,
          playbackMode: "all-motion",
          centerPriorityIds,
          mediaScheduler,
        }),
      {
        initialProps: {
          visibleVideos: new Set(["v0", "v1"]),
          centerPriorityIds: ["v0", "v1"],
        },
      }
    );

    const firstLease = result.current.getDecoderLease("v0");
    const secondLease = result.current.getDecoderLease("v1");
    expect(result.current.playingVideos).toEqual(new Set(["v0", "v1"]));

    rerender({
      visibleVideos: new Set(["v0", "v1", "v2"]),
      // A changed center order used to evict v1 while the passive playback
      // policy still exposed the prior two-decoder target.
      centerPriorityIds: ["v2", "v0", "v1"],
    });

    expect(result.current.playingVideos).toEqual(
      new Set(["v2", "v0", "v1"])
    );
    expect(result.current.getDecoderLease("v0")).toBe(firstLease);
    expect(result.current.getDecoderLease("v1")).toBe(secondLease);
    expect(mediaScheduler.getSnapshot().stoppingDecoders).toBe(0);
  });

  it("keeps retained All Motion leases stable as the viewport scrolls", () => {
    const videos = makeVideos(3);
    const loadedVideos = new Set(["v0", "v1", "v2"]);
    const mediaScheduler = createMediaSlotScheduler({
      maxResident: 3,
      maxLoaders: 3,
      maxDecoders: 3,
    });
    for (const id of loadedVideos) {
      const loader = mediaScheduler.reserveLoader(id);
      mediaScheduler.markLoaderReady(loader);
    }

    const { result, rerender } = renderHook(
      ({ visibleVideos, centerPriorityIds }) =>
        useVideoCollection({
          videos,
          visibleVideos,
          loadedVideos,
          decoderTarget: visibleVideos.size,
          activationTarget: 3,
          playbackMode: "all-motion",
          centerPriorityIds,
          mediaScheduler,
        }),
      {
        initialProps: {
          visibleVideos: new Set(["v0", "v1"]),
          centerPriorityIds: ["v0", "v1"],
        },
      }
    );

    const leavingLease = result.current.getDecoderLease("v0");
    const retainedLease = result.current.getDecoderLease("v1");

    rerender({
      visibleVideos: new Set(["v1", "v2"]),
      centerPriorityIds: ["v2", "v1"],
    });

    expect(result.current.playingVideos).toEqual(new Set(["v2", "v1"]));
    expect(result.current.getDecoderLease("v1")).toBe(retainedLease);
    expect(result.current.getDecoderLease("v2")).toBeTruthy();
    expect(mediaScheduler.getSnapshot()).toMatchObject({
      decoders: 3,
      stoppingDecoders: 1,
    });

    act(() => {
      expect(result.current.reportPaused("v0", leavingLease)).toBe(true);
    });
    expect(mediaScheduler.getSnapshot()).toMatchObject({
      decoders: 2,
      stoppingDecoders: 0,
    });
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
