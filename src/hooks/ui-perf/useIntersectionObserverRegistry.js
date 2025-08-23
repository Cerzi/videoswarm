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

  const currentRootMarginRef = useRef(rootMargin);
  const nearPxRef = useRef(nearPx);

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
  const handleEntries = useCallback((entries) => {
    const rootRect = getRootRect();
    for (const entry of entries) {
      const el = entry.target;
      const id = idsRef.current.get(el);
      updateFlags(entry, id, rootRect);

      const cb = handlersRef.current.get(el);
      if (cb) {
        // We pass "visible" (true viewport) for clarity
        cb(visibleIdsRef.current.has(id), entry);
      }
    }
  }, [getRootRect, updateFlags]);

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
  }, []);

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
    const v = Math.max(0, (px | 0));
    nearPxRef.current = v;
  }, []);
  const getNearPx = useCallback(() => nearPxRef.current, []);
  const getRootMargin = useCallback(() => currentRootMarginRef.current, []);

  return useMemo(() => ({
    observe,
    unobserve,
    isVisible,
    isNear,
    setNearPx,
    getNearPx,
    getRootMargin,
  }), [observe, unobserve, isVisible, isNear, setNearPx, getNearPx, getRootMargin]);
}
