// src/hooks/useIntersectionObserverRegistry.js
import { useEffect, useMemo, useRef, useCallback } from "react";

/**
 * Shared IntersectionObserver registry (single observer).
 * - "visible": overlap with the actual viewport of the root element.
 * - "near": overlap with viewport expanded by `nearPx`.
 *
 * API:
 *   const io = useIntersectionObserverRegistry(gridRef, { threshold, rootMargin, nearPx });
 *   io.observe(el, id, (visible, entry) => { ... }); // id optional; back-compat: observe(el, cb)
 *   io.unobserve(el);
 *   io.isVisible(id) -> boolean
 *   io.isNear(id)    -> boolean
 *   io.setNearPx(px) // adjust look-ahead window without rebuilding
 *   io.getNearPx()
 *   io.getRootMargin()
 *
 * NOTE: Avoid changing rootMargin per scroll; use a generous fixed margin.
 */
const MAX_SYNC_EVALUATIONS = 32;
const MAX_PER_FRAME = 160;
const REFRESH_SYNC_CHUNK = 96;

export default function useIntersectionObserverRegistry(
  rootRef,
  {
    rootMargin = "1600px 0px", // generous fixed prefetch window
    threshold = [0, 0.15],
    nearPx = 900,              // distance beyond viewport considered "near"
  } = {}
) {
  const handlersRef = useRef(new Map()); // Element -> (visible:boolean, entry)=>void
  const idsRef = useRef(new Map());      // Element -> id
  const visibleIdsRef = useRef(new Set()); // Set<id>
  const nearIdsRef = useRef(new Set());    // Set<id>
  const observerRef = useRef(null);
  const pendingEntriesRef = useRef(new Map()); // Map<Element, IntersectionObserverEntry>
  const pendingFrameRef = useRef(null);
  const pendingFrameIsTimeoutRef = useRef(false);
  const pendingEvaluateRef = useRef(new Set());
  const evaluateFrameRef = useRef(null);
  const evaluateFrameIsTimeoutRef = useRef(false);
  const immediateBudgetRef = useRef(MAX_SYNC_EVALUATIONS);

  const currentRootMarginRef = useRef(rootMargin);
  const nearPxRef = useRef(nearPx);

  useEffect(() => {
    nearPxRef.current = Math.max(0, Number.isFinite(nearPx) ? nearPx : 0);
  }, [nearPx]);

  // Resolve current root viewport rect (for visibility/near checks)
  const getRootRect = useCallback(() => {
    const rootEl = rootRef?.current ?? null;
    if (rootEl && rootEl.getBoundingClientRect) {
      return rootEl.getBoundingClientRect();
    }
    const h = typeof window !== "undefined" ? window.innerHeight : 0;
    return { top: 0, bottom: h };
  }, [rootRef]);

  const updateFlags = useCallback((entry, id, rootRect) => {
    if (id == null) return;
    const r = entry.boundingClientRect;
    if (!r) return;

    // Visible = overlap with actual viewport
    const isVisible =
      r.bottom > rootRect.top && r.top < rootRect.bottom;
    if (isVisible) visibleIdsRef.current.add(id);
    else visibleIdsRef.current.delete(id);

    // Near = overlap with expanded viewport
    const top = rootRect.top - nearPxRef.current;
    const bottom = rootRect.bottom + nearPxRef.current;
    const isNear = r.bottom > top && r.top < bottom;
    if (isNear) nearIdsRef.current.add(id);
    else nearIdsRef.current.delete(id);
  }, []);

  // Observer callback: compute visible/near, then notify per-element handler
  const flushPending = useCallback(() => {
    const pending = pendingEntriesRef.current;
    if (!pending.size) {
      pendingFrameRef.current = null;
      return;
    }

    pendingEntriesRef.current = new Map();
    pendingFrameRef.current = null;

    const rootRect = getRootRect();
    for (const [el, entry] of pending.entries()) {
      const id = idsRef.current.get(el);
      updateFlags(entry, id, rootRect);

      const cb = handlersRef.current.get(el);
      if (cb) {
        cb(visibleIdsRef.current.has(id), entry);
      }
    }
  }, [getRootRect, updateFlags]);

  const scheduleFlush = useCallback(() => {
    if (pendingFrameRef.current != null) return;

    const run = () => {
      pendingFrameRef.current = null;
      flushPending();
    };

    if (typeof requestAnimationFrame === "function") {
      pendingFrameIsTimeoutRef.current = false;
      pendingFrameRef.current = requestAnimationFrame(run);
    } else {
      pendingFrameIsTimeoutRef.current = true;
      pendingFrameRef.current = setTimeout(run, 16);
    }
  }, [flushPending]);

  useEffect(
    () => () => {
      const handle = pendingFrameRef.current;
      if (handle == null) return;
      if (pendingFrameIsTimeoutRef.current) {
        clearTimeout(handle);
      } else if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(handle);
      }
      pendingFrameRef.current = null;
      pendingFrameIsTimeoutRef.current = false;
      pendingEntriesRef.current = new Map();
    },
    []
  );

  const evaluateTarget = useCallback(
    (el, rootRect, time) => {
      if (!el) return;

      const id = idsRef.current.get(el);
      if (id == null) return;

      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!rect) return;

      const cb = handlersRef.current.get(el);
      const resolvedRootRect = rootRect || getRootRect();
      const timestamp =
        time ??
        (typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());

      const entry = {
        target: el,
        boundingClientRect: rect,
        intersectionRect: rect,
        isIntersecting: false,
        intersectionRatio: 0,
        time: timestamp,
      };

      updateFlags(entry, id, resolvedRootRect);

      const isVisible = visibleIdsRef.current.has(id);
      entry.isIntersecting = isVisible;
      entry.intersectionRatio = isVisible ? 1 : 0;

      if (cb) {
        cb(isVisible, entry);
      }
    },
    [getRootRect, updateFlags]
  );

  const flushQueuedEvaluations = useCallback(
    (limit = MAX_PER_FRAME, rootRectOverride = null, timeOverride = null) => {
      const pending = pendingEvaluateRef.current;
      if (!pending.size) return 0;

      const rootRect = rootRectOverride || getRootRect();
      const now =
        timeOverride ??
        (typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());

      const chunk = [];
      for (const el of pending) {
        chunk.push(el);
        if (chunk.length >= limit) break;
      }

      if (!chunk.length) return 0;

      for (const el of chunk) {
        pending.delete(el);
      }

      for (const el of chunk) {
        evaluateTarget(el, rootRect, now);
      }

      return chunk.length;
    },
    [evaluateTarget, getRootRect]
  );

  const scheduleEvaluateFlush = useCallback(() => {
    if (evaluateFrameRef.current != null) return;

    const run = () => {
      evaluateFrameRef.current = null;
      flushQueuedEvaluations();
      if (pendingEvaluateRef.current.size) {
        scheduleEvaluateFlush();
      }
    };

    if (typeof requestAnimationFrame === "function") {
      evaluateFrameIsTimeoutRef.current = false;
      evaluateFrameRef.current = requestAnimationFrame(run);
    } else {
      evaluateFrameIsTimeoutRef.current = true;
      evaluateFrameRef.current = setTimeout(run, 16);
    }
  }, [flushQueuedEvaluations]);

  useEffect(
    () => () => {
      const handle = evaluateFrameRef.current;
      if (handle == null) return;
      if (evaluateFrameIsTimeoutRef.current) {
        clearTimeout(handle);
      } else if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(handle);
      }
      evaluateFrameRef.current = null;
      evaluateFrameIsTimeoutRef.current = false;
      pendingEvaluateRef.current.clear();
    },
    []
  );

  const queueEvaluate = useCallback(
    (el) => {
      if (!el) return;
      pendingEvaluateRef.current.add(el);
      scheduleEvaluateFlush();
    },
    [scheduleEvaluateFlush]
  );

  const handleEntries = useCallback((entries) => {
    if (!entries || entries.length === 0) return;
    const pending = pendingEntriesRef.current;
    for (const entry of entries) {
      if (!entry || !entry.target) continue;
      pending.set(entry.target, entry);
    }
    scheduleFlush();
  }, [scheduleFlush]);

  // Build the single observer (or rebuild if root/opts truly change)
  useEffect(() => {
    // Disconnect old
    if (observerRef.current) {
      try { observerRef.current.disconnect(); } catch {}
      observerRef.current = null;
    }

    currentRootMarginRef.current = rootMargin;

    const obs = new IntersectionObserver(handleEntries, {
      root: rootRef?.current ?? null,
      rootMargin: currentRootMarginRef.current,
      threshold,
    });
    observerRef.current = obs;

    // Re-observe all registered elements
    for (const el of handlersRef.current.keys()) {
      try { obs.observe(el); } catch {}
    }

    return () => {
      try { observerRef.current?.disconnect(); } catch {}
      observerRef.current = null;
    };
  }, [rootRef, rootMargin, threshold, handleEntries]);

  // Public API: observe supports (el, cb) and (el, id, cb)
  const observe = useCallback((el, idOrCb, maybeCb) => {
    if (!el) return;
    let id = null;
    let cb = null;

    if (typeof idOrCb === "function") {
      cb = idOrCb; // back-compat: observe(el, cb)
    } else {
      id = idOrCb;
      cb = maybeCb;
    }

    if (cb) handlersRef.current.set(el, cb);
    if (id != null) idsRef.current.set(el, id);

    if (observerRef.current) {
      try { observerRef.current.observe(el); } catch {}
    }

    // Immediately evaluate the target so visibility reflects current layout
    if (immediateBudgetRef.current > 0) {
      immediateBudgetRef.current -= 1;
      evaluateTarget(el);
    } else {
      queueEvaluate(el);
    }
  }, [evaluateTarget, queueEvaluate]);

  const unobserve = useCallback((el) => {
    if (!el) return;
    handlersRef.current.delete(el);
    const id = idsRef.current.get(el);
    if (id != null) {
      visibleIdsRef.current.delete(id);
      nearIdsRef.current.delete(id);
    }
    idsRef.current.delete(el);
    if (observerRef.current) {
      try { observerRef.current.unobserve(el); } catch {}
    }
  }, []);

  // Query helpers
  const isVisible = useCallback((id) => visibleIdsRef.current.has(id), []);
  const isNear = useCallback((id) => nearIdsRef.current.has(id), []);

  // Tuning knobs (no observer rebuild for nearPx)
  const setNearPx = useCallback((px) => {
    const v = Math.max(0, Number.isFinite(px) ? Math.floor(px) : 0);
    nearPxRef.current = v;
  }, []);
  const getNearPx = useCallback(() => nearPxRef.current, []);
  const getRootMargin = useCallback(() => currentRootMarginRef.current, []);

  const refresh = useCallback(() => {
    flushPending();
    const rootRect = getRootRect();
    const now =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();

    for (const el of handlersRef.current.keys()) {
      pendingEvaluateRef.current.add(el);
    }

    const processed = flushQueuedEvaluations(REFRESH_SYNC_CHUNK, rootRect, now);
    if (pendingEvaluateRef.current.size) {
      scheduleEvaluateFlush();
    }

    return processed;
  }, [flushPending, getRootRect, flushQueuedEvaluations, scheduleEvaluateFlush]);

  return useMemo(() => ({
    observe,
    unobserve,
    isVisible,
    isNear,
    setNearPx,
    getNearPx,
    getRootMargin,
    refresh,
  }), [
    observe,
    unobserve,
    isVisible,
    isNear,
    setNearPx,
    getNearPx,
    getRootMargin,
    refresh,
  ]);
}
