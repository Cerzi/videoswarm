import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import VideoCard from './components/VideoCard';
import FullScreenModal from './components/FullScreenModal';
import ContextMenu from './components/ContextMenu';
import { useFullScreenModal } from './hooks/useFullScreenModal';
import { useContextMenu } from './hooks/useContextMenu';
import './App.css';

// Helper function to get directory path
const path = {
  dirname: (filePath) => {
    if (!filePath) return '';
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return lastSlash === -1 ? '' : filePath.substring(0, lastSlash);
  }
};

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true);
  const [maxConcurrentPlaying, setMaxConcurrentPlaying] = useState(30);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  
  // Loading state
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState('');
  const [loadingProgress, setLoadingProgress] = useState(0);
  
  // Performance tracking with React state
  const [playingVideos, setPlayingVideos] = useState(new Set());
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());

  // Refs for performance monitoring and masonry layout
  const cleanupTimeoutRef = useRef(null);
  const lastCleanupTimeRef = useRef(0);
  const gridRef = useRef(null);
  const aspectRatioCacheRef = useRef(new Map());
  const cachedGridMeasurementsRef = useRef(null);
  const isLayoutingRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const layoutRefreshInProgressRef = useRef(false);
  const lastScrollTimeRef = useRef(0);
  const masonryLayoutTimeoutRef = useRef(null);
  const resizeTimeoutRef = useRef(null);

  // MEMOIZED: Grouped and sorted videos
  const groupedAndSortedVideos = useMemo(() => {
    if (videos.length === 0) return [];

    // Group videos by their folder path
    const videosByFolder = new Map();
    
    videos.forEach(video => {
      const folderPath = video.metadata?.folder || path.dirname(video.fullPath || video.relativePath || '');
      
      if (!videosByFolder.has(folderPath)) {
        videosByFolder.set(folderPath, []);
      }
      videosByFolder.get(folderPath).push(video);
    });

    // Sort folders alphabetically, then sort videos within each folder
    const sortedFolders = Array.from(videosByFolder.keys()).sort();
    const result = [];

    sortedFolders.forEach(folderPath => {
      const folderVideos = videosByFolder.get(folderPath);
      // Sort videos within folder by name
      folderVideos.sort((a, b) => a.name.localeCompare(b.name));
      result.push(...folderVideos);
    });

    console.log(`📁 Grouped ${videos.length} videos into ${sortedFolders.length} folders`);
    return result;
  }, [videos]);

  // Use fullscreen modal (CORE FUNCTIONALITY PRESERVED) - simplified without layoutMode
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen
  } = useFullScreenModal(groupedAndSortedVideos, 'masonry-vertical', gridRef);

  // Use context menu (CORE FUNCTIONALITY PRESERVED)
  const {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    handleContextAction
  } = useContextMenu();

  // MEMOIZED: Performance limits calculation
  const performanceLimits = useMemo(() => {
    const videoCount = groupedAndSortedVideos.length;
    
    if (videoCount < 100) {
      return { maxLoaded: 60, maxConcurrentLoading: 4 };
    } else if (videoCount < 500) {
      return { maxLoaded: 80, maxConcurrentLoading: 3 };
    } else if (videoCount < 1000) {
      return { maxLoaded: 100, maxConcurrentLoading: 2 };
    } else {
      return { maxLoaded: 120, maxConcurrentLoading: 1 };
    }
  }, [groupedAndSortedVideos.length]);

  // MEMOIZED: Cleanup function (React-optimized)
  const performCleanup = useCallback(() => {
    const now = Date.now();
    
    // Throttle cleanup calls
    if (now - lastCleanupTimeRef.current < 3000) return;
    lastCleanupTimeRef.current = now;
    
    if (loadedVideos.size <= performanceLimits.maxLoaded) return;
    
    console.log(`🧹 React cleanup: ${loadedVideos.size}/${performanceLimits.maxLoaded} loaded`);
    
    // React-native cleanup using state
    setLoadedVideos(prev => {
      const toKeep = new Set();
      let keepCount = 0;
      
      // Keep visible videos first
      prev.forEach(videoId => {
        if (visibleVideos.has(videoId) && keepCount < performanceLimits.maxLoaded) {
          toKeep.add(videoId);
          keepCount++;
        }
      });
      
      // Keep playing videos
      prev.forEach(videoId => {
        if (playingVideos.has(videoId) && !toKeep.has(videoId) && keepCount < performanceLimits.maxLoaded) {
          toKeep.add(videoId);
          keepCount++;
        }
      });
      
      // Keep some recent videos
      const remaining = Array.from(prev).filter(id => !toKeep.has(id));
      remaining.slice(0, performanceLimits.maxLoaded - keepCount).forEach(id => toKeep.add(id));
      
      if (toKeep.size < prev.size) {
        console.log(`🧹 Cleaned up ${prev.size - toKeep.size} videos`);
      }
      
      return toKeep;
    });
    
    // Also clean loading state
    setLoadingVideos(prev => {
      const newSet = new Set();
      prev.forEach(videoId => {
        if (loadedVideos.has(videoId)) {
          newSet.add(videoId);
        }
      });
      return newSet;
    });
  }, [loadedVideos.size, visibleVideos, playingVideos, performanceLimits]);

  // REACT EFFECT: Performance monitoring
  useEffect(() => {
    // Clear any existing timeout
    if (cleanupTimeoutRef.current) {
      clearTimeout(cleanupTimeoutRef.current);
    }
    
    // Schedule cleanup check
    cleanupTimeoutRef.current = setTimeout(() => {
      if (loadedVideos.size > performanceLimits.maxLoaded || 
          loadingVideos.size > performanceLimits.maxConcurrentLoading) {
        performCleanup();
      }
    }, 1000);
    
    return () => {
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
      }
    };
  }, [loadedVideos.size, loadingVideos.size, performanceLimits, performCleanup]);

  // FIXED: Centralized playback management - App decides what plays
  useEffect(() => {
    // Get videos that are both visible AND loaded (can actually play)
    const playableVideos = Array.from(visibleVideos).filter(videoId => 
      loadedVideos.has(videoId)
    );

    // Reduced logging for performance
    if (playableVideos.length !== playingVideos.size || Math.random() < 0.01) {
      console.log(`Playback check: ${playableVideos.length} playable, ${playingVideos.size} currently playing, max: ${maxConcurrentPlaying}`);
    }

    // Determine which videos should be playing (up to the limit)
    const shouldBePlaying = new Set(playableVideos.slice(0, maxConcurrentPlaying));

    // Only update if there's actually a change
    const currentlyPlaying = Array.from(playingVideos).sort();
    const newPlaying = Array.from(shouldBePlaying).sort();
    
    if (JSON.stringify(currentlyPlaying) !== JSON.stringify(newPlaying)) {
      console.log(`Updating playing videos: ${currentlyPlaying.length} -> ${newPlaying.length}`);
      setPlayingVideos(shouldBePlaying);
    }

  }, [visibleVideos, loadedVideos, maxConcurrentPlaying, playingVideos]);

  // CALLBACK: Context menu handling
  useEffect(() => {
    if (!contextMenu.visible) return;

    const handleClickOutside = (event) => {
      const contextMenuElement = document.querySelector('[data-context-menu]');
      if (contextMenuElement && !contextMenuElement.contains(event.target)) {
        hideContextMenu();
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        hideContextMenu();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu.visible, hideContextMenu]);

  // Check if we're in Electron
  const isElectron = window.electronAPI?.isElectron;

  // CALLBACK: Settings loading (simplified without layoutMode)
  useEffect(() => {
    const loadSettings = async () => {
      if (window.electronAPI?.getSettings) {
        try {
          const settings = await window.electronAPI.getSettings();
          
          if (settings.recursiveMode !== undefined) setRecursiveMode(settings.recursiveMode);
          if (settings.showFilenames !== undefined) setShowFilenames(settings.showFilenames);
          if (settings.maxConcurrentPlaying !== undefined) setMaxConcurrentPlaying(settings.maxConcurrentPlaying);
          if (settings.zoomLevel !== undefined) setZoomLevel(settings.zoomLevel);
          
          setSettingsLoaded(true);
        } catch (error) {
          console.log('Using default settings');
          setSettingsLoaded(true);
        }
      } else {
        setSettingsLoaded(true);
      }
    };

    loadSettings();

    if (window.electronAPI?.onFolderSelected) {
      window.electronAPI.onFolderSelected((folderPath) => {
        handleElectronFolderSelection(folderPath);
      });
    }
  }, []);

  // CALLBACK: File system listeners
  useEffect(() => {
    if (!window.electronAPI) return;

    const handleFileAdded = (videoFile) => {
      setVideos(prev => {
        if (prev.some(v => v.id === videoFile.id)) return prev;
        return [...prev, videoFile].sort((a, b) => a.name.localeCompare(b.name));
      });
    };

    const handleFileRemoved = (filePath) => {
      setVideos(prev => prev.filter(v => v.id !== filePath));
      // Clean up related state
      setSelectedVideos(prev => { const newSet = new Set(prev); newSet.delete(filePath); return newSet; });
      setPlayingVideos(prev => { const newSet = new Set(prev); newSet.delete(filePath); return newSet; });
      setLoadedVideos(prev => { const newSet = new Set(prev); newSet.delete(filePath); return newSet; });
      setLoadingVideos(prev => { const newSet = new Set(prev); newSet.delete(filePath); return newSet; });
      setVisibleVideos(prev => { const newSet = new Set(prev); newSet.delete(filePath); return newSet; });
    };

    const handleFileChanged = (videoFile) => {
      setVideos(prev => prev.map(v => v.id === videoFile.id ? videoFile : v));
    };

    if (window.electronAPI.onFileAdded) window.electronAPI.onFileAdded(handleFileAdded);
    if (window.electronAPI.onFileRemoved) window.electronAPI.onFileRemoved(handleFileRemoved);
    if (window.electronAPI.onFileChanged) window.electronAPI.onFileChanged(handleFileChanged);

    return () => {
      if (window.electronAPI?.stopFolderWatch) {
        window.electronAPI.stopFolderWatch().catch(console.error);
      }
    };
  }, []);

  // MASONRY LAYOUT FUNCTIONS (extracted from useLayoutManager)
  
  // Helper function to get column count
  const getColumnCount = useCallback((computedStyle) => {
    const gridTemplateColumns = computedStyle.gridTemplateColumns;
    if (gridTemplateColumns === 'none') return 1;
    return gridTemplateColumns.split(' ').length;
  }, []);

  const updateCachedGridMeasurements = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const computedStyle = window.getComputedStyle(grid);
    const columnCount = getColumnCount(computedStyle);
    const columnGap = parseFloat(computedStyle.columnGap) || 4;

    const gridWidth = grid.clientWidth;
    const padding = (parseFloat(computedStyle.paddingLeft) || 0) + (parseFloat(computedStyle.paddingRight) || 0);

    const availableWidth = gridWidth - padding;
    const totalGapWidth = columnGap * (columnCount - 1);
    const columnWidth = (availableWidth - totalGapWidth) / columnCount;

    cachedGridMeasurementsRef.current = {
      columnWidth: Math.floor(columnWidth),
      columnCount,
      columnGap,
      gridWidth: availableWidth
    };

    console.log('Grid measurements:', cachedGridMeasurementsRef.current);
  }, [getColumnCount]);

  // TRUE MASONRY IMPLEMENTATION - Fixed Width, Variable Height (Vertical)
  const layoutMasonryVertical = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;

    console.log('Laying out vertical masonry (fixed width, variable height)');

    // Get grid measurements
    if (!cachedGridMeasurementsRef.current) {
      updateCachedGridMeasurements();
    }

    const { columnWidth, columnCount, columnGap } = cachedGridMeasurementsRef.current || {};
    if (!columnWidth) return;

    // Initialize column heights array
    const columnHeights = new Array(columnCount).fill(0);
    
    // Get all video items
    const videoItems = grid.querySelectorAll('.video-item');
    
    videoItems.forEach((videoItem, index) => {
      // Get or calculate aspect ratio
      const videoId = videoItem.dataset.videoId || videoItem.dataset.filename;
      let aspectRatio = aspectRatioCacheRef.current.get(videoId);
      
      if (!aspectRatio) {
        const video = videoItem.querySelector('video');
        if (video && video.videoWidth && video.videoHeight) {
          aspectRatio = video.videoWidth / video.videoHeight;
          aspectRatioCacheRef.current.set(videoId, aspectRatio);
        } else {
          aspectRatio = 16 / 9; // Default
        }
      }

      // Calculate item height based on fixed width and aspect ratio
      const itemHeight = Math.round(columnWidth / aspectRatio);

      // Find column with minimum height
      const shortestColumnIndex = columnHeights.indexOf(Math.min(...columnHeights));
      const leftPosition = shortestColumnIndex * (columnWidth + columnGap);
      const topPosition = columnHeights[shortestColumnIndex];

      // Position the item
      videoItem.style.position = 'absolute';
      videoItem.style.left = `${leftPosition}px`;
      videoItem.style.top = `${topPosition}px`;
      videoItem.style.width = `${columnWidth}px`;
      videoItem.style.height = `${itemHeight}px`;

      // Update the video container styling
      const videoContainer = videoItem.querySelector('.video-container, .video-placeholder, .error-indicator');
      if (videoContainer) {
        videoContainer.style.height = `${itemHeight}px`;
      }

      // Update column height
      columnHeights[shortestColumnIndex] += itemHeight + columnGap;
    });

    // Set grid container height to accommodate all items
    const maxHeight = Math.max(...columnHeights);
    grid.style.height = `${maxHeight}px`;
    grid.style.position = 'relative';
  }, [updateCachedGridMeasurements]);

  const initializeMasonryGrid = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || isLayoutingRef.current || isUserScrollingRef.current) return;

    // Check if native masonry is supported
    if (CSS.supports('grid-template-rows', 'masonry')) {
      console.log('Using native CSS masonry');
      return;
    }

    // Prevent layout loops
    if (layoutRefreshInProgressRef.current) {
      console.log('Skipping masonry init - refresh in progress');
      return;
    }

    isLayoutingRef.current = true;
    layoutRefreshInProgressRef.current = true;

    console.log('Initializing masonry layout');

    // Preserve scroll position
    const currentScrollY = window.scrollY;

    // Wait for DOM to settle, then apply layout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!isUserScrollingRef.current) {
          layoutMasonryVertical();
        }

        // Restore scroll position ONLY if it was significant
        if (currentScrollY > 100) {
          setTimeout(() => {
            if (!isUserScrollingRef.current) {
              window.scrollTo(0, currentScrollY);
              console.log(`Restored scroll position to ${currentScrollY}px`);
            }
          }, 100);
        }

        isLayoutingRef.current = false;

        // Longer delay before allowing refresh again
        setTimeout(() => {
          layoutRefreshInProgressRef.current = false;
        }, 500);
      });
    });
  }, [layoutMasonryVertical]);

  const refreshMasonryLayout = useCallback(() => {
    // Don't refresh if user is interacting or layout is already in progress
    if (isUserScrollingRef.current ||
        layoutRefreshInProgressRef.current ||
        isLayoutingRef.current) {
      console.log('Skipping layout refresh - interaction or refresh in progress');
      return;
    }

    // Don't refresh too frequently
    const now = Date.now();
    if (lastScrollTimeRef.current && (now - lastScrollTimeRef.current < 1000)) {
      console.log('Skipping layout refresh - recent user activity');
      return;
    }

    console.log('Refreshing masonry layout');
    initializeMasonryGrid();
  }, [initializeMasonryGrid]);

  // Setup scroll detection
  useEffect(() => {
    let scrollTimeout;

    const handleScroll = () => {
      lastScrollTimeRef.current = Date.now();
      isUserScrollingRef.current = true;

      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        isUserScrollingRef.current = false;
      }, 150);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    
    return () => {
      window.removeEventListener('scroll', handleScroll);
      clearTimeout(scrollTimeout);
    };
  }, []);

  // Setup resize handling
  useEffect(() => {
    const handleResize = () => {
      clearTimeout(resizeTimeoutRef.current);

      // Only handle resize AFTER user stops resizing for 500ms
      resizeTimeoutRef.current = setTimeout(() => {
        console.log('Window resize complete - updating layout');

        // Clear cached measurements
        cachedGridMeasurementsRef.current = null;

        // Re-layout
        if (!isLayoutingRef.current && !isUserScrollingRef.current) {
          setTimeout(() => {
            initializeMasonryGrid();
          }, 100);
        }
      }, 500);
    };

    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeoutRef.current);
    };
  }, [initializeMasonryGrid]);

  // Apply layout when videos change
  useEffect(() => {
    if (groupedAndSortedVideos.length > 0) {
      setTimeout(() => {
        updateCachedGridMeasurements();
        initializeMasonryGrid();
      }, 50);
    }
  }, [groupedAndSortedVideos.length, updateCachedGridMeasurements, initializeMasonryGrid]);

  // Setup zoom level handling
  const setZoom = useCallback((level) => {
    const grid = gridRef.current;
    if (!grid) return;

    const zoomLevels = ['zoom-small', 'zoom-medium', 'zoom-large', 'zoom-xlarge'];
    
    // Remove all zoom classes
    zoomLevels.forEach(cls => grid.classList.remove(cls));
    // Add the new zoom class
    grid.classList.add(zoomLevels[level]);

    // Refresh layout after zoom change
    clearTimeout(masonryLayoutTimeoutRef.current);
    masonryLayoutTimeoutRef.current = setTimeout(() => {
      cachedGridMeasurementsRef.current = null;
      initializeMasonryGrid();
    }, 300);
  }, [initializeMasonryGrid]);

  // Apply zoom when zoomLevel changes
  useEffect(() => {
    setZoom(zoomLevel);
  }, [zoomLevel, setZoom]);

  // Update aspect ratio cache when videos load
  const updateAspectRatio = useCallback((videoId, aspectRatio) => {
    aspectRatioCacheRef.current.set(videoId, aspectRatio);
    
    // Refresh layout
    setTimeout(() => {
      refreshMasonryLayout();
    }, 100);
  }, [refreshMasonryLayout]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(masonryLayoutTimeoutRef.current);
      clearTimeout(resizeTimeoutRef.current);
    };
  }, []);

  // CALLBACK: Folder loading (CORE FUNCTIONALITY PRESERVED)
  const handleElectronFolderSelection = useCallback(async (folderPath) => {
    if (!window.electronAPI?.readDirectory) {
      console.error('Electron readDirectory API not available');
      return;
    }

    try {
      setIsLoadingFolder(true);
      setLoadingStage('Reading directory...');
      setLoadingProgress(10);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Stop existing watcher
      if (window.electronAPI?.stopFolderWatch) {
        await window.electronAPI.stopFolderWatch();
      }

      // Clear ALL state
      setVideos([]);
      setSelectedVideos(new Set());
      setPlayingVideos(new Set());
      setVisibleVideos(new Set());
      setLoadedVideos(new Set());
      setLoadingVideos(new Set());

      setLoadingStage('Scanning for video files...');
      setLoadingProgress(30);
      await new Promise(resolve => setTimeout(resolve, 200));

      const videoFiles = await window.electronAPI.readDirectory(folderPath, recursiveMode);
      
      setLoadingStage(`Found ${videoFiles.length} videos - initializing masonry...`);
      setLoadingProgress(70);
      await new Promise(resolve => setTimeout(resolve, 300));

      console.log(`📊 Setting ${videoFiles.length} videos for masonry layout`);
      setVideos(videoFiles);

      await new Promise(resolve => setTimeout(resolve, 500));

      setLoadingStage('Complete!');
      setLoadingProgress(100);
      await new Promise(resolve => setTimeout(resolve, 300));

      setIsLoadingFolder(false);

      // Start file watcher
      if (window.electronAPI?.startFolderWatch) {
        const watchResult = await window.electronAPI.startFolderWatch(folderPath);
        if (watchResult.success) {
          console.log('👁️ Started watching folder for changes');
        }
      }

    } catch (error) {
      console.error('Error reading directory:', error);
      setIsLoadingFolder(false);
    }
  }, [recursiveMode]);

  // MEMOIZED: Performance callback functions
  const canPlayMoreVideos = useCallback(() => {
    return true; // Always allow playing since we removed autoplay toggle
  }, []);
  
  // FIXED: Always allow visible videos to load
  const canLoadMoreVideos = useCallback((videoId) => {
    // If this specific video is visible, ALWAYS allow it to load
    if (visibleVideos.has(videoId)) {
      return true;
    }
    
    // For non-visible videos, respect normal limits
    return loadingVideos.size < performanceLimits.maxConcurrentLoading && 
           loadedVideos.size < performanceLimits.maxLoaded;
  }, [visibleVideos, loadingVideos.size, loadedVideos.size, performanceLimits]);
  
  // SIMPLIFIED: Remove the old complex handlers, VideoCard will report actual play/pause events
  const handleVideoPlay = useCallback((videoId) => {
    console.log(`Video started playing: ${videoId}`);
    // VideoCard will report when it actually starts playing
  }, []);

  const handleVideoPause = useCallback((videoId) => {
    console.log(`Video paused: ${videoId}`);
    // VideoCard will report when it actually pauses
  }, []);

  const handleVideoLoaded = useCallback((videoId, aspectRatio) => {
    setLoadedVideos(prev => new Set([...prev, videoId]));
    updateAspectRatio?.(videoId, aspectRatio);
  }, [updateAspectRatio]);

  const handleVideoStartLoading = useCallback((videoId) => {
    setLoadingVideos(prev => new Set([...prev, videoId]));
  }, []);

  const handleVideoStopLoading = useCallback((videoId) => {
    setLoadingVideos(prev => { 
      const newSet = new Set(prev); 
      newSet.delete(videoId); 
      return newSet; 
    });
  }, []);

  const handleVideoVisibilityChange = useCallback((videoId, isVisible) => {
    setVisibleVideos(prev => {
      const newSet = new Set(prev);
      if (isVisible) {
        newSet.add(videoId);
      } else {
        newSet.delete(videoId);
      }
      return newSet;
    });
  }, []);

  // SIMPLIFIED: Settings functions (removed autoplay and cleanup)
  const saveSettings = useCallback(async () => {
    if (window.electronAPI?.saveSettingsPartial) {
      try {
        await window.electronAPI.saveSettingsPartial({
          recursiveMode, 
          maxConcurrentPlaying, 
          zoomLevel, 
          showFilenames
        });
        console.log('Settings saved successfully');
      } catch (error) {
        console.error('Failed to save settings:', error);
      }
    }
  }, [recursiveMode, maxConcurrentPlaying, zoomLevel, showFilenames]);

  const handleFolderSelect = useCallback(async () => {
    if (!window.electronAPI?.selectFolder) return;
    try {
      const result = await window.electronAPI.selectFolder();
      if (result && result.folderPath) {
        await handleElectronFolderSelection(result.folderPath);
      }
    } catch (error) {
      console.error('Error opening folder dialog:', error);
    }
  }, [handleElectronFolderSelection]);

  const handleWebFileSelection = useCallback((event) => {
    const files = Array.from(event.target.files || []).filter((file) => {
      const isVideoType = file.type.startsWith('video/');
      const hasVideoExtension = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ogv)$/i.test(file.name);
      return isVideoType || hasVideoExtension;
    });

    const videoObjects = files.map((file) => ({
      id: file.name + file.size,
      name: file.name,
      file,
      loaded: false,
      isElectronFile: false,
    }));

    setVideos(videoObjects);
    setSelectedVideos(new Set());
    setPlayingVideos(new Set());
    setVisibleVideos(new Set());
    setLoadedVideos(new Set());
    setLoadingVideos(new Set());
  }, []);

  // FIXED: Control handlers with immediate save (removed autoplay)
  const toggleRecursive = useCallback(() => { 
    const newRecursive = !recursiveMode;
    setRecursiveMode(newRecursive);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        recursiveMode: newRecursive,
        maxConcurrentPlaying, 
        zoomLevel, 
        showFilenames
      }).catch(console.error);
    }
  }, [recursiveMode, maxConcurrentPlaying, zoomLevel, showFilenames]);
  
  const toggleFilenames = useCallback(() => { 
    const newShowFilenames = !showFilenames;
    setShowFilenames(newShowFilenames);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        showFilenames: newShowFilenames,
        recursiveMode, 
        maxConcurrentPlaying, 
        zoomLevel
      }).catch(console.error);
    }
  }, [showFilenames, recursiveMode, maxConcurrentPlaying, zoomLevel]);

  const handleVideoLimitChange = useCallback((newLimit) => {
    setMaxConcurrentPlaying(newLimit);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        maxConcurrentPlaying: newLimit,
        recursiveMode, 
        zoomLevel, 
        showFilenames
      }).catch(console.error);
    }
  }, [recursiveMode, zoomLevel, showFilenames]);

  const handleZoomChange = useCallback((newZoom) => { 
    setZoomLevel(newZoom); 
    setZoom(newZoom);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        zoomLevel: newZoom,
        recursiveMode, 
        maxConcurrentPlaying, 
        showFilenames
      }).catch(console.error);
    }
  }, [setZoom, recursiveMode, maxConcurrentPlaying, showFilenames]);

  // MEMOIZED: UI helper functions
  const getZoomLabel = useMemo(() => 
    (['75%', '100%', '150%', '200%'][zoomLevel] || '100%'), 
    [zoomLevel]
  );

  const handleVideoSelect = useCallback((videoId, isCtrlClick, isDoubleClick) => {
    const video = groupedAndSortedVideos.find(v => v.id === videoId);
    
    if (isDoubleClick && video) {
      openFullScreen(video, playingVideos);
      return;
    }

    setSelectedVideos(prev => {
      const newSelected = new Set(prev);
      if (isCtrlClick) {
        if (newSelected.has(videoId)) newSelected.delete(videoId);
        else newSelected.add(videoId);
      } else {
        newSelected.clear();
        newSelected.add(videoId);
      }
      return newSelected;
    });
  }, [groupedAndSortedVideos, openFullScreen, playingVideos]);

  // CALLBACK: Emergency cleanup (reduced functionality)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isLoadingFolder) {
        setIsLoadingFolder(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isLoadingFolder]);

  return (
    <div className="app">
      {!settingsLoaded ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>
          Loading settings...
        </div>
      ) : (
        <>
          {/* Loading Screen (PRESERVED) */}
          {isLoadingFolder && (
            <div style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.95)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', zIndex: 99999,
              backdropFilter: 'blur(8px)'
            }}>
              <div style={{
                backgroundColor: '#1a1a1a', borderRadius: '20px', padding: '3rem',
                maxWidth: '600px', width: '90%', textAlign: 'center',
                boxShadow: '0 30px 60px rgba(0,0,0,0.8)', 
                border: '2px solid #333'
              }}>
                <div style={{ fontSize: '3rem', marginBottom: '1.5rem' }}>🐝</div>
                <div style={{ fontSize: '2rem', marginBottom: '1rem', color: '#4CAF50', fontWeight: 'bold' }}>
                  Video Swarm
                </div>
                <div style={{ fontSize: '1.2rem', color: '#ccc', marginBottom: '2rem', minHeight: '40px' }}>
                  {loadingStage || 'Preparing...'}
                </div>
                <div style={{
                  width: '100%', height: '16px', backgroundColor: '#333',
                  borderRadius: '8px', overflow: 'hidden', marginBottom: '2rem'
                }}>
                  <div style={{
                    width: `${loadingProgress}%`, height: '100%', 
                    background: 'linear-gradient(90deg, #4CAF50, #45a049)',
                    borderRadius: '8px', transition: 'width 0.5s ease'
                  }} />
                </div>
                <div style={{ fontSize: '1.5rem', color: '#4CAF50', fontWeight: 'bold', marginBottom: '2rem' }}>
                  {loadingProgress}%
                </div>
              </div>
            </div>
          )}

          {/* Header (SIMPLIFIED - removed layout toggle) */}
          <div className="header">
            <h1>🐝 Video Swarm <span style={{ fontSize: '0.6rem', color: '#666' }}>v1.0.0</span></h1>

            <div id="folderControls">
              {isElectron ? (
                <button onClick={handleFolderSelect} className="file-input-label" disabled={isLoadingFolder}>
                  📁 Select Folder
                </button>
              ) : (
                <div className="file-input-wrapper">
                  <input type="file" className="file-input" webkitdirectory="true" multiple 
                    onChange={handleWebFileSelection} style={{ display: 'none' }} id="fileInput" disabled={isLoadingFolder} />
                  <label htmlFor="fileInput" className="file-input-label">
                    ⚠️ Open Folder (Limited)
                  </label>
                </div>
              )}
            </div>

            <div className="debug-info" style={{
              fontSize: '0.75rem', color: '#888', background: '#1a1a1a',
              padding: '0.3rem 0.8rem', borderRadius: '4px'
            }}>
              📁 {videos.length} videos | ▶️ {playingVideos.size} playing | 👁️ {visibleVideos.size} in view
            </div>

            <div className="controls">
              <button onClick={toggleRecursive} className={`toggle-button ${recursiveMode ? 'active' : ''}`} disabled={isLoadingFolder}>
                {recursiveMode ? '📂 Recursive ON' : '📂 Recursive'}
              </button>
              <button onClick={toggleFilenames} className={`toggle-button ${showFilenames ? 'active' : ''}`} disabled={isLoadingFolder}>
                {showFilenames ? '📝 Filenames ON' : '📝 Filenames'}
              </button>

              <div className="video-limit-control" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>📹</span>
                <input type="range" min="10" max="100" value={maxConcurrentPlaying} step="5" style={{ width: '100px' }}
                  onChange={(e) => handleVideoLimitChange(parseInt(e.target.value))} disabled={isLoadingFolder} />
                <span style={{ fontSize: '0.8rem' }}>{maxConcurrentPlaying}</span>
              </div>

              <div className="zoom-control" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>🔍</span>
                <input type="range" min="0" max="3" value={zoomLevel} step="1"
                  onChange={(e) => handleZoomChange(parseInt(e.target.value))} disabled={isLoadingFolder} />
                <span>{getZoomLabel}</span>
              </div>
            </div>
          </div>

          {/* Main content area (SIMPLIFIED - always masonry-vertical) */}
          {groupedAndSortedVideos.length === 0 && !isLoadingFolder ? (
            <div className="drop-zone">
              <h2>🐝 Welcome to Video Swarm 🐝</h2>
              <p>Click "Select Folder" above to browse your video collection</p>
              <div style={{
                marginTop: '2rem', padding: '1rem', background: '#2a4a00', borderRadius: '8px'
              }}>
                <div style={{ color: '#4CAF50', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                  ⚡ Folder-Grouped Masonry Layout
                </div>
                <ul style={{ color: '#ccc', margin: 0, paddingLeft: '1.5rem', lineHeight: 1.6 }}>
                  <li>Videos automatically grouped by subfolder</li>
                  <li>Sorted alphabetically within each folder</li>
                  <li>Perfect for organized AI generation workflows</li>
                  <li>All performance optimizations preserved</li>
                </ul>
              </div>
            </div>
          ) : (
            <div 
              ref={gridRef}
              className={`video-grid masonry-vertical zoom-${['small', 'medium', 'large', 'xlarge'][zoomLevel]} ${!showFilenames ? 'hide-filenames' : ''}`}
            >
              {/* FIXED: Direct rendering of grouped and sorted videos */}
              {groupedAndSortedVideos.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  selected={selectedVideos.has(video.id)}
                  onSelect={handleVideoSelect}
                  canPlayMoreVideos={canPlayMoreVideos}
                  onVideoPlay={handleVideoPlay}
                  onVideoPause={handleVideoPause}
                  onVideoLoad={handleVideoLoaded}
                  showFilenames={showFilenames}
                  onContextMenu={showContextMenu}
                  
                  // Performance props
                  canLoadMoreVideos={() => canLoadMoreVideos(video.id)}
                  isLoading={loadingVideos.has(video.id)}
                  isLoaded={loadedVideos.has(video.id)}
                  isVisible={visibleVideos.has(video.id)}
                  isPlaying={playingVideos.has(video.id)}
                  onStartLoading={handleVideoStartLoading}
                  onStopLoading={handleVideoStopLoading}
                  onVisibilityChange={handleVideoVisibilityChange}
                />
              ))}
            </div>
          )}

          {/* Modals (PRESERVED) */}
          {fullScreenVideo && (
            <FullScreenModal
              video={fullScreenVideo}
              onClose={() => closeFullScreen()}
              onNavigate={navigateFullScreen}
              showFilenames={showFilenames}
              gridRef={gridRef}
            />
          )}

          {contextMenu.visible && (
            <ContextMenu
              video={contextMenu.video}
              position={contextMenu.position}
              onClose={hideContextMenu}
              onAction={handleContextAction}
            />
          )}
        </>
      )}
    </div>
  );
}

export default App;