import React, { useState, useEffect, useRef, useCallback } from 'react'

const VideoCard = ({ 
  video, 
  selected, 
  onSelect, 
  autoplayEnabled, 
  canPlayMoreVideos, 
  onVideoPlay, 
  onVideoPause,
  onVideoLoad, // Callback to report aspect ratio
  layoutMode // Current layout mode
}) => {
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [isVisible, setIsVisible] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const loadTimeoutRef = useRef(null)
  const hasLoadedRef = useRef(false)

  // Get video ID for tracking
  const videoId = video.id || video.fullPath || video.name

  // Intersection Observer for visibility detection
  useEffect(() => {
    if (!containerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const nowVisible = entry.isIntersecting
          setIsVisible(nowVisible)
          
          // Load video when it comes into view
          if (nowVisible && !loaded && !loading && !error && !hasLoadedRef.current) {
            loadVideo()
          }
          
          // Handle play/pause based on visibility and autoplay settings
          if (videoRef.current && loaded) {
            if (nowVisible && autoplayEnabled && canPlayMoreVideos() && !isPlaying) {
              playVideo()
            } else if (!nowVisible && isPlaying) {
              pauseVideo()
            }
          }
        })
      },
      {
        root: null,
        rootMargin: '50px 0px 100px 0px',
        threshold: [0, 0.1]
      }
    )

    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
    }
  }, [loaded, loading, error, autoplayEnabled, isPlaying])

  const loadVideo = useCallback(async () => {
    if (loading || loaded || error || hasLoadedRef.current) return

    hasLoadedRef.current = true
    setLoading(true)
    setError(null)

    try {
      const videoElement = document.createElement('video')
      videoElement.muted = true
      videoElement.loop = true
      videoElement.preload = 'metadata'
      videoElement.playsInline = true
      videoElement.className = 'video-element'
      
      // Store video ID for performance tracking
      videoElement.dataset.videoId = videoId
      
      // Basic styling - let CSS handle layout-specific sizing
      videoElement.style.width = '100%'
      videoElement.style.height = '100%'
      videoElement.style.objectFit = 'cover'
      videoElement.style.display = 'block'

      // Set up error handling
      const handleError = (e) => {
        console.error(`Video load error for ${video.name}:`, e.target?.error || e)
        clearTimeout(loadTimeoutRef.current)
        setLoading(false)
        hasLoadedRef.current = false
        
        let errorMessage = 'Load Error'
        
        if (e.target?.error?.message) {
          const msg = e.target.error.message
          if (msg.includes('DEMUXER_ERROR_NO_SUPPORTED_STREAMS') || 
              msg.includes('no supported streams')) {
            errorMessage = 'Codec Not Supported'
          } else if (msg.includes('DEMUXER_ERROR')) {
            errorMessage = 'Format Error'
          } else if (msg.includes('MEDIA_ELEMENT_ERROR')) {
            errorMessage = 'Media Error'
          }
        }
        
        setError({ message: errorMessage, type: 'load' })
      }

      // Set up success handling
      const handleLoad = () => {
        if (videoRef.current) return // Already loaded
        
        clearTimeout(loadTimeoutRef.current)
        setLoading(false)
        setLoaded(true)
        videoRef.current = videoElement

        // Report aspect ratio to parent for layout calculations
        if (videoElement.videoWidth && videoElement.videoHeight) {
          const aspectRatio = videoElement.videoWidth / videoElement.videoHeight
          onVideoLoad?.(videoId, aspectRatio)
        }
        
        // Better event handlers for loop management
        videoElement.addEventListener('ended', () => {
          // Reset and replay instead of relying on loop attribute
          if (videoElement && !videoElement.paused) {
            videoElement.currentTime = 0
            videoElement.play().catch(() => {
              // Ignore autoplay errors on loop
            })
          }
        })

        // Handle errors during playback
        videoElement.addEventListener('error', (e) => {
          console.warn('Playback error:', e)
          // Don't crash, just pause
          if (isPlaying) {
            pauseVideo()
          }
        })
        
        // Try to play if visible and autoplay is enabled
        if (isVisible && autoplayEnabled && canPlayMoreVideos()) {
          setTimeout(() => playVideo(), Math.random() * 500)
        }
      }

      // Set up timeout
      loadTimeoutRef.current = setTimeout(() => {
        handleError({ target: { error: { message: 'Loading timeout' } } })
      }, 10000)

      // Add event listeners
      videoElement.addEventListener('loadedmetadata', handleLoad)
      videoElement.addEventListener('canplay', handleLoad) 
      videoElement.addEventListener('error', handleError)

      // Set video source
      if (video.isElectronFile && video.fullPath) {
        videoElement.src = `file://${video.fullPath}`
      } else if (video.file) {
        videoElement.src = URL.createObjectURL(video.file)
      } else {
        throw new Error('No valid video source')
      }

    } catch (err) {
      console.error('Error setting up video:', err)
      setLoading(false)
      hasLoadedRef.current = false
      setError({ message: 'Setup Error', type: 'setup' })
    }
  }, [video, loading, loaded, error, isVisible, autoplayEnabled, videoId, onVideoLoad])

  const playVideo = useCallback(() => {
    if (!videoRef.current || isPlaying || !canPlayMoreVideos()) return

    const playPromise = videoRef.current.play()
    
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          setIsPlaying(true)
          onVideoPlay?.(videoId)
        })
        .catch((err) => {
          console.debug('Autoplay prevented or failed:', err)
          // Don't set playing state if play failed
        })
    }
  }, [isPlaying, canPlayMoreVideos, onVideoPlay, videoId])

  const pauseVideo = useCallback(() => {
    if (!videoRef.current || !isPlaying) return

    try {
      videoRef.current.pause()
      setIsPlaying(false)
      onVideoPause?.(videoId)
    } catch (err) {
      console.warn('Error pausing video:', err)
      // Still update state even if pause failed
      setIsPlaying(false)
      onVideoPause?.(videoId)
    }
  }, [isPlaying, onVideoPause, videoId])

  // Handle autoplay changes
  useEffect(() => {
    if (!autoplayEnabled && isPlaying) {
      pauseVideo()
    } else if (autoplayEnabled && isVisible && loaded && !isPlaying && canPlayMoreVideos()) {
      playVideo()
    }
  }, [autoplayEnabled, isVisible, loaded, isPlaying, canPlayMoreVideos, playVideo, pauseVideo])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current)
      }
      if (videoRef.current) {
        try {
          // Clean up source
          if (videoRef.current.src?.startsWith('blob:')) {
            URL.revokeObjectURL(videoRef.current.src)
          }
          
          videoRef.current.pause()
          videoRef.current.removeAttribute('src')
          videoRef.current.load()
        } catch (err) {
          console.warn('Error during video cleanup:', err)
        }
      }
      
      hasLoadedRef.current = false
    }
  }, [])

  const handleClick = (e) => {
    e.stopPropagation()
    onSelect(videoId, e.ctrlKey || e.metaKey)
  }

  const handleContextMenu = (e) => {
    e.preventDefault()
    console.log('Context menu for:', video.name)
  }

  // Get placeholder content based on layout mode
  const getPlaceholderContent = () => {
    if (error) {
      return (
        <div className="error-indicator">
          ❌<br />
          {error.message}
        </div>
      )
    } else if (loading) {
      return (
        <div className="video-placeholder">
          📼 Loading...
        </div>
      )
    } else {
      return (
        <div className="video-placeholder">
          📼 Scroll to load
        </div>
      )
    }
  }

  return (
    <div 
      ref={containerRef}
      className={`video-item ${selected ? 'selected' : ''} ${error ? 'error' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      data-filename={video.name}
      data-video-id={videoId}
      data-loaded={loaded.toString()}
    >
      {loaded && videoRef.current ? (
        <div 
          className="video-container"
          ref={(container) => {
            if (container && videoRef.current && !container.contains(videoRef.current)) {
              container.appendChild(videoRef.current)
            }
          }}
        />
      ) : (
        getPlaceholderContent()
      )}
      
      <div className="video-filename">
        {video.name}
      </div>
    </div>
  )
}

export default VideoCard