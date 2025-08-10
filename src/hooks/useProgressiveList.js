import { useState, useEffect } from 'react';

/**
 * Incrementally reveals items in a list to avoid mounting everything at once.
 * @param {Array} items - The full list of items to render.
 * @param {number} batchSize - Number of items to add per step.
 * @param {number} delay - Delay between batches (ms).
 */
export function useProgressiveList(items, batchSize = 100, delay = 16) {
  const [visibleCount, setVisibleCount] = useState(batchSize);

  useEffect(() => {
    if (visibleCount >= items.length) return;

    let cancelled = false;

    function loadMore() {
      if (cancelled) return;

      setVisibleCount(c => {
        const nextCount = Math.min(c + batchSize, items.length);
        return nextCount;
      });

      if (visibleCount + batchSize < items.length) {
        if ('requestIdleCallback' in window) {
          requestIdleCallback(loadMore);
        } else {
          setTimeout(loadMore, delay);
        }
      }
    }

    if ('requestIdleCallback' in window) {
      requestIdleCallback(loadMore);
    } else {
      setTimeout(loadMore, delay);
    }

    return () => { cancelled = true; };
  }, [items.length, batchSize, delay, visibleCount]);

  return items.slice(0, visibleCount);
}
