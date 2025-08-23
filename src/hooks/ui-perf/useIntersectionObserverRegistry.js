// src/hooks/useIntersectionObserverRegistry.js
import { useEffect, useMemo, useRef, useCallback } from "react";

/**
 * Shared IntersectionObserver registry.
 * - Owns ONE observer.
 * - Any component can register an element + callback.
 * - Rebuilds observer if root or options change.
 */
export default function useIntersectionObserverRegistry(
  rootRef,
  {
    rootMargin = "200px 0px",
    threshold = [0, 0.15],
  } = {}
) {
  const handlersRef = useRef(new Map()); // Element -> (visible:boolean, entry:IntersectionObserverEntry)=>void
  const observerRef = useRef(null);

  // stable callback used by the observer
  const handleEntries = useCallback((entries) => {
    for (const entry of entries) {
      const cb = handlersRef.current.get(entry.target);
      if (cb) cb(entry.isIntersecting, entry);
    }
  }, []);

  // (Re)create observer when root/opts change
  useEffect(() => {
    // Disconnect old
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    const rootEl = rootRef?.current ?? null;
    const obs = new IntersectionObserver(handleEntries, {
      root: rootEl,
      rootMargin,
      threshold,
    });
    observerRef.current = obs;

    // Re-observe all previously registered elements with the new observer
    for (const el of handlersRef.current.keys()) {
      try { obs.observe(el); } catch { /* ignore */ }
    }

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, [rootRef, rootMargin, threshold, handleEntries]);

  // Public API
  const observe = useCallback((el, cb) => {
    if (!el) return;
    handlersRef.current.set(el, cb);
    if (observerRef.current) {
      try { observerRef.current.observe(el); } catch { /* ignore */ }
    }
  }, []);

  const unobserve = useCallback((el) => {
    if (!el) return;
    handlersRef.current.delete(el);
    if (observerRef.current) {
      try { observerRef.current.unobserve(el); } catch { /* ignore */ }
    }
  }, []);

  return useMemo(() => ({ observe, unobserve }), [observe, unobserve]);
}
