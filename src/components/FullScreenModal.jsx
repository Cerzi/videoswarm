import React, { useEffect, useRef, useCallback } from 'react';

const FullScreenModal = ({ 
  video, 
  onClose, 
  onNavigate, 
  showFilenames,
  layoutMode,
  gridRef 
}) => {
  const videoRef = useRef(null);
  const modalRef = useRef(null);

  // Set up video when modal opens
  useEffect(() => {
    if (video && videoRef.current) {
      const videoElement = videoRef.current;
      
      // Set up video source
      if (video.isElectronFile && video.fullPath) {
        videoElement.src = `file://${video.fullPath}`;
      } else if (video.file) {
        videoElement.src = URL.createObjectURL(video.file);
      }

      // Video settings
      videoElement.muted = true;
      videoElement.loop = true;
      videoElement.playsInline = true;

      // Start playing when loaded
      const handleCanPlay = () => {
        videoElement.play().catch(console.debug);
      };

      videoElement.addEventListener('canplay', handleCanPlay);
      
      return () => {
        videoElement.removeEventListener('canplay', handleCanPlay);
        // Clean up blob URLs
        if (videoElement.src?.startsWith('blob:')) {
          URL.revokeObjectURL(videoElement.src);
        }
      };
    }
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
          onNavigate('left');
          break;
        case 'ArrowRight':
          e.preventDefault();
          onNavigate('right');
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNavigate]);

  // Handle click outside to close
  const handleModalClick = useCallback((e) => {
    if (e.target === modalRef.current) {
      onClose();
    }
  }, [onClose]);

  if (!video) return null;

  return (
    <div 
      ref={modalRef}
      className="fullscreen-modal"
      onClick={handleModalClick}
    >
      <div className="fullscreen-video-container">
        <video
          ref={videoRef}
          className="fullscreen-video"
          controls={false}
          autoPlay
          muted
          loop
          playsInline
        />
        
        {showFilenames && (
          <div className="fullscreen-filename">
            {video.name}
          </div>
        )}
      </div>
    </div>
  );
};

export default FullScreenModal;