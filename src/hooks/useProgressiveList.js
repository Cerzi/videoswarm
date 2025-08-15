import { useEffect, useRef, useState } from "react";

/**
 * Progressively reveals items in small chunks, yielding to the browser
 * between bumps. Keeps a ref to avoid stale closures.
 */
export function useProgressiveList(
  items,
  initial = 80,
  maxPerBatch = 60,
  idleMinMs = 10,
  fallbackDelay = 32
) {
  const [visibleCount, setVisibleCount] = useState(Math.min(initial, items.length));
  const visibleRef = useRef(visibleCount);
  const rcId = useRef(0);

  // keep ref in sync
  useEffect(() => {
    visibleRef.current = visibleCount;
  }, [visibleCount]);

  // reset when dataset size changes
  useEffect(() => {
    const next = Math.min(Math.max(initial, visibleRef.current), items.length);
    visibleRef.current = next;
    setVisibleCount(next);
  }, [items.length, initial]);

  useEffect(() => {
    if (visibleRef.current >= items.length) return;

    let cancelled = false;
    const myId = ++rcId.current;

    const schedule = () => {
      if (cancelled || rcId.current !== myId) return;

      const run = (deadline) => {
        if (cancelled || rcId.current !== myId) return;

        let remaining = maxPerBatch;

        const bump = (step) => {
          const next = Math.min(visibleRef.current + step, items.length);
          if (next !== visibleRef.current) {
            visibleRef.current = next;
            setVisibleCount(next);
          }
          return next;
        };

        if (deadline && typeof deadline.timeRemaining === "function") {
          // micro-chunk while there’s idle time
          while (deadline.timeRemaining() > idleMinMs && remaining > 0) {
            const step = Math.min(20, remaining);
            const next = bump(step);
            remaining -= step;
            if (next >= items.length) break;
          }
        } else {
          bump(Math.min(24, maxPerBatch));
        }

        if (!cancelled && visibleRef.current < items.length) {
          setTimeout(schedule, fallbackDelay);
        }
      };

      if ("requestIdleCallback" in window) {
        requestIdleCallback(run, { timeout: 250 });
      } else {
        setTimeout(() => run(), fallbackDelay);
      }
    };

    schedule();
    return () => {
      cancelled = true;
    };
  }, [items.length, maxPerBatch, idleMinMs, fallbackDelay]);

  return items.slice(0, visibleCount);
}
