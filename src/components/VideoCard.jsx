import React, { useState, useEffect, useRef, useCallback } from 'react'

const VideoCard = ({ video, selected, onSelect, autoplayEnabled, canPlayMoreVideos, onVideoPlay, onVideoPause }) => {
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [isVisible, setIsVisible] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  
  const videoRef = useRef(null)
  const containerRef = useRef(null)
  const loadTimeoutRef = useRef(null)

  // Intersection Observer for visibility detection
  useEffect(() => {
    if (!containerRef.current) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const wasVisible = isVisible
          const nowVisible = entry.isIntersecting
          
          setIsVisible(nowVisible)
          
          // Load video when it comes into view
          if (nowVisible && !loaded && !loading && !error) {
            loadVideo()
          }
          
          // Handle play/pause based on visibility
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
  }, [loaded, loading, error, isVisible, autoplayEnabled, canPlayMoreVideos, isPlaying])

  const loadVideo = useCallback(async () => {
    if (loading || loaded || error) return

    setLoading(true)
    setError(null)

    try {
      const videoElement = document.createElement('video')
      videoElement.muted = true
      videoElement.loop = true
      videoElement.preload = 'metadata'
      videoElement.playsInline = true
      videoElement.className = 'video-element'

      // Set up error handling
      const handleError = (e) => {
        console.error(`Video load error for ${video.name}:`, e.target?.error)
        setLoading(false)
        
        let errorMessage = 'Load Error'
        let errorType = 'unknown'
        
        if (e.target?.error?.message) {
          const msg = e.target.error.message
          if (msg.includes('DEMUXER_ERROR_NO_SUPPORTED_STREAMS') || 
              msg.includes('no supported streams')) {
            errorMessage = 'Codec Not Supported (H.265/HEVC)'
            errorType = 'codec'
          } else if (msg.includes('DEMUXER_ERROR')) {
            errorMessage = 'Format Error'
            errorType = 'format'
          } else if (msg.includes('MEDIA_ELEMENT_ERROR')) {
            errorMessage = 'Media Error'
            errorType = 'media'
          }
        }
        
        setError({ message: errorMessage, type: errorType })
      }

      // Set up success handling
      const handleLoad = () => {
        if (videoRef.current) return // Already loaded
        
        setLoading(false)
        setLoaded(true)
        videoRef.current = videoElement
        
        // Try to play if visible and autoplay is enabled
        if (isVisible && autoplayEnabled && canPlayMoreVideos()) {
          setTimeout(() => playVideo(), Math.random() * 500)
        }
      }

      // Set up timeout
      loadTimeoutRef.current = setTimeout(() => {
        handleError({ target: { error: { message: 'Loading timeout' } } })
      }, 15000)

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
      setError({ message: 'Setup Error', type: 'setup' })
    }
  }, [video, loading, loaded, error, isVisible, autoplayEnabled, canPlayMoreVideos])

  const playVideo = useCallback(() => {
    if (!videoRef.current || isPlaying || !canPlayMoreVideos()) return

    videoRef.current.play()
      .then(() => {
        setIsPlaying(true)
        onVideoPlay?.(video.id)
      })
      .catch((err) => {
        console.debug('Autoplay prevented:', err)
      })
  }, [isPlaying, canPlayMoreVideos, onVideoPlay, video.id])

  const pauseVideo = useCallback(() => {
    if (!videoRef.current || !isPlaying) return

    videoRef.current.pause()
    setIsPlaying(false)
    onVideoPause?.(video.id)
  }, [isPlaying, onVideoPause, video.id])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current)
      }
      if (videoRef.current) {
        if (videoRef.current.src?.startsWith('blob:')) {
          URL.revokeObjectURL(videoRef.current.src)
        }
        videoRef.current.pause()
        videoRef.current.removeAttribute('src')
        videoRef.current.load()
      }
    }
  }, [])

  const handleClick = (e) => {
    e.stopPropagation()
    onSelect(video.id, e.ctrlKey || e.metaKey)
  }

  const handleContextMenu = (e) => {
    e.preventDefault()
    // TODO: Implement context menu
    console.log('Context menu for:', video.name)
  }

  return (
    <div 
      ref={containerRef}
      className={`video-item ${selected ? 'selected' : ''} ${error ? 'error' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      data-filename={video.name}
      data-loaded={loaded.toString()}
    >
      {error ? (
        <div className="error-indicator">
          ❌<br />
          {error.message}
        </div>
      ) : loaded && videoRef.current ? (
        <div 
          className="video-container"
          ref={(container) => {
            if (container && videoRef.current && !container.contains(videoRef.current)) {
              container.appendChild(videoRef.current)
            }
          }}
        />
      ) : (
        <div className="video-placeholder">
          {loading ? '📼 Loading...' : '📼 Scroll to load'}
        </div>
      )}
      
      <div className="video-filename">
        {video.name}
      </div>
    </div>
  )
}

export default VideoCard