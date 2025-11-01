// hooks/video-collection/useVideoCollection.js
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
  scrollRef = null,
  progressive = {},
  hadLongTaskRecently = false,
  isNear,
  activationTarget = null,
  activationWindowIds = [],
  suspendEvictions = false,
  renderLimit = null,
}) {
  const {
    initial = PROGRESSIVE_DEFAULTS.initial,
    batchSize = PROGRESSIVE_DEFAULTS.batchSize,
    intervalMs = PROGRESSIVE_DEFAULTS.intervalMs,
    pauseOnScroll = PROGRESSIVE_DEFAULTS.pauseOnScroll,
    longTaskAdaptation = PROGRESSIVE_DEFAULTS.longTaskAdaptation,
    forceInterval,
    maxVisible,
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

  // Layer 1: Progressive rendering (React performance)
  const progressiveState = useProgressiveList(
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
      maxVisible,
      materializeAll: true,
    }
  );

  const progressiveVideos = progressiveState.items || videos;
  const progressiveVisibleCount =
    typeof progressiveState.visibleCount === "number"
      ? progressiveState.visibleCount
      : videos.length;
  const progressiveTargetCount =
    typeof progressiveState.targetCount === "number"
      ? progressiveState.targetCount
      : videos.length;

  const userLimit =
    renderLimit != null && Number.isFinite(renderLimit)
      ? Math.max(0, Math.floor(renderLimit))
      : null;

  const limitedVideos =
    userLimit == null
      ? progressiveVideos
      : progressiveVideos.slice(0, userLimit);

  const limitedVisibleCount =
    userLimit == null
      ? progressiveVisibleCount
      : Math.min(progressiveVisibleCount, userLimit);

  const limitedTargetCount =
    userLimit == null
      ? progressiveTargetCount
      : Math.min(progressiveTargetCount, Math.max(userLimit, 0));

  const desiredActiveCount = Number.isFinite(activationTarget) && activationTarget > 0
    ? Math.max(1, Math.floor(activationTarget))
    : progressiveVisibleCount;

  const cappedDesiredActiveCount =
    userLimit == null
      ? desiredActiveCount
      : Math.min(
          Math.max(0, desiredActiveCount),
          Math.max(userLimit, 0)
        );

  const activationWindowSize = (() => {
    if (activationWindowIds instanceof Set) return activationWindowIds.size;
    if (Array.isArray(activationWindowIds)) return activationWindowIds.length;
    if (activationWindowIds && typeof activationWindowIds[Symbol.iterator] === "function") {
      let count = 0;
      for (const _ of activationWindowIds) {
        count += 1;
      }
      return count;
    }
    return 0;
  })();

  // Layer 2: Resource management (Browser performance)
  const {
    canLoadVideo,
    performCleanup,
    limits,
    memoryStatus,
    reportPlayerCreationFailure,
  } = useVideoResourceManager({
    progressiveVideos: limitedVideos,
    progressiveVisibleCount: limitedVisibleCount,
    progressiveTargetCount: limitedTargetCount,
    desiredActiveCount: cappedDesiredActiveCount,
    visibleVideos,
    loadedVideos,
    loadingVideos,
    playingVideos: actualPlaying,
    hadLongTaskRecently,
    isNear,
    suspendEvictions,
  });

  // Layer 3: Play orchestration (Business logic)
  const playingCap =
    cappedDesiredActiveCount && cappedDesiredActiveCount > 0
      ? Math.floor(cappedDesiredActiveCount)
      : limitedVisibleCount;
  const { playingSet, markHover, reportPlayError, reportStarted } =
    usePlayOrchestrator({
      visibleIds: visibleVideos,
      loadedIds: loadedVideos,
      maxPlaying:
        Number.isFinite(playingCap) && playingCap > 0
          ? playingCap
          : limitedVisibleCount,
    });

  return {
    // What to render
    videosToRender: limitedVideos,

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
      rendered: limitedVideos.length,
      playing: playingSet.size,
      loaded: loadedVideos.size,
      progressiveVisible: limitedVisibleCount,
      activationTarget: cappedDesiredActiveCount,
      activeWindow: activationWindowSize,
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
