import { useEffect, useRef, useCallback } from 'react'

export const useLayoutManager = (videos, zoomLevel) => {
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

  // VERTICAL MASONRY IMPLEMENTATION - Fixed Width, Variable Height
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
      }

      // Calculate item height based on fixed width and aspect ratio
      const itemHeight = Math.round(columnWidth / aspectRatio)

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

      // Update the video container styling
      const videoContainer = videoItem.querySelector('.video-container, .video-placeholder, .error-indicator')
      if (videoContainer) {
        videoContainer.style.height = `${itemHeight}px`
      }

      // Update column height
      columnHeights[shortestColumnIndex] += itemHeight + columnGap
    })

    // Set grid container height to accommodate all items
    const maxHeight = Math.max(...columnHeights)
    grid.style.height = `${maxHeight}px`
    grid.style.position = 'relative'
  }, [updateCachedGridMeasurements])

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

    console.log('Initializing vertical masonry layout')

    // Preserve scroll position
    const currentScrollY = window.scrollY

    // Wait for DOM to settle, then apply layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!isUserScrollingRef.current) {
          layoutMasonryVertical()
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
  }, [layoutMasonryVertical])

  const applyLayout = useCallback(() => {
    const grid = gridRef.current
    if (!grid) return

    console.log('Applying vertical masonry layout')

    // Preserve scroll position during layout changes
    const currentScrollY = window.scrollY

    // Clear aspect ratio cache if it's getting large (memory management)
    if (aspectRatioCacheRef.current.size > 1000) {
      console.log(`🧹 Clearing large aspect ratio cache (${aspectRatioCacheRef.current.size} entries)`)
      aspectRatioCacheRef.current.clear()
    }

    // Clear cached measurements
    cachedGridMeasurementsRef.current = null

    // Apply vertical masonry layout
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
  }, [initializeMasonryGrid, updateCachedGridMeasurements])

  // Setup resize handling
  useEffect(() => {
    const handleResize = () => {
      clearTimeout(resizeTimeoutRef.current)

      // Only handle resize AFTER user stops resizing for 500ms
      resizeTimeoutRef.current = setTimeout(() => {
        console.log('Window resize complete - updating layout')

        // Clear cached measurements
        cachedGridMeasurementsRef.current = null

        // Re-layout
        if (!isLayoutingRef.current && !isUserScrollingRef.current) {
          setTimeout(() => {
            initializeMasonryGrid()
          }, 100)
        }
      }, 500)
    }

    window.addEventListener('resize', handleResize)
    
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(resizeTimeoutRef.current)
    }
  }, [initializeMasonryGrid])

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
    if (lastScrollTimeRef.current && (now - lastScrollTimeRef.current < 1000)) {
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

  const saveZoomSetting = useCallback(async (newZoomLevel) => {
    if (window.electronAPI?.saveSettingsPartial) {
      try {
        await window.electronAPI.saveSettingsPartial({
          zoomLevel: newZoomLevel,
        });
        console.log('Zoom level saved:', newZoomLevel);
      } catch (error) {
        console.error('Failed to save zoom level:', error);
      }
    }
  }, []);

  const setZoom = useCallback((level) => {
    const grid = gridRef.current
    if (!grid) return

    const zoomLevels = ['zoom-small', 'zoom-medium', 'zoom-large', 'zoom-xlarge']
    
    // Remove all zoom classes
    zoomLevels.forEach(cls => grid.classList.remove(cls))
    // Add the new zoom class
    grid.classList.add(zoomLevels[level])

    // Save the zoom setting
    saveZoomSetting(level)

    // Refresh layout after zoom change
    clearTimeout(masonryLayoutTimeoutRef.current)
    masonryLayoutTimeoutRef.current = setTimeout(() => {
      cachedGridMeasurementsRef.current = null
      initializeMasonryGrid()
    }, 300)
  }, [initializeMasonryGrid, saveZoomSetting])

  // Apply layout when mode or videos change
  useEffect(() => {
    if (videos.length > 0) {
      applyLayout()
    }
  }, [layoutMode, videos.length, applyLayout])

  // Apply zoom when zoomLevel changes
  useEffect(() => {
    setZoom(zoomLevel)
  }, [zoomLevel, setZoom])

  // Update aspect ratio cache when videos load
  const updateAspectRatio = useCallback((videoId, aspectRatio) => {
    aspectRatioCacheRef.current.set(videoId, aspectRatio)
    
    // Refresh layout
    setTimeout(() => {
      refreshMasonryLayout()
    }, 100)
  }, [refreshMasonryLayout])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(masonryLayoutTimeoutRef.current)
      clearTimeout(resizeTimeoutRef.current)
    }
  }, [])

  return {
    gridRef,
    refreshMasonryLayout,
    forceLayout,
    setZoom,
    updateAspectRatio,
    manualVisibilityCheck: () => new Set() // Placeholder for compatibility
  }
}
