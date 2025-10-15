// hooks/video-collection/useVideoCollection.js
import { useMemo } from "react";
import { useProgressiveList } from "./useProgressiveList";
import useVideoResourceManager from "./useVideoResourceManager";
import usePlayOrchestrator from "./usePlayOrchestrator";

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
  const clampOptions = progressive?.clamp ?? null;

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

  const idToIndexMap = useMemo(() => {
    const map = new Map();
    videos.forEach((video, index) => {
      const id = video?.id;
      if (id != null) map.set(id, index);
    });
    return map;
  }, [videos]);

  const highestVisibleIndex = useMemo(() => {
    if (!visibleVideos || typeof visibleVideos.forEach !== "function") return -1;
    let max = -1;
    visibleVideos.forEach((id) => {
      const idx = idToIndexMap.get(id);
      if (typeof idx === "number" && idx > max) {
        max = idx;
      }
    });
    return max;
  }, [visibleVideos, idToIndexMap]);

  const progressiveClamp = useMemo(() => {
    if (!clampOptions) return null;
    return {
      ...clampOptions,
      sentinelIndex: highestVisibleIndex,
    };
  }, [clampOptions, highestVisibleIndex]);

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
      clamp: progressiveClamp ?? undefined,
    }
  );

  // Layer 2: Resource management (Browser performance)
  const {
    canLoadVideo,
    performCleanup,
    limits,
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

  return {
    // What to render
    videosToRender: progressiveVideos,

    // Functions for VideoCard
    canLoadVideo,
    isVideoPlaying: (videoId) => playingSet.has(videoId),
    markHover,
    reportPlayError,
    reportStarted,
    reportPlayerCreationFailure,

    // Functions for parent
    performCleanup,

    // Derived state for UI
    playingVideos: playingSet,
    stats: {
      total: videos.length,
      rendered: progressiveVideos.length,
      playing: playingSet.size,
      loaded: loadedVideos.size,
    },

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
