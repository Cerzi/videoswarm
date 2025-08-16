// hooks/video-collection/useVideoResourceManager.js
import { useCallback, useMemo, useRef } from "react";

/**
 * Manages browser resource limits for video elements
 * Prevents browser overload while prioritizing visible content
 */
export default function useVideoResourceManager({
  progressiveVideos,
  visibleVideos,
  loadedVideos,
  loadingVideos,
  playingVideos,
}) {
  const lastCleanupTimeRef = useRef(0);

  // Smart limits based on what's actually rendered
  const limits = useMemo(() => {
    const n = progressiveVideos.length;
    if (n < 100) return { maxLoaded: 40, maxConcurrentLoading: 4 };
    if (n < 300) return { maxLoaded: 80, maxConcurrentLoading: 3 };
    if (n < 600) return { maxLoaded: 120, maxConcurrentLoading: 2 };
    return { maxLoaded: 350, maxConcurrentLoading: 1 };
  }, [progressiveVideos.length]);

  // Decide if a specific video can load
  const canLoadVideo = useCallback((videoId) => {
    // Must be in progressive list
    const inProgressiveList = progressiveVideos.some(v => v.id === videoId);
    if (!inProgressiveList) return false;
    
    // Always allow visible videos (highest priority)
    if (visibleVideos.has(videoId)) return true;
    
    // For non-visible, respect resource limits
    return (
      loadingVideos.size < limits.maxConcurrentLoading &&
      loadedVideos.size < limits.maxLoaded
    );
  }, [progressiveVideos, visibleVideos, loadingVideos, loadedVideos, limits]);

  // Gentle cleanup of excess loaded videos
  const performCleanup = useCallback(() => {
    const now = Date.now();
    if (now - lastCleanupTimeRef.current < 10000) return null; // Every 10 seconds max
    lastCleanupTimeRef.current = now;
    
    // Only cleanup if way over limit (50% buffer)
    const bufferLimit = Math.floor(limits.maxLoaded * 1.5);
    if (loadedVideos.size <= bufferLimit) return null;

    return (prevLoadedVideos) => {
      const toKeep = new Set();
      
      // Keep ALL visible and playing videos (never remove)
      prevLoadedVideos.forEach((id) => {
        if (visibleVideos.has(id) || playingVideos.has(id)) {
          toKeep.add(id);
        }
      });
      
      // If still over limit, trim non-essential videos
      if (toKeep.size > limits.maxLoaded) {
        const nonEssential = Array.from(prevLoadedVideos).filter(id => 
          !visibleVideos.has(id) && !playingVideos.has(id)
        );
        
        const excess = toKeep.size - limits.maxLoaded;
        for (let i = 0; i < Math.min(excess, nonEssential.length); i++) {
          toKeep.delete(nonEssential[i]);
        }
      }
      
      return toKeep;
    };
  }, [loadedVideos.size, visibleVideos, playingVideos, limits]);

  return {
    canLoadVideo,
    performCleanup,
    limits, // Expose for debugging
  };
}