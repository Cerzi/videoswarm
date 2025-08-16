import { useEffect, useMemo, useRef, useState, useCallback } from "react";

/**
 * Centralized play orchestration.
 * - playingSet is the *desired* (allowed) set.
 * - Hover reserves a slot immediately (even if not yet loaded).
 * - Eviction prefers: hovered > visible+loaded > visible > others.
 * - Caller reports actual starts/errors via reportStarted/reportPlayError.
 */
export default function usePlayOrchestrator({
  visibleIds, // Set<string>
  loadedIds, // Set<string>
  maxPlaying, // number
}) {
  const [playingSet, setPlayingSet] = useState(new Set()); // allowed/desired
  const hoveredRef = useRef(null);
  const startOrderRef = useRef([]); // newer at the end
  const recentlyErroredRef = useRef(new Map()); // id -> ts

  // Stable function to avoid recreation on every render
  const pushStartOrder = useCallback((id) => {
    startOrderRef.current = startOrderRef.current.filter((x) => x !== id);
    startOrderRef.current.push(id);
  }, []);

  // Stable function with useCallback to prevent infinite loops
  const markHover = useCallback((id) => {
    hoveredRef.current = id;
    reconcile(); // make it snappy
  }, []); // Empty dependency array - this function doesn't depend on anything

  // Media actually started - FIXED to prevent infinite loops
  const reportStarted = useCallback((id) => {
    // Keep id in desired set (if not already)
    setPlayingSet((prev) => {
      if (prev.has(id)) return prev; // No change needed
      const next = new Set(prev);
      next.add(id);
      // Move pushStartOrder outside setState to avoid side effects during render
      setTimeout(() => pushStartOrder(id), 0);
      return next;
    });
  }, [pushStartOrder]);

  const reportPlayError = useCallback((id, _err) => {
    recentlyErroredRef.current.set(id, performance.now());
    setPlayingSet((prev) => {
      if (!prev.has(id)) return prev; // No change needed
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Prefer kept items based on desirability
  const evictIfNeeded = useCallback((baseSet) => {
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
  }, [maxPlaying, visibleIds, loadedIds]);

  // We only remove things that are no longer visible (to avoid wasting slots).
  const reconcile = useCallback(() => {
    setPlayingSet((prev) => {
      let next = new Set(prev);

      // drop anything not visible anymore
      for (const id of next) {
        if (!visibleIds.has(id)) next.delete(id);
      }

      // Add all visible videos
      for (const id of visibleIds) {
        if (loadedIds.has(id)) {
          next.add(id);
          // Move side effect outside setState
          setTimeout(() => pushStartOrder(id), 0);
        }
      }

      // always try to include hovered (if visible)
      const hovered = hoveredRef.current;
      if (hovered && visibleIds.has(hovered)) {
        next.add(hovered);
        setTimeout(() => pushStartOrder(hovered), 0);
      }

      // cap
      next = evictIfNeeded(next);
      return next;
    });
  }, [visibleIds, loadedIds, evictIfNeeded, pushStartOrder]);

  // FIXED: Add proper dependency management for reconcile
  useEffect(() => {
    reconcile();
  }, [visibleIds.size, loadedIds.size, maxPlaying]); // Only depend on sizes, not the sets themselves

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

  // Memoize the return object to prevent unnecessary re-renders
  return useMemo(
    () => ({
      playingSet, // desired/allowed
      markHover, // force-priority on hover
      reportStarted, // call when <video> fires "playing"
      reportPlayError, // call on error (load/play)
    }),
    [playingSet, markHover, reportStarted, reportPlayError]
  );
}