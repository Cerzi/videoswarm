import { useEffect, useState, useCallback } from "react";

/**
 * Progressively reveals items based on scroll position and user activity
 * Much more responsive than idle-time based loading
 */
export function useProgressiveList(
  items = [],
  initial = 100,
  batchSize = 50,
  scrollBuffer = 20 // Load this many extra items ahead of scroll
) {
  const safeItems = Array.isArray(items) ? items : [];
  const [visibleCount, setVisibleCount] = useState(Math.min(initial, safeItems.length));

  // Reset when items change
  useEffect(() => {
    const initialCount = Math.min(initial, safeItems.length);
    setVisibleCount(initialCount);
  }, [safeItems.length, initial]);

  // Dynamic loading based on scroll and user activity
  const loadMore = useCallback(() => {
    setVisibleCount(prev => {
      const next = Math.min(prev + batchSize, safeItems.length);
      if (next > prev) {
        console.log(`📈 Dynamic load: ${prev} → ${next}`);
      }
      return next;
    });
  }, [batchSize, safeItems.length]);

  // Auto-load more as user scrolls or interacts
  useEffect(() => {
    if (visibleCount >= safeItems.length) return;

    let timeoutId;
    let isUserActive = false;

    const scheduleLoad = (delay = 100) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(loadMore, delay);
    };

    const onScroll = () => {
      isUserActive = true;
      const scrollPercentage = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight);
      
      // If user scrolled past 70% of current content, load more immediately
      if (scrollPercentage > 0.7) {
        clearTimeout(timeoutId);
        loadMore();
      } else if (scrollPercentage > 0.5) {
        // If scrolled past 50%, load more soon
        scheduleLoad(50);
      }
    };

    const onUserActivity = () => {
      isUserActive = true;
      scheduleLoad(200); // Load more when user is active
    };

    // Auto-load even without user activity (but slower)
    const autoLoadInterval = setInterval(() => {
      if (!isUserActive) {
        loadMore();
      }
      isUserActive = false; // Reset activity flag
    }, 2000); // Auto-load every 2 seconds if user isn't active

    // Initial fast load
    scheduleLoad(100);

    // Event listeners
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('mousemove', onUserActivity, { passive: true });
    window.addEventListener('keydown', onUserActivity, { passive: true });

    return () => {
      clearTimeout(timeoutId);
      clearInterval(autoLoadInterval);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('mousemove', onUserActivity);
      window.removeEventListener('keydown', onUserActivity);
    };
  }, [visibleCount, safeItems.length, loadMore]);

  return safeItems.slice(0, visibleCount);
}