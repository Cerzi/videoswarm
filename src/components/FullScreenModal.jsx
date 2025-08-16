import React, { useEffect, useRef, useState, useCallback } from 'react';

const FullScreenModal = ({ 
  video, 
  onClose, 
  onNavigate, 
  showFilenames,
  gridRef 
}) => {
  const modalRef = useRef(null);
  const adoptHostRef = useRef(null);     // host where we move the existing grid <video>
  const fallbackRef = useRef(null);      // fallback <video> if adoption fails
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [usingAdopted, setUsingAdopted] = useState(false);

  // Keep track for restoration
  const adoptedElRef = useRef(null);
  const originalParentRef = useRef(null);
  const originalNextSiblingRef = useRef(null);

  // Try to adopt (move) the existing grid video element for instant loading
  const tryAdoptExistingVideo = useCallback(() => {
    if (!video) return false;

    // Find existing video element in the grid
    const existingVideo = document.querySelector(
      `[data-video-id="${video.id}"] video`
    );
    if (existingVideo && existingVideo.readyState >= 2 && adoptHostRef.current) {
      try {
        originalParentRef.current = existingVideo.parentElement;
        originalNextSiblingRef.current = existingVideo.nextSibling;

        // mark adopted so the card won't re-attach or tear down
        existingVideo.dataset.adopted = 'modal';

        // move node into modal host
        adoptHostRef.current.appendChild(existingVideo);

        // style + controls for modal
        existingVideo.controls = true;
        existingVideo.style.maxWidth = '100%';
        existingVideo.style.maxHeight = '80vh';
        existingVideo.style.objectFit = 'contain';
        existingVideo.style.borderRadius = '8px';
        existingVideo.style.boxShadow = '0 20px 40px rgba(0, 0, 0, 0.8)';

        // play (muted already from tile)
        existingVideo.play?.().catch(() => {});

        adoptedElRef.current = existingVideo;
        setIsLoading(false);
        setVideoLoaded(true);
        setUsingAdopted(true);
        return true;
      } catch (e) {
        console.warn('Adopt failed, will fall back:', e);
      }
    }
    return false;
  }, [video]);

  // Restore adopted node to its original parent/position
  const restoreAdopted = useCallback(() => {
    const el = adoptedElRef.current;
    if (!el) return;
    try {
      // revert styles/controls
      el.controls = false;
      el.style.maxWidth = '';
      el.style.maxHeight = '';
      el.style.objectFit = '';
      el.style.borderRadius = '';
      el.style.boxShadow = '';
      if (el.dataset) delete el.dataset.adopted;

      const parent = originalParentRef.current;
      const next = originalNextSiblingRef.current;
      if (parent) {
        if (next && next.parentNode === parent) {
          parent.insertBefore(el, next);
        } else {
          parent.appendChild(el);
        }
      }
    } catch {}
    adoptedElRef.current = null;
    originalParentRef.current = null;
    originalNextSiblingRef.current = null;
  }, []);

  // Main effect: adopt if possible, else use fallback <video>
  useEffect(() => {
    if (!video) return;

    setIsLoading(true);
    setError(null);
    setVideoLoaded(false);
    setUsingAdopted(false);

    // Fast path: adopt
    const adopted = tryAdoptExistingVideo();
    if (adopted) return () => restoreAdopted();

    // Fallback: separate <video> element (no forced .load(), reuse src)
    const el = fallbackRef.current;
    if (!el) return;

    const onCanPlay = () => {
      setIsLoading(false);
      setVideoLoaded(true);
      el.play().catch(() => {});
    };
    const onError = (e) => {
      setIsLoading(false);
      setError(e?.target?.error?.message || 'Failed to load video');
    };

    el.addEventListener('canplay', onCanPlay);
    el.addEventListener('error', onError);

    // Set source once (avoid .load() resets)
    const nextSrc = video.isElectronFile && video.fullPath
      ? `file://${video.fullPath}`
      : (video.blobUrl || (video.file ? URL.createObjectURL(video.file) : ''));

    if (el.src !== nextSrc) {
      el.preload = 'auto';
      el.src = nextSrc;
    }

    return () => {
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('error', onError);
      // Do not revoke blob here if shared elsewhere
    };
  }, [video, tryAdoptExistingVideo, restoreAdopted]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          onNavigate('prev');
          break;
        case 'ArrowRight':
          e.preventDefault();
          onNavigate('next');
          break;
        case ' ':
          e.preventDefault();
          {
            const el = usingAdopted ? adoptedElRef.current : fallbackRef.current;
            if (el) el.paused ? el.play() : el.pause();
          }
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNavigate, usingAdopted]);

  // Handle click outside to close
  const handleBackdropClick = useCallback((e) => {
    if (e.target === modalRef.current) {
      onClose();
    }
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      // restore adopted video if any
      restoreAdopted();
      document.body.style.overflow = '';
    };
  }, [restoreAdopted]);

  if (!video) return null;

  return (
    <>
      {/* CSS animation moved to separate style element */}
      <style>{`
        @keyframes modalSpinner {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .modal-spinner {
          animation: modalSpinner 1s linear infinite;
        }
      `}</style>
      
      <div
        ref={modalRef}
        className="fullscreen-modal"
        onClick={handleBackdropClick}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.95)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
          backdropFilter: 'blur(4px)'
        }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '20px',
            right: '20px',
            background: 'rgba(0, 0, 0, 0.7)',
            border: 'none',
            borderRadius: '50%',
            width: '50px',
            height: '50px',
            color: 'white',
            fontSize: '24px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10001,
            transition: 'background-color 0.2s'
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = 'rgba(0, 0, 0, 0.9)'}
          onMouseLeave={(e) => e.target.style.backgroundColor = 'rgba(0, 0, 0, 0.7)'}
          title="Close (Esc)"
        >
          ×
        </button>

        {/* Navigation buttons */}
        <button
          onClick={() => onNavigate('prev')}
          style={{
            position: 'absolute',
            left: '20px',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'rgba(0, 0, 0, 0.7)',
            border: 'none',
            borderRadius: '50%',
            width: '60px',
            height: '60px',
            color: 'white',
            fontSize: '24px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10001,
            transition: 'background-color 0.2s'
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = 'rgba(0, 0, 0, 0.9)'}
          onMouseLeave={(e) => e.target.style.backgroundColor = 'rgba(0, 0, 0, 0.7)'}
          title="Previous (←)"
        >
          ←
        </button>

        <button
          onClick={() => onNavigate('next')}
          style={{
            position: 'absolute',
            right: '20px',
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'rgba(0, 0, 0, 0.7)',
            border: 'none',
            borderRadius: '50%',
            width: '60px',
            height: '60px',
            color: 'white',
            fontSize: '24px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10001,
            transition: 'background-color 0.2s'
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = 'rgba(0, 0, 0, 0.9)'}
          onMouseLeave={(e) => e.target.style.backgroundColor = 'rgba(0, 0, 0, 0.7)'}
          title="Next (→)"
        >
          →
        </button>

        {/* Body */}
        <div
          style={{
            maxWidth: '90vw',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {/* Loading/Error states */}
          {isLoading && (
            <div style={{
              color: 'white',
              fontSize: '18px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginBottom: '20px'
            }}>
              <div 
                className="modal-spinner"
                style={{
                  width: '20px',
                  height: '20px',
                  border: '2px solid #ffffff33',
                  borderTop: '2px solid white',
                  borderRadius: '50%'
                }}
              />
              Loading video...
            </div>
          )}

          {error && (
            <div style={{
              color: '#ff6b6b',
              fontSize: '18px',
              textAlign: 'center',
              marginBottom: '20px',
              padding: '20px',
              background: 'rgba(255, 107, 107, 0.1)',
              borderRadius: '8px',
              border: '1px solid rgba(255, 107, 107, 0.3)'
            }}>
              <div style={{ fontSize: '24px', marginBottom: '10px' }}>⚠️</div>
              <div style={{ fontWeight: 'bold', marginBottom: '5px' }}>Error Loading Video</div>
              <div style={{ opacity: 0.8 }}>{error}</div>
            </div>
          )}

          {/* Host where we adopt the existing grid <video> */}
          <div
            ref={adoptHostRef}
            style={{
              display: usingAdopted ? 'block' : 'none',
              maxWidth: '100%',
              maxHeight: '80vh'
            }}
            onClick={(e) => e.stopPropagation()}
          />

          {/* Fallback <video> used only if adoption fails */}
          <video
            ref={fallbackRef}
            muted
            loop
            controls
            playsInline
            style={{
              display: usingAdopted ? 'none' : 'block',
              maxWidth: '100%',
              maxHeight: '80vh',
              objectFit: 'contain',
              borderRadius: '8px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.8)'
            }}
            onClick={(e) => e.stopPropagation()}
          />

          {/* Video info */}
          {showFilenames && videoLoaded && (
            <div style={{
              marginTop: '20px',
              padding: '15px 25px',
              background: 'rgba(0, 0, 0, 0.8)',
              borderRadius: '25px',
              color: 'white',
              fontSize: '16px',
              textAlign: 'center',
              maxWidth: '80vw',
              wordBreak: 'break-word'
            }}>
              {video.name}
            </div>
          )}

          {/* Keyboard shortcuts help */}
          <div style={{
            position: 'absolute',
            bottom: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0, 0, 0, 0.7)',
            padding: '10px 20px',
            borderRadius: '20px',
            color: 'rgba(255, 255, 255, 0.8)',
            fontSize: '14px',
            textAlign: 'center'
          }}>
            <span style={{ marginRight: '20px' }}>← → Navigate</span>
            <span style={{ marginRight: '20px' }}>Space Play/Pause</span>
            <span>Esc Close</span>
          </div>
        </div>
      </div>
    </>
  );
};

export default FullScreenModal;
