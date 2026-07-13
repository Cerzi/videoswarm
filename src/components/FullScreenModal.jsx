import React, { useEffect, useRef, useState, useCallback } from 'react';
import { toFileURL } from './VideoCard/videoDom';

const detachFullscreenMedia = (element) => {
  if (!element) return;
  try { element.pause(); } catch {}
  try {
    element.removeAttribute('src');
    element.srcObject = null;
    element.load();
  } catch {}
};

const FullScreenModal = ({ 
  video, 
  onClose, 
  onNavigate, 
  showFilenames
}) => {
  const modalRef = useRef(null);
  const fallbackRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [videoLoaded, setVideoLoaded] = useState(false);

  // Fullscreen owns its media element. Grid cards can virtualize independently.
  useEffect(() => {
    if (!video) return;

    setIsLoading(true);
    setError(null);
    setVideoLoaded(false);

    const el = fallbackRef.current;
    if (!el) return;
    let ownedBlobUrl = null;

    const onCanPlay = () => {
      setIsLoading(false);
      setVideoLoaded(true);
      el.play?.()?.catch?.(() => {});
    };
    const onError = (e) => {
      setIsLoading(false);
      setError(e?.target?.error?.message || 'Failed to load video');
    };

    el.addEventListener('canplay', onCanPlay);
    el.addEventListener('error', onError);

    let nextSrc = '';
    if (video.isElectronFile && video.fullPath) {
      nextSrc = toFileURL(video.fullPath);
    } else if (video.blobUrl) {
      nextSrc = video.blobUrl;
    } else if (video.file) {
      ownedBlobUrl = URL.createObjectURL(video.file);
      nextSrc = ownedBlobUrl;
    } else {
      nextSrc = video.fullPath || video.relativePath || '';
    }

    if (!nextSrc) {
      setIsLoading(false);
      setError('No valid video source');
    } else if (el.src !== nextSrc) {
      el.preload = 'auto';
      el.src = nextSrc;
    }

    return () => {
      el.removeEventListener('canplay', onCanPlay);
      el.removeEventListener('error', onError);
      detachFullscreenMedia(el);
      if (ownedBlobUrl) URL.revokeObjectURL(ownedBlobUrl);
    };
  }, [video]);

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
            const el = fallbackRef.current;
            if (el) el.paused ? el.play() : el.pause();
          }
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNavigate]);

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
      document.body.style.overflow = '';
    };
  }, []);

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

          {/* Modal-owned media remains safe when grid cards virtualize away. */}
          <video
            ref={fallbackRef}
            muted
            loop
            controls
            playsInline
            style={{
              display: 'block',
              width: 'auto',
              height: '90vh',
              maxWidth: '90vw',
              maxHeight: '90vh',
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
