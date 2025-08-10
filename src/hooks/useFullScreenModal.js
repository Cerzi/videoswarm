import { useState, useCallback } from 'react';

export const useFullScreenModal = (videos, gridRef) => {
  const [fullScreenVideo, setFullScreenVideo] = useState(null);

  // Calculate grid navigation order (always vertical masonry)
  const getGridOrder = useCallback(() => {
    if (!gridRef.current || !videos.length) return [];

    const videoElements = Array.from(gridRef.current.querySelectorAll('.video-item'));
    
    // Sort by visual position: top to bottom, left to right (vertical masonry)
    return videoElements.sort((a, b) => {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      
      // First sort by Y position (row)
      const yDiff = rectA.top - rectB.top;
      if (Math.abs(yDiff) > 10) { // Allow for small differences
        return yDiff;
      }
      
      // Then sort by X position (column)
      return rectA.left - rectB.left;
    });
  }, [videos, gridRef]);

  // Find video by ID in the grid order
  const findVideoIndex = useCallback((videoId) => {
    const gridOrder = getGridOrder();
    return gridOrder.findIndex(element => {
      const elementVideoId = element.dataset.videoId || element.dataset.filename;
      return elementVideoId === videoId;
    });
  }, [getGridOrder]);

  // Navigate to adjacent video
  const navigateFullScreen = useCallback((direction) => {
    if (!fullScreenVideo) return;

    const gridOrder = getGridOrder();
    const currentIndex = findVideoIndex(fullScreenVideo.id);
    
    if (currentIndex === -1) return;

    let newIndex;
    if (direction === 'left') {
      newIndex = currentIndex === 0 ? gridOrder.length - 1 : currentIndex - 1;
    } else if (direction === 'right') {
      newIndex = currentIndex === gridOrder.length - 1 ? 0 : currentIndex + 1;
    } else {
      return;
    }

    const newElement = gridOrder[newIndex];
    const newVideoId = newElement.dataset.videoId || newElement.dataset.filename;
    const newVideo = videos.find(v => v.id === newVideoId);
    
    if (newVideo) {
      setFullScreenVideo(newVideo);
    }
  }, [fullScreenVideo, getGridOrder, findVideoIndex, videos]);

  // Open fullscreen modal
  const openFullScreen = useCallback((video) => {
    setFullScreenVideo(video);
  }, []);

  // Close fullscreen modal
  const closeFullScreen = useCallback(() => {
    setFullScreenVideo(null);
  }, []);

  return {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen
  };
};
