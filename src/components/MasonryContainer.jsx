import React, { useRef, useEffect, useState } from 'react'
import { useMasonryLayout } from '../hooks/useMasonryLayout'

export const MasonryContainer = ({ 
  videos, 
  layoutMode, 
  zoomLevel, 
  children,
  onLayoutModeChange 
}) => {
  const containerRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(0)
  
  const { 
    itemPositions, 
    containerHeight, 
    containerWidth: calculatedWidth,
    updateAspectRatio,
    recalculateLayout,
    isMasonry
  } = useMasonryLayout(videos, layoutMode, zoomLevel, containerWidth)

  // Measure container width and handle resize
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        const newWidth = containerRef.current.clientWidth
        setContainerWidth(newWidth)
      }
    }

    updateWidth()
    
    let resizeTimeout
    const handleResize = () => {
      clearTimeout(resizeTimeout)
      resizeTimeout = setTimeout(updateWidth, 100) // Debounce resize
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(resizeTimeout)
    }
  }, [])

  // Recalculate layout when zoom changes
  useEffect(() => {
    recalculateLayout()
  }, [zoomLevel, recalculateLayout])

  // Container styles based on layout mode
  const containerStyles = {
    position: isMasonry ? 'relative' : 'static',
    height: containerHeight ? `${containerHeight}px` : 'auto',
    width: layoutMode === 'masonry-horizontal' && calculatedWidth ? `${calculatedWidth}px` : '100%',
    overflowX: layoutMode === 'masonry-horizontal' ? 'auto' : 'visible',
    overflowY: layoutMode === 'masonry-horizontal' ? 'hidden' : 'visible'
  }

  // Create a position lookup for quick access
  const positionLookup = itemPositions.reduce((acc, pos) => {
    acc[pos.id] = pos
    return acc
  }, {})

  return (
    <div 
      ref={containerRef}
      className={`video-grid ${layoutMode} zoom-${['small', 'medium', 'large', 'xlarge'][zoomLevel]}`}
      style={containerStyles}
    >
      {React.Children.map(children, (child, index) => {
        const video = videos[index]
        if (!video) return child

        const position = positionLookup[video.id]
        if (!position) return child

        // For masonry modes, apply absolute positioning
        if (isMasonry) {
          const itemStyle = {
            position: 'absolute',
            left: `${position.x}px`,
            top: `${position.y}px`,
            width: `${position.width}px`,
            height: `${position.height}px`,
            transition: 'none' // Disable transitions during layout
          }

          return React.cloneElement(child, {
            key: video.id,
            style: itemStyle,
            contentHeight: position.contentHeight,
            onVideoLoad: (aspectRatio) => updateAspectRatio(video.id, aspectRatio),
            layoutMode: layoutMode
          })
        }

        // For grid mode, let CSS Grid handle positioning
        return React.cloneElement(child, {
          key: video.id,
          contentHeight: position.contentHeight,
          onVideoLoad: (aspectRatio) => updateAspectRatio(video.id, aspectRatio),
          layoutMode: layoutMode
        })
      })}
    </div>
  )
}

export default MasonryContainer