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
      }

      // Calculate item height based on fixed width and aspect ratio
      const contentHeight = Math.round(columnWidth / aspectRatio)
      const itemHeight = contentHeight + 30 // Add space for filename

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
        videoContainer.style.height = `${contentHeight}px`
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

    // Get the container width and fixed height
    const containerWidth = grid.clientWidth - 32 // Account for padding
    const fixedHeight = 200 // Base fixed height
    const contentHeight = fixedHeight - 30 // Subtract filename space
    const gap = 4
    
    // Start laying out videos row by row
    let currentRowWidth = 0
    let currentRowY = 0
    let rowVideos = []
    const allRows = []
    
    // Get all video items
    const videoItems = Array.from(grid.querySelectorAll('.video-item'))
    
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

      // Calculate item width based on fixed height and aspect ratio
      const itemWidth = Math.round(contentHeight * aspectRatio)

      // Check if this video fits in the current row
      if (currentRowWidth + itemWidth <= containerWidth || rowVideos.length === 0) {
        // Add to current row
        rowVideos.push({ videoItem, width: itemWidth, aspectRatio })
        currentRowWidth += itemWidth + (rowVideos.length > 1 ? gap : 0)
      } else {
        // Start new row - first save the current row
        if (rowVideos.length > 0) {
          allRows.push({ videos: rowVideos, y: currentRowY })
          currentRowY += fixedHeight + gap
        }
        
        // Start new row with this video
        rowVideos = [{ videoItem, width: itemWidth, aspectRatio }]
        currentRowWidth = itemWidth
      }

      // If this is the last video, save the current row
      if (index === videoItems.length - 1 && rowVideos.length > 0) {
        allRows.push({ videos: rowVideos, y: currentRowY })
      }
    })

    // Now position all videos
    allRows.forEach(row => {
      let currentX = 0
      
      row.videos.forEach(({ videoItem, width }) => {
        // Position the item
        videoItem.style.position = 'absolute'
        videoItem.style.left = `${currentX}px`
        videoItem.style.top = `${row.y}px`
        videoItem.style.width = `${width}px`
        videoItem.style.height = `${fixedHeight}px`

        // Update the video container styling
        const videoContainer = videoItem.querySelector('.video-container, .video-placeholder, .error-indicator')
        if (videoContainer) {
          videoContainer.style.height = `${contentHeight}px`
        }

        currentX += width + gap
      })
    })

    // Set grid container height (no horizontal overflow)
    const totalHeight = allRows.length > 0 ? (allRows.length * (fixedHeight + gap)) : fixedHeight
    grid.style.height = `${totalHeight}px`
    grid.style.width = '100%' // Don't expand horizontally
    grid.style.position = 'relative'
    grid.style.overflowX = 'visible' // No horizontal scroll
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
      
      // Reset video container styling - let CSS handle it
      const videoContainer = videoItem.querySelector('.video-container, .video-placeholder, .error-indicator')
      if (videoContainer) {
        videoContainer.style.height = ''
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

    // Apply the layout immediately
    if (mode === 'masonry-vertical') {
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
    const handleResize = () => {
      clearTimeout(resizeTimeoutRef.current)

      // Only handle resize AFTER user stops resizing for 500ms
      resizeTimeoutRef.current = setTimeout(() => {
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
      }, 500)
    }

    window.addEventListener('resize', handleResize)
    
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(resizeTimeoutRef.current)
    }
  }, [layoutMode, initializeMasonryGrid])

  const toggleLayout = useCallback(() => {
    const modes = ['grid', 'masonry-vertical', 'masonry-horizontal']
    const currentIndex = modes.indexOf(layoutMode)
    const nextIndex = (currentIndex + 1) % modes.length
    const newMode = modes[nextIndex]
    
    setLayoutMode(newMode)
    
    // Apply layout immediately after state change
    setTimeout(() => {
      applyLayout(newMode)
    }, 50)
    
    return newMode
  }, [layoutMode, applyLayout])

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
    if (layoutMode !== 'grid') {
      initializeMasonryGrid()
    }
  }, [initializeMasonryGrid, layoutMode])

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
    
    // Remove all zoom classes
    zoomLevels.forEach(cls => grid.classList.remove(cls))
    // Add the new zoom class
    grid.classList.add(zoomLevels[level])

    // Refresh layout after zoom change
    clearTimeout(masonryLayoutTimeoutRef.current)
    masonryLayoutTimeoutRef.current = setTimeout(() => {
      cachedGridMeasurementsRef.current = null
      if (layoutMode !== 'grid') {
        initializeMasonryGrid()
      }
    }, 300)
  }, [initializeMasonryGrid, layoutMode])

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
    
    // Refresh layout if this is a masonry mode
    if (layoutMode !== 'grid') {
      setTimeout(() => {
        refreshMasonryLayout()
      }, 100)
    }
  }, [layoutMode, refreshMasonryLayout])

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
    updateAspectRatio,
    manualVisibilityCheck: () => new Set() // Placeholder for compatibility
  }
}