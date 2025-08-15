// App.jsx
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import VideoCard from "./components/VideoCard";
import FullScreenModal from "./components/FullScreenModal";
import ContextMenu from "./components/ContextMenu";
import { useFullScreenModal } from "./hooks/useFullScreenModal";
import { useContextMenu } from "./hooks/useContextMenu";
import useChunkedMasonry from "./hooks/useChunkedMasonry";
import { useProgressiveList } from "./hooks/useProgressiveList";
import usePlayOrchestrator from "./hooks/usePlayOrchestrator";
import "./App.css";

// Helper
const path = {
  dirname: (filePath) => {
    if (!filePath) return "";
    const lastSlash = Math.max(
      filePath.lastIndexOf("/"),
      filePath.lastIndexOf("\\")
    );
    return lastSlash === -1 ? "" : filePath.substring(0, lastSlash);
  },
};

const __DEV__ = import.meta.env.MODE !== "production";

function App() {
  const [videos, setVideos] = useState([]);
  const [selectedVideos, setSelectedVideos] = useState(new Set());
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true);
  const [maxConcurrentPlaying, setMaxConcurrentPlaying] = useState(250);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Loading state
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [loadingProgress, setLoadingProgress] = useState(0);

  // Performance tracking with React state
  const [playingVideos, setPlayingVideos] = useState(new Set());
  const [actualPlaying, setActualPlaying] = useState(new Set());
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());

  const gridRef = useRef(null);
  const cleanupTimeoutRef = useRef(null);
  const lastCleanupTimeRef = useRef(0);

  // ----- Masonry hook -----
  const { updateAspectRatio, onItemsChanged, setZoomClass } = useChunkedMasonry(
    { gridRef }
  );

  // MEMOIZED: Grouped and sorted videos
  const groupedAndSortedVideos = useMemo(() => {
    if (videos.length === 0) return [];
    const videosByFolder = new Map();
    videos.forEach((video) => {
      const folderPath =
        video.metadata?.folder ||
        path.dirname(video.fullPath || video.relativePath || "");
      if (!videosByFolder.has(folderPath)) videosByFolder.set(folderPath, []);
      videosByFolder.get(folderPath).push(video);
    });
    const sortedFolders = Array.from(videosByFolder.keys()).sort();
    const result = [];
    sortedFolders.forEach((folderPath) => {
      const folderVideos = videosByFolder.get(folderPath);
      folderVideos.sort((a, b) => a.name.localeCompare(b.name));
      result.push(...folderVideos);
    });
    if (__DEV__)
      console.log(
        `📁 Grouped ${videos.length} videos into ${sortedFolders.length} folders`
      );
    return result;
  }, [videos]);

  // fullscreen / context menu
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen,
  } = useFullScreenModal(groupedAndSortedVideos, "masonry-vertical", gridRef);
  const { contextMenu, showContextMenu, hideContextMenu, handleContextAction } =
    useContextMenu();

  // --- Centralized play orchestration ---
  const { playingSet, markHover, reportPlayError, reportStarted } =
    usePlayOrchestrator({
      visibleIds: visibleVideos,
      loadedIds: loadedVideos,
      maxPlaying: maxConcurrentPlaying,
    });

  // reflect orchestrator allowed set → props for cards
  useEffect(() => {
    setPlayingVideos(new Set(playingSet));
  }, [playingSet]);

  // settings load
  useEffect(() => {
    const load = async () => {
      const api = window.electronAPI;
      if (!api?.getSettings) {
        setSettingsLoaded(true);
        return;
      }
      try {
        const s = await api.getSettings();
        if (s.recursiveMode !== undefined) setRecursiveMode(s.recursiveMode);
        if (s.showFilenames !== undefined) setShowFilenames(s.showFilenames);
        if (s.maxConcurrentPlaying !== undefined)
          setMaxConcurrentPlaying(s.maxConcurrentPlaying);
        if (s.zoomLevel !== undefined) setZoomLevel(s.zoomLevel);
      } catch {}
      setSettingsLoaded(true);
    };
    load();

    window.electronAPI?.onFolderSelected?.((folderPath) => {
      handleElectronFolderSelection(folderPath);
    });
  }, []); // eslint-disable-line

  // FS listeners (unchanged)
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const handleFileAdded = (videoFile) => {
      setVideos((prev) => {
        if (prev.some((v) => v.id === videoFile.id)) return prev;
        return [...prev, videoFile].sort((a, b) =>
          a.name.localeCompare(b.name)
        );
      });
    };
    const handleFileRemoved = (filePath) => {
      setVideos((prev) => prev.filter((v) => v.id !== filePath));
      setSelectedVideos((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setPlayingVideos((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setLoadedVideos((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setLoadingVideos((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setVisibleVideos((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setActualPlaying((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
    };
    const handleFileChanged = (videoFile) => {
      setVideos((prev) =>
        prev.map((v) => (v.id === videoFile.id ? videoFile : v))
      );
    };

    api.onFileAdded?.(handleFileAdded);
    api.onFileRemoved?.(handleFileRemoved);
    api.onFileChanged?.(handleFileChanged);

    return () => {
      api?.stopFolderWatch?.().catch(() => {});
    };
  }, []);

  // relayout when list changes
  useEffect(() => {
    if (groupedAndSortedVideos.length) onItemsChanged();
  }, [groupedAndSortedVideos.length, onItemsChanged]);

  // zoom handling via hook
  useEffect(() => {
    setZoomClass(zoomLevel);
  }, [zoomLevel, setZoomClass]);

  // aspect ratio updates from cards
  const handleVideoLoaded = useCallback(
    (videoId, aspectRatio) => {
      setLoadedVideos((prev) => new Set([...prev, videoId]));
      updateAspectRatio(videoId, aspectRatio);
    },
    [updateAspectRatio]
  );

  const handleVideoStartLoading = useCallback((videoId) => {
    setLoadingVideos((prev) => new Set([...prev, videoId]));
  }, []);
  const handleVideoStopLoading = useCallback((videoId) => {
    setLoadingVideos((prev) => {
      const ns = new Set(prev);
      ns.delete(videoId);
      return ns;
    });
  }, []);
  const handleVideoVisibilityChange = useCallback((videoId, isVisible) => {
    setVisibleVideos((prev) => {
      const ns = new Set(prev);
      if (isVisible) ns.add(videoId);
      else ns.delete(videoId);
      return ns;
    });
  }, []);

  const handleFolderSelect = useCallback(async () => {
    const res = await window.electronAPI?.selectFolder?.();
    if (res?.folderPath) await handleElectronFolderSelection(res.folderPath);
  }, []); // eslint-disable-line

  const handleWebFileSelection = useCallback((event) => {
    const files = Array.from(event.target.files || []).filter((f) => {
      const isVideoType = f.type.startsWith("video/");
      const hasExt = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ogv)$/i.test(
        f.name
      );
      return isVideoType || hasExt;
    });
    const list = files.map((f) => ({
      id: f.name + f.size,
      name: f.name,
      file: f,
      loaded: false,
      isElectronFile: false,
    }));
    setVideos(list);
    setSelectedVideos(new Set());
    setPlayingVideos(new Set());
    setVisibleVideos(new Set());
    setLoadedVideos(new Set());
    setLoadingVideos(new Set());
    setActualPlaying(new Set());
  }, []);

  const toggleRecursive = useCallback(() => {
    const next = !recursiveMode;
    setRecursiveMode(next);
    window.electronAPI?.saveSettingsPartial?.({
      recursiveMode: next,
      maxConcurrentPlaying,
      zoomLevel,
      showFilenames,
    });
  }, [recursiveMode, maxConcurrentPlaying, zoomLevel, showFilenames]);

  const toggleFilenames = useCallback(() => {
    const next = !showFilenames;
    setShowFilenames(next);
    window.electronAPI?.saveSettingsPartial?.({
      showFilenames: next,
      recursiveMode,
      maxConcurrentPlaying,
      zoomLevel,
    });
  }, [showFilenames, recursiveMode, maxConcurrentPlaying, zoomLevel]);

  const handleVideoLimitChange = useCallback(
    (n) => {
      setMaxConcurrentPlaying(n);
      window.electronAPI?.saveSettingsPartial?.({
        maxConcurrentPlaying: n,
        recursiveMode,
        zoomLevel,
        showFilenames,
      });
    },
    [recursiveMode, zoomLevel, showFilenames]
  );

  const handleZoomChange = useCallback(
    (z) => {
      setZoomLevel(z);
      setZoomClass(z);
      window.electronAPI?.saveSettingsPartial?.({
        zoomLevel: z,
        recursiveMode,
        maxConcurrentPlaying,
        showFilenames,
      });
    },
    [setZoomClass, recursiveMode, maxConcurrentPlaying, showFilenames]
  );

  const getZoomLabel = useMemo(
    () => ["75%", "100%", "150%", "200%"][zoomLevel] || "100%",
    [zoomLevel]
  );

  const handleVideoSelect = useCallback(
    (videoId, isCtrlClick, isDoubleClick) => {
      const video = groupedAndSortedVideos.find((v) => v.id === videoId);
      if (isDoubleClick && video) {
        openFullScreen(video, playingVideos);
        return;
      }
      setSelectedVideos((prev) => {
        const ns = new Set(prev);
        if (isCtrlClick) {
          if (ns.has(videoId)) ns.delete(videoId);
          else ns.add(videoId);
        } else {
          ns.clear();
          ns.add(videoId);
        }
        return ns;
      });
    },
    [groupedAndSortedVideos, openFullScreen, playingVideos]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && isLoadingFolder) setIsLoadingFolder(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isLoadingFolder]);

  const progressiveVideos = useProgressiveList(groupedAndSortedVideos, 100, 16);

  return (
    <div className="app">
      {!settingsLoaded ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            color: "#888",
          }}
        >
          Loading settings...
        </div>
      ) : (
        <>
          {isLoadingFolder && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                backgroundColor: "rgba(0,0,0,0.95)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 99999,
                backdropFilter: "blur(8px)",
              }}
            >
              <div
                style={{
                  backgroundColor: "#1a1a1a",
                  borderRadius: 20,
                  padding: "3rem",
                  maxWidth: 600,
                  width: "90%",
                  textAlign: "center",
                  boxShadow: "0 30px 60px rgba(0,0,0,0.8)",
                  border: "2px solid #333",
                }}
              >
                <div style={{ fontSize: "3rem", marginBottom: "1.5rem" }}>
                  🐝
                </div>
                <div
                  style={{
                    fontSize: "2rem",
                    marginBottom: "1rem",
                    color: "#4CAF50",
                    fontWeight: "bold",
                  }}
                >
                  Video Swarm
                </div>
                <div
                  style={{
                    fontSize: "1.2rem",
                    color: "#ccc",
                    marginBottom: "2rem",
                    minHeight: 40,
                  }}
                >
                  {loadingStage || "Preparing..."}
                </div>
                <div
                  style={{
                    width: "100%",
                    height: 16,
                    backgroundColor: "#333",
                    borderRadius: 8,
                    overflow: "hidden",
                    marginBottom: "2rem",
                  }}
                >
                  <div
                    style={{
                      width: `${loadingProgress}%`,
                      height: "100%",
                      background: "linear-gradient(90deg, #4CAF50, #45a049)",
                      borderRadius: 8,
                      transition: "width 0.5s ease",
                    }}
                  />
                </div>
                <div
                  style={{
                    fontSize: "1.5rem",
                    color: "#4CAF50",
                    fontWeight: "bold",
                    marginBottom: "2rem",
                  }}
                >
                  {loadingProgress}%
                </div>
              </div>
            </div>
          )}

          <div className="header">
            <h1>
              🐝 Video Swarm{" "}
              <span style={{ fontSize: "0.6rem", color: "#666" }}>v1.0.0</span>
            </h1>

            <div id="folderControls">
              {window.electronAPI?.isElectron ? (
                <button
                  onClick={handleFolderSelect}
                  className="file-input-label"
                  disabled={isLoadingFolder}
                >
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
                    style={{ display: "none" }}
                    id="fileInput"
                    disabled={isLoadingFolder}
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
                fontSize: "0.75rem",
                color: "#888",
                background: "#1a1a1a",
                padding: "0.3rem 0.8rem",
                borderRadius: 4,
              }}
            >
              📁 {videos.length} videos | ▶️ {actualPlaying.size} playing | 👁️{" "}
              {visibleVideos.size} in view
            </div>

            <div className="controls">
              <button
                onClick={toggleRecursive}
                className={`toggle-button ${recursiveMode ? "active" : ""}`}
                disabled={isLoadingFolder}
              >
                {recursiveMode ? "📂 Recursive ON" : "📂 Recursive"}
              </button>
              <button
                onClick={toggleFilenames}
                className={`toggle-button ${showFilenames ? "active" : ""}`}
                disabled={isLoadingFolder}
              >
                {showFilenames ? "📝 Filenames ON" : "📝 Filenames"}
              </button>

              <div
                className="video-limit-control"
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <span>📹</span>
                <input
                  type="range"
                  min="10"
                  max="500"
                  value={maxConcurrentPlaying}
                  step="10"
                  style={{ width: 100 }}
                  onChange={(e) =>
                    handleVideoLimitChange(parseInt(e.target.value))
                  }
                  disabled={isLoadingFolder}
                />
                <span style={{ fontSize: "0.8rem" }}>
                  {maxConcurrentPlaying}
                </span>
              </div>

              <div
                className="zoom-control"
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <span>🔍</span>
                <input
                  type="range"
                  min="0"
                  max="3"
                  value={zoomLevel}
                  step="1"
                  onChange={(e) => handleZoomChange(parseInt(e.target.value))}
                  disabled={isLoadingFolder}
                />
                <span>{getZoomLabel}</span>
              </div>
            </div>
          </div>

          {groupedAndSortedVideos.length === 0 && !isLoadingFolder ? (
            <div className="drop-zone">
              <h2>🐝 Welcome to Video Swarm 🐝</h2>
              <p>Click "Select Folder" above to browse your video collection</p>
            </div>
          ) : (
            <div
              ref={gridRef}
              className={`video-grid masonry-vertical ${
                !showFilenames ? "hide-filenames" : ""
              } ${
                ["zoom-small", "zoom-medium", "zoom-large", "zoom-xlarge"][
                  zoomLevel
                ]
              }`}
            >
              {useProgressiveList(groupedAndSortedVideos, 100, 16).map(
                (video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    ioRoot={gridRef}
                    selected={selectedVideos.has(video.id)}
                    onSelect={(...args) => handleVideoSelect(...args)}
                    onContextMenu={showContextMenu}
                    showFilenames={showFilenames}
                    // load/visibility limits
                    canLoadMoreVideos={() =>
                      visibleVideos.has(video.id) ||
                      (loadingVideos.size <
                        performanceLimits.maxConcurrentLoading &&
                        loadedVideos.size < performanceLimits.maxLoaded)
                    }
                    isLoading={loadingVideos.has(video.id)}
                    isLoaded={loadedVideos.has(video.id)}
                    isVisible={visibleVideos.has(video.id)}
                    // orchestrated play flag (desired)
                    isPlaying={playingVideos.has(video.id)}
                    // lifecycle callbacks
                    onStartLoading={handleVideoStartLoading}
                    onStopLoading={handleVideoStopLoading}
                    onVideoLoad={handleVideoLoaded}
                    onVisibilityChange={handleVideoVisibilityChange}
                    // media events → update orchestrator + true count
                    onVideoPlay={(id) => {
                      reportStarted(id); // tell orchestrator it really started
                      setActualPlaying((prev) => {
                        const next = new Set(prev);
                        next.add(id);
                        return next;
                      });
                    }}
                    onVideoPause={(id) => {
                      setActualPlaying((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                      });
                    }}
                    onPlayError={(id) => {
                      // mark error, free any "actual" slot
                      reportPlayError(id);
                      setActualPlaying((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                      });
                    }}
                    // hover to force priority
                    onHover={(id) => markHover(id)}
                  />
                )
              )}
            </div>
          )}

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
