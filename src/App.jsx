import React, { useState, useEffect, useCallback, useRef } from 'react';
import VideoCard from './components/VideoCard';
import FullScreenModal from './components/FullScreenModal';
import ContextMenu from './components/ContextMenu';
import { useLayoutManager } from './hooks/useLayoutManager';
import { useFullScreenModal } from './hooks/useFullScreenModal';
import { useContextMenu } from './hooks/useContextMenu';
import { usePerformanceManager } from './hooks/usePerformanceManager';
import './App.css';

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [autoplayEnabled, setAutoplayEnabled] = useState(true);
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true);
  const [maxConcurrentPlaying, setMaxConcurrentPlaying] = useState(30);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  
  // NEW: Loading state with progress
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState('');
  const [loadingProgress, setLoadingProgress] = useState(0);

  // Use the layout manager hook (RESTORED)
  const {
    layoutMode,
    gridRef,
    toggleLayout,
    refreshMasonryLayout,
    forceLayout,
    setZoom,
    updateAspectRatio,
    manualVisibilityCheck
  } = useLayoutManager(videos, zoomLevel);

  // Use performance manager with REDUCED complexity (not removed)
  const {
    loadingVideos,
    loadedVideos,
    visibleVideos,
    playingVideos,
    setLoadingVideos,
    setLoadedVideos,
    setVisibleVideos,
    setPlayingVideos,
    smartCleanup,
    emergencyCleanup,
    maxLoadedVideos,
    maxConcurrentLoading,
    getPerformanceStats
  } = usePerformanceManager(videos, maxConcurrentPlaying, autoplayEnabled);

  // Use the fullscreen modal hook (RESTORED)
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen
  } = useFullScreenModal(videos, layoutMode, gridRef);

  // Use the context menu hook
  const {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    handleContextAction
  } = useContextMenu();

  // Handle click outside context menu to close it
  useEffect(() => {
    if (contextMenu.visible) {
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
    }
  }, [contextMenu.visible, hideContextMenu]);

  // Check if we're in Electron
  const isElectron = window.electronAPI?.isElectron;

  // Synchronously load settings on mount to prevent flash of default values
  useEffect(() => {
    const loadSettings = async () => {
      if (window.electronAPI?.getSettings) {
        try {
          // Try to get settings synchronously
          const settings = await window.electronAPI.getSettings();
          console.log('Synchronously loaded settings:', settings);
          
          if (settings.recursiveMode !== undefined) setRecursiveMode(settings.recursiveMode);
          if (settings.autoplayEnabled !== undefined) setAutoplayEnabled(settings.autoplayEnabled);
          if (settings.showFilenames !== undefined) setShowFilenames(settings.showFilenames);
          if (settings.maxConcurrentPlaying !== undefined) setMaxConcurrentPlaying(settings.maxConcurrentPlaying);
          if (settings.zoomLevel !== undefined) setZoomLevel(settings.zoomLevel);
          
          setSettingsLoaded(true);
        } catch (error) {
          console.log('Could not load settings synchronously, using defaults');
          setSettingsLoaded(true);
        }
      } else {
        // No Electron API, use defaults
        setSettingsLoaded(true);
      }
    };

    loadSettings();

    // Also set up the async listener as backup
    if (window.electronAPI?.onSettingsLoaded) {
      window.electronAPI.onSettingsLoaded((settings) => {
        console.log('Async settings received:', settings);
        if (settings.recursiveMode !== undefined) setRecursiveMode(settings.recursiveMode);
        if (settings.autoplayEnabled !== undefined) setAutoplayEnabled(settings.autoplayEnabled);
        if (settings.showFilenames !== undefined) setShowFilenames(settings.showFilenames);
        if (settings.maxConcurrentPlaying !== undefined) setMaxConcurrentPlaying(settings.maxConcurrentPlaying);
        if (settings.zoomLevel !== undefined) setZoomLevel(settings.zoomLevel);
        setSettingsLoaded(true);
      });
    }

    // Listen for folder selection from menu
    if (window.electronAPI?.onFolderSelected) {
      window.electronAPI.onFolderSelected((folderPath) => {
        handleElectronFolderSelection(folderPath);
      });
    }
  }, []);

  // Set up file system event listeners
  useEffect(() => {
    if (!window.electronAPI) return;

    // File added
    const handleFileAdded = (videoFile) => {
      console.log('File added:', videoFile.name);
      setVideos(prev => {
        // Check if file already exists (avoid duplicates)
        if (prev.some(v => v.id === videoFile.id)) {
          return prev;
        }
        // Add and sort by name
        const newVideos = [...prev, videoFile];
        return newVideos.sort((a, b) => a.name.localeCompare(b.name));
      });
    };

    // File removed  
    const handleFileRemoved = (filePath) => {
      console.log('File removed:', filePath);
      setVideos(prev => prev.filter(v => v.id !== filePath));
      // Also clean up any related state
      setSelectedVideos(prev => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
      setPlayingVideos(prev => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
      setLoadedVideos(prev => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
      setLoadingVideos(prev => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
    };

    // File changed (updated metadata)
    const handleFileChanged = (videoFile) => {
      console.log('File changed:', videoFile.name);
      setVideos(prev => prev.map(v => 
        v.id === videoFile.id ? videoFile : v
      ));
    };

    // File watch error
    const handleFileWatchError = (error) => {
      console.warn('File watch error (this is usually harmless):', error);
      // Could show a toast notification here instead of console spam
    };

    // Set up listeners
    if (window.electronAPI.onFileAdded) {
      window.electronAPI.onFileAdded(handleFileAdded);
    }
    if (window.electronAPI.onFileRemoved) {
      window.electronAPI.onFileRemoved(handleFileRemoved);
    }
    if (window.electronAPI.onFileChanged) {
      window.electronAPI.onFileChanged(handleFileChanged);
    }
    if (window.electronAPI.onFileWatchError) {
      window.electronAPI.onFileWatchError(handleFileWatchError);
    }

    // Cleanup on unmount
    return () => {
      if (window.electronAPI?.stopFolderWatch) {
        window.electronAPI.stopFolderWatch().catch(console.error);
      }
    };
  }, [setPlayingVideos, setLoadedVideos, setLoadingVideos]);

  const canPlayMoreVideos = useCallback(() => {
    return playingVideos.size < maxConcurrentPlaying;
  }, [playingVideos.size, maxConcurrentPlaying]);

  const handleVideoPlay = useCallback((videoId) => {
    if (playingVideos.size < maxConcurrentPlaying) {
      setPlayingVideos(prev => new Set([...prev, videoId]));
    }
  }, [playingVideos.size, maxConcurrentPlaying, setPlayingVideos]);

  const handleVideoPause = useCallback((videoId) => {
    setPlayingVideos(prev => {
      const newSet = new Set(prev);
      newSet.delete(videoId);
      return newSet;
    });
  }, [setPlayingVideos]);

  const handleVideoLoaded = useCallback(
    (videoId, aspectRatio) => {
      setLoadedVideos((prev) => new Set([...prev, videoId]));
      updateAspectRatio(videoId, aspectRatio);
    },
    [setLoadedVideos, updateAspectRatio]
  );

  const handleVideoStartLoading = useCallback((videoId) => {
    setLoadingVideos(prev => new Set([...prev, videoId]));
  }, [setLoadingVideos]);

  const handleVideoStopLoading = useCallback((videoId) => {
    setLoadingVideos(prev => {
      const newSet = new Set(prev);
      newSet.delete(videoId);
      return newSet;
    });
  }, [setLoadingVideos]);

  const handleVideoVisibilityChange = useCallback((videoId, isVisible) => {
    console.log(`Visibility change: ${videoId} -> ${isVisible ? 'visible' : 'hidden'}`);
    setVisibleVideos(prev => {
      const newSet = new Set(prev);
      if (isVisible) {
        newSet.add(videoId);
      } else {
        newSet.delete(videoId);
      }
      console.log(`Total visible videos: ${newSet.size}`);
      return newSet;
    });
  }, [setVisibleVideos]);

  // NEW: Enhanced folder loading with progress
  const handleElectronFolderSelection = async (folderPath) => {
    if (!window.electronAPI?.readDirectory) {
      console.error('Electron readDirectory API not available');
      return;
    }

    try {
      console.log('🚀 SHOWING LOADING SCREEN');
      
      // SHOW LOADING SCREEN WITH PROMINENT DISPLAY
      setIsLoadingFolder(true);
      setLoadingStage('Reading directory...');
      setLoadingProgress(10);

      // Give React time to render the loading screen
      await new Promise(resolve => setTimeout(resolve, 100));

      console.log('📁 Starting folder scan:', folderPath);

      // Stop any existing file watcher
      if (window.electronAPI?.stopFolderWatch) {
        await window.electronAPI.stopFolderWatch();
      }

      // Clear ALL state but do it BEFORE we start loading new videos
      console.log('🧹 Clearing existing state');
      setVideos([]);
      setSelectedVideos(new Set());
      setPlayingVideos(new Set());
      setLoadedVideos(new Set());
      setLoadingVideos(new Set());
      setVisibleVideos(new Set());

      // Update progress
      setLoadingStage('Scanning for video files...');
      setLoadingProgress(30);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Read directory
      console.log('📂 Reading directory with recursive:', recursiveMode);
      const videoFiles = await window.electronAPI.readDirectory(folderPath, recursiveMode);
      
      console.log(`📊 Found ${videoFiles.length} video files`);

      // Update progress
      setLoadingStage(`Found ${videoFiles.length} videos - preparing layout...`);
      setLoadingProgress(70);
      await new Promise(resolve => setTimeout(resolve, 300));

      // Set videos - this is where the magic happens
      console.log('🎬 Setting videos state - layout will initialize');
      setVideos(videoFiles);

      // Give the layout system time to initialize 
      await new Promise(resolve => setTimeout(resolve, 500));

      // Complete loading
      setLoadingStage('Complete!');
      setLoadingProgress(100);
      await new Promise(resolve => setTimeout(resolve, 300));

      console.log('✅ Loading complete, hiding screen');
      setIsLoadingFolder(false);

      // Start file system watcher
      if (window.electronAPI?.startFolderWatch) {
        const watchResult = await window.electronAPI.startFolderWatch(folderPath);
        if (watchResult.success) {
          console.log('👁️ Started watching folder for changes');
        } else {
          console.warn('Failed to start folder watcher:', watchResult.error);
        }
      }

    } catch (error) {
      console.error('Error reading directory:', error);
      setIsLoadingFolder(false);
      setLoadingStage('Error occurred');
    }
  };

  const saveSettings = useCallback(async () => {
    if (window.electronAPI?.saveSettingsPartial) {
      try {
        await window.electronAPI.saveSettingsPartial({
          recursiveMode,
          autoplayEnabled,
          maxConcurrentPlaying,
        });
      } catch (error) {
        console.error('Failed to save settings:', error);
      }
    }
  }, [recursiveMode, autoplayEnabled, maxConcurrentPlaying]);

  const handleFolderSelect = async () => {
    if (!window.electronAPI?.selectFolder) {
      console.error('Electron API not available');
      return;
    }

    try {
      const result = await window.electronAPI.selectFolder();
      if (result && result.folderPath) {
        await handleElectronFolderSelection(result.folderPath);
      }
    } catch (error) {
      console.error('Error opening folder dialog:', error);
    }
  };

  const handleWebFileSelection = (event) => {
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
    setLoadedVideos(new Set());
    setLoadingVideos(new Set());
    setVisibleVideos(new Set());
  };

  const toggleAutoplay = () => {
    const newAutoplay = !autoplayEnabled;
    setAutoplayEnabled(newAutoplay);

    if (!newAutoplay) {
      // Pause all videos
      setPlayingVideos(new Set());
    }

    saveSettings();
  };

  const handleLayoutToggle = () => {
    const newMode = toggleLayout();
    // Layout mode is now saved automatically in useLayoutManager
    return newMode;
  };

  const toggleRecursive = () => {
    setRecursiveMode(!recursiveMode);
    saveSettings();
  };

  const toggleFilenames = () => {
    const newShowFilenames = !showFilenames;
    setShowFilenames(newShowFilenames);
    
    // Save immediately like other settings
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        showFilenames: newShowFilenames,
      }).catch(error => {
        console.error('Failed to save filename setting:', error);
      });
    }
  };

  const handleVideoLimitChange = (newLimit) => {
    setMaxConcurrentPlaying(newLimit);

    // If we reduced the limit, pause excess videos
    if (playingVideos.size > newLimit) {
      const playingArray = Array.from(playingVideos);
      const toKeepPlaying = playingArray.slice(0, newLimit);
      
      setPlayingVideos(new Set(toKeepPlaying));
    }

    saveSettings();
  };

  const handleZoomChange = (newZoom) => {
    setZoomLevel(newZoom);
    setZoom(newZoom); // This now handles saving automatically
  };

  const getLayoutButtonText = () => {
    const buttonTexts = {
      grid: '📐 Grid',
      'masonry-vertical': '📐 Vertical',
      'masonry-horizontal': '📐 Horizontal',
    };
    return buttonTexts[layoutMode];
  };

  const getZoomLabel = () => {
    const labels = ['75%', '100%', '150%', '200%'];
    return labels[zoomLevel] || '100%';
  };

  const handleVideoSelect = (videoId, isCtrlClick, isDoubleClick) => {
    const video = videos.find(v => v.id === videoId);
    
    if (isDoubleClick && video) {
      // Open fullscreen on double-click
      openFullScreen(video, playingVideos);
      // Note: Background videos continue playing
      return;
    }

    // Regular selection logic
    const newSelected = new Set(selectedVideos);

    if (isCtrlClick) {
      if (newSelected.has(videoId)) {
        newSelected.delete(videoId);
      } else {
        newSelected.add(videoId);
      }
    } else {
      newSelected.clear();
      newSelected.add(videoId);
    }

    setSelectedVideos(newSelected);
  };

  // Handle keyboard shortcuts for fullscreen
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Only handle if not in fullscreen and have a selection
      if (fullScreenVideo || selectedVideos.size !== 1) return;

      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        const selectedVideoId = Array.from(selectedVideos)[0];
        const video = videos.find(v => v.id === selectedVideoId);
        
        if (video) {
          openFullScreen(video, playingVideos);
          // Note: Background videos continue playing
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [fullScreenVideo, selectedVideos, videos, openFullScreen, playingVideos]);

  // Handle fullscreen close
  const handleFullScreenClose = useCallback(() => {
    closeFullScreen();
    // Note: Background videos continue playing naturally
  }, [closeFullScreen]);

  // Emergency cleanup hotkey
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'F12' && e.ctrlKey) {
        console.log('Emergency cleanup triggered');
        emergencyCleanup();
      }
      
      // Cancel loading
      if (e.key === 'Escape' && isLoadingFolder) {
        console.log('Loading cancelled');
        setIsLoadingFolder(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [emergencyCleanup, isLoadingFolder]);

  return (
    <div className="app">
      {/* Show loading until settings are loaded to prevent flash of wrong values */}
      {!settingsLoaded ? (
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          height: '100vh',
          color: '#888'
        }}>
          Loading settings...
        </div>
      ) : (
        <>
          {/* NEW: Enhanced Loading Screen */}
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
                border: '2px solid #333',
                position: 'relative'
              }}>
                <div style={{ fontSize: '3rem', marginBottom: '1.5rem' }}>
                  🐝
                </div>
                <div style={{ fontSize: '2rem', marginBottom: '1rem', color: '#4CAF50', fontWeight: 'bold' }}>
                  Video Swarm
                </div>
                <div style={{ fontSize: '1.2rem', color: '#ccc', marginBottom: '2rem', minHeight: '40px', lineHeight: 1.4 }}>
                  {loadingStage || 'Preparing...'}
                </div>
                <div style={{
                  width: '100%', height: '16px', backgroundColor: '#333',
                  borderRadius: '8px', overflow: 'hidden', marginBottom: '2rem',
                  border: '1px solid #444'
                }}>
                  <div style={{
                    width: `${loadingProgress}%`, height: '100%', 
                    background: 'linear-gradient(90deg, #4CAF50, #45a049, #4CAF50)',
                    borderRadius: '8px', transition: 'width 0.5s ease',
                    backgroundSize: '200% 100%',
                    animation: loadingProgress < 100 ? 'shimmer 2s infinite linear' : 'none'
                  }} />
                </div>
                <div style={{ 
                  fontSize: '1.5rem', color: '#4CAF50', fontWeight: 'bold', marginBottom: '2rem' 
                }}>
                  {loadingProgress}%
                </div>
                <div style={{
                  fontSize: '1rem', color: '#666', marginBottom: '2rem',
                  padding: '1.5rem', background: '#222', borderRadius: '12px',
                  lineHeight: 1.5
                }}>
                  <div style={{ color: '#4CAF50', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                    ⚡ Advanced Masonry Layouts
                  </div>
                  Loading your video collection with intelligent performance management...
                </div>
                <button onClick={() => {
                  console.log('❌ Loading cancelled by user');
                  setIsLoadingFolder(false);
                }} style={{
                  padding: '1rem 2.5rem', backgroundColor: '#ff4444',
                  color: 'white', border: 'none', borderRadius: '10px', 
                  cursor: 'pointer', fontSize: '1.1rem', fontWeight: 'bold',
                  transition: 'background-color 0.3s ease'
                }} onMouseEnter={(e) => e.target.style.backgroundColor = '#cc3333'}
                   onMouseLeave={(e) => e.target.style.backgroundColor = '#ff4444'}>
                  Cancel Loading
                </button>
              </div>
            </div>
          )}

          {/* Header */}
          <div className="header">
            <h1>
              🐝 Video Swarm{' '}
              <span style={{ fontSize: '0.6rem', color: '#666', fontWeight: 'normal' }}>v2.15-restored</span>
            </h1>

            <div id="folderControls">
              {isElectron ? (
                <button onClick={handleFolderSelect} className="file-input-label" disabled={isLoadingFolder}>
                  📁 Select Folder
                </button>
              ) : (
                <div className="file-input-wrapper">
                  <input
                    type="file"
                    className="file-input"
                    webkitdirectory="true"
                    multiple
                    onChange={handleWebFileSelection}
                    style={{ display: 'none' }}
                    id="fileInput"
                  />
                  <label htmlFor="fileInput" className="file-input-label">
                    ⚠️ Open Folder (Limited)
                  </label>
                </div>
              )}
            </div>

            <div
              className="debug-info"
              style={{
                fontSize: '0.75rem',
                color: '#888',
                background: '#1a1a1a',
                padding: '0.3rem 0.8rem',
                borderRadius: '4px',
              }}
            >
              📁 {videos.length} videos | ▶️ {playingVideos.size} playing | 👁️ {visibleVideos.size} in view
            </div>

            <div className="controls">
              <button
                onClick={toggleAutoplay}
                className={`toggle-button ${!autoplayEnabled ? 'active' : ''}`}
                disabled={isLoadingFolder}
              >
                {autoplayEnabled ? '⏸️ Pause All' : '▶️ Resume All'}
              </button>

              <button
                onClick={toggleRecursive}
                className={`toggle-button ${recursiveMode ? 'active' : ''}`}
                disabled={isLoadingFolder}
              >
                {recursiveMode ? '📂 Recursive ON' : '📂 Recursive'}
              </button>

              <button
                onClick={toggleFilenames}
                className={`toggle-button ${showFilenames ? 'active' : ''}`}
                disabled={isLoadingFolder}
              >
                {showFilenames ? '📝 Filenames ON' : '📝 Filenames'}
              </button>

              <button onClick={handleLayoutToggle} className="toggle-button" disabled={isLoadingFolder}>
                {getLayoutButtonText()}
              </button>

              <button 
                onClick={emergencyCleanup}
                className="toggle-button"
                title="Clean up loaded videos to free memory"
                style={{ color: '#ff6b6b' }}
                disabled={isLoadingFolder}
              >
                🧹 Cleanup
              </button>

              <div className="video-limit-control" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.9rem' }}>📹</span>
                <input
                  type="range"
                  className="zoom-slider"
                  min="10"
                  max="100"
                  value={maxConcurrentPlaying}
                  step="5"
                  style={{ width: '100px' }}
                  onChange={(e) => handleVideoLimitChange(parseInt(e.target.value))}
                  disabled={isLoadingFolder}
                />
                <span style={{ fontSize: '0.8rem', minWidth: '30px' }}>{maxConcurrentPlaying}</span>
              </div>

              <div className="zoom-control" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span>🔍</span>
                <input
                  type="range"
                  className="zoom-slider"
                  min="0"
                  max="3"
                  value={zoomLevel}
                  step="1"
                  onChange={(e) => handleZoomChange(parseInt(e.target.value))}
                  disabled={isLoadingFolder}
                />
                <span>{getZoomLabel()}</span>
              </div>
            </div>
          </div>

          {/* Main content area */}
          {videos.length === 0 && !isLoadingFolder ? (
            <div className="drop-zone">
              {isElectron ? (
                <div>
                  <h2>🐝 Welcome to Video Swarm 🐝</h2>
                  <p>Click "Select Folder" above to browse your video collection</p>
                  <p style={{ marginTop: '1rem', color: '#666', fontSize: '0.8rem' }}>
                    Supports: MP4, MOV, AVI, MKV, WebM, M4V, FLV, WMV, 3GP, OGV
                  </p>
                  <div
                    style={{
                      marginTop: '2rem',
                      padding: '1rem',
                      background: '#2a4a00',
                      borderRadius: '8px',
                      borderLeft: '4px solid #4CAF50',
                    }}
                  >
                    <div style={{ color: '#4CAF50', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                      ✨ Advanced Masonry Layouts
                    </div>
                    <ul style={{ color: '#ccc', margin: 0, paddingLeft: '1.5rem', lineHeight: 1.6 }}>
                      <li>Grid Layout: Responsive grid with consistent spacing</li>
                      <li>Vertical Masonry: Pinterest-style fixed width, variable height</li>
                      <li>Horizontal Masonry: Fixed height, variable width for ultrawide</li>
                      <li>Smart performance management for 1000+ video collections</li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div>
                  <h2>Drop video files here</h2>
                  <p>Or use the "Open Folder" button above</p>
                  <p style={{ marginTop: '1rem', color: '#666', fontSize: '0.8rem' }}>
                    Supports: MP4, MOV, AVI, MKV, WebM, M4V (H.264 codec)
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div 
              ref={gridRef}
              className={`video-grid ${layoutMode} zoom-${['small', 'medium', 'large', 'xlarge'][zoomLevel]} ${!showFilenames ? 'hide-filenames' : ''}`}
            >
              {videos.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  selected={selectedVideos.has(video.id)}
                  onSelect={handleVideoSelect}
                  autoplayEnabled={autoplayEnabled}
                  canPlayMoreVideos={canPlayMoreVideos}
                  onVideoPlay={handleVideoPlay}
                  onVideoPause={handleVideoPause}
                  onVideoLoad={handleVideoLoaded}
                  layoutMode={layoutMode}
                  showFilenames={showFilenames}
                  onContextMenu={showContextMenu}
                  
                  // Performance manager integration (RESTORED)
                  canLoadMoreVideos={() => loadingVideos.size < maxConcurrentLoading && loadedVideos.size < maxLoadedVideos}
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

          {/* Fullscreen Modal */}
          {fullScreenVideo && (
            <FullScreenModal
              video={fullScreenVideo}
              onClose={handleFullScreenClose}
              onNavigate={navigateFullScreen}
              showFilenames={showFilenames}
              layoutMode={layoutMode}
              gridRef={gridRef}
            />
          )}

          {/* Context Menu */}
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
      
      {/* Add CSS for loading animation */}
      <style jsx>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </div>
  );
}

export default App;