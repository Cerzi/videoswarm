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

  // FIXED: More conservative hover handling to prevent video disruption
  const markHover = useCallback((id) => {
    // Only update if hover actually changed
    if (hoveredRef.current === id) return;

    hoveredRef.current = id;
  }, []);

  // Media actually started - FIXED to prevent infinite loops
  const reportStarted = useCallback(
    (id) => {
      setPlayingSet((prev) => {
        if (prev.has(id)) return prev; // No change needed
        const next = new Set(prev);
        next.add(id);
        // Move pushStartOrder outside setState to avoid side effects during render
        setTimeout(() => pushStartOrder(id), 0);
        return next;
      });
    },
    [pushStartOrder]
  );

  const reportPlayError = useCallback((id, _err) => {
    recentlyErroredRef.current.set(id, performance.now());
    setPlayingSet((prev) => {
      if (!prev.has(id)) return prev; // No change needed
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // IMPROVED: More stable eviction that doesn't disrupt existing players
  const evictIfNeeded = useCallback(
    (baseSet) => {
      const cap = Math.max(0, Number(maxPlaying) || 0);
      if (baseSet.size <= cap) return baseSet;

      const hovered = hoveredRef.current;
      const entries = Array.from(baseSet);

      const orderIdx = new Map();
      startOrderRef.current.forEach((id, idx) => orderIdx.set(id, idx));

      const desirability = (id) => {
        const isHovered = hovered && id === hovered ? 10 : 0; // Much higher priority for hovered
        const visible = visibleIds.has(id) ? 5 : 0;
        const loaded = loadedIds.has(id) ? 1 : 0;
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

      const toKeep = new Set(entries.slice(0, cap));

      // CRITICAL: Always ensure hovered video is included if visible
      if (hovered && visibleIds.has(hovered)) {
        toKeep.add(hovered);
        // If we're now over capacity, remove the least important non-hovered video
        if (toKeep.size > cap) {
          const nonHovered = entries.filter((id) => id !== hovered);
          const leastImportant = nonHovered[nonHovered.length - 1];
          if (leastImportant) toKeep.delete(leastImportant);
        }
      }

      return toKeep;
    },
    [maxPlaying, visibleIds, loadedIds]
  );

  // MUCH more conservative reconcile - only runs when really needed
  const reconcile = useCallback(() => {
    setPlayingSet((prev) => {
      let next = new Set(prev);
      let hasChanges = false;

      // Only remove videos that are no longer visible
      for (const id of next) {
        if (!visibleIds.has(id)) {
          next.delete(id);
          hasChanges = true;
        }
      }

      // Only add videos that should be playing but aren't
      for (const id of visibleIds) {
        if (loadedIds.has(id) && !next.has(id)) {
          next.add(id);
          hasChanges = true;
          setTimeout(() => pushStartOrder(id), 0);
        }
      }

      // Handle hovered video priority without disrupting others
      const hovered = hoveredRef.current;
      if (hovered && visibleIds.has(hovered) && loadedIds.has(hovered)) {
        if (!next.has(hovered)) {
          next.add(hovered);
          hasChanges = true;
          setTimeout(() => pushStartOrder(hovered), 0);
        }
      }

      // Only evict if we're significantly over capacity (not for small overruns)
      if (next.size > maxPlaying * 1.1) {
        // 10% buffer before evicting
        const evicted = evictIfNeeded(next);
        if (evicted.size !== next.size) {
          next = evicted;
          hasChanges = true;
        }
      }

      return hasChanges ? next : prev; // Only return new set if there are actual changes
    });
  }, [visibleIds, loadedIds, maxPlaying, evictIfNeeded, pushStartOrder]);

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
