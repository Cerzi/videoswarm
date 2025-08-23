// hooks/video-collection/useProgressiveList.js
import { useEffect, useRef, useState } from "react";

/**
 * Frame-budget aware progressive list.
 *
 * Back-compat signature:
 *   useProgressiveList(items, initial=100, batchSize=50, intervalMs=100, options?)
 *
 * Default behavior in real browsers:
 *   - Uses requestIdleCallback (fallback rAF) to grow only when the main thread is idle.
 *   - Pauses growth while the user is actively scrolling.
 *   - Adapts batch size up/down based on recent long tasks.
 *
 * Test/SSR environments (no rIC): falls back to setInterval using `intervalMs`,
 * so existing tests that use fake timers still pass.
 */
export function useProgressiveList(
  items = [],
  initial = 100,
  batchSize = 50,
  intervalMs = 100,
  options = {}
) {
  const {
    // Optional scroll root to detect active scrolling; defaults to window.
    scrollRef = null,
    pauseOnScroll = true,
    longTaskAdaptation = true,
    minBatch = Math.max(8, Math.floor(batchSize / 2)),
    maxBatch = Math.max(batchSize, batchSize * 3),
    scrollIdleMs = 120,
    // Force simple interval mode (useful for tests)
    forceInterval = false,
  } = options;

  const safe = Array.isArray(items) ? items : [];
  const [visible, setVisible] = useState(() => Math.min(initial, safe.length));
  const prevLenRef = useRef(safe.length);
  const didInitRef = useRef(false);

  // ---- Clamp logic: initialize once; clamp on shrink; don't reset on growth ----
  useEffect(() => {
    const len = safe.length;
    if (!didInitRef.current) {
      didInitRef.current = true;
      setVisible((v) => Math.min(v, len));
      prevLenRef.current = len;
      return;
    }

    // If list shrank below currently visible, clamp down.
    if (len < prevLenRef.current && visible > len) {
      setVisible(len);
    }
    // Do not reset visible on growth.
    prevLenRef.current = len;
  }, [safe.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Short-circuit when fully visible
  const allVisible = visible >= safe.length;

  // ---------------------- Scheduling strategies ----------------------

  // Fallback: deterministic interval (for tests / SSR)
  const shouldUseInterval =
    forceInterval ||
    typeof window === "undefined" ||
    typeof window.requestIdleCallback !== "function";

  // State/refs used by idle strategy
  const isScrollingRef = useRef(false);
  const scrollingTimeoutRef = useRef(null);
  const hadLongTaskRecentlyRef = useRef(false);
  const longTaskTimeoutRef = useRef(null);
  const dynamicBatchRef = useRef(batchSize);

  // Attach scroll listener (pause while user is scrolling)
  useEffect(() => {
    if (!pauseOnScroll) return;
    const target =
      scrollRef?.current ??
      (typeof window !== "undefined" ? window : null);
    if (!target || shouldUseInterval) return;

    const onScroll = () => {
      isScrollingRef.current = true;
      if (scrollingTimeoutRef.current) clearTimeout(scrollingTimeoutRef.current);
      scrollingTimeoutRef.current = setTimeout(() => {
        isScrollingRef.current = false;
      }, scrollIdleMs);
    };

    target.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      target.removeEventListener("scroll", onScroll);
      if (scrollingTimeoutRef.current) clearTimeout(scrollingTimeoutRef.current);
    };
  }, [scrollRef, pauseOnScroll, scrollIdleMs, shouldUseInterval]);

  // Watch for long tasks and adapt the batch size window
  useEffect(() => {
    if (!longTaskAdaptation || shouldUseInterval) return;
    if (typeof window === "undefined" || typeof PerformanceObserver !== "function") return;

    let observer;
    try {
      // 'longtask' is part of Long Tasks API; not always available.
      observer = new PerformanceObserver((list) => {
        // Any entry implies we had a recent jank; lower batch for a short window.
        if (list.getEntries && list.getEntries().length) {
          hadLongTaskRecentlyRef.current = true;
          if (longTaskTimeoutRef.current) clearTimeout(longTaskTimeoutRef.current);
          longTaskTimeoutRef.current = setTimeout(() => {
            hadLongTaskRecentlyRef.current = false;
          }, 800); // decay window
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Silently ignore if unsupported
    }

    return () => {
      if (observer) {
        try { observer.disconnect(); } catch {}
      }
      if (longTaskTimeoutRef.current) clearTimeout(longTaskTimeoutRef.current);
    };
  }, [longTaskAdaptation, shouldUseInterval]);

  // Choose next batch size based on conditions
  const computeNextBatch = () => {
    let b = dynamicBatchRef.current;

    // If we've been seeing long tasks or actively scrolling, bias small
    if (hadLongTaskRecentlyRef.current || isScrollingRef.current) {
      b = Math.max(minBatch, Math.floor(b / 2));
    } else {
      // If things have been calm, grow toward maxBatch
      b = Math.min(maxBatch, b + Math.max(2, Math.floor(batchSize / 4)));
    }

    // Keep within bounds and store
    b = Math.max(minBatch, Math.min(maxBatch, b));
    dynamicBatchRef.current = b;
    return b;
  };

  // Idle growth scheduler
  useEffect(() => {
    if (allVisible || shouldUseInterval) return;

    let cancelled = false;

    const schedule = () => {
      if (cancelled) return;
      // Skip while user actively scrolling to prioritize smoothness
      if (pauseOnScroll && isScrollingRef.current) {
        // Try again soon (throttle)
        rafId = requestAnimationFrame(schedule);
        return;
      }

      const idleCb = () => {
        if (cancelled) return;
        if (!allVisible) {
          const add = computeNextBatch();
          setVisible((v) => (v < safe.length ? Math.min(v + add, safe.length) : v));
        }
        // Chain next idle tick
        rafId = requestAnimationFrame(schedule);
      };

      // Prefer rIC; fallback to rAF for scheduling cadence, but still call idleCb synchronously.
      if (typeof window.requestIdleCallback === "function") {
        ricId = window.requestIdleCallback(idleCb, { timeout: 250 });
      } else {
        idleCb();
      }
    };

    let rafId = 0;
    let ricId = 0;
    rafId = requestAnimationFrame(schedule);

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (ricId && typeof window.cancelIdleCallback === "function") {
        try { window.cancelIdleCallback(ricId); } catch {}
      }
    };
  }, [
    allVisible,
    pauseOnScroll,
    shouldUseInterval,
    // do not depend on visible/safe.length here; the setVisible closure handles it
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Interval fallback (tests/SSR)
  useEffect(() => {
    if (!shouldUseInterval) return;
    if (allVisible) return;

    const timer = setInterval(() => {
      setVisible((v) =>
        v < safe.length ? Math.min(v + batchSize, safe.length) : v
      );
    }, intervalMs);

    return () => clearInterval(timer);
  }, [shouldUseInterval, allVisible, safe.length, batchSize, intervalMs]);

  return safe.slice(0, visible);
}
