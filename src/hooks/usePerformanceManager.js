import { useState, useEffect, useRef, useCallback } from 'react'

export const usePerformanceManager = (videos, maxConcurrentPlaying, autoplayEnabled) => {
  // Simple state - just what we need
  const [loadingVideos, setLoadingVideos] = useState(new Set())
  const [loadedVideos, setLoadedVideos] = useState(new Set()) // Just a Set, not Map with timestamps
  const [visibleVideos, setVisibleVideos] = useState(new Set())
  const [playingVideos, setPlayingVideos] = useState(new Set())
  
  // Simple limits - no complex calculations
  const maxLoadedVideos = Math.min(100, videos.length) // Cap at 100 regardless of video count
  const maxConcurrentLoading = 3 // Keep it very conservative
  
  // Simple cleanup based on distance from viewport
  const smartCleanup = useCallback(() => {
    if (loadedVideos.size <= maxLoadedVideos) return
    
    const viewportCenter = window.scrollY + (window.innerHeight / 2)
    const candidates = []
    
    // Find loaded videos that aren't visible and get their distance from viewport
    loadedVideos.forEach(videoId => {
      if (visibleVideos.has(videoId)) return // Don't unload visible videos
      
      const videoElement = document.querySelector(`[data-video-id="${videoId}"], [data-filename="${videoId}"]`)
      if (!videoElement) return
      
      const rect = videoElement.getBoundingClientRect()
      const elementCenter = rect.top + window.scrollY + (rect.height / 2)
      const distance = Math.abs(elementCenter - viewportCenter)
      
      candidates.push({ videoId, distance })
    })
    
    // Sort by distance (farthest first) and unload excess
    candidates.sort((a, b) => b.distance - a.distance)
    
    const excessCount = loadedVideos.size - maxLoadedVideos
    const toUnload = candidates.slice(0, excessCount + 5) // Unload a few extra
    
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
    
    console.log(`Cleaned up ${toUnload.length} videos (${loadedVideos.size} -> ${loadedVideos.size - toUnload.length})`)
  }, [loadedVideos, visibleVideos, maxLoadedVideos])
  
  // Simple enforcement of limits
  useEffect(() => {
    // Don't let too many videos load at once
    if (loadingVideos.size > maxConcurrentLoading) {
      const excess = Array.from(loadingVideos).slice(maxConcurrentLoading)
      setLoadingVideos(prev => {
        const newSet = new Set(prev)
        excess.forEach(id => newSet.delete(id))
        return newSet
      })
    }
    
    // Don't let too many videos stay loaded
    if (loadedVideos.size > maxLoadedVideos) {
      setTimeout(smartCleanup, 100) // Small delay to prevent thrashing
    }
    
    // Don't let too many videos play at once
    if (playingVideos.size > maxConcurrentPlaying) {
      const excess = Array.from(playingVideos).slice(maxConcurrentPlaying)
      setPlayingVideos(prev => {
        const newSet = new Set(prev)
        excess.forEach(id => newSet.delete(id))
        return newSet
      })
    }
  }, [loadingVideos.size, loadedVideos.size, playingVideos.size, maxConcurrentLoading, maxLoadedVideos, maxConcurrentPlaying, smartCleanup])
  
  // Emergency cleanup when things get out of hand
  const emergencyCleanup = useCallback(() => {
    console.log('Emergency cleanup triggered')
    
    // Pause all videos
    setPlayingVideos(new Set())
    
    // Only keep visible videos loaded
    setLoadedVideos(prev => {
      const newSet = new Set()
      prev.forEach(videoId => {
        if (visibleVideos.has(videoId)) {
          newSet.add(videoId)
        }
      })
      return newSet
    })
    
    // Clear loading queue
    setLoadingVideos(new Set())
    
  }, [visibleVideos])
  
  // Simple memory monitoring - just trigger emergency cleanup if needed
  useEffect(() => {
    const checkMemory = () => {
      if (performance.memory) {
        const memoryRatio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit
        
        if (memoryRatio > 0.8) {
          console.log(`High memory usage detected: ${Math.round(memoryRatio * 100)}%`)
          emergencyCleanup()
        }
      }
    }
    
    const intervalId = setInterval(checkMemory, 5000) // Check every 5 seconds
    return () => clearInterval(intervalId)
  }, [emergencyCleanup])
  
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
    
    // Cleanup
    smartCleanup,
    emergencyCleanup,
    
    // Config - simple and conservative
    maxLoadedVideos,
    maxConcurrentLoading
  }
}