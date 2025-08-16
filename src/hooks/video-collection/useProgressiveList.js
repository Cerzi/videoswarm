import { useEffect, useState } from "react";

/**
 * Simple progressive loading with reliable timers
 * Industry standard approach - no fancy idle detection
 */
export function useProgressiveList(
  items = [],
  initial = 100,
  batchSize = 50,
  intervalMs = 100 // Load a batch every 100ms
) {
  const safeItems = Array.isArray(items) ? items : [];
  const [visibleCount, setVisibleCount] = useState(Math.min(initial, safeItems.length));

  // Reset when items change
  useEffect(() => {
    const initialCount = Math.min(initial, safeItems.length);
    setVisibleCount(initialCount);
  }, [safeItems.length, initial]);

  // Simple interval-based progressive loading
  useEffect(() => {
    if (visibleCount >= safeItems.length) return;

    const timer = setInterval(() => {
      setVisibleCount(prev => {
        const next = Math.min(prev + batchSize, safeItems.length);
        if (next > prev) {
          console.log(`📈 Progressive: ${prev} → ${next}/${safeItems.length}`);
        }
        if (next >= safeItems.length) {
          console.log(`✅ Progressive loading complete: ${next} items`);
        }
        return next;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [visibleCount, safeItems.length, batchSize, intervalMs]);

  return safeItems.slice(0, visibleCount);
}