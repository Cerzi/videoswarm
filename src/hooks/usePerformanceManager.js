import { useState, useEffect, useRef, useCallback } from 'react'

export const usePerformanceManager = (videos, maxConcurrentPlaying, autoplayEnabled) => {
  // Core state management - simplified but functional
  const [loadingVideos, setLoadingVideos] = useState(new Set())
  const [loadedVideos, setLoadedVideos] = useState(new Set()) 
  const [visibleVideos, setVisibleVideos] = useState(new Set())
  const [playingVideos, setPlayingVideos] = useState(new Set())
  
  // Performance metrics tracking
  const metricsRef = useRef({
    totalMemoryCleanups: 0,
    lastCleanupTime: 0,
  })
  
  // VERY CONSERVATIVE limits to prevent tile memory issues
  const getPerformanceLimits = useCallback(() => {
    const videoCount = videos.length
    
    // EXTREMELY conservative limits to prevent tile memory errors
    if (videoCount < 50) {
      return {
        maxLoadedVideos: 25,
        maxConcurrentLoading: 3
      }
    } else if (videoCount < 100) {
      return {
        maxLoadedVideos: 40,
        maxConcurrentLoading: 3
      }
    } else if (videoCount < 500) {
      return {
        maxLoadedVideos: 60,
        maxConcurrentLoading: 2
      }
    } else if (videoCount < 1000) {
      return {
        maxLoadedVideos: 80,
        maxConcurrentLoading: 2
      }
    } else {
      // For very large collections: extremely conservative
      return {
        maxLoadedVideos: 100,
        maxConcurrentLoading: 1
      }
    }
  }, [videos.length])
  
  const { maxLoadedVideos, maxConcurrentLoading } = getPerformanceLimits()
  
  // SIMPLIFIED cleanup - less aggressive to prevent performance issues
  const smartCleanup = useCallback(() => {
    if (loadedVideos.size <= maxLoadedVideos) return
    
    console.log(`Smart cleanup: ${loadedVideos.size} loaded, limit: ${maxLoadedVideos}`)
    
    const candidates = []
    
    // Simple distance-based cleanup
    loadedVideos.forEach(videoId => {
      if (visibleVideos.has(videoId)) return // Never unload visible videos
      if (playingVideos.has(videoId)) return // Never unload playing videos
      
      // Simple scoring - no expensive DOM queries
      let score = 1; // Base score
      
      // Prioritize for cleanup if video had errors
      const videoElement = document.querySelector(`[data-video-id="${videoId}"]`)
      if (videoElement?.classList.contains('error')) {
        score = 10; // High priority for cleanup
      }
      
      candidates.push({ videoId, score })
    })
    
    // Sort by score and unload excess
    candidates.sort((a, b) => b.score - a.score)
    const excessCount = loadedVideos.size - maxLoadedVideos
    const toUnload = candidates.slice(0, excessCount + 5) // Small buffer
    
    if (toUnload.length > 0) {
      setLoadedVideos(prev => {
        const newSet = new Set(prev)
        toUnload.forEach(({ videoId }) => newSet.delete(videoId))
        return newSet
      })
      
      setLoadingVideos(prev => {
        const newSet = new Set(prev)
        toUnload.forEach(({ videoId }) => newSet.delete(videoId))
        return newSet
      })
      
      metricsRef.current.totalMemoryCleanups++
      metricsRef.current.lastCleanupTime = Date.now()
      
      console.log(`Cleaned up ${toUnload.length} videos`)
    }
  }, [loadedVideos, visibleVideos, playingVideos, maxLoadedVideos])
  
  // THROTTLED cleanup to prevent excessive calls
  const throttledCleanup = useCallback(() => {
    const now = Date.now()
    const timeSinceLastCleanup = now - metricsRef.current.lastCleanupTime
    
    // Don't cleanup more than once every 3 seconds
    if (timeSinceLastCleanup < 3000) {
      return
    }
    
    smartCleanup()
  }, [smartCleanup])
  
  // SIMPLIFIED limit enforcement - less aggressive
  useEffect(() => {
    // Only run enforcement every few seconds to prevent cascading updates
    const timeoutId = setTimeout(() => {
      // Limit concurrent loading
      if (loadingVideos.size > maxConcurrentLoading) {
        const excess = Array.from(loadingVideos).slice(maxConcurrentLoading)
        setLoadingVideos(prev => {
          const newSet = new Set(prev)
          excess.forEach(id => newSet.delete(id))
          return newSet
        })
      }
      
      // Limit total loaded videos
      if (loadedVideos.size > maxLoadedVideos) {
        throttledCleanup()
      }
      
      // Limit concurrent playing
      if (playingVideos.size > maxConcurrentPlaying) {
        const playingArray = Array.from(playingVideos)
        const visiblePlaying = playingArray.filter(id => visibleVideos.has(id))
        const invisiblePlaying = playingArray.filter(id => !visibleVideos.has(id))
        
        // Prefer keeping visible videos playing
        const toKeep = [
          ...visiblePlaying.slice(0, maxConcurrentPlaying),
          ...invisiblePlaying.slice(0, Math.max(0, maxConcurrentPlaying - visiblePlaying.length))
        ]
        
        setPlayingVideos(new Set(toKeep))
      }
    }, 1000) // 1 second delay to prevent rapid state changes
    
    return () => clearTimeout(timeoutId)
  }, [
    loadingVideos.size, 
    loadedVideos.size, 
    playingVideos.size, 
    visibleVideos,
    maxConcurrentLoading, 
    maxLoadedVideos, 
    maxConcurrentPlaying, 
    throttledCleanup
  ])
  
  // Emergency cleanup for critical situations
  const emergencyCleanup = useCallback(() => {
    console.log('🚨 EMERGENCY CLEANUP TRIGGERED 🚨')
    
    // Only keep visible videos playing
    const visiblePlayingVideos = Array.from(playingVideos).filter(id => visibleVideos.has(id))
    setPlayingVideos(new Set(visiblePlayingVideos.slice(0, Math.min(10, maxConcurrentPlaying))))
    
    // Only keep visible videos loaded, plus a few nearby ones
    const keepLoaded = new Set(visibleVideos)
    
    setLoadedVideos(keepLoaded)
    setLoadingVideos(new Set())
    
    // Force garbage collection if available
    if (window.gc) {
      setTimeout(() => {
        window.gc()
        console.log('Forced garbage collection')
      }, 1000)
    }
    
    metricsRef.current.totalMemoryCleanups++
    metricsRef.current.lastCleanupTime = Date.now()
    
    console.log(`Emergency cleanup complete: kept ${keepLoaded.size} videos loaded`)
  }, [playingVideos, visibleVideos, maxConcurrentPlaying])
  
  // EMERGENCY: Prevent tile memory issues with aggressive DOM limiting
  useEffect(() => {
    // Force very aggressive cleanup if we detect too many DOM elements
    const checkDOMOverload = () => {
      const videoElements = document.querySelectorAll('.video-item')
      const loadedElements = document.querySelectorAll('.video-item[data-loaded="true"]')
      
      console.log(`DOM Check: ${videoElements.length} total elements, ${loadedElements.length} loaded`)
      
      // If we have too many DOM elements, force emergency cleanup
      if (videoElements.length > 200) {
        console.warn(`⚠️ Too many DOM elements (${videoElements.length}), forcing cleanup`)
        emergencyCleanup()
      }
      
      // If we have too many loaded videos, force cleanup
      if (loadedVideos.size > 100) {
        console.warn(`⚠️ Too many loaded videos (${loadedVideos.size}), forcing cleanup`)
        smartCleanup()
      }
    }
    
    // Check DOM every 5 seconds
    const intervalId = setInterval(checkDOMOverload, 5000)
    return () => clearInterval(intervalId)
  }, [loadedVideos.size, emergencyCleanup, smartCleanup])

  // LESS AGGRESSIVE memory monitoring but with more logging
  useEffect(() => {
    const checkMemory = () => {
      if (!performance.memory) return
      
      const { usedJSHeapSize, jsHeapSizeLimit } = performance.memory
      const memoryRatio = usedJSHeapSize / jsHeapSizeLimit
      
      // Log performance stats periodically
      if (Math.random() < 0.1) { // 10% chance
        console.log(`Performance: ${Math.round(memoryRatio * 100)}% memory, ${loadedVideos.size}/${maxLoadedVideos} loaded, ${visibleVideos.size} visible`)
      }
      
      // Higher thresholds to prevent premature cleanup
      if (memoryRatio > 0.85) {
        console.warn('Critical memory usage:', Math.round(memoryRatio * 100) + '%')
        emergencyCleanup()
      } else if (memoryRatio > 0.75 && loadedVideos.size > maxLoadedVideos * 0.8) {
        console.log('High memory usage, gradual cleanup')
        throttledCleanup()
      }
    }
    
    // Check less frequently to reduce overhead
    const intervalId = setInterval(checkMemory, 8000) // Every 8 seconds
    
    return () => clearInterval(intervalId)
  }, [emergencyCleanup, throttledCleanup, loadedVideos.size, visibleVideos.size, maxLoadedVideos])
  
  // SIMPLIFIED performance stats
  const getPerformanceStats = useCallback(() => {
    return {
      videos: videos.length,
      loaded: loadedVideos.size,
      loading: loadingVideos.size,
      playing: playingVideos.size,
      visible: visibleVideos.size,
      limits: { maxLoadedVideos, maxConcurrentLoading, maxConcurrentPlaying },
      cleanups: metricsRef.current.totalMemoryCleanups,
      memoryUsage: performance.memory ? {
        used: Math.round((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100),
        total: Math.round((performance.memory.totalJSHeapSize / performance.memory.jsHeapSizeLimit) * 100)
      } : null
    }
  }, [videos.length, loadedVideos.size, loadingVideos.size, playingVideos.size, visibleVideos.size, maxLoadedVideos, maxConcurrentLoading, maxConcurrentPlaying])
  
  return {
    // State
    loadingVideos,
    loadedVideos,
    visibleVideos,
    playingVideos,
    
    // Actions
    setLoadingVideos,
    setLoadedVideos,
    setVisibleVideos,
    setPlayingVideos,
    
    // Cleanup functions
    smartCleanup,
    emergencyCleanup,
    
    // Limits (conservative)
    maxLoadedVideos,
    maxConcurrentLoading,
    
    // Debugging
    getPerformanceStats
  }
}