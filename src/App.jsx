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
import usePlayOrchestrator from "./hooks/usePlayOrchestrator"; // <-- NEW
import "./App.css";

// Helper function to get directory path
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
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());

  const cleanupTimeoutRef = useRef(null);
  const lastCleanupTimeRef = useRef(0);
  const gridRef = useRef(null);

  // ----- Masonry hook -----
  const { updateAspectRatio, onItemsChanged, setZoomClass, scheduleLayout } =
    useChunkedMasonry({ gridRef });

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

  // perf limits
  const performanceLimits = useMemo(() => {
    const n = groupedAndSortedVideos.length;
    if (n < 100) return { maxLoaded: 60, maxConcurrentLoading: 4 };
    if (n < 500) return { maxLoaded: 80, maxConcurrentLoading: 3 };
    if (n < 1000) return { maxLoaded: 100, maxConcurrentLoading: 2 };
    return { maxLoaded: 120, maxConcurrentLoading: 1 };
  }, [groupedAndSortedVideos.length]);

  const performCleanup = useCallback(() => {
    const now = Date.now();
    if (now - lastCleanupTimeRef.current < 3000) return;
    lastCleanupTimeRef.current = now;
    if (loadedVideos.size <= performanceLimits.maxLoaded) return;

    setLoadedVideos((prev) => {
      const toKeep = new Set();
      let keep = 0;
      prev.forEach((id) => {
        if (visibleVideos.has(id) && keep < performanceLimits.maxLoaded) {
          toKeep.add(id);
          keep++;
        }
      });
      prev.forEach((id) => {
        if (
          playingVideos.has(id) &&
          !toKeep.has(id) &&
          keep < performanceLimits.maxLoaded
        ) {
          toKeep.add(id);
          keep++;
        }
      });
      const remaining = Array.from(prev).filter((id) => !toKeep.has(id));
      remaining
        .slice(0, performanceLimits.maxLoaded - keep)
        .forEach((id) => toKeep.add(id));
      return toKeep;
    });

    setLoadingVideos((prev) => {
      const ns = new Set();
      prev.forEach((id) => {
        if (loadedVideos.has(id)) ns.add(id);
      });
      return ns;
    });
  }, [loadedVideos.size, visibleVideos, playingVideos, performanceLimits]);

  useEffect(() => {
    if (cleanupTimeoutRef.current) clearTimeout(cleanupTimeoutRef.current);
    cleanupTimeoutRef.current = setTimeout(() => {
      if (
        loadedVideos.size > performanceLimits.maxLoaded ||
        loadingVideos.size > performanceLimits.maxConcurrentLoading
      ) {
        performCleanup();
      }
    }, 1000);
    return () => clearTimeout(cleanupTimeoutRef.current);
  }, [
    loadedVideos.size,
    loadingVideos.size,
    performanceLimits,
    performCleanup,
  ]);

  // --- NEW: Centralized play orchestration ---
  const { playingSet, markHover, reportPlayError, reportStarted } =
    usePlayOrchestrator({
      visibleIds: visibleVideos,
      loadedIds: loadedVideos,
      maxPlaying: maxConcurrentPlaying,
    });

  useEffect(() => {
    setPlayingVideos(new Set(playingSet));
  }, [playingSet]);

  // context menu hide
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handleClickOutside = (e) => {
      const el = document.querySelector("[data-context-menu]");
      if (el && !el.contains(e.target)) hideContextMenu();
    };
    const handleEsc = (e) => e.key === "Escape" && hideContextMenu();
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [contextMenu.visible, hideContextMenu]);

  const isElectron = window.electronAPI?.isElectron;

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

  // file system listeners (unchanged)
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

  // when the list changes → relayout
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

  // remaining callbacks (unchanged)
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

  const saveSettings = useCallback(async () => {
    await window.electronAPI?.saveSettingsPartial?.({
      recursiveMode,
      maxConcurrentPlaying,
      zoomLevel,
      showFilenames,
    });
  }, [recursiveMode, maxConcurrentPlaying, zoomLevel, showFilenames]);

  const handleElectronFolderSelection = useCallback(
    async (folderPath) => {
      const api = window.electronAPI;
      if (!api?.readDirectory) return;

      try {
        setIsLoadingFolder(true);
        setLoadingStage("Reading directory...");
        setLoadingProgress(10);
        await new Promise((r) => setTimeout(r, 100));

        await api.stopFolderWatch?.();

        setVideos([]);
        setSelectedVideos(new Set());
        setPlayingVideos(new Set());
        setVisibleVideos(new Set());
        setLoadedVideos(new Set());
        setLoadingVideos(new Set());

        setLoadingStage("Scanning for video files...");
        setLoadingProgress(30);
        await new Promise((r) => setTimeout(r, 200));

        const files = await api.readDirectory(folderPath, recursiveMode);

        setLoadingStage(
          `Found ${files.length} videos — initializing masonry...`
        );
        setLoadingProgress(70);
        await new Promise((r) => setTimeout(r, 200));

        setVideos(files); // triggers onItemsChanged via effect
        await new Promise((r) => setTimeout(r, 300));

        setLoadingStage("Complete!");
        setLoadingProgress(100);
        await new Promise((r) => setTimeout(r, 250));
        setIsLoadingFolder(false);

        const watchResult = await api.startFolderWatch?.(folderPath);
        if (watchResult?.success && __DEV__) console.log("👁️ watching folder");
      } catch (e) {
        console.error("Error reading directory:", e);
        setIsLoadingFolder(false);
      }
    },
    [recursiveMode, onItemsChanged]
  );

  const handleFolderSelect = useCallback(async () => {
    const res = await window.electronAPI?.selectFolder?.();
    if (res?.folderPath) await handleElectronFolderSelection(res.folderPath);
  }, [handleElectronFolderSelection]);

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
      setZoomClass(z); // hook handles relayout + class change
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
              📁 {videos.length} videos | ▶️ {playingVideos.size} playing | 👁️{" "}
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
                    onSelect={handleVideoSelect}
                    canPlayMoreVideos={() => true}
                    onVideoPlay={(id) => reportStarted(id)}   
                    onPlayError={(id, err) => reportPlayError(id)} 
                    onHover={(id) => markHover(id)}            
                    onVideoPause={() => {}}
                    onVideoLoad={handleVideoLoaded}
                    showFilenames={showFilenames}
                    onContextMenu={showContextMenu}
                    canLoadMoreVideos={() =>
                      visibleVideos.has(video.id) ||
                      (loadingVideos.size <
                        performanceLimits.maxConcurrentLoading &&
                        loadedVideos.size < performanceLimits.maxLoaded)
                    }
                    isLoading={loadingVideos.has(video.id)}
                    isLoaded={loadedVideos.has(video.id)}
                    isVisible={visibleVideos.has(video.id)}
                    isPlaying={playingVideos.has(video.id)}
                    onStartLoading={handleVideoStartLoading}
                    onStopLoading={handleVideoStopLoading}
                    onVisibilityChange={handleVideoVisibilityChange}
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
