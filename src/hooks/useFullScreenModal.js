import { useState, useCallback, useRef } from 'react';

export const useFullScreenModal = (videos, layoutMode, gridRef) => {
  const [fullScreenVideo, setFullScreenVideo] = useState(null);
  const pausedVideosRef = useRef(new Set()); // Store which videos were playing before fullscreen

  // Calculate grid navigation order
  const getGridOrder = useCallback(() => {
    if (!gridRef.current || !videos.length) return [];

    const videoElements = Array.from(gridRef.current.querySelectorAll('.video-item'));
    
    if (layoutMode === 'grid' || layoutMode === 'masonry-vertical') {
      // Sort by visual position: top to bottom, left to right
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
    } else if (layoutMode === 'masonry-horizontal') {
      // Sort by visual position: left to right, top to bottom
      return videoElements.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        
        // First sort by X position (column)
        const xDiff = rectA.left - rectB.left;
        if (Math.abs(xDiff) > 10) { // Allow for small differences
          return xDiff;
        }
        
        // Then sort by Y position (row)
        return rectA.top - rectB.top;
      });
    }
    
    return videoElements;
  }, [videos, layoutMode, gridRef]);

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
  const openFullScreen = useCallback((video, currentlyPlaying) => {
    // Store currently playing videos
    pausedVideosRef.current = new Set(currentlyPlaying);
    
    // Open the modal
    setFullScreenVideo(video);
  }, []);

  // Close fullscreen modal
  const closeFullScreen = useCallback(() => {
    setFullScreenVideo(null);
    
    // Return the set of videos that should resume playing
    const toResume = pausedVideosRef.current;
    pausedVideosRef.current = new Set();
    
    return toResume;
  }, []);

  return {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen
  };
};