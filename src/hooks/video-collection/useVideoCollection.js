// hooks/video-collection/useVideoCollection.js
import { useEffect, useState } from "react";
import { useProgressiveList } from "./useProgressiveList";
import useVideoResourceManager from "./useVideoResourceManager";
import usePlayOrchestrator from "./usePlayOrchestrator";

// Render a generous number of extra tiles beyond the resource manager caps so
// that we always have DOM ready when the user scrolls aggressively in either
// direction. A larger buffer keeps more cards mounted without overwhelming the
// browser because the resource manager still enforces real loading limits.
const MAX_TILES_BUFFER = 120;

export const PROGRESSIVE_DEFAULTS = {
  initial: 100,
  batchSize: 50,
  intervalMs: 100,
  pauseOnScroll: true,
  longTaskAdaptation: true,
};

/**
 * Composite hook that coordinates the 3-layer video collection system
 * Handles React performance, browser resources, and play orchestration
 */
export default function useVideoCollection({
  videos = [],
  visibleVideos = new Set(),
  loadedVideos = new Set(),
  loadingVideos = new Set(),
  actualPlaying = new Set(),
  maxConcurrentPlaying = 250,
  scrollRef = null,
  progressive = {},
  hadLongTaskRecently = false,
  isNear,
}) {
  const {
    initial = PROGRESSIVE_DEFAULTS.initial,
    batchSize = PROGRESSIVE_DEFAULTS.batchSize,
    intervalMs = PROGRESSIVE_DEFAULTS.intervalMs,
    pauseOnScroll = PROGRESSIVE_DEFAULTS.pauseOnScroll,
    longTaskAdaptation = PROGRESSIVE_DEFAULTS.longTaskAdaptation,
    forceInterval,
  } = progressive || {};

  // Normalize to safe numbers
  const safeInitial = Math.max(
    0,
    Number.isFinite(initial) ? initial : PROGRESSIVE_DEFAULTS.initial
  );
  const safeBatchSize = Math.max(
    1,
    Number.isFinite(batchSize) ? batchSize : PROGRESSIVE_DEFAULTS.batchSize
  );
  const safeInterval = Math.max(
    1,
    Number.isFinite(intervalMs) ? intervalMs : PROGRESSIVE_DEFAULTS.intervalMs
  );

  const [renderCap, setRenderCap] = useState(Number.POSITIVE_INFINITY);
  const [evictionVictims, setEvictionVictims] = useState([]);

  // Layer 1: Progressive rendering (React performance)
  const progressiveVideos = useProgressiveList(
    videos,
    safeInitial,
    safeBatchSize,
    safeInterval,
    {
      scrollRef,
      pauseOnScroll,
      longTaskAdaptation,
      hadLongTaskRecently,
      forceInterval: !!forceInterval,
      maxRendered: renderCap,
    }
  );

  // Layer 2: Resource management (Browser performance)
  const {
    canLoadVideo,
    performCleanup,
    limits,
    memoryStatus,
    reportPlayerCreationFailure,
  } = useVideoResourceManager({
    progressiveVideos,
    visibleVideos,
    loadedVideos,
    loadingVideos,
    playingVideos: actualPlaying,
    hadLongTaskRecently,
    isNear,
    playingCap: maxConcurrentPlaying,
  });

  // Layer 3: Play orchestration (Business logic)
  const { playingSet, markHover, reportPlayError, reportStarted } =
    usePlayOrchestrator({
      visibleIds: visibleVideos,
      loadedIds: loadedVideos,
      maxPlaying: maxConcurrentPlaying,
    });

  const collectionSize = (collection) => {
    if (!collection) return 0;
    if (typeof collection.size === "number") return collection.size;
    if (Array.isArray(collection)) return collection.length;
    try {
      return Array.from(collection).length;
    } catch {
      return 0;
    }
  };

  const loadedCount = collectionSize(loadedVideos);
  const visibleCount = collectionSize(visibleVideos);

  useEffect(() => {
    const safeMaxLoaded = Number.isFinite(limits?.maxLoaded)
      ? Math.max(0, limits.maxLoaded)
      : videos.length;
    const safeMaxLoading = Number.isFinite(limits?.maxConcurrentLoading)
      ? Math.max(0, limits.maxConcurrentLoading)
      : 0;

    const rawCap = safeMaxLoaded + safeMaxLoading + MAX_TILES_BUFFER;
    const boundedCap = Math.min(videos.length, Math.max(0, Math.floor(rawCap)));

    setRenderCap((prev) => (prev === boundedCap ? prev : boundedCap));
  }, [videos.length, limits?.maxLoaded, limits?.maxConcurrentLoading]);

  useEffect(() => {
    if (typeof performCleanup !== "function") {
      setEvictionVictims((prev) => (prev.length ? [] : prev));
      return;
    }
    const victims = performCleanup() || [];
    setEvictionVictims((prev) => {
      if (prev.length === victims.length && prev.every((id, idx) => id === victims[idx])) {
        return prev;
      }
      return victims;
    });
  }, [
    performCleanup,
    loadedCount,
    visibleCount,
    limits?.maxLoaded,
    limits?.maxConcurrentLoading,
  ]);

  return {
    // What to render
    videosToRender: progressiveVideos,

    // Functions for VideoCard
    canLoadVideo,
    evictionVictims,
    isVideoPlaying: (videoId) => playingSet.has(videoId),
    markHover,
    reportPlayError,
    reportStarted,
    reportPlayerCreationFailure,

    // Functions for parent
    performCleanup,
    limits,

    // Derived state for UI
    playingVideos: playingSet,
    stats: {
      total: videos.length,
      rendered: progressiveVideos.length,
      playing: playingSet.size,
      loaded: loadedVideos.size,
    },

    memoryStatus,

    // Debug info (development only)
    debug:
      process.env.NODE_ENV === "development"
        ? {
            resourceLimits: limits,
            systemHealth:
              loadedVideos.size > limits.maxLoaded ? "overloaded" : "good",
          }
        : undefined,
  };
}
