import { useState, useEffect, useCallback } from 'react';

export const useFullScreenModal = (videos, layoutMode, gridRef) => {
  const [fullScreenVideo, setFullScreenVideo] = useState(null);
  const [fullScreenIndex, setFullScreenIndex] = useState(-1);

  const openFullScreen = useCallback((video, playingVideos) => {
    const index = videos.findIndex(v => v.id === video.id);
    setFullScreenVideo(video);
    setFullScreenIndex(index);
    
    // Pause all currently playing videos when entering fullscreen
    if (playingVideos && playingVideos.size > 0) {
      playingVideos.forEach(videoId => {
        const videoElement = document.querySelector(`[data-video-id="${videoId}"] video`);
        if (videoElement) {
          videoElement.pause();
        }
      });
    }
  }, [videos]);

  const closeFullScreen = useCallback(() => {
    setFullScreenVideo(null);
    setFullScreenIndex(-1);
  }, []);

  const navigateFullScreen = useCallback((direction) => {
    if (fullScreenIndex === -1 || videos.length === 0) return;

    let newIndex;
    if (direction === 'next') {
      newIndex = (fullScreenIndex + 1) % videos.length;
    } else {
      newIndex = fullScreenIndex === 0 ? videos.length - 1 : fullScreenIndex - 1;
    }

    const newVideo = videos[newIndex];
    if (newVideo) {
      setFullScreenVideo(newVideo);
      setFullScreenIndex(newIndex);
    }
  }, [fullScreenIndex, videos]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!fullScreenVideo) return;

    const handleKeyDown = (e) => {
      switch (e.key) {
        case 'Escape':
          closeFullScreen();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          navigateFullScreen('prev');
          break;
        case 'ArrowRight':
          e.preventDefault();
          navigateFullScreen('next');
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [fullScreenVideo, closeFullScreen, navigateFullScreen]);

  return {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen
  };
};