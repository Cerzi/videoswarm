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
        // Suppress console logging for known codec issues to reduce noise
        const isCodecError = e.target?.error?.message?.includes('DEMUXER_ERROR_NO_SUPPORTED_STREAMS') || 
                            e.target?.error?.message?.includes('no supported streams')
        
        if (!isCodecError) {
          console.error(`Video load error for ${video.name}:`, e.target?.error || e)
        } else {
          console.debug(`Codec not supported for ${video.name} (H.265/HEVC)`)
        }
        
        clearTimeout(loadTimeoutRef.current)
        setLoading(false)
        hasLoadedRef.current = false
        
        let errorMessage = 'Load Error'
        let errorType = 'load'
        
        if (e.target?.error?.message) {
          const msg = e.target.error.message
          if (msg.includes('DEMUXER_ERROR_NO_SUPPORTED_STREAMS') || 
              msg.includes('no supported streams')) {
            errorMessage = 'Unsupported Codec'
            errorType = 'codec'
          } else if (msg.includes('DEMUXER_ERROR')) {
            errorMessage = 'Format Error'
            errorType = 'format'
          } else if (msg.includes('MEDIA_ELEMENT_ERROR')) {
            errorMessage = 'Media Error'
            errorType = 'media'
          } else if (msg.includes('NETWORK_ERROR')) {
            errorMessage = 'Network Error'
            errorType = 'network'
          }
        }
        
        setError({ message: errorMessage, type: errorType })
      }

      // Set up success handling with better error catching
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
            videoElement.play().catch((playError) => {
              // Silently ignore autoplay errors on loop
              console.debug('Autoplay prevented on loop:', playError)
            })
          }
        })

        // Handle errors during playback - catch and suppress
        videoElement.addEventListener('error', (playbackError) => {
          console.debug('Playback error (handled):', playbackError)
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

      // Set up timeout with better error handling
      loadTimeoutRef.current = setTimeout(() => {
        handleError({ 
          target: { 
            error: { 
              message: 'Loading timeout - video took too long to load' 
            } 
          } 
        })
      }, 10000)

      // Add event listeners with error suppression
      videoElement.addEventListener('loadedmetadata', handleLoad)
      videoElement.addEventListener('canplay', handleLoad) 
      videoElement.addEventListener('error', handleError)

      // Wrap video source setting in try-catch
      try {
        if (video.isElectronFile && video.fullPath) {
          videoElement.src = `file://${video.fullPath}`
        } else if (video.file) {
          videoElement.src = URL.createObjectURL(video.file)
        } else {
          throw new Error('No valid video source available')
        }
      } catch (srcError) {
        console.debug('Error setting video source:', srcError)
        handleError({ 
          target: { 
            error: { 
              message: `Source error: ${srcError.message}` 
            } 
          } 
        })
        return // Don't continue if source setting failed
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

    try {
      const playPromise = videoRef.current.play()
      
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            setIsPlaying(true)
            onVideoPlay?.(videoId)
          })
          .catch((err) => {
            console.debug('Autoplay prevented or failed (handled):', err)
            // Don't set playing state if play failed
          })
      }
    } catch (playError) {
      console.debug('Play error caught:', playError)
      // Don't crash the app for play errors
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
      const getErrorIcon = () => {
        switch (error.type) {
          case 'codec': return '🎞️'
          case 'format': return '📄'
          case 'network': return '🌐'
          case 'media': return '📹'
          default: return '❌'
        }
      }

      const getErrorDescription = () => {
        switch (error.type) {
          case 'codec': return 'Unsupported video codec (likely H.265/HEVC)'
          case 'format': return 'Unsupported video format'
          case 'network': return 'Network error loading video'
          case 'media': return 'Media playback error'
          default: return error.message
        }
      }

      return (
        <div className={`error-indicator error-${error.type}`}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
            {getErrorIcon()}
          </div>
          <div style={{ fontSize: '0.7rem', fontWeight: 'bold', marginBottom: '0.25rem' }}>
            {error.message}
          </div>
          <div style={{ fontSize: '0.6rem', opacity: 0.8, lineHeight: 1.2 }}>
            {getErrorDescription()}
          </div>
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