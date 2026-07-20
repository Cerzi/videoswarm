import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createMediaSlotScheduler } from "../../services/mediaSlotScheduler";
import {
  buildPlaybackPriority,
  DEFAULT_PLAYBACK_MODE,
  normalizePlaybackMode,
  PLAYBACK_MODES,
} from "../../playback/playbackPolicy";

const ERROR_COOLDOWN_MS = 8000;
export const MAX_PLAYBACK_START_HISTORY = 1024;
const EMPTY_IDS = Object.freeze([]);
const EMPTY_SET = new Set();

const asSet = (value) =>
  value && typeof value.has === "function"
    ? value
    : value
      ? new Set(Array.isArray(value) ? value : Array.from(value))
      : EMPTY_SET;

const sameSet = (left, right) => {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
};

/**
 * Decoder orchestration backed by the imperative media-slot scheduler.
 * `playingSet` is a React mirror used to drive card effects; it never grants a
 * decoder by itself.
 */
export default function usePlayOrchestrator({
  visibleIds,
  loadedIds,
  maxPlaying,
  hoverAudioEnabled = false,
  mediaScheduler = null,
  playbackSuspended = false,
  playbackMode = DEFAULT_PLAYBACK_MODE,
  selectedIds = EMPTY_SET,
  centerPriorityIds = EMPTY_IDS,
  hoveredId,
}) {
  const fallbackSchedulerRef = useRef(null);
  if (!fallbackSchedulerRef.current) {
    fallbackSchedulerRef.current = createMediaSlotScheduler();
  }
  const scheduler = mediaScheduler || fallbackSchedulerRef.current;
  const ownsScheduler = !mediaScheduler;
  const visible = asSet(visibleIds);
  const loaded = asSet(loadedIds);
  const selected = asSet(selectedIds);
  const normalizedMode = normalizePlaybackMode(playbackMode);
  const centerOrder = Array.isArray(centerPriorityIds)
    ? centerPriorityIds
    : EMPTY_IDS;
  // All Motion deliberately retains the pre-mode ordering. In particular,
  // viewport-center changes must not make already-playing media hand its
  // decoder back merely because the user scrolled a few pixels.
  const boundedCenterOrder =
    normalizedMode === PLAYBACK_MODES.ALL_MOTION ? EMPTY_IDS : centerOrder;
  const decoderCap = playbackSuspended
    ? 0
    : Math.max(0, Math.floor(Number(maxPlaying) || 0));

  const [playingSet, setPlayingSet] = useState(
    () => scheduler.getSnapshot().decoderIds
  );
  const [activeHoverAudioId, setActiveHoverAudioId] = useState(null);
  const [reconcileRevision, setReconcileRevision] = useState(0);
  const hoveredRef = useRef(null);
  const startOrderRef = useRef([]);
  const recentlyErroredRef = useRef(new Map());
  const errorTimersRef = useRef(new Map());

  const mirrorScheduler = useCallback(() => {
    const next = scheduler.getSnapshot().decoderIds;
    setPlayingSet((previous) => (sameSet(previous, next) ? previous : next));
    return next;
  }, [scheduler]);

  const pushStartOrder = useCallback((id) => {
    startOrderRef.current = startOrderRef.current.filter((value) => value !== id);
    startOrderRef.current.push(id);
    if (startOrderRef.current.length > MAX_PLAYBACK_START_HISTORY) {
      startOrderRef.current.splice(
        0,
        startOrderRef.current.length - MAX_PLAYBACK_START_HISTORY
      );
    }
  }, []);

  const reconcile = useCallback(() => {
    startOrderRef.current = startOrderRef.current
      .filter((id) => loaded.has(id))
      .slice(-MAX_PLAYBACK_START_HISTORY);
    if (decoderCap <= 0 || playbackSuspended) {
      scheduler.reconcileDecoders([]);
      mirrorScheduler();
      return;
    }

    const now = performance.now();
    const recentOrder = [...startOrderRef.current].reverse();
    const retained = scheduler.getSnapshot().decoderIds;
    let priority;
    if (normalizedMode === PLAYBACK_MODES.ALL_MOTION) {
      const included = new Set();
      priority = [];
      const add = (id) => {
        if (
          id == null ||
          included.has(id) ||
          !visible.has(id) ||
          !loaded.has(id)
        ) {
          return;
        }
        included.add(id);
        priority.push(id);
      };

      add(hoveredId !== undefined ? hoveredId : hoveredRef.current);
      for (const id of retained) add(id);
      for (const id of recentOrder) add(id);
      for (const id of visible) add(id);
    } else {
      const ranked = buildPlaybackPriority({
        mode: normalizedMode,
        visibleIds: visible,
        loadedIds: loaded,
        centerOrderedIds: boundedCenterOrder.length
          ? boundedCenterOrder
          : recentOrder,
        hoveredId: hoveredId !== undefined ? hoveredId : hoveredRef.current,
        selectedIds: selected,
      });
      const rankedSet = new Set(ranked);
      const included = new Set();
      priority = [];
      const add = (id) => {
        if (id == null || included.has(id) || !rankedSet.has(id)) return;
        included.add(id);
        priority.push(id);
      };

      // Explicit interaction can preempt a decoder. Otherwise retain current
      // visible owners before admitting the rest of the center-ranked list, so
      // small scroll/layout changes do not churn healthy decoders.
      add(hoveredId !== undefined ? hoveredId : hoveredRef.current);
      for (const id of ranked) {
        if (selected.has(id)) add(id);
      }
      for (const id of retained) add(id);
      for (const id of ranked) add(id);
    }
    const candidates = priority.filter((id) => {
      if (!scheduler.getResidentLease(id)) return false;
      const failedAt = recentlyErroredRef.current.get(id);
      return !(failedAt && now - failedAt < ERROR_COOLDOWN_MS);
    });

    scheduler.reconcileDecoders(candidates);
    mirrorScheduler();
  }, [
    decoderCap,
    loaded,
    mirrorScheduler,
    normalizedMode,
    playbackSuspended,
    reconcileRevision,
    scheduler,
    selected,
    boundedCenterOrder,
    hoveredId,
    visible,
  ]);

  useLayoutEffect(() => {
    scheduler.configure({
      maxDecoders: decoderCap,
      ...(ownsScheduler
        ? {
            maxResident: Math.max(1, loaded.size),
            maxLoaders: Math.max(1, loaded.size),
          }
        : {}),
    });
    // Standalone hook callers (mainly focused tests) provide loaded IDs
    // without card-owned resident leases. Production never uses this branch.
    if (ownsScheduler) {
      const residentIds = scheduler.getSnapshot().residentIds;
      for (const id of residentIds) {
        if (!loaded.has(id)) scheduler.releaseId(id);
      }
      for (const id of loaded) {
        if (scheduler.getResidentLease(id)) continue;
        const lease = scheduler.reserveLoader(id);
        if (lease) scheduler.markLoaderReady(lease);
      }
    }
    reconcile();
  }, [decoderCap, loaded.size, ownsScheduler, reconcile, scheduler]);

  const reportStarted = useCallback(
    (id, lease = null) => {
      const current = scheduler.getDecoderLease(id);
      const activeIds = scheduler.getSnapshot().decoderIds;
      if (
        !current ||
        !activeIds.has(id) ||
        (lease && current !== lease)
      ) {
        return false;
      }
      pushStartOrder(id);
      return true;
    },
    [pushStartOrder, scheduler]
  );

  const reportPlayError = useCallback(
    (id, _error, lease = null) => {
      const current = scheduler.getDecoderLease(id);
      if (!current || (lease && current !== lease)) return false;
      scheduler.requestDecoderStop(current);
      recentlyErroredRef.current.set(id, performance.now());
      mirrorScheduler();
      setReconcileRevision((value) => value + 1);

      const previousTimer = errorTimersRef.current.get(id);
      if (previousTimer) clearTimeout(previousTimer);
      const timer = setTimeout(() => {
        errorTimersRef.current.delete(id);
        recentlyErroredRef.current.delete(id);
        setReconcileRevision((value) => value + 1);
      }, ERROR_COOLDOWN_MS);
      errorTimersRef.current.set(id, timer);
      return true;
    },
    [mirrorScheduler, scheduler]
  );

  const reportPaused = useCallback(
    (id, lease = null) => {
      const current = scheduler.getDecoderLease(id);
      // A pause acknowledgement is an ownership mutation. Never let a stale
      // render with no lease release a decoder granted by a newer layout pass.
      if (!lease || !current || current !== lease) return false;
      scheduler.acknowledgeDecoderStopped(current);
      mirrorScheduler();
      setReconcileRevision((value) => value + 1);
      return true;
    },
    [mirrorScheduler, scheduler]
  );

  const markHover = useCallback((id) => {
    if (hoveredRef.current === id) return;
    hoveredRef.current = id;
    setReconcileRevision((value) => value + 1);
  }, []);

  const onCardHoverAudioStart = useCallback(
    (id) => {
      if (!hoverAudioEnabled) return;
      setActiveHoverAudioId((previous) => (previous === id ? previous : id));
    },
    [hoverAudioEnabled]
  );

  const onCardHoverAudioEnd = useCallback((id) => {
    setActiveHoverAudioId((previous) => (previous === id ? null : previous));
  }, []);

  useEffect(() => {
    if (!hoverAudioEnabled) setActiveHoverAudioId(null);
  }, [hoverAudioEnabled]);

  useEffect(() => {
    setActiveHoverAudioId((previous) =>
      previous && !visible.has(previous) ? null : previous
    );
    if (hoveredRef.current && !visible.has(hoveredRef.current)) {
      hoveredRef.current = null;
      setReconcileRevision((value) => value + 1);
    }
  }, [visible]);

  useEffect(
    () => () => {
      for (const timer of errorTimersRef.current.values()) clearTimeout(timer);
      errorTimersRef.current.clear();
      recentlyErroredRef.current.clear();
      startOrderRef.current = [];
      if (ownsScheduler) scheduler.reset();
    },
    [ownsScheduler, scheduler]
  );

  const getDecoderLease = useCallback(
    (id) => scheduler.getDecoderLease(id),
    [scheduler]
  );

  const getCacheDebugSnapshot = useCallback(
    () => ({
      startHistoryEntries: startOrderRef.current.length,
      staleStartHistoryEntries: startOrderRef.current.filter(
        (id) => !loaded.has(id)
      ).length,
      maxStartHistoryEntries: MAX_PLAYBACK_START_HISTORY,
    }),
    [loaded]
  );

  return useMemo(
    () => ({
      playingSet,
      markHover,
      activeHoverAudioId,
      onCardHoverAudioStart,
      onCardHoverAudioEnd,
      reportStarted,
      reportPlayError,
      reportPaused,
      getDecoderLease,
      getCacheDebugSnapshot,
    }),
    [
      activeHoverAudioId,
      getDecoderLease,
      getCacheDebugSnapshot,
      markHover,
      onCardHoverAudioEnd,
      onCardHoverAudioStart,
      playingSet,
      reportPlayError,
      reportPaused,
      reportStarted,
    ]
  );
}
