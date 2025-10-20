// hooks/video-collection/useVideoCollection.js
import { useCallback, useEffect, useMemo, useRef } from "react";
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

const MAX_RAIL_OVERRIDE = 1200;
const MIN_RAIL_WINDOW = 180;

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
  suspendEvictions = false,
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

  const progressiveControllerRef = useRef(null);
  const baselineMaxVisible = useMemo(() => {
    if (Number.isFinite(maxVisible) && maxVisible > 0) {
      return Math.floor(maxVisible);
    }
    return videos.length;
  }, [maxVisible, videos.length]);

  const overrideTargetRef = useRef(null);
  const decayTimerRef = useRef(null);

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
      maxVisible,
      controllerRef: progressiveControllerRef,
    }
  );

  useEffect(() => {
    const controller = progressiveControllerRef.current;
    if (!controller) return;
    if (overrideTargetRef.current != null) {
      controller.setMaxVisibleOverride?.(overrideTargetRef.current);
      controller.ensureVisible?.(overrideTargetRef.current);
    } else {
      controller.setMaxVisibleOverride?.(null);
    }
  }, [baselineMaxVisible, videos.length]);

  useEffect(
    () => () => {
      if (decayTimerRef.current) {
        clearTimeout(decayTimerRef.current);
        decayTimerRef.current = null;
      }
    },
    []
  );

  const scheduleBudgetDecay = useCallback(
    (priority = "idle") => {
      const controller = progressiveControllerRef.current;
      if (!controller) return;
      const baseline = baselineMaxVisible || videos.length || 0;
      const stepDelay = priority === "rail" ? 280 : 420;
      const initialDelay = priority === "rail" ? 320 : 600;

      if (decayTimerRef.current) {
        clearTimeout(decayTimerRef.current);
      }

      const runStep = () => {
        const currentOverride = overrideTargetRef.current;
        if (currentOverride == null || currentOverride <= baseline) {
          overrideTargetRef.current = null;
          controller.setMaxVisibleOverride?.(null);
          decayTimerRef.current = null;
          return;
        }
        const next = Math.max(
          baseline,
          Math.floor((currentOverride + baseline) / 2)
        );
        if (next <= baseline || next === currentOverride) {
          overrideTargetRef.current = null;
          controller.setMaxVisibleOverride?.(null);
          decayTimerRef.current = null;
          return;
        }
        overrideTargetRef.current = next;
        controller.setMaxVisibleOverride?.(next);
        decayTimerRef.current = setTimeout(runStep, stepDelay);
      };

      decayTimerRef.current = setTimeout(runStep, initialDelay);
    },
    [baselineMaxVisible, videos.length]
  );

  const ensureVisibleRange = useCallback(
    (start, end, { priority = "nav" } = {}) => {
      const controller = progressiveControllerRef.current;
      const total = videos.length;
      if (!controller || !total) return;

      const safeStart = Math.max(
        0,
        Math.min(total - 1, Math.floor(Number.isFinite(start) ? start : 0))
      );
      const safeEnd = Math.max(
        safeStart,
        Math.min(total - 1, Math.floor(Number.isFinite(end) ? end : safeStart))
      );
      const span = safeEnd - safeStart + 1;
      const baseline = baselineMaxVisible || total;
      const safeSpan = Math.max(1, span);

      let targetWindow = safeSpan;
      if (priority === "rail") {
        const padded = safeSpan + Math.max(Math.floor(safeSpan * 0.75), 48);
        const minimum = Math.max(MIN_RAIL_WINDOW, safeSpan);
        const limit = Math.min(MAX_RAIL_OVERRIDE, Math.max(minimum, padded));
        targetWindow = Math.min(limit, padded);
      } else if (priority === "nav") {
        const padded = safeSpan + Math.max(Math.floor(safeSpan * 0.5), 36);
        const minimum = Math.max(Math.floor(MIN_RAIL_WINDOW * 0.75), safeSpan);
        const limit = Math.min(MAX_RAIL_OVERRIDE, Math.max(minimum, padded));
        targetWindow = Math.min(limit, padded);
      } else {
        const padded = safeSpan + Math.max(Math.floor(safeSpan * 0.25), 24);
        const minimum = Math.max(Math.floor(MIN_RAIL_WINDOW / 2), safeSpan);
        const limit = Math.min(Math.floor(MAX_RAIL_OVERRIDE / 2), Math.max(minimum, padded));
        targetWindow = Math.min(limit, padded);
      }

      const targetEnd = Math.min(total - 1, safeStart + targetWindow - 1);
      const override = Math.min(total, Math.max(baseline, targetEnd + 1));
      overrideTargetRef.current = override;
      controller.setMaxVisibleOverride?.(override);
      controller.ensureVisible?.(override);
      scheduleBudgetDecay(priority);
      return override;
    },
    [baselineMaxVisible, videos.length, scheduleBudgetDecay]
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
