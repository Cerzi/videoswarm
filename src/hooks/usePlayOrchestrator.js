import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Centralized play orchestration.
 * - playingSet is the *desired* (allowed) set.
 * - Hover reserves a slot immediately (even if not yet loaded).
 * - Eviction prefers: hovered > visible+loaded > visible > others.
 * - Caller reports actual starts/errors via reportStarted/reportPlayError.
 */
export default function usePlayOrchestrator({
  visibleIds,   // Set<string>
  loadedIds,    // Set<string>
  maxPlaying,   // number
}) {
  const [playingSet, setPlayingSet] = useState(new Set()); // allowed/desired
  const hoveredRef = useRef(null);
  const startOrderRef = useRef([]);        // newer at the end
  const recentlyErroredRef = useRef(new Map()); // id -> ts

  const pushStartOrder = (id) => {
    startOrderRef.current = startOrderRef.current.filter((x) => x !== id);
    startOrderRef.current.push(id);
  };

  const markHover = (id) => {
    hoveredRef.current = id;
    reconcile(); // make it snappy
  };

  // media actually started
  const reportStarted = (id) => {
    // Keep id in desired set (if not already)
    setPlayingSet((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      pushStartOrder(id);
      return next;
    });
  };

  const reportPlayError = (id, _err) => {
    recentlyErroredRef.current.set(id, performance.now());
    setPlayingSet((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // Prefer kept items based on desirability
  const evictIfNeeded = (baseSet) => {
    const cap = Math.max(0, Number(maxPlaying) || 0);
    if (baseSet.size <= cap) return baseSet;

    const hovered = hoveredRef.current;
    const entries = Array.from(baseSet);

    const orderIdx = new Map();
    startOrderRef.current.forEach((id, idx) => orderIdx.set(id, idx));

    const desirability = (id) => {
      const isHovered = hovered && id === hovered ? 2 : 0;
      const visible = visibleIds.has(id) ? 1 : 0;
      const loaded = loadedIds.has(id) ? 0.5 : 0; // nudge loaded above not-loaded
      return isHovered + visible + loaded;
    };

    entries.sort((a, b) => {
      const db = desirability(b);
      const da = desirability(a);
      if (db !== da) return db - da;
      // tie-break: keep more recently started first
      const ib = orderIdx.get(b) ?? -1;
      const ia = orderIdx.get(a) ?? -1;
      return ib - ia;
    });

    return new Set(entries.slice(0, cap));
  };

  // IMPORTANT: we do NOT remove "not loaded" here anymore.
  // We only remove things that are no longer visible (to avoid wasting slots).
  const reconcile = () => {
    setPlayingSet((prev) => {
      let next = new Set(prev);

      // drop anything not visible anymore
      for (const id of next) {
        if (!visibleIds.has(id)) next.delete(id);
      }

      // always try to include hovered (if visible)
      const hovered = hoveredRef.current;
      if (hovered && visibleIds.has(hovered)) {
        next.add(hovered);
        pushStartOrder(hovered);
      }

      // cap
      next = evictIfNeeded(next);
      return next;
    });
  };

  useEffect(() => {
    reconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds, loadedIds, maxPlaying]);

  // Expire "recently errored" entries so they can retry later
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      for (const [id, ts] of recentlyErroredRef.current) {
        if (now - ts > 8000) {
          recentlyErroredRef.current.delete(id);
        }
      }
    }, 2000);
    return () => clearInterval(t);
  }, []);

  return useMemo(
    () => ({
      playingSet,      // desired/allowed
      markHover,       // force-priority on hover
      reportStarted,   // call when <video> fires "playing"
      reportPlayError, // call on error (load/play)
    }),
    [playingSet]
  );
}
