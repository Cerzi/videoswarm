import React, { useState, useEffect, useRef, useCallback, memo } from 'react';

const VideoCard = memo(({ 
  video, 
  selected, 
  onSelect, 
  layoutMode,
  showFilenames = true,
  onContextMenu,
  onVideoLoad,
  
  // Commands from VideoManager (PURE INPUTS)
  shouldPlay,
  shouldLoad,
  canLoadMore,
  
  // Event reporting to VideoManager (PURE OUTPUTS)
  onVisibilityChange,
  onLoadStart,
  onLoadComplete,
  onLoadError
}) => {
  // Local UI state only (not shared with parent)
  const [error, setError] = useState(null);
  const [localLoading, setLocalLoading] = useState(false);
  
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const loadTimeoutRef = useRef(null);
  const clickTimeoutRef = useRef(null);
  const hasAttemptedLoadRef = useRef(false);
  const observerRef = useRef(null); // Use ref instead of state

  const videoId = video.id || video.fullPath || video.name;

  // PURE: Load video function - reports events, doesn't manage global state
  const loadVideo = useCallback(async () => {
    if (hasAttemptedLoadRef.current || localLoading || videoRef.current) return;

    hasAttemptedLoadRef.current = true;
    setLocalLoading(true);
    setError(null);
    
    // PURE: Report load start
    onLoadStart?.(videoId);

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
        clearTimeout(loadTimeoutRef.current);
        setLocalLoading(false);
        hasAttemptedLoadRef.current = false;
        
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
        
        // PURE: Report error
        onLoadError?.(videoId);
      };

      const handleLoad = () => {
        if (videoRef.current) return; // Already loaded
        
        clearTimeout(loadTimeoutRef.current);
        setLocalLoading(false);
        videoRef.current = videoElement;

        let aspectRatio = 16/9; // Default
        if (videoElement.videoWidth && videoElement.videoHeight) {
          aspectRatio = videoElement.videoWidth / videoElement.videoHeight;
        }
        
        // PURE: Report load complete with aspect ratio
        onLoadComplete?.(videoId, aspectRatio);
        
        // Also report to layout manager if provided
        onVideoLoad?.(videoId, aspectRatio);
      };

      // Timeout after 10 seconds
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

      // Set video source
      if (video.isElectronFile && video.fullPath) {
        videoElement.src = `file://${video.fullPath}`;
      } else if (video.file) {
        videoElement.src = URL.createObjectURL(video.file);
      } else {
        throw new Error('No valid video source available');
      }

    } catch (err) {
      console.error('Error setting up video:', err);
      setLocalLoading(false);
      hasAttemptedLoadRef.current = false;
      setError({ message: 'Setup Error', type: 'setup' });
      onLoadError?.(videoId);
    }
  }, [video, videoId, onLoadStart, onLoadComplete, onLoadError, onVideoLoad, localLoading]);

  // Listen for layout switch reset events
  useEffect(() => {
    const handleResetLoading = () => {
      console.log(`🔄 VideoCard ${video.name}: Resetting for layout switch`);
      hasAttemptedLoadRef.current = false;
      setLocalLoading(false);
      setError(null);
    };

    window.addEventListener('resetVideoLoading', handleResetLoading);
    return () => window.removeEventListener('resetVideoLoading', handleResetLoading);
  }, [video.name]); // Removed intersectionObserver dependency

  // PURE: Intersection observer - only reports, doesn't decide  
  useEffect(() => {
    if (!containerRef.current) return;

    // Disconnect existing observer if any
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const isVisible = entry.isIntersecting;
          // PURE: Just report visibility, let VideoManager decide what to do
          onVisibilityChange?.(videoId, isVisible);
        });
      },
      {
        root: null,
        rootMargin: '50px 0px 100px 0px',
        threshold: [0, 0.1]
      }
    );

    observer.observe(containerRef.current);
    observerRef.current = observer;
    
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
    };
  }, [videoId, onVisibilityChange]); // Stable dependencies

  // PURE: Load video when VideoManager says we should
  useEffect(() => {
    if (shouldLoad && !videoRef.current && !localLoading && !error && !hasAttemptedLoadRef.current && canLoadMore) {
      console.log(`🎬 VideoCard ${video.name}: Attempting to load (shouldLoad=${shouldLoad}, canLoadMore=${canLoadMore})`);
      loadVideo();
    }
  }, [shouldLoad, canLoadMore, localLoading, error, loadVideo]);

  // PURE: Play/pause video when VideoManager says we should
  useEffect(() => {
    if (!videoRef.current) return;

    const videoElement = videoRef.current;

    if (shouldPlay && videoElement.paused) {
      videoElement.play().catch(console.debug);
    } else if (!shouldPlay && !videoElement.paused) {
      videoElement.pause();
    }
  }, [shouldPlay]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
      }
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
      if (observerRef.current) {
        observerRef.current.disconnect();
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
      hasAttemptedLoadRef.current = false;
    };
  }, []); // No dependencies - only run on mount/unmount

  // Click handlers
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
    onContextMenu?.(e, video);
  }, [onContextMenu, video]);

  // Determine what to show
  const getContent = () => {
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
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100%', background: 'linear-gradient(135deg, #2d1a1a, #3d2d2d)', color: '#ff6b6b',
          textAlign: 'center', padding: '1rem', fontSize: '0.8rem'
        }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{getErrorIcon()}</div>
          <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{error.message}</div>
          <div style={{ opacity: 0.8, lineHeight: 1.2 }}>
            {error.type === 'codec' ? 'Unsupported video codec (likely H.265/HEVC)' : error.message}
          </div>
        </div>
      );
    } 
    
    if (localLoading) {
      return (
        <div className="video-placeholder" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
          background: 'linear-gradient(135deg, #1a1a1a, #2d2d2d)', color: '#888', fontSize: '0.9rem'
        }}>
          📼 Loading...
        </div>
      );
    } 
    
    if (!canLoadMore) {
      return (
        <div className="video-placeholder" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
          background: 'linear-gradient(135deg, #1a1a1a, #2d2d2d)', color: '#666', fontSize: '0.9rem'
        }}>
          ⏳ Waiting...
        </div>
      );
    } 
    
    return (
      <div className="video-placeholder" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
        background: 'linear-gradient(135deg, #1a1a1a, #2d2d2d)', color: '#666', fontSize: '0.9rem'
      }}>
        📼 Scroll to load
      </div>
    );
  };

  return (
    <div 
      ref={containerRef}
      className={`video-item ${selected ? 'selected' : ''} ${error ? 'error' : ''} ${localLoading ? 'loading' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      data-filename={video.name}
      data-video-id={videoId}
      data-loaded={!!videoRef.current}
      style={{ 
        userSelect: 'none', position: 'relative', width: '100%', height: '100%',
        borderRadius: '8px', overflow: 'hidden', cursor: 'pointer',
        border: selected ? '3px solid #007acc' : '1px solid #333', background: '#1a1a1a'
      }}
    >
      {videoRef.current ? (
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
          {getContent()}
        </div>
      )}
      
      {showFilenames && (
        <div className="video-filename" style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: '40px',
          background: 'rgba(0, 0, 0, 0.8)', color: '#fff', padding: '8px',
          fontSize: '0.75rem', lineHeight: '1.2', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center'
        }}>
          {video.name}
        </div>
      )}
    </div>
  );
});

VideoCard.displayName = 'VideoCard';

export default VideoCard;