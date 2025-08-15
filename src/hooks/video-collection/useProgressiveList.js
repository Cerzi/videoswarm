import { useEffect, useRef, useState } from "react";

/**
 * Progressively reveals items in small chunks, yielding to the browser
 * between bumps. Keeps a ref to avoid stale closures.
 */
export function useProgressiveList(
  items = [],
  initial = 80,
  maxPerBatch = 60,
  idleMinMs = 10,
  fallbackDelay = 32
) {
  const safeItems = Array.isArray(items) ? items : [];
  
  const [visibleCount, setVisibleCount] = useState(Math.min(initial, safeItems.length));
  const visibleRef = useRef(visibleCount);
  const rcId = useRef(0);

  // keep ref in sync
  useEffect(() => {
    visibleRef.current = visibleCount;
  }, [visibleCount]);

  // reset when dataset size changes
  useEffect(() => {
    const next = Math.min(Math.max(initial, visibleRef.current), safeItems.length);
    console.log(`🔄 Dataset changed: setting visible to ${next}`);
    visibleRef.current = next;
    setVisibleCount(next);
  }, [safeItems.length, initial]);

  // MAIN FIX: Use visibleCount instead of visibleRef.current in the condition
  useEffect(() => {
    console.log(`🎯 Progressive effect: ${visibleCount} >= ${safeItems.length}? ${visibleCount >= safeItems.length}`);
    
    // Use visibleCount (state) instead of visibleRef.current
    if (visibleCount >= safeItems.length) {
      console.log(`🏁 All items already visible, skipping progressive loading`);
      return;
    }

    console.log(`🚀 Starting progressive loading from ${visibleCount} to ${safeItems.length}`);
    
    let cancelled = false;
    const myId = ++rcId.current;

    const schedule = () => {
      if (cancelled || rcId.current !== myId) return;

      const run = (deadline) => {
        if (cancelled || rcId.current !== myId) return;

        const bump = (step) => {
          const currentVisible = visibleRef.current;
          const next = Math.min(currentVisible + step, safeItems.length);
          console.log(`📈 Bump: ${currentVisible} + ${step} = ${next}`);
          
          if (next !== currentVisible) {
            visibleRef.current = next;
            setVisibleCount(next);
            console.log(`✅ Updated visible count to ${next}`);
          }
          return next;
        };

        if (deadline && typeof deadline.timeRemaining === "function") {
          let remaining = maxPerBatch;
          while (deadline.timeRemaining() > idleMinMs && remaining > 0) {
            const step = Math.min(20, remaining);
            const next = bump(step);
            remaining -= step;
            if (next >= safeItems.length) break;
          }
        } else {
          bump(Math.min(24, maxPerBatch));
        }

        // Check current state, not ref
        if (!cancelled && visibleRef.current < safeItems.length) {
          console.log(`🔄 Scheduling next batch`);
          setTimeout(schedule, fallbackDelay);
        } else {
          console.log(`🏁 Progressive loading complete`);
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
  }, [visibleCount, safeItems.length, maxPerBatch, idleMinMs, fallbackDelay]); // Added visibleCount to deps

  return safeItems.slice(0, visibleCount);
}