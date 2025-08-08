import React, { useState, useEffect, useCallback, useRef } from 'react';
import VideoCard from './components/VideoCard';
import MasonryContainer from './components/MasonryContainer';
import { useMasonryLayout } from './hooks/useMasonryLayout';
import './App.css';

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [autoplayEnabled, setAutoplayEnabled] = useState(true);
  const [layoutMode, setLayoutMode] = useState('grid');
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [maxConcurrentPlaying, setMaxConcurrentPlaying] = useState(30);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [playingVideos, setPlayingVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());

  // Measure container width
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const updateContainerWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };

    updateContainerWidth();
    window.addEventListener('resize', updateContainerWidth);
    return () => window.removeEventListener('resize', updateContainerWidth);
  }, []);

  // Use the masonry layout hook
  const {
    itemPositions,
    containerHeight,
    updateAspectRatio,
    recalculateLayout,
    isMasonry,
  } = useMasonryLayout(videos, layoutMode, zoomLevel, containerWidth, {
    baseColumnWidth: 200,
    gap: 4,
    rowHeight: 200,
    headerHeight: 200,
    filenameOverlayHeight: 30,
  });

  // Check if we're in Electron
  const isElectron = window.electronAPI?.isElectron;

  // Load settings from Electron
  useEffect(() => {
    if (window.electronAPI?.onSettingsLoaded) {
      window.electronAPI.onSettingsLoaded((settings) => {
        console.log('Settings received:', settings);
        if (settings.recursiveMode !== undefined) setRecursiveMode(settings.recursiveMode);
        if (settings.layoutMode !== undefined) setLayoutMode(settings.layoutMode);
        if (settings.autoplayEnabled !== undefined) setAutoplayEnabled(settings.autoplayEnabled);
        if (settings.maxConcurrentPlaying !== undefined)
          setMaxConcurrentPlaying(settings.maxConcurrentPlaying);
        if (settings.zoomLevel !== undefined) setZoomLevel(settings.zoomLevel);
      });
    }

    // Listen for folder selection from menu
    if (window.electronAPI?.onFolderSelected) {
      window.electronAPI.onFolderSelected((folderPath) => {
        handleElectronFolderSelection(folderPath);
      });
    }
  }, []);

  const canPlayMoreVideos = useCallback(() => {
    return playingVideos.size < maxConcurrentPlaying;
  }, [playingVideos.size, maxConcurrentPlaying]);

  const handleVideoPlay = useCallback((videoId) => {
    setPlayingVideos((prev) => new Set([...prev, videoId]));
  }, []);

  const handleVideoPause = useCallback((videoId) => {
    setPlayingVideos((prev) => {
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
          layoutMode,
          autoplayEnabled,
          maxConcurrentPlaying,
          zoomLevel,
        });
      } catch (error) {
        console.error('Failed to save settings:', error);
      }
    }
  }, [recursiveMode, layoutMode, autoplayEnabled, maxConcurrentPlaying, zoomLevel]);

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
      setVideos([]); // Clear existing videos
      setSelectedVideos(new Set());
      setPlayingVideos(new Set());
      setLoadedVideos(new Set());

      const videoFiles = await window.electronAPI.readDirectory(folderPath, recursiveMode);
      console.log(`Found ${videoFiles.length} video files`);

      const videoObjects = videoFiles.map((filePath) => ({
        id: filePath,
        name: filePath.split(/[/\\]/).pop(),
        fullPath: filePath,
        loaded: false,
        isElectronFile: true,
      }));

      setVideos(videoObjects);
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
    setLoadedVideos(new Set());
  };

  const toggleAutoplay = () => {
    const newAutoplay = !autoplayEnabled;
    setAutoplayEnabled(newAutoplay);

    if (!newAutoplay) {
      setPlayingVideos(new Set());
    }

    saveSettings();
  };

  const toggleLayout = () => {
    const modes = ['grid', 'masonry-vertical', 'masonry-horizontal'];
    const currentIndex = modes.indexOf(layoutMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const newMode = modes[nextIndex];

    setLayoutMode(newMode);
    saveSettings();
    recalculateLayout(); // Ensure layout updates immediately
    return newMode;
  };

  const toggleRecursive = () => {
    setRecursiveMode(!recursiveMode);
    saveSettings();
  };

  const handleVideoLimitChange = (newLimit) => {
    setMaxConcurrentPlaying(newLimit);

    if (playingVideos.size > newLimit) {
      const playingArray = Array.from(playingVideos);
      const toKeep = playingArray.slice(0, newLimit);
      setPlayingVideos(new Set(toKeep));
    }

    saveSettings();
  };

  const handleZoomChange = (newZoom) => {
    setZoomLevel(newZoom);
    saveSettings();
    recalculateLayout(); // Ensure layout updates on zoom change
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

  const handleVideoSelect = (videoId, isCtrlClick) => {
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

  return (
    <div className="app">
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

        {selectedVideos.size > 0 && (
          <div className="selection-info">{selectedVideos.size} selected</div>
        )}

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
          📁 {videos.length} videos | ▶️ {playingVideos.size}/{maxConcurrentPlaying} playing | ✅{' '}
          {selectedVideos.size} selected | {getLayoutButtonText()}
        </div>

        <div className="controls">
          <button
            onClick={toggleAutoplay}
            className={`toggle-button ${autoplayEnabled ? 'active' : ''}`}
          >
            {autoplayEnabled ? '⏸️ Pause All' : '▶️ Resume All'}
          </button>

          <button
            onClick={toggleRecursive}
            className={`toggle-button ${recursiveMode ? 'active' : ''}`}
          >
            {recursiveMode ? '📂 Recursive ON' : '📂 Recursive'}
          </button>

          <button onClick={toggleLayout} className="toggle-button">
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
        <MasonryContainer
          ref={containerRef}
          itemPositions={itemPositions}
          containerHeight={containerHeight}
          containerWidth={containerWidth}
          isMasonry={isMasonry}
          className={`video-grid ${layoutMode} zoom-${['small', 'medium', 'large', 'xlarge'][zoomLevel]}`}
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
              onVideoLoaded={handleVideoLoaded}
              layoutMode={layoutMode}
              position={itemPositions.find((pos) => pos.id === video.id)}
            />
          ))}
        </MasonryContainer>
      )}
    </div>
  );
}

export default App;