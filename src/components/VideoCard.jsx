import React, { useState, useEffect, useRef, useCallback, memo } from 'react';

const VideoCard = memo(({ 
  video, 
  selected, 
  onSelect, 
  canPlayMoreVideos,
  onVideoPlay,
  onVideoPause,
  onVideoLoad,
  showFilenames = true,
  onContextMenu,
  
  // Performance props
  canLoadMoreVideos,
  isLoading,
  isLoaded,
  isVisible,
  isPlaying,
  onStartLoading,
  onStopLoading,
  onVisibilityChange
}) => {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [visible, setVisible] = useState(false);
  
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const loadTimeoutRef = useRef(null);
  const clickTimeoutRef = useRef(null);
  const hasLoadedRef = useRef(false);

  const videoId = video.id || video.fullPath || video.name;

  // Sync with parent state
  useEffect(() => {
    setLoaded(isLoaded);
    setLoading(isLoading);
    setVisible(isVisible);
  }, [isLoaded, isLoading, isVisible]);

  // DEBUGGING: Removed console log spam

  // SIMPLIFIED: Only handle visibility detection
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const nowVisible = entry.isIntersecting;
          setVisible(nowVisible);
          
          // Report visibility to parent - that's ALL we do
          onVisibilityChange?.(videoId, nowVisible);
          
          // Load video when it becomes visible
          if (nowVisible && !loaded && !loading && !error && !hasLoadedRef.current && canLoadMoreVideos()) {
            loadVideo();
          }
        });
      },
      {
        root: null,
        rootMargin: '50px 0px 100px 0px',
        threshold: [0, 0.1]
      }
    );

    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [loaded, loading, error, canLoadMoreVideos, onVisibilityChange, videoId]);

  // FIXED: Respond to parent's isPlaying prop AND report actual state
  useEffect(() => {
    if (!videoRef.current || !loaded) return;

    const videoElement = videoRef.current;

    if (isPlaying && videoElement.paused) {
      // Parent says we should be playing
      console.log(`Starting video: ${video.name}`);
      videoElement.play()
        .then(() => {
          console.log(`✓ Video playing: ${video.name}`);
          onVideoPlay?.(videoId); // Report actual play
        })
        .catch((err) => {
          console.log(`✗ Video play failed: ${video.name}`, err);
          onVideoPause?.(videoId); // Report that we're not actually playing
        });
    } else if (!isPlaying && !videoElement.paused) {
      // Parent says we should be paused
      console.log(`Pausing video: ${video.name}`);
      videoElement.pause();
      onVideoPause?.(videoId); // Report actual pause
    }
  }, [isPlaying, loaded, video.name, videoId, onVideoPlay, onVideoPause]);

  // ALSO ADD: Direct event listeners on the video element to catch any state changes
  useEffect(() => {
    if (!videoRef.current) return;

    const videoElement = videoRef.current;

    const handlePlay = () => {
      console.log(`🎬 Video actually started playing: ${video.name}`);
      onVideoPlay?.(videoId);
    };

    const handlePause = () => {
      console.log(`⏸️ Video actually paused: ${video.name}`);
      onVideoPause?.(videoId);
    };

    const handleEnded = () => {
      console.log(`🔄 Video ended, restarting: ${video.name}`);
      if (videoElement && !videoElement.paused) {
        videoElement.currentTime = 0;
        videoElement.play().catch(console.debug);
      }
    };

    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('ended', handleEnded);

    return () => {
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('ended', handleEnded);
    };
  }, [loaded, video.name, videoId, onVideoPlay, onVideoPause]);

  // CALLBACK: Load video function
  const loadVideo = useCallback(async () => {
    if (loading || loaded || error || hasLoadedRef.current || !canLoadMoreVideos()) return;

    hasLoadedRef.current = true;
    setLoading(true);
    setError(null);
    
    onStartLoading?.(videoId);

    try {
      const videoElement = document.createElement('video');
      videoElement.muted = true;
      videoElement.loop = true;
      videoElement.preload = 'metadata';
      videoElement.playsInline = true;
      videoElement.className = 'video-element';
      
      videoElement.dataset.videoId = videoId;
      videoElement.style.width = '100%';
      videoElement.style.height = '100%';
      videoElement.style.objectFit = 'cover';
      videoElement.style.display = 'block';

      const handleError = (e) => {
        const isCodecError = e.target?.error?.message?.includes('DEMUXER_ERROR_NO_SUPPORTED_STREAMS') || 
                            e.target?.error?.message?.includes('no supported streams');
        
        if (!isCodecError) {
          console.error(`Video load error for ${video.name}:`, e.target?.error || e);
        }
        
        clearTimeout(loadTimeoutRef.current);
        setLoading(false);
        hasLoadedRef.current = false;
        
        onStopLoading?.(videoId);
        
        let errorMessage = 'Load Error';
        let errorType = 'load';
        
        if (e.target?.error?.message) {
          const msg = e.target.error.message;
          if (msg.includes('DEMUXER_ERROR_NO_SUPPORTED_STREAMS') || 
              msg.includes('no supported streams')) {
            errorMessage = 'Unsupported Codec';
            errorType = 'codec';
          } else if (msg.includes('DEMUXER_ERROR')) {
            errorMessage = 'Format Error';
            errorType = 'format';
          }
        }
        
        setError({ message: errorMessage, type: errorType });
      };

      const handleLoad = () => {
        if (videoRef.current) return;
        
        clearTimeout(loadTimeoutRef.current);
        setLoading(false);
        setLoaded(true);
        videoRef.current = videoElement;

        onStopLoading?.(videoId);
        
        if (videoElement.videoWidth && videoElement.videoHeight) {
          const aspectRatio = videoElement.videoWidth / videoElement.videoHeight;
          onVideoLoad?.(videoId, aspectRatio);
        }
      };

      loadTimeoutRef.current = setTimeout(() => {
        handleError({ 
          target: { 
            error: { 
              message: 'Loading timeout - video took too long to load' 
            } 
          } 
        });
      }, 10000);

      videoElement.addEventListener('loadedmetadata', handleLoad);
      videoElement.addEventListener('canplay', handleLoad); 
      videoElement.addEventListener('error', handleError);

      if (video.isElectronFile && video.fullPath) {
        videoElement.src = `file://${video.fullPath}`;
      } else if (video.file) {
        videoElement.src = URL.createObjectURL(video.file);
      } else {
        throw new Error('No valid video source available');
      }

    } catch (err) {
      console.error('Error setting up video:', err);
      setLoading(false);
      hasLoadedRef.current = false;
      onStopLoading?.(videoId);
      setError({ message: 'Setup Error', type: 'setup' });
    }
  }, [video, loading, loaded, error, videoId, onVideoLoad, onStartLoading, onStopLoading, canLoadMoreVideos]);

  // Cleanup and click handlers
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
      if (videoRef.current) {
        try {
          if (videoRef.current.src?.startsWith('blob:')) {
            URL.revokeObjectURL(videoRef.current.src);
          }
          videoRef.current.pause();
          videoRef.current.removeAttribute('src');
          videoRef.current.load();
        } catch (err) {
          console.warn('Error during video cleanup:', err);
        }
      }
      hasLoadedRef.current = false;
    };
  }, []);

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
      onSelect(videoId, e.ctrlKey || e.metaKey, true);
      return;
    }
    
    clickTimeoutRef.current = setTimeout(() => {
      onSelect(videoId, e.ctrlKey || e.metaKey, false);
      clickTimeoutRef.current = null;
    }, 300);
  }, [onSelect, videoId]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (onContextMenu) {
      onContextMenu(e, video);
    }
  }, [onContextMenu, video]);

  const getPlaceholderContent = useCallback(() => {
    if (error) {
      const getErrorIcon = () => {
        switch (error.type) {
          case 'codec': return '🎞️';
          case 'format': return '📄';
          case 'network': return '🌐';
          default: return '❌';
        }
      };

      return (
        <div className={`error-indicator error-${error.type}`} style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: 'linear-gradient(135deg, #2d1a1a, #3d2d2d)',
          color: '#ff6b6b',
          textAlign: 'center',
          padding: '1rem',
          fontSize: '0.8rem'
        }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
            {getErrorIcon()}
          </div>
          <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
            {error.message}
          </div>
          <div style={{ opacity: 0.8, lineHeight: 1.2 }}>
            {error.type === 'codec' ? 'Unsupported video codec (likely H.265/HEVC)' : error.message}
          </div>
        </div>
      );
    } else if (loading) {
      return (
        <div className="video-placeholder" style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: 'linear-gradient(135deg, #1a1a1a, #2d2d2d)',
          color: '#888',
          fontSize: '0.9rem'
        }}>
          📼 Loading...
        </div>
      );
    } else if (!canLoadMoreVideos()) {
      return (
        <div className="video-placeholder" style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: 'linear-gradient(135deg, #1a1a1a, #2d2d2d)',
          color: '#666',
          fontSize: '0.9rem'
        }}>
          ⏳ Waiting...
        </div>
      );
    } else {
      return (
        <div className="video-placeholder" style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          background: 'linear-gradient(135deg, #1a1a1a, #2d2d2d)',
          color: '#666',
          fontSize: '0.9rem'
        }}>
          📼 Scroll to load
        </div>
      );
    }
  }, [error, loading, canLoadMoreVideos]);

  return (
    <div 
      ref={containerRef}
      className={`video-item ${selected ? 'selected' : ''} ${error ? 'error' : ''} ${loading ? 'loading' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      data-filename={video.name}
      data-video-id={videoId}
      data-loaded={loaded.toString()}
      style={{ 
        userSelect: 'none',
        position: 'relative',
        width: '100%',
        height: '100%',
        borderRadius: '8px',
        overflow: 'hidden',
        cursor: 'pointer',
        border: selected ? '3px solid #007acc' : '1px solid #333',
        background: '#1a1a1a'
      }}
    >
      {loaded && videoRef.current ? (
        <div 
          className="video-container"
          style={{ width: '100%', height: showFilenames ? 'calc(100% - 40px)' : '100%' }}
          ref={(container) => {
            if (container && videoRef.current && !container.contains(videoRef.current)) {
              container.appendChild(videoRef.current);
            }
          }}
        />
      ) : (
        <div style={{ width: '100%', height: showFilenames ? 'calc(100% - 40px)' : '100%' }}>
          {getPlaceholderContent()}
        </div>
      )}
      
      {showFilenames && (
        <div className="video-filename" style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '40px',
          background: 'rgba(0, 0, 0, 0.8)',
          color: '#fff',
          padding: '8px',
          fontSize: '0.75rem',
          lineHeight: '1.2',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center'
        }}>
          {video.name}
        </div>
      )}
    </div>
  );
});

VideoCard.displayName = 'VideoCard';

export default VideoCard;