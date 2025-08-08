import { useState, useEffect, useCallback, useMemo } from 'react'

export const useMasonryLayout = (videos, layoutMode, zoomLevel, containerWidth) => {
  const [itemPositions, setItemPositions] = useState([])
  const [containerHeight, setContainerHeight] = useState(0)
  const [containerWidth as number, setContainerWidth] = useState(0)
  const [aspectRatios, setAspectRatios] = useState(new Map())

  // Calculate grid measurements based on zoom and container size
  const gridConfig = useMemo(() => {
    if (!containerWidth) return null

    const zoomMultipliers = [0.75, 1, 1.5, 2] // small, medium, large, xlarge
    const baseColumnWidth = 200
    const scaledColumnWidth = baseColumnWidth * zoomMultipliers[zoomLevel || 1]
    const gap = 4
    
    // Calculate how many columns fit
    const columns = Math.max(1, Math.floor(containerWidth / (scaledColumnWidth + gap)))
    const actualColumnWidth = (containerWidth - (gap * (columns - 1))) / columns

    return {
      columns,
      columnWidth: actualColumnWidth,
      gap,
      rowHeight: 200 * zoomMultipliers[zoomLevel || 1] // for horizontal mode
    }
  }, [containerWidth, zoomLevel])

  // Calculate positions for vertical masonry (fixed width, variable height)
  const calculateVerticalMasonry = useCallback(() => {
    if (!gridConfig || videos.length === 0) return

    const { columns, columnWidth, gap } = gridConfig
    const columnHeights = new Array(columns).fill(0)
    const positions = []

    videos.forEach((video) => {
      const aspectRatio = aspectRatios.get(video.id) || (16/9)
      const contentHeight = Math.round(columnWidth / aspectRatio)
      const totalHeight = contentHeight + 30 // +30 for filename overlay

      // Find shortest column
      const shortestColumnIndex = columnHeights.indexOf(Math.min(...columnHeights))
      
      const position = {
        id: video.id,
        x: shortestColumnIndex * (columnWidth + gap),
        y: columnHeights[shortestColumnIndex],
        width: columnWidth,
        height: totalHeight,
        contentHeight: contentHeight
      }

      positions.push(position)
      columnHeights[shortestColumnIndex] += totalHeight + gap
    })

    setItemPositions(positions)
    setContainerHeight(Math.max(...columnHeights))
  }, [videos, aspectRatios, gridConfig])

  // Calculate positions for horizontal masonry (fixed height, variable width)
  const calculateHorizontalMasonry = useCallback(() => {
    if (!gridConfig || videos.length === 0) return

    const { rowHeight, gap } = gridConfig
    const viewportHeight = window.innerHeight - 200 // Account for header
    const maxRows = Math.max(1, Math.floor(viewportHeight / (rowHeight + gap)))
    const rowWidths = new Array(maxRows).fill(0)
    const positions = []

    videos.forEach((video) => {
      const aspectRatio = aspectRatios.get(video.id) || (16/9)
      const contentWidth = Math.round((rowHeight - 30) * aspectRatio) // -30 for filename
      const totalWidth = contentWidth

      // Find shortest row
      const shortestRowIndex = rowWidths.indexOf(Math.min(...rowWidths))
      
      const position = {
        id: video.id,
        x: rowWidths[shortestRowIndex],
        y: shortestRowIndex * (rowHeight + gap),
        width: totalWidth,
        height: rowHeight,
        contentHeight: rowHeight - 30
      }

      positions.push(position)
      rowWidths[shortestRowIndex] += totalWidth + gap
    })

    setItemPositions(positions)
    setContainerHeight(maxRows * (rowHeight + gap))
    setContainerWidth(Math.max(...rowWidths))
  }, [videos, aspectRatios, gridConfig])

  // Calculate grid positions (CSS Grid fallback)
  const calculateGridLayout = useCallback(() => {
    const positions = videos.map((video) => ({
      id: video.id,
      x: null, // Let CSS Grid handle positioning
      y: null,
      width: null,
      height: null,
      contentHeight: 140, // Fixed height for grid mode
      isGrid: true
    }))

    setItemPositions(positions)
    setContainerHeight(null) // Let CSS Grid handle height
    setContainerWidth(null)
  }, [videos])

  // Update aspect ratio when video loads
  const updateAspectRatio = useCallback((videoId, aspectRatio) => {
    setAspectRatios(prev => {
      const newMap = new Map(prev)
      newMap.set(videoId, aspectRatio)
      return newMap
    })
  }, [])

  // Recalculate layout when dependencies change
  useEffect(() => {
    if (layoutMode === 'masonry-vertical') {
      calculateVerticalMasonry()
    } else if (layoutMode === 'masonry-horizontal') {
      calculateHorizontalMasonry()
    } else {
      calculateGridLayout()
    }
  }, [layoutMode, calculateVerticalMasonry, calculateHorizontalMasonry, calculateGridLayout])

  // Force recalculation (for external triggers like zoom changes)
  const recalculateLayout = useCallback(() => {
    // Small delay to ensure any DOM changes have been applied
    setTimeout(() => {
      if (layoutMode === 'masonry-vertical') {
        calculateVerticalMasonry()
      } else if (layoutMode === 'masonry-horizontal') {
        calculateHorizontalMasonry()
      } else {
        calculateGridLayout()
      }
    }, 50)
  }, [layoutMode, calculateVerticalMasonry, calculateHorizontalMasonry, calculateGridLayout])

  return {
    itemPositions,
    containerHeight,
    containerWidth: containerWidth,
    updateAspectRatio,
    recalculateLayout,
    isMasonry: layoutMode.startsWith('masonry')
  }
}