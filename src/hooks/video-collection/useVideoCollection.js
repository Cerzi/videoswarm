// hooks/video-collection/useVideoCollection.js
import { useProgressiveList } from "./useProgressiveList";
import useVideoResourceManager from "./useVideoResourceManager";
import usePlayOrchestrator from "./usePlayOrchestrator";

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
}) {
  const {
    initial = 100,
    batchSize = 50,
    intervalMs = 100,
    pauseOnScroll = true,
    longTaskAdaptation = true,
  } = progressive;

  // Layer 1: Progressive rendering (React performance)
  const progressiveVideos = useProgressiveList(
    videos,
    initial,
    batchSize,
    intervalMs,
    {
      scrollRef,
      pauseOnScroll,
      longTaskAdaptation,
    }
  );

  // Layer 2: Resource management (Browser performance)
  const { canLoadVideo, performCleanup, limits } = useVideoResourceManager({
    progressiveVideos,
    visibleVideos,
    loadedVideos,
    loadingVideos,
    playingVideos: actualPlaying,
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
