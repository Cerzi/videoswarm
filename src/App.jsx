import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import VideoCard from './components/VideoCard';
import FullScreenModal from './components/FullScreenModal';
import ContextMenu from './components/ContextMenu';
import { useLayoutManager } from './hooks/useLayoutManager';
import { useFullScreenModal } from './hooks/useFullScreenModal';
import { useContextMenu } from './hooks/useContextMenu';
import { useVideoManager } from './hooks/useVideoManager';
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
  
  // Loading state
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState('');
  const [loadingProgress, setLoadingProgress] = useState(0);
  
  // CENTRALIZED: Video state management
  const videoManager = useVideoManager(videos, autoplayEnabled, maxConcurrentPlaying);

  // Use layout manager (SIMPLIFIED TO VERTICAL MASONRY ONLY)
  const {
    gridRef,
    refreshMasonryLayout,
    forceLayout,
    setZoom,
    updateAspectRatio,
    manualVisibilityCheck
  } = useLayoutManager(videos, zoomLevel);

  // Use fullscreen modal (SIMPLIFIED)
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen
  } = useFullScreenModal(videos, gridRef);

  // Use context menu (CORE FUNCTIONALITY PRESERVED)
  const {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    handleContextAction
  } = useContextMenu();

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

  // CALLBACK: Settings loading
  useEffect(() => {
    const loadSettings = async () => {
      if (window.electronAPI?.getSettings) {
        try {
          const settings = await window.electronAPI.getSettings();
          
          if (settings.recursiveMode !== undefined) setRecursiveMode(settings.recursiveMode);
          if (settings.autoplayEnabled !== undefined) setAutoplayEnabled(settings.autoplayEnabled);
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

    // NEW: Helper function to sort videos hierarchically by folder then name
    const sortVideosHierarchically = (videos) => {
      return videos.sort((a, b) => {
        // Get directory paths (or empty string for root)
        const dirA = a.directory || '';
        const dirB = b.directory || '';

        // First sort by directory
        if (dirA !== dirB) {
          return dirA.localeCompare(dirB);
        }

        // Then sort by filename within the same directory
        return a.name.localeCompare(b.name);
      });
    };

    const handleFileAdded = (videoFile) => {
      setVideos(prev => {
        if (prev.some(v => v.id === videoFile.id)) return prev;
        const newVideos = [...prev, videoFile];
        return sortVideosHierarchically(newVideos);
      });
    };

    const handleFileRemoved = (filePath) => {
      setVideos(prev => prev.filter(v => v.id !== filePath));
      // Clean up related state
      setSelectedVideos(prev => { const newSet = new Set(prev); newSet.delete(filePath); return newSet; });
      // Video state cleanup now handled by useVideoManager
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
      // Video state now managed by useVideoManager hook

      setLoadingStage('Scanning for video files...');
      setLoadingProgress(30);
      await new Promise(resolve => setTimeout(resolve, 200));

      const videoFiles = await window.electronAPI.readDirectory(folderPath, recursiveMode);
      
      setLoadingStage(`Found ${videoFiles.length} videos - sorting and organizing...`);
      setLoadingProgress(70);
      await new Promise(resolve => setTimeout(resolve, 300));

      // NEW: Sort videos hierarchically by directory then name
      const sortedVideos = videoFiles.sort((a, b) => {
        // Get directory paths (or empty string for root)
        const dirA = a.directory || '';
        const dirB = b.directory || '';

        // First sort by directory
        if (dirA !== dirB) {
          return dirA.localeCompare(dirB);
        }

        // Then sort by filename within the same directory
        return a.name.localeCompare(b.name);
      });

      console.log(`📊 Setting ${sortedVideos.length} videos for masonry layout`);
      setVideos(sortedVideos);

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

  // MEMOIZED: Performance callback functions - simplified
  const canPlayMoreVideos = useCallback(() => {
    return autoplayEnabled;
  }, [autoplayEnabled]);

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
      directory: '', // Web files don't have directory structure
    }));

    // Sort web files alphabetically by name
    const sortedVideoObjects = videoObjects.sort((a, b) => a.name.localeCompare(b.name));

    setVideos(sortedVideoObjects);
    setSelectedVideos(new Set());
    // Video state now managed by useVideoManager hook
  }, []);

  // FIXED: Control handlers with immediate save
  const toggleAutoplay = useCallback(() => {
    const newAutoplay = !autoplayEnabled;
    setAutoplayEnabled(newAutoplay);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        autoplayEnabled: newAutoplay,
        recursiveMode, 
        maxConcurrentPlaying, 
        zoomLevel, 
        showFilenames
      }).catch(console.error);
    }
  }, [autoplayEnabled, recursiveMode, maxConcurrentPlaying, zoomLevel, showFilenames]);


  const toggleRecursive = useCallback(() => { 
    const newRecursive = !recursiveMode;
    setRecursiveMode(newRecursive);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        recursiveMode: newRecursive,
        autoplayEnabled, 
        maxConcurrentPlaying, 
        zoomLevel, 
        showFilenames
      }).catch(console.error);
    }
  }, [recursiveMode, autoplayEnabled, maxConcurrentPlaying, zoomLevel, showFilenames]);
  
  const toggleFilenames = useCallback(() => { 
    const newShowFilenames = !showFilenames;
    setShowFilenames(newShowFilenames);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        showFilenames: newShowFilenames,
        recursiveMode, 
        autoplayEnabled, 
        maxConcurrentPlaying, 
        zoomLevel
      }).catch(console.error);
    }
  }, [showFilenames, recursiveMode, autoplayEnabled, maxConcurrentPlaying, zoomLevel]);

  const handleVideoLimitChange = useCallback((newLimit) => {
    setMaxConcurrentPlaying(newLimit);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        maxConcurrentPlaying: newLimit,
        recursiveMode, 
        autoplayEnabled, 
        zoomLevel, 
        showFilenames
      }).catch(console.error);
    }
  }, [recursiveMode, autoplayEnabled, zoomLevel, showFilenames]);

  const handleZoomChange = useCallback((newZoom) => { 
    setZoomLevel(newZoom); 
    setZoom(newZoom);
    
    // Save immediately
    if (window.electronAPI?.saveSettingsPartial) {
      window.electronAPI.saveSettingsPartial({
        zoomLevel: newZoom,
        recursiveMode, 
        autoplayEnabled, 
        maxConcurrentPlaying, 
        showFilenames
      }).catch(console.error);
    }
  }, [setZoom, recursiveMode, autoplayEnabled, maxConcurrentPlaying, showFilenames]);

  const getZoomLabel = useMemo(() => 
    (['75%', '100%', '150%', '200%'][zoomLevel] || '100%'), 
    [zoomLevel]
  );

  const handleVideoSelect = useCallback((videoId, isCtrlClick, isDoubleClick) => {
    const video = videos.find(v => v.id === videoId);
    
    if (isDoubleClick && video) {
      openFullScreen(video, videoManager.playingVideos);
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
  }, [videos, openFullScreen, videoManager.playingVideos]);

  // CALLBACK: Emergency cleanup
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
                <button onClick={() => setIsLoadingFolder(false)} style={{
                  padding: '1rem 2.5rem', backgroundColor: '#ff4444',
                  color: 'white', border: 'none', borderRadius: '10px', 
                  cursor: 'pointer', fontSize: '1.1rem', fontWeight: 'bold'
                }}>
                  Cancel Loading
                </button>
              </div>
            </div>
          )}


          {/* Header (PRESERVED) */}
          <div className="header">
            <h1>🐝 Video Swarm <span style={{ fontSize: '0.6rem', color: '#666' }}>v2.21-fixed</span></h1>

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
              📁 {videos.length} videos | ▶️ {videoManager.playingVideos.size} playing | 👁️ {videoManager.visibleVideos.size} in view
            </div>

            <div className="controls">
              <button onClick={toggleAutoplay} className={`toggle-button ${!autoplayEnabled ? 'active' : ''}`} disabled={isLoadingFolder}>
                {autoplayEnabled ? '⏸️ Pause All' : '▶️ Resume All'}
              </button>
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

          {/* Main content area (CORE FUNCTIONALITY PRESERVED, FIXED FREEZING) */}
          {videos.length === 0 && !isLoadingFolder ? (
            <div className="drop-zone">
              <h2>🐝 Welcome to Video Swarm 🐝</h2>
              <p>Click "Select Folder" above to browse your video collection</p>
              <div style={{
                marginTop: '2rem', padding: '1rem', background: '#2a4a00', borderRadius: '8px'
              }}>
                <div style={{ color: '#4CAF50', fontWeight: 'bold', marginBottom: '0.5rem' }}>
                  ⚡ Performance Improvements (v2.21)
                </div>
                <ul style={{ color: '#ccc', margin: 0, paddingLeft: '1.5rem', lineHeight: 1.6 }}>
                  <li>Fixed infinite playback loops - centralized video state management</li>
                  <li>Improved layout switching with proper playback recovery</li>
                  <li>Smart hierarchical folder sorting (folder groups)</li>
                  <li>Conservative memory management to prevent crashes</li>
                </ul>
              </div>
            </div>
          ) : (
            <div 
              ref={gridRef}
              className={`video-grid masonry-vertical zoom-${['small', 'medium', 'large', 'xlarge'][zoomLevel]} ${!showFilenames ? 'hide-filenames' : ''}`}
            >
              {/* CENTRALIZED: Direct rendering with VideoManager commands */}
              {videos.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  selected={selectedVideos.has(video.id)}
                  onSelect={handleVideoSelect}
                  showFilenames={showFilenames}
                  onContextMenu={showContextMenu}
                  onVideoLoad={updateAspectRatio}
                  
                  // Commands from VideoManager (PURE INPUTS)
                  shouldPlay={videoManager.videoCardAPI.isPlaying(video.id)}
                  shouldLoad={videoManager.videoCardAPI.isVisible(video.id)}
                  canLoadMore={videoManager.videoCardAPI.canLoadMore(video.id)}
                  
                  // Event reporting to VideoManager (PURE OUTPUTS)
                  onVisibilityChange={videoManager.videoCardAPI.reportVisibility}
                  onLoadStart={videoManager.videoCardAPI.reportLoadStart}
                  onLoadComplete={videoManager.videoCardAPI.reportLoadComplete}
                  onLoadError={videoManager.videoCardAPI.reportLoadError}
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
