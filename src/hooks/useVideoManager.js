import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * useVideoManager - Single source of truth for all video state
 * 
 * This hook is the ONLY authority on:
 * - Which videos should be playing
 * - Which videos should be loaded
 * - Which videos are visible
 * - Performance limits and cleanup
 * 
 * VideoCard components are pure and only receive commands from this hook.
 */
export const useVideoManager = (videos, autoplayEnabled, maxConcurrentPlaying) => {
  // Core state - this hook is the single source of truth
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());
  const [playingVideos, setPlayingVideos] = useState(new Set());
  
  // Performance management
  const lastCleanupRef = useRef(0);
  const cleanupTimeoutRef = useRef(null);
  
  // Performance limits based on collection size
  const performanceLimits = {
    maxLoaded: videos.length < 100 ? 60 : videos.length < 500 ? 80 : videos.length < 1000 ? 100 : 120,
    maxConcurrentLoading: videos.length < 100 ? 4 : videos.length < 500 ? 3 : videos.length < 1000 ? 2 : 1
  };
  
  // AUTHORITY: Decide which videos should be playing
  useEffect(() => {
    if (!autoplayEnabled) {
      setPlayingVideos(new Set());
      return;
    }

    // Get videos that are both visible AND loaded (can actually play)
    const playableVideos = Array.from(visibleVideos).filter(videoId => 
      loadedVideos.has(videoId)
    );

    // Determine which should be playing (up to the limit)
    const shouldBePlaying = new Set(playableVideos.slice(0, maxConcurrentPlaying));

    // Only update if there's actually a change - compare stringified to avoid reference issues
    setPlayingVideos(prev => {
      const currentPlaying = Array.from(prev).sort().join(',');
      const newPlaying = Array.from(shouldBePlaying).sort().join(',');
      
      if (currentPlaying !== newPlaying) {
        console.log(`🎮 VideoManager: Updating playing videos ${prev.size} -> ${shouldBePlaying.size}`);
        return shouldBePlaying;
      }
      
      return prev; // No change, return same reference
    });
  }, [autoplayEnabled, visibleVideos, loadedVideos, maxConcurrentPlaying]); // REMOVED playingVideos from dependencies

  // AUTHORITY: Cleanup management
  const performCleanup = useCallback(() => {
    const now = Date.now();
    if (now - lastCleanupRef.current < 3000) return; // Throttle
    lastCleanupRef.current = now;
    
    if (loadedVideos.size <= performanceLimits.maxLoaded) return;
    
    console.log(`🧹 VideoManager: Cleanup ${loadedVideos.size}/${performanceLimits.maxLoaded} loaded`);
    
    setLoadedVideos(prev => {
      const toKeep = new Set();
      let keepCount = 0;
      
      // Priority 1: Keep visible videos
      prev.forEach(videoId => {
        if (visibleVideos.has(videoId) && keepCount < performanceLimits.maxLoaded) {
          toKeep.add(videoId);
          keepCount++;
        }
      });
      
      // Priority 2: Keep playing videos
      prev.forEach(videoId => {
        if (playingVideos.has(videoId) && !toKeep.has(videoId) && keepCount < performanceLimits.maxLoaded) {
          toKeep.add(videoId);
          keepCount++;
        }
      });
      
      // Priority 3: Keep some additional recent videos
      const remaining = Array.from(prev).filter(id => !toKeep.has(id));
      remaining.slice(0, performanceLimits.maxLoaded - keepCount).forEach(id => toKeep.add(id));
      
      if (toKeep.size < prev.size) {
        console.log(`🧹 VideoManager: Cleaned up ${prev.size - toKeep.size} videos`);
      }
      
      return toKeep;
    });
    
    // Also clean loading state
    setLoadingVideos(prev => {
      const newSet = new Set();
      prev.forEach(videoId => {
        if (loadedVideos.has(videoId)) {
          newSet.add(videoId);
        }
      });
      return newSet;
    });
  }, [loadedVideos.size, visibleVideos, playingVideos, performanceLimits]);

  // Schedule cleanup
  useEffect(() => {
    if (cleanupTimeoutRef.current) {
      clearTimeout(cleanupTimeoutRef.current);
    }
    
    cleanupTimeoutRef.current = setTimeout(() => {
      if (loadedVideos.size > performanceLimits.maxLoaded || 
          loadingVideos.size > performanceLimits.maxConcurrentLoading) {
        performCleanup();
      }
    }, 1000);
    
    return () => {
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
      }
    };
  }, [loadedVideos.size, loadingVideos.size, performanceLimits, performCleanup]);

  // NEW: Reset loading attempts for layout switches
  const resetLoadingAttempts = useCallback(() => {
    console.log('🔄 VideoManager: Resetting loading attempts for layout switch');
    
    // Dispatch custom event to tell VideoCards to reset their loading flags
    window.dispatchEvent(new CustomEvent('resetVideoLoading'));
    
    // Also clear our loading state
    setLoadingVideos(new Set());
  }, []);

  // FIXED: Layout switching cleanup - state-only, no DOM manipulation
  const prepareForLayoutSwitch = useCallback(() => {
    console.log('🔄 VideoManager: Preparing for layout switch');
    
    // 1. Stop all playback immediately
    setPlayingVideos(new Set());
    
    // 2. STATE-ONLY cleanup - let React handle DOM
    console.log(`🧹 VideoManager: Pre-layout cleanup - keeping ${visibleVideos.size} visible videos`);
    
    // Keep only currently visible videos loaded
    setLoadedVideos(prev => {
      const keepLoaded = new Set();
      prev.forEach(videoId => {
        if (visibleVideos.has(videoId)) {
          keepLoaded.add(videoId);
        }
      });
      
      const unloadCount = prev.size - keepLoaded.size;
      if (unloadCount > 0) {
        console.log(`🧹 VideoManager: State cleanup - unloading ${unloadCount} non-visible videos`);
      }
      
      return keepLoaded;
    });
    
    // Clear loading state to allow fresh loads
    setLoadingVideos(new Set());
    
    // 3. Reset VideoCard loading attempts
    resetLoadingAttempts();
    
    // 4. DON'T clear visibility - preserve it so videos can resume playing
    // The intersection observers will re-report visibility naturally
    
    // 5. Force GC if we cleaned up a lot (but no DOM manipulation)
    if (loadedVideos.size > visibleVideos.size + 10) {
      setTimeout(() => {
        if (window.gc) {
          window.gc();
          console.log('🗑️ VideoManager: Forced garbage collection after state cleanup');
        }
      }, 100);
    }
    
  }, [visibleVideos, loadedVideos.size, resetLoadingAttempts]);

  // API for VideoCard components - PURE COMMANDS ONLY
  const videoCardAPI = {
    // Query functions (VideoCard can ask but not change)
    isVisible: (videoId) => visibleVideos.has(videoId),
    isLoaded: (videoId) => loadedVideos.has(videoId),
    isLoading: (videoId) => loadingVideos.has(videoId),
    isPlaying: (videoId) => playingVideos.has(videoId),
    canLoadMore: (videoId) => {
      // Always allow visible videos to load
      if (visibleVideos.has(videoId)) return true;
      // For others, respect limits
      return loadingVideos.size < performanceLimits.maxConcurrentLoading && 
             loadedVideos.size < performanceLimits.maxLoaded;
    },
    
    // Command functions (VideoCard reports events, this hook decides response)
    reportVisibility: (videoId, isVisible) => {
      setVisibleVideos(prev => {
        const newSet = new Set(prev);
        if (isVisible) {
          newSet.add(videoId);
        } else {
          newSet.delete(videoId);
        }
        return newSet;
      });
    },
    
    reportLoadStart: (videoId) => {
      setLoadingVideos(prev => new Set([...prev, videoId]));
    },
    
    reportLoadComplete: (videoId, aspectRatio) => {
      setLoadingVideos(prev => {
        const newSet = new Set(prev);
        newSet.delete(videoId);
        return newSet;
      });
      setLoadedVideos(prev => new Set([...prev, videoId]));
      
      // Return aspect ratio for layout manager
      return aspectRatio;
    },
    
    reportLoadError: (videoId) => {
      setLoadingVideos(prev => {
        const newSet = new Set(prev);
        newSet.delete(videoId);
        return newSet;
      });
    }
  };

  // Public API
  return {
    // State (read-only)
    visibleVideos,
    loadedVideos,
    loadingVideos,
    playingVideos,
    performanceLimits,
    
    // Commands
    prepareForLayoutSwitch,
    resetLoadingAttempts,
    performCleanup,
    
    // VideoCard API
    videoCardAPI,
    
    // Debugging
    getStats: () => ({
      visible: visibleVideos.size,
      loaded: loadedVideos.size,
      loading: loadingVideos.size,
      playing: playingVideos.size,
      limits: performanceLimits
    })
  };
};