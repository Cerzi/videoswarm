// hooks/video-collection/useVideoResourceManager.js
import { useCallback, useMemo, useRef, useEffect, useState } from "react";

const isProduction = process.env.NODE_ENV === 'production';

// Production memory limits (conservative estimates)
const PRODUCTION_LIMITS = {
  // Target 80% of 3.6GB limit = ~2.9GB safe zone
  MAX_SAFE_MEMORY_MB: 2900,
  // Estimated memory per loaded video (conservative)
  ESTIMATED_VIDEO_MEMORY_MB: 15, // ~15MB per video (varies by resolution/length)
  // Memory monitoring interval
  MONITOR_INTERVAL_MS: 2000,
  // Emergency threshold - start aggressive cleanup
  EMERGENCY_THRESHOLD_MB: 3200,
};

/**
 * Manages browser resource limits for video elements
 * Prevents browser overload while prioritizing visible content
 * Now includes memory monitoring for production crash prevention
 */
export default function useVideoResourceManager({
  progressiveVideos,
  visibleVideos,
  loadedVideos,
  loadingVideos,
  playingVideos,
}) {
  const lastCleanupTimeRef = useRef(0);
  const [currentMemoryMB, setCurrentMemoryMB] = useState(0);
  const [memoryPressure, setMemoryPressure] = useState(0); // 0-1 scale
  const memoryLogThrottleRef = useRef(0);

  // Monitor memory usage in production (and dev for warnings)
  useEffect(() => {
    const monitorMemory = () => {
      if (performance.memory) {
        const usedMB = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
        const limitMB = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
        
        setCurrentMemoryMB(usedMB);
        setMemoryPressure(usedMB / limitMB);

        // Throttled logging (every 10 seconds max)
        const now = Date.now();
        if (now - memoryLogThrottleRef.current > 10000) {
          console.log(`🧠 Memory: ${usedMB}MB / ${limitMB}MB (${Math.round((usedMB/limitMB) * 100)}%)`);
          memoryLogThrottleRef.current = now;
        }

        // Emergency warning
        if (usedMB > PRODUCTION_LIMITS.EMERGENCY_THRESHOLD_MB) {
          console.warn(`🚨 MEMORY EMERGENCY: ${usedMB}MB - Triggering aggressive cleanup`);
        }
      }
    };

    const interval = setInterval(monitorMemory, PRODUCTION_LIMITS.MONITOR_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Enhanced limits with memory awareness
  const limits = useMemo(() => {
    const n = progressiveVideos.length;
    
    if (!isProduction) {
      // Dev mode - generous limits but with memory warnings
      if (currentMemoryMB > 3000) {
        console.warn(`🔥 DEV WARNING: High memory usage (${currentMemoryMB}MB) - this would crash in production!`);
      }
      
      // Keep existing generous dev limits
      if (n < 100) return { maxLoaded: 40, maxConcurrentLoading: 4 };
      if (n < 300) return { maxLoaded: 80, maxConcurrentLoading: 3 };
      if (n < 600) return { maxLoaded: 120, maxConcurrentLoading: 2 };
      return { maxLoaded: 350, maxConcurrentLoading: 1 };
    }

    // Production mode - memory-aware limits
    const availableMemoryMB = PRODUCTION_LIMITS.MAX_SAFE_MEMORY_MB - currentMemoryMB;
    const maxVideosByMemory = Math.floor(availableMemoryMB / PRODUCTION_LIMITS.ESTIMATED_VIDEO_MEMORY_MB);
    
    // Apply memory pressure scaling
    const pressureMultiplier = Math.max(0.3, 1 - memoryPressure * 0.7); // Scale down as pressure increases
    
    // Base limits scaled by collection size
    let baseMaxLoaded;
    let baseMaxLoading;
    
    if (n < 100) {
      baseMaxLoaded = 30;
      baseMaxLoading = 3;
    } else if (n < 300) {
      baseMaxLoaded = 50;
      baseMaxLoading = 2;
    } else {
      baseMaxLoaded = 70;
      baseMaxLoading = 1;
    }

    // Apply memory constraints
    const memoryConstrainedLoaded = Math.min(
      Math.floor(baseMaxLoaded * pressureMultiplier),
      maxVideosByMemory,
      200 // Absolute maximum for stability
    );

    const finalLimits = {
      maxLoaded: Math.max(10, memoryConstrainedLoaded), // Never go below 10
      maxConcurrentLoading: baseMaxLoading,
      // Debug info
      debug: {
        currentMemoryMB,
        memoryPressure: Math.round(memoryPressure * 100) + '%',
        availableMemoryMB,
        maxVideosByMemory,
        pressureMultiplier: Math.round(pressureMultiplier * 100) + '%'
      }
    };

    // Log significant limit changes
    if (memoryConstrainedLoaded !== baseMaxLoaded) {
      console.log(`📉 Memory pressure reducing limits: ${baseMaxLoaded} → ${memoryConstrainedLoaded}`);
    }

    return finalLimits;
  }, [progressiveVideos.length, currentMemoryMB, memoryPressure]);

  // Enhanced canLoadVideo with memory checking
  const canLoadVideo = useCallback((videoId) => {
    // Must be in progressive list
    const inProgressiveList = progressiveVideos.some(v => v.id === videoId);
    if (!inProgressiveList) return false;
    
    // Always allow visible videos (highest priority)
    if (visibleVideos.has(videoId)) {
      // But in production, check if we're in memory emergency
      if (isProduction && currentMemoryMB > PRODUCTION_LIMITS.EMERGENCY_THRESHOLD_MB) {
        console.warn(`🚨 Memory emergency - blocking even visible video load: ${videoId}`);
        return false;
      }
      return true;
    }
    
    // For non-visible videos, respect all limits
    const memoryOk = !isProduction || 
      (currentMemoryMB + PRODUCTION_LIMITS.ESTIMATED_VIDEO_MEMORY_MB < PRODUCTION_LIMITS.MAX_SAFE_MEMORY_MB);
    
    return (
      loadingVideos.size < limits.maxConcurrentLoading &&
      loadedVideos.size < limits.maxLoaded &&
      memoryOk
    );
  }, [progressiveVideos, visibleVideos, loadingVideos, loadedVideos, limits, currentMemoryMB]);

  // Enhanced cleanup with memory pressure awareness
  const performCleanup = useCallback(() => {
    const now = Date.now();
    
    // More frequent cleanup in production under memory pressure
    const cleanupInterval = isProduction && memoryPressure > 0.7 ? 5000 : 10000;
    
    if (now - lastCleanupTimeRef.current < cleanupInterval) return null;
    lastCleanupTimeRef.current = now;
    
    // More aggressive cleanup in production
    const bufferMultiplier = isProduction ? 
      (memoryPressure > 0.8 ? 1.0 : 1.2) : // Cleanup at limit or 20% over
      1.5; // Dev mode - 50% buffer
    
    const effectiveLimit = Math.floor(limits.maxLoaded * bufferMultiplier);
    
    if (loadedVideos.size <= effectiveLimit) return null;

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
        // In production under pressure, be more aggressive
        const cleanupCount = isProduction && memoryPressure > 0.8 ? 
          Math.min(excess * 2, nonEssential.length) : 
          Math.min(excess, nonEssential.length);
          
        for (let i = 0; i < cleanupCount; i++) {
          toKeep.delete(nonEssential[i]);
        }
        
        if (isProduction && cleanupCount > 0) {
          console.log(`🧹 Cleaned up ${cleanupCount} videos due to memory pressure`);
        }
      }
      
      return toKeep;
    };
  }, [loadedVideos.size, visibleVideos, playingVideos, limits, memoryPressure]);

  // Force garbage collection under pressure (both dev and production)
  useEffect(() => {
    // In dev: only at very high pressure for testing
    // In production: at medium-high pressure for stability
    const gcThreshold = isProduction ? 0.7 : 0.9;
    
    if (memoryPressure > gcThreshold && window.gc) {
      const gcThrottle = setTimeout(() => {
        window.gc();
        console.log(`♻️ Forced GC (${isProduction ? 'prod' : 'dev'}) - pressure: ${Math.round(memoryPressure * 100)}%`);
      }, 1000);
      
      return () => clearTimeout(gcThrottle);
    }
  }, [memoryPressure]);

  return {
    canLoadVideo,
    performCleanup,
    limits,
    
    // Memory monitoring exports
    memoryStatus: {
      currentMemoryMB,
      memoryPressure: Math.round(memoryPressure * 100),
      safetyMarginMB: isProduction ? PRODUCTION_LIMITS.MAX_SAFE_MEMORY_MB - currentMemoryMB : null,
      isNearLimit: memoryPressure > 0.8,
      debugInfo: limits.debug
    }
  };
}