import { useState, useEffect, useRef, useCallback } from 'react'

export const usePerformanceManager = (videos, maxConcurrentPlaying, autoplayEnabled) => {
  // State
  const [loadingVideos, setLoadingVideos] = useState(new Set())
  const [loadedVideos, setLoadedVideos] = useState(new Map()) // videoId -> timestamp
  const [visibleVideos, setVisibleVideos] = useState(new Set())
  const [playingVideos, setPlayingVideos] = useState(new Set())
  
  // Refs for complex state that doesn't need rerenders
  const maxConcurrentLoadingRef = useRef(6)
  const maxLoadedVideosRef = useRef(60)
  const loadQueueRef = useRef([])
  const priorityQueueRef = useRef([])
  const normalQueueRef = useRef([])
  const isProcessingQueueRef = useRef(false)
  const isLayoutStableRef = useRef(true)
  const initialLoadCompleteRef = useRef(false)
  const layoutRefreshInProgressRef = useRef(false)
  
  // Configuration
  const unloadDistance = 800
  const maxQueueSize = 25
  const viewportUpdateThrottle = 200
  const estimatedVideoHeight = 250
  
  // Calculate optimal limits based on concurrent playing
  const calculateOptimalLimits = useCallback(() => {
    const maxPlaying = maxConcurrentPlaying || 30
    maxLoadedVideosRef.current = Math.max(60, maxPlaying * 3.5)
    maxConcurrentLoadingRef.current = Math.min(8, Math.max(4, Math.floor(maxPlaying / 5)))
    
    console.log(`Calculated limits: ${maxLoadedVideosRef.current} loaded, ${maxConcurrentLoadingRef.current} concurrent loading`)
  }, [maxConcurrentPlaying])

  // Update limits when max playing changes
  useEffect(() => {
    calculateOptimalLimits()
  }, [calculateOptimalLimits])

  // Layout collapse detection
  useEffect(() => {
    let lastHeight = 0
    let lastScrollY = 0

    const checkLayoutCollapse = () => {
      const currentHeight = document.documentElement.scrollHeight
      const currentScrollY = window.scrollY

      const heightDrop = lastHeight - currentHeight
      const scrollJump = Math.abs(currentScrollY - lastScrollY)

      // Detect layout collapse: big height drop or sudden scroll jump to 0
      if ((heightDrop > window.innerHeight * 2) ||
          (currentScrollY === 0 && lastScrollY > 1000 && scrollJump > 1000)) {

        console.error(`LAYOUT COLLAPSE DETECTED: Height -${heightDrop}px, Scroll jumped ${scrollJump}px`)
        handleLayoutCollapse()
      }

      lastHeight = currentHeight
      lastScrollY = currentScrollY
    }

    const intervalId = setInterval(checkLayoutCollapse, 200)
    return () => clearInterval(intervalId)
  }, [])

  const handleLayoutCollapse = useCallback(() => {
    console.log('Handling layout collapse - entering recovery mode')
    
    layoutRefreshInProgressRef.current = true
    isLayoutStableRef.current = false
    initialLoadCompleteRef.current = false

    // Clear all queues immediately
    clearQueues()

    // Pause all playing videos
    setPlayingVideos(new Set())

    // Wait longer before considering layout stable again
    setTimeout(() => {
      layoutRefreshInProgressRef.current = false
      isLayoutStableRef.current = true
      performInitialLoad()
    }, 1000)
  }, [])

  const clearQueues = useCallback(() => {
    console.log('Clearing all queues due to layout instability')
    loadQueueRef.current = []
    priorityQueueRef.current = []
    normalQueueRef.current = []
    isLayoutStableRef.current = false
    initialLoadCompleteRef.current = false
  }, [])

  const shouldQueueVideo = useCallback((videoElement) => {
    // Don't queue if already loaded or loading
    const videoId = videoElement.dataset.videoId || videoElement.dataset.filename
    if (loadedVideos.has(videoId) || loadingVideos.has(videoId)) {
      return false
    }

    // Don't queue during layout refresh
    if (layoutRefreshInProgressRef.current || !isLayoutStableRef.current) {
      return false
    }

    // Don't queue if already in any queue
    const isInQueue = loadQueueRef.current.includes(videoElement) ||
                     priorityQueueRef.current.includes(videoElement) ||
                     normalQueueRef.current.includes(videoElement)
    if (isInQueue) return false

    // Check if video has reasonable dimensions
    const rect = videoElement.getBoundingClientRect()
    const hasRealDimensions = rect.height > 10 && rect.width > 10

    // Don't queue collapsed videos during instability
    if (!hasRealDimensions && (!isLayoutStableRef.current || layoutRefreshInProgressRef.current)) {
      return false
    }

    // Don't exceed queue limits
    const totalQueued = priorityQueueRef.current.length + normalQueueRef.current.length + loadQueueRef.current.length
    if (totalQueued >= maxQueueSize) {
      return false
    }

    return true
  }, [loadedVideos, loadingVideos])

  const addToQueue = useCallback((videoElement, priority = 'normal') => {
    if (priority === 'priority') {
      priorityQueueRef.current.push(videoElement)
    } else {
      normalQueueRef.current.push(videoElement)
    }

    // Merge queues into main load queue, priority first
    loadQueueRef.current = [...priorityQueueRef.current, ...normalQueueRef.current]

    // Trim if too long
    if (loadQueueRef.current.length > maxQueueSize) {
      loadQueueRef.current = loadQueueRef.current.slice(0, maxQueueSize)
      priorityQueueRef.current = priorityQueueRef.current.slice(0, Math.min(priorityQueueRef.current.length, 8))
      normalQueueRef.current = normalQueueRef.current.slice(0, maxQueueSize - priorityQueueRef.current.length)
    }
  }, [])

  const performInitialLoad = useCallback(() => {
    if (initialLoadCompleteRef.current) return

    console.log('Performing initial load...')

    // Calculate how many videos fit in viewport
    const viewportHeight = window.innerHeight
    const estimatedVideosPerRow = Math.floor(window.innerWidth / 200)
    const estimatedRowsInViewport = Math.ceil(viewportHeight / estimatedVideoHeight)
    const estimatedViewportCapacity = estimatedVideosPerRow * estimatedRowsInViewport

    // Load 2x viewport capacity for initial load
    const maxInitialLoad = Math.min(20, estimatedViewportCapacity * 2)

    console.log(`Estimated viewport capacity: ${estimatedViewportCapacity}, loading: ${maxInitialLoad}`)

    const viewportTop = window.scrollY
    const viewportBottom = viewportTop + viewportHeight

    let loadedCount = 0

    // Get video elements from DOM
    const videoElements = Array.from(document.querySelectorAll('.video-item'))
    
    // Sort by position
    const sortedVideos = videoElements.sort((a, b) => {
      const rectA = a.getBoundingClientRect()
      const rectB = b.getBoundingClientRect()
      return (rectA.top + window.scrollY) - (rectB.top + window.scrollY)
    })

    for (const videoElement of sortedVideos) {
      if (loadedCount >= maxInitialLoad) break

      const rect = videoElement.getBoundingClientRect()
      const absoluteTop = rect.top + window.scrollY

      // More generous initial loading - include items just below viewport
      const inExtendedViewport = absoluteTop <= viewportBottom + viewportHeight
      const hasRealDimensions = rect.height > 10

      if (inExtendedViewport && shouldQueueVideo(videoElement)) {
        addToQueue(videoElement, 'priority')
        loadedCount++
        console.log(`Initial load queued: ${videoElement.dataset.filename}`)
      }
    }

    initialLoadCompleteRef.current = true
    processQueues()
  }, [shouldQueueVideo, addToQueue])

  const shouldLoadVideo = useCallback((videoElement) => {
    const videoId = videoElement.dataset.videoId || videoElement.dataset.filename
    
    // Final check before loading
    if (loadedVideos.has(videoId) || loadingVideos.has(videoId)) return false

    // Check if still relevant (in or near viewport)
    const rect = videoElement.getBoundingClientRect()
    const viewportTop = window.scrollY
    const viewportBottom = viewportTop + window.innerHeight
    const buffer = 300

    const isRelevant = (rect.top + window.scrollY) <= (viewportBottom + buffer) &&
                      (rect.bottom + window.scrollY) >= (viewportTop - buffer)

    return isRelevant
  }, [loadedVideos, loadingVideos])

  const processQueues = useCallback(async () => {
    if (isProcessingQueueRef.current || !isLayoutStableRef.current) return

    // Don't process if we're at loaded limit
    if (loadedVideos.size >= maxLoadedVideosRef.current) {
      console.log('At loaded limit, cleaning up before processing queue')
      smartCleanup()
      return
    }

    isProcessingQueueRef.current = true

    let processed = 0
    const maxBatchSize = 4

    while (loadQueueRef.current.length > 0 &&
           loadingVideos.size < maxConcurrentLoadingRef.current &&
           loadedVideos.size < maxLoadedVideosRef.current &&
           processed < maxBatchSize) {

      const videoElement = loadQueueRef.current.shift()

      // Remove from priority/normal queues too
      priorityQueueRef.current = priorityQueueRef.current.filter(v => v !== videoElement)
      normalQueueRef.current = normalQueueRef.current.filter(v => v !== videoElement)

      // Double-check the video should still be loaded
      if (!shouldLoadVideo(videoElement)) {
        continue
      }

      try {
        // Signal that we're starting to load this video
        const videoId = videoElement.dataset.videoId || videoElement.dataset.filename
        setLoadingVideos(prev => new Set([...prev, videoId]))
        
        // The actual video loading will be handled by the VideoCard component
        // We just track the state here
        
        processed++

        // Shorter delay between loads
        if (processed < maxBatchSize && loadQueueRef.current.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }

      } catch (error) {
        console.warn('Failed to process video load:', error)
      }
    }

    isProcessingQueueRef.current = false

    // Schedule next processing if needed
    if (loadQueueRef.current.length > 0 && loadedVideos.size < maxLoadedVideosRef.current) {
      setTimeout(() => processQueues(), 200)
    }
  }, [loadedVideos, loadingVideos, shouldLoadVideo])

  const smartCleanup = useCallback(() => {
    const candidates = []

    loadedVideos.forEach((timestamp, videoId) => {
      // Never unload visible videos
      if (visibleVideos.has(videoId)) return

      // Find the video element
      const videoElement = document.querySelector(`[data-video-id="${videoId}"], [data-filename="${videoId}"]`)
      if (!videoElement) return

      const rect = videoElement.getBoundingClientRect()
      const distance = Math.abs(rect.top + rect.height/2 - window.innerHeight/2)
      const age = Date.now() - timestamp

      candidates.push({
        videoId,
        videoElement,
        priority: distance + (age / 1000)
      })
    })

    // Sort by priority (highest = unload first)
    candidates.sort((a, b) => b.priority - a.priority)

    // Unload excess items
    const targetUnload = Math.max(0, loadedVideos.size - maxLoadedVideosRef.current)

    for (let i = 0; i < Math.min(targetUnload + 5, candidates.length); i++) {
      const { videoId } = candidates[i]
      setLoadedVideos(prev => {
        const newMap = new Map(prev)
        newMap.delete(videoId)
        return newMap
      })
      setLoadingVideos(prev => {
        const newSet = new Set(prev)
        newSet.delete(videoId)
        return newSet
      })
    }

    console.log(`Smart cleanup: unloaded ${Math.min(targetUnload + 5, candidates.length)} videos`)
  }, [loadedVideos, visibleVideos])

  // Performance monitoring
  useEffect(() => {
    const monitorPerformance = () => {
      // Memory monitoring with dynamic limits
      if (performance.memory) {
        const memoryRatio = performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit
        const baseMaxLoaded = maxConcurrentPlaying * 3.5

        if (memoryRatio > 0.7) {
          maxLoadedVideosRef.current = Math.max(baseMaxLoaded * 0.5, maxLoadedVideosRef.current - 20)
          maxConcurrentLoadingRef.current = Math.max(2, maxConcurrentLoadingRef.current - 1)
          emergencyCleanup()
        } else if (memoryRatio > 0.5) {
          maxLoadedVideosRef.current = Math.max(baseMaxLoaded * 0.7, maxLoadedVideosRef.current - 10)
          smartCleanup()
        } else if (memoryRatio < 0.3) {
          maxLoadedVideosRef.current = Math.min(baseMaxLoaded, maxLoadedVideosRef.current + 5)
          maxConcurrentLoadingRef.current = Math.min(8, maxConcurrentLoadingRef.current + 1)
        }
      }
    }

    const intervalId = setInterval(monitorPerformance, 3000)
    return () => clearInterval(intervalId)
  }, [maxConcurrentPlaying, smartCleanup])

  const emergencyCleanup = useCallback(() => {
    console.log('EMERGENCY CLEANUP')

    // Clear all queues
    clearQueues()

    // Pause all videos
    setPlayingVideos(new Set())

    // Unload everything except visible
    const toUnload = []
    loadedVideos.forEach((timestamp, videoId) => {
      if (!visibleVideos.has(videoId)) {
        toUnload.push(videoId)
      }
    })

    setLoadedVideos(prev => {
      const newMap = new Map(prev)
      toUnload.forEach(videoId => newMap.delete(videoId))
      return newMap
    })

    console.log(`Emergency cleanup: unloaded ${toUnload.length} videos`)
  }, [clearQueues, loadedVideos, visibleVideos])

  // Initialize
  useEffect(() => {
    if (videos.length > 0 && !initialLoadCompleteRef.current) {
      // Wait for layout stability before starting
      setTimeout(() => {
        isLayoutStableRef.current = true
        performInitialLoad()
      }, 1000)
    }
  }, [videos.length, performInitialLoad])

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
    
    // Queue management
    shouldQueueVideo,
    addToQueue,
    processQueues,
    clearQueues,
    
    // Cleanup
    smartCleanup,
    emergencyCleanup,
    
    // Monitoring
    handleLayoutCollapse,
    
    // Config
    maxLoadedVideos: maxLoadedVideosRef.current,
    maxConcurrentLoading: maxConcurrentLoadingRef.current
  }
}