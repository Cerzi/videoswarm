import { useEffect, useRef, useCallback, useState } from 'react'

export const useLayoutManager = (videos, zoomLevel) => {
  const [layoutMode, setLayoutMode] = useState('grid')
  const gridRef = useRef(null)
  const isLayoutingRef = useRef(false)
  const isUserScrollingRef = useRef(false)
  const layoutRefreshInProgressRef = useRef(false)
  const lastScrollTimeRef = useRef(0)
  const aspectRatioCacheRef = useRef(new Map())
  const cachedGridMeasurementsRef = useRef(null)
  const masonryLayoutTimeoutRef = useRef(null)
  const resizeTimeoutRef = useRef(null)

  // Setup scroll detection
  useEffect(() => {
    let scrollTimeout

    const handleScroll = () => {
      lastScrollTimeRef.current = Date.now()
      isUserScrollingRef.current = true

      clearTimeout(scrollTimeout)
      scrollTimeout = setTimeout(() => {
        isUserScrollingRef.current = false
      }, 150)
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    
    return () => {
      window.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimeout)
    }
  }, [])

  // Helper functions
  const getColumnCount = useCallback((computedStyle) => {
    const gridTemplateColumns = computedStyle.gridTemplateColumns
    if (gridTemplateColumns === 'none') return 1
    return gridTemplateColumns.split(' ').length
  }, [])

  const updateCachedGridMeasurements = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return

    const computedStyle = window.getComputedStyle(grid)
    const columnCount = getColumnCount(computedStyle)
    const columnGap = parseFloat(computedStyle.columnGap) || 4

    const gridWidth = grid.clientWidth
    const padding = (parseFloat(computedStyle.paddingLeft) || 0) + (parseFloat(computedStyle.paddingRight) || 0)

    const availableWidth = gridWidth - padding
    const totalGapWidth = columnGap * (columnCount - 1)
    const columnWidth = (availableWidth - totalGapWidth) / columnCount

    cachedGridMeasurementsRef.current = {
      columnWidth: Math.floor(columnWidth),
      columnCount,
      columnGap,
      gridWidth: availableWidth
    }

    console.log('Grid measurements:', cachedGridMeasurementsRef.current)
  }, [getColumnCount])

  // TRUE MASONRY IMPLEMENTATION - Fixed Width, Variable Height (Vertical)
  const layoutMasonryVertical = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return

    console.log('Laying out vertical masonry (fixed width, variable height)')

    // Get grid measurements
    if (!cachedGridMeasurementsRef.current) {
      updateCachedGridMeasurements()
    }

    const { columnWidth, columnCount, columnGap } = cachedGridMeasurementsRef.current || {}
    if (!columnWidth) return

    // Initialize column heights array
    const columnHeights = new Array(columnCount).fill(0)
    
    // Get all video items
    const videoItems = grid.querySelectorAll('.video-item')
    
    videoItems.forEach((videoItem, index) => {
      // Get or calculate aspect ratio
      const videoId = videoItem.dataset.videoId || videoItem.dataset.filename
      let aspectRatio = aspectRatioCacheRef.current.get(videoId)
      
      if (!aspectRatio) {
        const video = videoItem.querySelector('video')
        if (video && video.videoWidth && video.videoHeight) {
          aspectRatio = video.videoWidth / video.videoHeight
          aspectRatioCacheRef.current.set(videoId, aspectRatio)
        } else {
          aspectRatio = 16 / 9 // Default
        }
      } else if (typeof aspectRatio === 'string') {
        const [width, height] = aspectRatio.split('/').map(Number)
        aspectRatio = width / height
      }

      // Calculate item height based on fixed width and aspect ratio
      const itemHeight = Math.round(columnWidth / aspectRatio) + 30 // Add space for filename

      // Find column with minimum height
      const shortestColumnIndex = columnHeights.indexOf(Math.min(...columnHeights))
      const leftPosition = shortestColumnIndex * (columnWidth + columnGap)
      const topPosition = columnHeights[shortestColumnIndex]

      // Position the item
      videoItem.style.position = 'absolute'
      videoItem.style.left = `${leftPosition}px`
      videoItem.style.top = `${topPosition}px`
      videoItem.style.width = `${columnWidth}px`
      videoItem.style.height = `${itemHeight}px`

      // Update the video element styling for aspect ratio
      const videoElement = videoItem.querySelector('video, .video-placeholder')
      if (videoElement) {
        videoElement.style.width = '100%'
        videoElement.style.height = `${itemHeight - 30}px` // Subtract filename space
        videoElement.style.objectFit = 'cover'
      }

      // Update column height
      columnHeights[shortestColumnIndex] += itemHeight + columnGap
    })

    // Set grid container height to accommodate all items
    const maxHeight = Math.max(...columnHeights)
    grid.style.height = `${maxHeight}px`
    grid.style.position = 'relative'
  }, [updateCachedGridMeasurements])

  // TRUE MASONRY IMPLEMENTATION - Fixed Height, Variable Width (Horizontal)
  const layoutMasonryHorizontal = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return

    console.log('Laying out horizontal masonry (fixed height, variable width)')

    // For horizontal masonry, we need a fixed row height
    const fixedRowHeight = 200 // Base height
    const rowGap = 4
    
    // Calculate how many rows can fit in viewport
    const viewportHeight = window.innerHeight - 200 // Account for header
    const maxRows = Math.floor(viewportHeight / (fixedRowHeight + rowGap))
    
    // Initialize row widths array
    const rowWidths = new Array(maxRows).fill(0)
    
    // Get all video items
    const videoItems = grid.querySelectorAll('.video-item')
    
    videoItems.forEach((videoItem) => {
      // Get or calculate aspect ratio
      const videoId = videoItem.dataset.videoId || videoItem.dataset.filename
      let aspectRatio = aspectRatioCacheRef.current.get(videoId)
      
      if (!aspectRatio) {
        const video = videoItem.querySelector('video')
        if (video && video.videoWidth && video.videoHeight) {
          aspectRatio = video.videoWidth / video.videoHeight
          aspectRatioCacheRef.current.set(videoId, aspectRatio)
        } else {
          aspectRatio = 16 / 9 // Default
        }
      } else if (typeof aspectRatio === 'string') {
        const [width, height] = aspectRatio.split('/').map(Number)
        aspectRatio = width / height
      }

      // Calculate item width based on fixed height and aspect ratio
      const itemWidth = Math.round(fixedRowHeight * aspectRatio)

      // Find row with minimum width
      const shortestRowIndex = rowWidths.indexOf(Math.min(...rowWidths))
      const leftPosition = rowWidths[shortestRowIndex]
      const topPosition = shortestRowIndex * (fixedRowHeight + rowGap)

      // Position the item
      videoItem.style.position = 'absolute'
      videoItem.style.left = `${leftPosition}px`
      videoItem.style.top = `${topPosition}px`
      videoItem.style.width = `${itemWidth}px`
      videoItem.style.height = `${fixedRowHeight}px`

      // Update the video element styling
      const videoElement = videoItem.querySelector('video, .video-placeholder')
      if (videoElement) {
        videoElement.style.width = '100%'
        videoElement.style.height = `${fixedRowHeight - 30}px` // Subtract filename space
        videoElement.style.objectFit = 'cover'
      }

      // Update row width
      rowWidths[shortestRowIndex] += itemWidth + rowGap
    })

    // Set grid container dimensions
    const maxWidth = Math.max(...rowWidths)
    grid.style.width = `${maxWidth}px`
    grid.style.height = `${maxRows * (fixedRowHeight + rowGap)}px`
    grid.style.position = 'relative'
    grid.style.overflowX = 'auto'
  }, [])

  // Grid layout (original CSS grid behavior)
  const layoutGrid = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return

    console.log('Applying grid layout')
    
    // Reset all positioning
    const videoItems = grid.querySelectorAll('.video-item')
    videoItems.forEach((videoItem) => {
      videoItem.style.position = ''
      videoItem.style.left = ''
      videoItem.style.top = ''
      videoItem.style.width = ''
      videoItem.style.height = ''
      
      // Reset video element styling
      const videoElement = videoItem.querySelector('video, .video-placeholder')
      if (videoElement) {
        videoElement.style.width = '100%'
        videoElement.style.height = '140px' // Fixed height for grid mode
        videoElement.style.objectFit = 'cover'
      }
    })

    // Reset grid container
    grid.style.height = ''
    grid.style.width = ''
    grid.style.position = ''
    grid.style.overflowX = ''
  }, [])

  const initializeMasonryGrid = useCallback(() => {
    const grid = gridRef.current
    if (!grid || isLayoutingRef.current || isUserScrollingRef.current) return

    // Check if native masonry is supported
    if (CSS.supports('grid-template-rows', 'masonry')) {
      console.log('Using native CSS masonry')
      return
    }

    // Prevent layout loops
    if (layoutRefreshInProgressRef.current) {
      console.log('Skipping masonry init - refresh in progress')
      return
    }

    isLayoutingRef.current = true
    layoutRefreshInProgressRef.current = true

    console.log('Initializing masonry layout for mode:', layoutMode)

    // Preserve scroll position
    const currentScrollY = window.scrollY

    // Wait for DOM to settle, then apply layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!isUserScrollingRef.current) {
          if (layoutMode === 'masonry-vertical') {
            layoutMasonryVertical()
          } else if (layoutMode === 'masonry-horizontal') {
            layoutMasonryHorizontal()
          } else {
            layoutGrid()
          }
        }

        // Restore scroll position ONLY if it was significant
        if (currentScrollY > 100) {
          setTimeout(() => {
            if (!isUserScrollingRef.current) {
              window.scrollTo(0, currentScrollY)
              console.log(`Restored scroll position to ${currentScrollY}px`)
            }
          }, 100)
        }

        isLayoutingRef.current = false

        // Longer delay before allowing refresh again
        setTimeout(() => {
          layoutRefreshInProgressRef.current = false
        }, 500)
      })
    })
  }, [layoutMode, layoutMasonryVertical, layoutMasonryHorizontal, layoutGrid])

  const applyLayout = useCallback((mode = layoutMode) => {
    const grid = gridRef.current
    if (!grid) return

    console.log('Applying layout mode:', mode)

    // Preserve scroll position during layout changes
    const currentScrollY = window.scrollY

    // Clear cached measurements when switching layouts
    cachedGridMeasurementsRef.current = null

    // Remove all layout classes
    grid.classList.remove('masonry-vertical', 'masonry-horizontal')

    if (mode === 'masonry-vertical') {
      grid.classList.add('masonry-vertical')
      // Use setTimeout to ensure CSS changes are applied first
      setTimeout(() => {
        updateCachedGridMeasurements()
        initializeMasonryGrid()
        // Restore scroll position after layout
        if (currentScrollY > 0) {
          requestAnimationFrame(() => {
            window.scrollTo(0, currentScrollY)
          })
        }
      }, 50)
    } else if (mode === 'masonry-horizontal') {
      grid.classList.add('masonry-horizontal')
      setTimeout(() => {
        initializeMasonryGrid()
        if (currentScrollY > 0) {
          requestAnimationFrame(() => {
            window.scrollTo(0, currentScrollY)
          })
        }
      }, 50)
    } else {
      // Grid mode
      setTimeout(() => {
        layoutGrid()
        if (currentScrollY > 0) {
          requestAnimationFrame(() => {
            window.scrollTo(0, currentScrollY)
          })
        }
      }, 50)
    }
  }, [layoutMode, initializeMasonryGrid, layoutGrid, updateCachedGridMeasurements])

  // Setup resize handling
  useEffect(() => {
    let isResizing = false

    const handleResize = () => {
      isResizing = true
      clearTimeout(resizeTimeoutRef.current)

      // Only handle resize AFTER user stops resizing for 1 second
      resizeTimeoutRef.current = setTimeout(() => {
        isResizing = false
        handleResizeComplete()
      }, 1000)
    }

    const handleResizeComplete = () => {
      console.log('Window resize complete - updating layout')

      // Clear cached measurements
      cachedGridMeasurementsRef.current = null

      // Re-layout for any masonry mode
      if ((layoutMode === 'masonry-vertical' || layoutMode === 'masonry-horizontal') &&
          !isLayoutingRef.current &&
          !isUserScrollingRef.current) {
        setTimeout(() => {
          initializeMasonryGrid()
        }, 100)
      }

      // Handle post-resize video management
      setTimeout(() => {
        handlePostResize()
      }, 300)
    }

    window.addEventListener('resize', handleResize)
    
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(resizeTimeoutRef.current)
    }
  }, [layoutMode, initializeMasonryGrid])

  const handlePostResize = useCallback(() => {
    console.log('LayoutManager handling post-resize recovery...')
    
    // Manual visibility check since observers might be confused
    const visibleVideoIds = manualVisibilityCheck()
    
    // Restart videos that should be playing
    setTimeout(() => {
      restartVisibleVideos(visibleVideoIds)
    }, 100)
  }, [])

  const manualVisibilityCheck = useCallback(() => {
    const viewportTop = window.scrollY
    const viewportBottom = viewportTop + window.innerHeight
    const buffer = 100

    let visibleCount = 0
    const visibleVideoIds = new Set()

    const videoElements = document.querySelectorAll('.video-item')
    videoElements.forEach(videoItem => {
      const rect = videoItem.getBoundingClientRect()
      const absoluteTop = rect.top + window.scrollY
      const absoluteBottom = absoluteTop + rect.height

      const isVisible = absoluteBottom >= (viewportTop - buffer) &&
                       absoluteTop <= (viewportBottom + buffer)

      if (isVisible) {
        const videoId = videoItem.dataset.videoId || videoItem.dataset.filename
        visibleVideoIds.add(videoId)
        visibleCount++
      }
    })

    console.log(`Manual visibility check found ${visibleCount} visible videos`)
    return visibleVideoIds
  }, [])

  const restartVisibleVideos = useCallback((visibleVideoIds) => {
    console.log('Restarting visible videos after resize...')
    return visibleVideoIds
  }, [])

  const toggleLayout = useCallback(() => {
    const modes = ['grid', 'masonry-vertical', 'masonry-horizontal']
    const currentIndex = modes.indexOf(layoutMode)
    const nextIndex = (currentIndex + 1) % modes.length
    const newMode = modes[nextIndex]
    
    setLayoutMode(newMode)
    return newMode
  }, [layoutMode])

  const refreshMasonryLayout = useCallback(() => {
    // Don't refresh if user is interacting or layout is already in progress
    if (isUserScrollingRef.current ||
        layoutRefreshInProgressRef.current ||
        isLayoutingRef.current) {
      console.log('Skipping layout refresh - interaction or refresh in progress')
      return
    }

    // Don't refresh too frequently
    const now = Date.now()
    if (lastScrollTimeRef.current && (now - lastScrollTimeRef.current < 2000)) {
      console.log('Skipping layout refresh - recent user activity')
      return
    }

    console.log('Refreshing masonry layout')
    initializeMasonryGrid()
  }, [initializeMasonryGrid])

  const forceLayout = useCallback(() => {
    const currentScrollY = window.scrollY

    initializeMasonryGrid()

    // Restore scroll position
    setTimeout(() => {
      if (currentScrollY > 0) {
        window.scrollTo(0, currentScrollY)
      }
    }, 100)
  }, [initializeMasonryGrid])

  const setZoom = useCallback((level) => {
    const grid = gridRef.current
    if (!grid) return

    const zoomLevels = ['zoom-small', 'zoom-medium', 'zoom-large', 'zoom-xlarge']
    
    zoomLevels.forEach(cls => grid.classList.remove(cls))
    grid.classList.add(zoomLevels[level])

    // Refresh layout after zoom change
    clearTimeout(masonryLayoutTimeoutRef.current)
    masonryLayoutTimeoutRef.current = setTimeout(() => {
      cachedGridMeasurementsRef.current = null
      initializeMasonryGrid()
    }, 300)
  }, [initializeMasonryGrid])

  const handleLayoutCollapse = useCallback(() => {
    console.log('Layout collapse detected - resetting layout manager')
    
    layoutRefreshInProgressRef.current = false
    isLayoutingRef.current = false

    // Force layout recalculation
    setTimeout(() => {
      initializeMasonryGrid()
    }, 100)
  }, [initializeMasonryGrid])

  // Apply layout when mode changes or videos change
  useEffect(() => {
    applyLayout()
  }, [layoutMode, videos.length, applyLayout])

  // Apply zoom when zoomLevel changes
  useEffect(() => {
    setZoom(zoomLevel)
  }, [zoomLevel, setZoom])

  // Setup layout collapse monitoring
  useEffect(() => {
    let lastHeight = document.documentElement.scrollHeight
    let consecutiveChecks = 0

    const monitorLayoutCollapse = () => {
      // Skip monitoring during layout operations
      if (isLayoutingRef.current || layoutRefreshInProgressRef.current) {
        return
      }

      const currentHeight = document.documentElement.scrollHeight
      const heightChange = Math.abs(currentHeight - lastHeight)

      // Only trigger on MASSIVE height changes (real collapses, not normal layout)
      if (heightChange > window.innerHeight * 4) {
        consecutiveChecks++

        // Only trigger after multiple consecutive detections to avoid false positives
        if (consecutiveChecks >= 2) {
          console.warn(`SEVERE LAYOUT COLLAPSE DETECTED: Height changed by ${heightChange}px`)
          handleLayoutCollapse()
          consecutiveChecks = 0
        }
      } else {
        consecutiveChecks = 0
      }

      lastHeight = currentHeight
    }

    const intervalId = setInterval(monitorLayoutCollapse, 1000)
    return () => clearInterval(intervalId)
  }, [handleLayoutCollapse])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(masonryLayoutTimeoutRef.current)
      clearTimeout(resizeTimeoutRef.current)
    }
  }, [])

  return {
    layoutMode,
    gridRef,
    toggleLayout,
    refreshMasonryLayout,
    forceLayout,
    setZoom,
    handlePostResize,
    manualVisibilityCheck
  }
}