// hooks/video-collection/useVideoCollection.js
import { useCallback, useMemo } from "react";
import useVideoResourceManager from "./useVideoResourceManager";
import usePlayOrchestrator from "./usePlayOrchestrator";

/**
 * Composite hook that coordinates the video collection system.
 * With full DOM rendering we simply render all videos and rely on
 * resource and playback orchestration to keep the experience smooth.
 */
export default function useVideoCollection({
  videos = [],
  visibleVideos = new Set(),
  loadedVideos = new Set(),
  loadingVideos = new Set(),
  actualPlaying = new Set(),
  maxConcurrentPlaying = 250,
  hadLongTaskRecently = false,
  isNear,
  suspendEvictions = false,
}) {
  const progressiveVideos = videos;

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
    suspendEvictions,
  });

  // Layer 3: Play orchestration (Business logic)
  const { playingSet, markHover, reportPlayError, reportStarted } =
    usePlayOrchestrator({
      visibleIds: visibleVideos,
      loadedIds: loadedVideos,
      maxPlaying: maxConcurrentPlaying,
    });

  const logicalOrder = useMemo(
    () =>
      videos.map((video, index) => {
        if (!video) return `__index_${index}`;
        return (
          video.id ||
          video.fullPath ||
          video.name ||
          `__index_${index}`
        );
      }),
    [videos]
  );

  const idToIndex = useMemo(() => {
    const map = new Map();
    logicalOrder.forEach((id, index) => {
      if (id == null) return;
      if (!map.has(id)) {
        map.set(id, index);
      }
    });
    return map;
  }, [logicalOrder]);

  const ensureVisibleRange = useCallback(() => {}, []);

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

    logicalOrder,
    idToIndex,
    ensureVisibleRange,

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
