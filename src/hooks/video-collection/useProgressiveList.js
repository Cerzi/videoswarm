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
 *
 * Options.clamp?: {
 *   targetVisible: number,
 *   columns?: number,
 *   bufferRows?: number,
 *   viewportRows?: number,
 *   sentinelIndex?: number,
 * }
 *   - Limits progressive growth to a viewport-sized window unless the
 *     sentinel index (highest visible item) advances.
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

    // Viewport-aware clamp configuration
    clamp: clampOptions = null,
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
      setVisible((v) => {
        const cap = Math.min(len, effectiveCapRef.current || len);
        return v > cap ? cap : Math.min(v, len);
      });
      prevLenRef.current = len;
      return;
    }

    // If list shrank below currently visible, clamp down.
    if (len < prevLenRef.current && visible > len) {
      const cap = Math.min(len, effectiveCapRef.current || len);
      setVisible(cap);
    }
    // Do not reset visible on growth.
    prevLenRef.current = len;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe.length]);

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
  const dynamicBatchRef = useRef(batchSize);

  // Viewport clamp sanitization
  const clampTargetRaw = clampOptions?.targetVisible;
  const clampColumnsRaw = clampOptions?.columns;
  const clampBufferRowsRaw = clampOptions?.bufferRows;
  const clampViewportRowsRaw = clampOptions?.viewportRows;
  const clampSentinelRaw = clampOptions?.sentinelIndex;

  const clampTarget =
    Number.isFinite(clampTargetRaw) && clampTargetRaw > 0
      ? clampTargetRaw
      : Infinity;
  const clampColumns =
    Number.isFinite(clampColumnsRaw) && clampColumnsRaw > 0
      ? Math.max(1, Math.floor(clampColumnsRaw))
      : null;
  const clampBufferRows =
    Number.isFinite(clampBufferRowsRaw) && clampBufferRowsRaw >= 0
      ? Math.max(0, Math.floor(clampBufferRowsRaw))
      : null;
  const clampViewportRows =
    Number.isFinite(clampViewportRowsRaw) && clampViewportRowsRaw > 0
      ? Math.max(1, Math.floor(clampViewportRowsRaw))
      : null;
  const clampSentinelIndex =
    Number.isFinite(clampSentinelRaw) && clampSentinelRaw >= 0
      ? Math.floor(clampSentinelRaw)
      : -1;

  const clampBase = Number.isFinite(clampTarget)
    ? Math.max(initial, Math.floor(clampTarget))
    : Infinity;

  const sentinelRowAllowance = (() => {
    const viewport = clampViewportRows ?? 0;
    const buffer = clampBufferRows ?? 0;
    if (viewport && buffer) return viewport + buffer;
    if (viewport) return Math.max(viewport * 2, viewport + 2);
    if (buffer) return Math.max(buffer, 2);
    return 6;
  })();
  const sentinelColumns = clampColumns ?? 1;

  const sentinelAllowance =
    clampSentinelIndex >= 0
      ? clampSentinelIndex + sentinelColumns * sentinelRowAllowance
      : -1;

  const clampLimit = (() => {
    if (!Number.isFinite(clampBase) && clampSentinelIndex < 0) {
      return Infinity;
    }
    const candidate = Math.max(
      Number.isFinite(clampBase) ? clampBase : -Infinity,
      sentinelAllowance
    );
    if (!Number.isFinite(candidate)) return Infinity;
    return Math.max(initial, Math.floor(candidate));
  })();

  const effectiveCapRef = useRef(Infinity);

  // Short-circuit when we've reached the effective clamp limit
  const effectiveCap = Math.min(safe.length, clampLimit);
  const atEffectiveCap = visible >= effectiveCap;

  useEffect(() => {
    effectiveCapRef.current = effectiveCap;
  }, [effectiveCap]);

  useEffect(() => {
    setVisible((prev) => (prev > effectiveCap ? effectiveCap : prev));
  }, [effectiveCap]);

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

  // Idle growth scheduler (preferred in real browsers)
  useEffect(() => {
    if (atEffectiveCap || shouldUseInterval) return;

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
        if (!atEffectiveCap) {
          const add = computeNextBatch();
          setVisible((v) => {
            const cap = effectiveCapRef.current;
            const limit = Math.min(safe.length, Number.isFinite(cap) ? cap : safe.length);
            if (v >= limit) return v;
            const next = Math.min(v + add, limit);
            return next === v ? v : next;
          });
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
    atEffectiveCap,
    pauseOnScroll,
    shouldUseInterval,
    // note: do not depend on visible/safe.length here; the setVisible closure handles it
  ]);

  // Interval fallback (tests/SSR) — deterministic growth using fixed batchSize
  // (kept fixed for backward-compat with existing tests)
  useEffect(() => {
    if (!shouldUseInterval) return;
    if (atEffectiveCap) return;

    const timer = setInterval(() => {
      setVisible((v) => {
        const cap = effectiveCapRef.current;
        const limit = Math.min(safe.length, Number.isFinite(cap) ? cap : safe.length);
        if (v >= limit) return v;
        const next = Math.min(v + batchSize, limit);
        return next === v ? v : next;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [shouldUseInterval, atEffectiveCap, safe.length, batchSize, intervalMs]);

  return safe.slice(0, visible);
}
