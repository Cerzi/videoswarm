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
 * so existing tests that use fake timers still pass (deterministic).
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

    // Enable adaptive batch sizing based on recent long tasks.
    longTaskAdaptation = true,

    // NEW: external/global signal from higher layers (composite hook)
    // indicating "we saw a recent long task somewhere" → throttle here too.
    hadLongTaskRecently = false,

    // Adaptive batch size window
    minBatch = Math.max(8, Math.floor(batchSize / 2)),
    maxBatch = Math.max(batchSize, batchSize * 3),

    // Scroll inactivity threshold
    scrollIdleMs = 120,

    // Force interval mode (useful for tests/SSR)
    forceInterval = false,

    // Cap the number of rendered (mounted) items regardless of total length
    maxRendered = Infinity,
  } = options;

  const safe = Array.isArray(items) ? items : [];
  const normalizedMaxRendered = Number.isFinite(maxRendered)
    ? Math.max(0, Math.floor(maxRendered))
    : Number.POSITIVE_INFINITY;
  const targetCount = Math.min(safe.length, normalizedMaxRendered);
  const safeInitial = Number.isFinite(initial)
    ? Math.max(0, Math.floor(initial))
    : 0;
  const baseBatchSize = Number.isFinite(batchSize)
    ? Math.max(1, Math.floor(batchSize))
    : 1;
  const [visible, setVisible] = useState(() =>
    Math.min(safeInitial, targetCount)
  );
  const prevLenRef = useRef(safe.length);
  const prevTargetRef = useRef(targetCount);
  const didInitRef = useRef(false);

  // ---- Clamp logic: initialize once; clamp on shrink; don't reset on growth ----
  useEffect(() => {
    const len = safe.length;
    const normalized = Number.isFinite(maxRendered)
      ? Math.max(0, Math.floor(maxRendered))
      : Number.POSITIVE_INFINITY;
    const nextTarget = Math.min(len, normalized);
    const prevTarget = prevTargetRef.current;
    const prevLen = prevLenRef.current;

    setVisible((current) => {
      let next = current;

      if (!didInitRef.current) {
        didInitRef.current = true;
        next = Math.min(current, nextTarget);
      } else {
        if (len < prevLen && next > len) {
          next = Math.min(next, len);
        }
        if (nextTarget < prevTarget && next > nextTarget) {
          next = Math.min(next, nextTarget);
        }
        if (nextTarget > prevTarget && next < nextTarget) {
          const delta = Math.max(
            1,
            Math.min(baseBatchSize, nextTarget - next)
          );
          next = Math.min(nextTarget, next + delta);
        }
      }

      prevLenRef.current = len;
      prevTargetRef.current = nextTarget;

      return next === current ? current : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe.length, maxRendered, baseBatchSize]);

  // Short-circuit when fully visible
  const allVisible = visible >= targetCount;

  // ---------------------- Scheduling strategies ----------------------

  // Fallback: deterministic interval (for tests / SSR)
  const shouldUseInterval =
    forceInterval ||
    typeof window === "undefined" ||
    typeof window.requestIdleCallback !== "function";

  // State/refs used by idle strategy
  const isScrollingRef = useRef(false);
  const scrollingTimeoutRef = useRef(null);

  // Unified “recent long task” flag (internal OR external)
  const hadLongTaskRecentlyRef = useRef(false);
  const longTaskTimeoutRef = useRef(null);

  // Adaptive batch (only used by idle path)
  const resolvedMinBatch = Number.isFinite(minBatch)
    ? Math.max(1, Math.floor(minBatch))
    : Math.max(1, Math.floor(baseBatchSize / 2));
  const resolvedMaxBatch = Number.isFinite(maxBatch)
    ? Math.max(resolvedMinBatch, Math.floor(maxBatch))
    : Math.max(resolvedMinBatch, baseBatchSize * 3);

  const dynamicBatchRef = useRef(
    Math.min(resolvedMaxBatch, Math.max(resolvedMinBatch, baseBatchSize))
  );

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
        scrollingTimeoutRef.current = null;
      }, scrollIdleMs);
    };

    target.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      target.removeEventListener("scroll", onScroll);
      if (scrollingTimeoutRef.current) clearTimeout(scrollingTimeoutRef.current);
    };
  }, [scrollRef, pauseOnScroll, scrollIdleMs, shouldUseInterval]);

  // EXTERNAL recent-long-task signal → coalesce into the same ref with a short decay
  useEffect(() => {
    if (!longTaskAdaptation) return;
    if (!hadLongTaskRecently) return;

    hadLongTaskRecentlyRef.current = true;
    if (longTaskTimeoutRef.current) clearTimeout(longTaskTimeoutRef.current);
    longTaskTimeoutRef.current = setTimeout(() => {
      hadLongTaskRecentlyRef.current = false;
    }, 800); // same decay window as the internal observer
  }, [hadLongTaskRecently, longTaskAdaptation]);

  // INTERNAL Long Tasks API observer (where available)
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

  // Choose next batch size based on conditions (idle path only)
  const computeNextBatch = () => {
    let b = dynamicBatchRef.current;

    // If we've been seeing long tasks or actively scrolling, bias small
    if (hadLongTaskRecentlyRef.current || isScrollingRef.current) {
      b = Math.max(resolvedMinBatch, Math.floor(b / 2));
    } else {
      // If things have been calm, grow toward maxBatch
      b = Math.min(
        resolvedMaxBatch,
        b + Math.max(2, Math.floor(baseBatchSize / 4))
      );
    }

    // Keep within bounds and store
    b = Math.max(resolvedMinBatch, Math.min(resolvedMaxBatch, b));
    dynamicBatchRef.current = b;
    return b;
  };

  // Idle growth scheduler (preferred in real browsers)
  useEffect(() => {
    if (allVisible || shouldUseInterval) return;

    let cancelled = false;

    const schedule = () => {
      if (cancelled) return;

      // Skip while user actively scrolling to prioritize smoothness
      if (pauseOnScroll && isScrollingRef.current) {
        rafId = requestAnimationFrame(schedule);
        return;
      }

      const idleCb = () => {
        if (cancelled) return;
        if (!allVisible) {
          const add = computeNextBatch();
          setVisible((v) =>
            v < targetCount ? Math.min(v + add, targetCount) : v
          );
        }
        // Chain next idle tick
        rafId = requestAnimationFrame(schedule);
      };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allVisible,
    pauseOnScroll,
    shouldUseInterval,
    // note: do not depend on visible/safe.length here; the setVisible closure handles it
  ]);

  // Interval fallback (tests/SSR) — deterministic growth using fixed batchSize
  // (kept fixed for backward-compat with existing tests)
  useEffect(() => {
    if (!shouldUseInterval) return;
    if (allVisible) return;

    const timer = setInterval(() => {
      setVisible((v) =>
        v < targetCount ? Math.min(v + batchSize, targetCount) : v
      );
    }, intervalMs);

    return () => clearInterval(timer);
  }, [
    shouldUseInterval,
    allVisible,
    targetCount,
    batchSize,
    intervalMs,
  ]);

  return safe.slice(0, visible);
}
