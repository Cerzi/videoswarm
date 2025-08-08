import React, { useState, useEffect, useCallback, useRef } from 'react';
import VideoCard from './components/VideoCard';
import FullScreenModal from './components/FullScreenModal';
import ContextMenu from './components/ContextMenu';
import { useLayoutManager } from './hooks/useLayoutManager';
import { useFullScreenModal } from './hooks/useFullScreenModal';
import { useContextMenu } from './hooks/useContextMenu';
import './App.css';

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [autoplayEnabled, setAutoplayEnabled] = useState(true);
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true); // NEW: Filename visibility setting
  const [maxConcurrentPlaying, setMaxConcurrentPlaying] = useState(30);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [playingVideos, setPlayingVideos] = useState(new Set());
  const [videosWantingToPlay, setVideosWantingToPlay] = useState(new Set()); // Track all videos that want to play
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [settingsLoaded, setSettingsLoaded] = useState(false); // Track if settings are loaded

  // Use the layout manager hook
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

  // Use the fullscreen modal hook
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
        // Check if click is outside the context menu
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
      setVideosWantingToPlay(prev => {
        const newSet = new Set(prev);
        newSet.delete(filePath);
        return newSet;
      });
      setLoadedVideos(prev => {
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
  }, []);

  const canPlayMoreVideos = useCallback(() => {
    return playingVideos.size < maxConcurrentPlaying;
  }, [playingVideos.size, maxConcurrentPlaying]);

  const handleVideoPlay = useCallback((videoId) => {
    setVideosWantingToPlay((prev) => new Set([...prev, videoId]));
    
    // Only actually play if under the limit
    if (playingVideos.size < maxConcurrentPlaying) {
      setPlayingVideos((prev) => new Set([...prev, videoId]));
    }
  }, [playingVideos.size, maxConcurrentPlaying]);

  const handleVideoPause = useCallback((videoId) => {
    setPlayingVideos((prev) => {
      const newSet = new Set(prev);
      newSet.delete(videoId);
      return newSet;
    });
    
    setVideosWantingToPlay((prev) => {
      const newSet = new Set(prev);
      newSet.delete(videoId);
      return newSet;
    });
  }, []);

  const saveSettings = useCallback(async () => {
    if (window.electronAPI?.saveSettingsPartial) {
      try {
        await window.electronAPI.saveSettingsPartial({
          recursiveMode,
          autoplayEnabled,
          maxConcurrentPlaying,
          // Note: layoutMode, zoomLevel, and showFilenames are saved individually
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

  const handleElectronFolderSelection = async (folderPath) => {
    if (!window.electronAPI?.readDirectory) {
      console.error('Electron readDirectory API not available');
      return;
    }

    try {
      // Stop any existing file watcher
      if (window.electronAPI?.stopFolderWatch) {
        await window.electronAPI.stopFolderWatch();
      }

      // Clear existing state
      setVideos([]);
      setSelectedVideos(new Set());
      setPlayingVideos(new Set());
      setVideosWantingToPlay(new Set());
      setLoadedVideos(new Set());

      // Read directory with rich metadata
      const videoFiles = await window.electronAPI.readDirectory(folderPath, recursiveMode);
      console.log(`Found ${videoFiles.length} video files with metadata`);

      // Video files now come as rich objects, not just paths
      setVideos(videoFiles);

      // Start file system watcher
      if (window.electronAPI?.startFolderWatch) {
        const watchResult = await window.electronAPI.startFolderWatch(folderPath);
        if (watchResult.success) {
          console.log('Started watching folder for changes');
        } else {
          console.warn('Failed to start folder watcher:', watchResult.error);
        }
      }

    } catch (error) {
      console.error('Error reading directory:', error);
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
    setVideosWantingToPlay(new Set());
    setLoadedVideos(new Set());
  };

  const toggleAutoplay = () => {
    const newAutoplay = !autoplayEnabled;
    setAutoplayEnabled(newAutoplay);

    if (!newAutoplay) {
      // Pause all videos but remember they wanted to play
      setPlayingVideos(new Set());
      // Keep videosWantingToPlay as-is so they can resume later
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
      const toPause = playingArray.slice(newLimit);
      
      setPlayingVideos(new Set(toKeepPlaying));
      
      // The paused videos should still want to play
      // (videosWantingToPlay already includes them)
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

  const handleVideoLoaded = useCallback(
    (videoId, aspectRatio) => {
      setLoadedVideos((prev) => new Set([...prev, videoId]));
      updateAspectRatio(videoId, aspectRatio);
    },
    [updateAspectRatio]
  );

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
          {/* Header */}
          <div className="header">
            <h1>
              🎬 Video Browser{' '}
              <span style={{ fontSize: '0.6rem', color: '#666', fontWeight: 'normal' }}>v2.10</span>
            </h1>

            <div id="folderControls">
              {isElectron ? (
                <button onClick={handleFolderSelect} className="file-input-label">
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
              📁 {videos.length} videos | ▶️ {playingVideos.size} playing {videosWantingToPlay.size > playingVideos.size && `(${videosWantingToPlay.size - playingVideos.size} waiting)`} | 📼 {loadedVideos.size} loaded
            </div>

            <div className="controls">
              <button
                onClick={toggleAutoplay}
                className={`toggle-button ${!autoplayEnabled ? 'active' : ''}`}
              >
                {autoplayEnabled ? '⏸️ Pause All' : '▶️ Resume All'}
              </button>

              <button
                onClick={toggleRecursive}
                className={`toggle-button ${recursiveMode ? 'active' : ''}`}
              >
                {recursiveMode ? '📂 Recursive ON' : '📂 Recursive'}
              </button>

              <button
                onClick={toggleFilenames}
                className={`toggle-button ${showFilenames ? 'active' : ''}`}
              >
                {showFilenames ? '📝 Filenames ON' : '📝 Filenames'}
              </button>

              <button onClick={handleLayoutToggle} className="toggle-button">
                {getLayoutButtonText()}
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
                />
                <span>{getZoomLabel()}</span>
              </div>
            </div>
          </div>

          {/* Main content area */}
          {videos.length === 0 ? (
            <div className="drop-zone">
              {isElectron ? (
                <div>
                  <h2>🎬 Welcome to Video Browser</h2>
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
                      ✨ Full Desktop Integration
                    </div>
                    <ul style={{ color: '#ccc', margin: 0, paddingLeft: '1.5rem', lineHeight: 1.6 }}>
                      <li>Browse any folder on your computer</li>
                      <li>Right-click to show files in file manager</li>
                      <li>Delete files (moves to trash)</li>
                      <li>Optimized performance for large collections</li>
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
                  <div
                    style={{
                      marginTop: '2rem',
                      padding: '1rem',
                      background: '#4a3000',
                      borderRadius: '8px',
                      borderLeft: '4px solid #ff9800',
                    }}
                  >
                    <div style={{ color: '#ff9800', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                      ⚠️ Limited Web Mode
                    </div>
                    <p style={{ color: '#ccc', margin: 0, lineHeight: 1.6 }}>
                      Running in web browser with reduced functionality. For full desktop integration, consider
                      downloading the desktop app.
                    </p>
                  </div>
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
    </div>
  );
}

export default App;