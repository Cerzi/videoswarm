import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createMediaSlotScheduler } from "../../services/mediaSlotScheduler";

const ERROR_COOLDOWN_MS = 8000;

const asSet = (value) =>
  value && typeof value.has === "function"
    ? value
    : new Set(Array.isArray(value) ? value : value ? Array.from(value) : []);

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
}) {
  const fallbackSchedulerRef = useRef(null);
  if (!fallbackSchedulerRef.current) {
    fallbackSchedulerRef.current = createMediaSlotScheduler();
  }
  const scheduler = mediaScheduler || fallbackSchedulerRef.current;
  const ownsScheduler = !mediaScheduler;
  const visible = asSet(visibleIds);
  const loaded = asSet(loadedIds);
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
  }, []);

  const reconcile = useCallback(() => {
    if (decoderCap <= 0 || playbackSuspended) {
      scheduler.reconcileDecoders([]);
      mirrorScheduler();
      return;
    }

    const now = performance.now();
    const candidates = [];
    const candidateSet = new Set();
    const addCandidate = (id) => {
      if (
        !id ||
        candidateSet.has(id) ||
        !visible.has(id) ||
        !loaded.has(id) ||
        !scheduler.getResidentLease(id)
      ) {
        return;
      }
      const failedAt = recentlyErroredRef.current.get(id);
      if (failedAt && now - failedAt < ERROR_COOLDOWN_MS) return;
      candidateSet.add(id);
      candidates.push(id);
    };

    addCandidate(hoveredRef.current);

    // Retain admitted decoders where possible to avoid churn during small
    // visibility/layout changes.
    for (const id of scheduler.getSnapshot().decoderIds) addCandidate(id);

    const orderIndex = new Map();
    startOrderRef.current.forEach((id, index) => orderIndex.set(id, index));
    const remaining = Array.from(visible).filter((id) => loaded.has(id));
    remaining.sort(
      (left, right) =>
        (orderIndex.get(right) ?? -1) - (orderIndex.get(left) ?? -1)
    );
    remaining.forEach(addCandidate);

    scheduler.reconcileDecoders(candidates);
    mirrorScheduler();
  }, [
    decoderCap,
    loaded,
    mirrorScheduler,
    playbackSuspended,
    reconcileRevision,
    scheduler,
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
      if (!current || (lease && current !== lease)) return false;
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
  }, [visible]);

  useEffect(
    () => () => {
      for (const timer of errorTimersRef.current.values()) clearTimeout(timer);
      errorTimersRef.current.clear();
      if (ownsScheduler) scheduler.reset();
    },
    [ownsScheduler, scheduler]
  );

  const getDecoderLease = useCallback(
    (id) => scheduler.getDecoderLease(id),
    [scheduler]
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
    }),
    [
      activeHoverAudioId,
      getDecoderLease,
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
