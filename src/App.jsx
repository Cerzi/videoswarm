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
import RecentFolders from "./components/RecentFolders";
import { useFullScreenModal } from "./hooks/useFullScreenModal";
import { useContextMenu } from "./hooks/useContextMenu";
import useChunkedMasonry from "./hooks/useChunkedMasonry";
import { useVideoCollection } from "./hooks/video-collection";
import useRecentFolders from "./hooks/useRecentFolders";
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

/** --- Small split-outs to keep App.jsx readable --- */
const LoadingOverlay = ({ show, stage, progress }) => {
  if (!show) return null;
  return (
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
        <div style={{ fontSize: "3rem", marginBottom: "1.5rem" }}>🐝</div>
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
          {stage || "Preparing..."}
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
              width: `${progress}%`,
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
          {progress}%
        </div>
      </div>
    </div>
  );
};

const MemoryAlert = ({ memStatus }) => {
  if (!memStatus || !memStatus.isNearLimit) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: "80px",
        right: "20px",
        background: "rgba(255, 107, 107, 0.95)",
        color: "white",
        padding: "1rem",
        borderRadius: "8px",
        zIndex: 1000,
        maxWidth: "300px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>
        🚨 Memory Warning
      </div>
      <div style={{ fontSize: "0.9rem" }}>
        Memory usage: {memStatus.currentMemoryMB}MB ({memStatus.memoryPressure}
        %)
        <br />
        Reducing video quality to prevent crashes.
      </div>
    </div>
  );
};
/** --- end split-outs --- */

function App() {
  const [version, setVersion] = useState(
    import.meta.env.VITE_APP_VERSION || "dev"
  );
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

  // Video collection state
  const [actualPlaying, setActualPlaying] = useState(new Set());
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());

  const gridRef = useRef(null);

  // ----- Recent Folders hook -----
  const {
    items: recentFolders,
    add: addRecentFolder,
    remove: removeRecentFolder,
    clear: clearRecentFolders,
  } = useRecentFolders();

  // ----- Masonry hook -----
  const { updateAspectRatio, onItemsChanged, setZoomClass } = useChunkedMasonry(
    { gridRef }
  );

  // MEMOIZED grouped & sorted
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

  useEffect(() => {
    // Prefer the runtime version if available (packaged Electron reflects real app version)
    if (window.electronAPI?.getAppVersion) {
      window.electronAPI
        .getAppVersion()
        .then((v) => v && setVersion(v))
        .catch(() => {});
    }
  }, []);

  // --- Composite Video Collection Hook ---
  const videoCollection = useVideoCollection({
    videos: groupedAndSortedVideos,
    visibleVideos,
    loadedVideos,
    loadingVideos,
    actualPlaying,
    maxConcurrentPlaying,
    progressiveOptions: { initial: 100, batchSize: 40 },
  });

  // fullscreen / context menu
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen,
  } = useFullScreenModal(groupedAndSortedVideos, "masonry-vertical", gridRef);
  const { contextMenu, showContextMenu, hideContextMenu, handleContextAction } =
    useContextMenu();

  // === DYNAMIC ZOOM CALCULATION ===
  const calculateSafeZoom = useCallback(
    (windowWidth, windowHeight, videoCount) => {
      const zoomSizes = [150, 200, 300, 400];
      const estimatedVideosPerRow = zoomSizes.map((size) =>
        Math.floor(windowWidth / size)
      );
      const estimatedVisibleVideos = estimatedVideosPerRow.map(
        (perRow) => perRow * 5
      );
      const memoryPressure = estimatedVisibleVideos.map(
        (visible) => (visible * 15) / 3600
      );
      for (let i = 0; i < memoryPressure.length; i++) {
        if (memoryPressure[i] < 0.8) {
          console.log(
            `🧠 Safe zoom level ${i} (${
              ["75%", "100%", "150%", "200%"][i]
            }) - estimated ${estimatedVisibleVideos[i]} visible videos`
          );
          return i;
        }
      }
      console.warn(
        "⚠️ All zoom levels may cause memory pressure - using maximum zoom"
      );
      return 3;
    },
    []
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

  const getMinimumZoomLevel = useCallback(() => {
    const videoCount = groupedAndSortedVideos.length;
    const windowWidth = window.innerWidth;
    if (videoCount > 200 && windowWidth > 2560) return 2;
    if (videoCount > 150 && windowWidth > 1920) return 1;
    return 0;
  }, [groupedAndSortedVideos.length]);

  const handleZoomChangeSafe = useCallback(
    (newZoom) => {
      const minZoom = getMinimumZoomLevel();
      const safeZoom = Math.max(newZoom, minZoom);
      if (safeZoom !== newZoom) {
        console.warn(
          `🛡️ Zoom limited to ${
            ["75%", "100%", "150%", "200%"][safeZoom]
          } for memory safety (requested ${
            ["75%", "100%", "150%", "200%"][newZoom]
          })`
        );
      }
      handleZoomChange(safeZoom);
    },
    [getMinimumZoomLevel, handleZoomChange]
  );

  // === MEMORY MONITORING (unchanged logging) ===
  useEffect(() => {
    if (performance.memory) {
      console.log("🧠 Initial memory limits:", {
        jsHeapSizeLimit:
          Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) + "MB",
        totalJSHeapSize:
          Math.round(performance.memory.totalJSHeapSize / 1024 / 1024) + "MB",
        usedJSHeapSize:
          Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + "MB",
      });
    } else {
      console.log("📊 performance.memory not available");
    }

    if (process.env.NODE_ENV !== "production") {
      const handleKeydown = (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === "G") {
          if (window.gc) {
            const before = performance.memory?.usedJSHeapSize;
            window.gc();
            const after = performance.memory?.usedJSHeapSize;
            const freed =
              before && after ? Math.round((before - after) / 1024 / 1024) : 0;
            console.log(`🧹 Manual GC: ${freed}MB freed`);
          } else {
            console.warn(
              '🚫 GC not available - start with --js-flags="--expose-gc"'
            );
          }
        }
      };
      window.addEventListener("keydown", handleKeydown);
      return () => window.removeEventListener("keydown", handleKeydown);
    }
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && videoCollection.memoryStatus) {
      const { currentMemoryMB, memoryPressure } = videoCollection.memoryStatus;
      if (currentMemoryMB > 3000) {
        console.warn(
          `🔥 DEV WARNING: High memory usage (${currentMemoryMB}MB) - this would crash in production!`
        );
      }
      if (memoryPressure > 80) {
        console.warn(
          `⚠️ DEV WARNING: Memory pressure at ${memoryPressure}% - production limits would kick in`
        );
      }
    }
  }, [
    videoCollection.memoryStatus?.currentMemoryMB,
    videoCollection.memoryStatus?.memoryPressure,
  ]);

  // === DYNAMIC ZOOM RESIZE / COUNT (unchanged) ===
  useEffect(() => {
    if (!window.electronAPI?.isElectron) return;
    const handleResize = () => {
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      const videoCount = groupedAndSortedVideos.length;
      if (videoCount > 50) {
        const safeZoom = calculateSafeZoom(
          windowWidth,
          windowHeight,
          videoCount
        );
        if (safeZoom > zoomLevel) {
          console.log(
            `📐 Window resized: ${windowWidth}x${windowHeight} with ${videoCount} videos - adjusting zoom to ${
              ["75%", "100%", "150%", "200%"][safeZoom]
            } for safety`
          );
          handleZoomChange(safeZoom);
        }
      }
    };
    let resizeTimeout;
    const debouncedResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(handleResize, 500);
    };
    window.addEventListener("resize", debouncedResize);
    return () => {
      window.removeEventListener("resize", debouncedResize);
      clearTimeout(resizeTimeout);
    };
  }, [groupedAndSortedVideos.length]);

  useEffect(() => {
    if (groupedAndSortedVideos.length > 100) {
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      const safeZoom = calculateSafeZoom(
        windowWidth,
        windowHeight,
        groupedAndSortedVideos.length
      );
      if (safeZoom > zoomLevel) {
        console.log(
          `📹 Large collection detected (${groupedAndSortedVideos.length} videos) - adjusting zoom for memory safety`
        );
        handleZoomChange(safeZoom);
      }
    }
  }, [groupedAndSortedVideos.length]);

  // settings load + folder selection event
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

    window.electronAPI?.onFolderSelected?.(
      (folderPath) => {
        handleElectronFolderSelection(folderPath);
      },
      [handleElectronFolderSelection]
    );
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
      setActualPlaying((prev) => {
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

  // relayout when list changes
  useEffect(() => {
    if (groupedAndSortedVideos.length) onItemsChanged();
  }, [groupedAndSortedVideos.length]);

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

  const handleElectronFolderSelection = useCallback(
    async (folderPath) => {
      const api = window.electronAPI;
      if (!api?.readDirectory) return;

      try {
        console.log(
          "🔍 Starting folder selection with recursive =",
          recursiveMode
        );
        setIsLoadingFolder(true);
        setLoadingStage("Reading directory...");
        setLoadingProgress(10);
        await new Promise((r) => setTimeout(r, 100));

        await api.stopFolderWatch?.();

        setVideos([]);
        setSelectedVideos(new Set());
        setVisibleVideos(new Set());
        setLoadedVideos(new Set());
        setLoadingVideos(new Set());
        setActualPlaying(new Set());

        setLoadingStage("Scanning for video files...");
        setLoadingProgress(30);
        await new Promise((r) => setTimeout(r, 200));

        console.log("📁 Calling readDirectory with:", {
          folderPath,
          recursiveMode,
        });
        const files = await api.readDirectory(folderPath, recursiveMode);
        console.log("📁 readDirectory returned:", files.length, "files");

        setLoadingStage(
          `Found ${files.length} videos — initializing masonry...`
        );
        setLoadingProgress(70);
        await new Promise((r) => setTimeout(r, 200));

        setVideos(files);
        await new Promise((r) => setTimeout(r, 300));

        setLoadingStage("Complete!");
        setLoadingProgress(100);
        await new Promise((r) => setTimeout(r, 250));
        setIsLoadingFolder(false);

        const watchResult = await api.startFolderWatch?.(folderPath);
        if (watchResult?.success && __DEV__) console.log("👁️ watching folder");

        // ✅ record in recent folders AFTER successful open
        addRecentFolder(folderPath);
      } catch (e) {
        console.error("Error reading directory:", e);
        setIsLoadingFolder(false);
      }
    },
    [recursiveMode, addRecentFolder]
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
    setVisibleVideos(new Set());
    setLoadedVideos(new Set());
    setLoadingVideos(new Set());
    setActualPlaying(new Set());

    // Web “folder” path is not real; skip adding to recents
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

  const getZoomLabel = useMemo(
    () => ["75%", "100%", "150%", "200%"][zoomLevel] || "100%",
    [zoomLevel]
  );

  const handleVideoSelect = useCallback(
    (videoId, isCtrlClick, isDoubleClick) => {
      const video = groupedAndSortedVideos.find((v) => v.id === videoId);
      if (isDoubleClick && video) {
        openFullScreen(video, videoCollection.playingVideos);
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
    [groupedAndSortedVideos, openFullScreen, videoCollection.playingVideos]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && isLoadingFolder) setIsLoadingFolder(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isLoadingFolder]);

  // cleanup pass from videoCollection
  useEffect(() => {
    const cleanup = videoCollection.performCleanup();
    if (cleanup) {
      setLoadedVideos(cleanup);
    }
  }, [videoCollection.performCleanup]);

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
          {/* Memory Alert */}
          <MemoryAlert memStatus={videoCollection.memoryStatus} />

          {/* Loading overlay */}
          <LoadingOverlay
            show={isLoadingFolder}
            stage={loadingStage}
            progress={loadingProgress}
          />

          <div className="header">
            <h1>
              🐝 Video Swarm{" "}
              <span style={{ fontSize: "0.6rem", color: "#666" }}>
                v{version}
              </span>
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

            {/* Debug Info */}
            <div
              className="debug-info"
              style={{
                fontSize: "0.75rem",
                color: "#888",
                background: "#1a1a1a",
                padding: "0.3rem 0.8rem",
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              <span>🎬 {videoCollection.stats.total} videos</span>
              <span>🎭 {videoCollection.stats.rendered} rendered</span>
              <span>▶️ {videoCollection.stats.playing} playing</span>
              <span>👁️ {visibleVideos.size} in view</span>
              {videoCollection.memoryStatus && (
                <>
                  <span>|</span>
                  <span
                    style={{
                      color: videoCollection.memoryStatus.isNearLimit
                        ? "#ff6b6b"
                        : videoCollection.memoryStatus.memoryPressure > 70
                        ? "#ffa726"
                        : "#51cf66",
                      fontWeight: videoCollection.memoryStatus.isNearLimit
                        ? "bold"
                        : "normal",
                    }}
                  >
                    🧠 {videoCollection.memoryStatus.currentMemoryMB}MB (
                    {videoCollection.memoryStatus.memoryPressure}%)
                  </span>
                  {videoCollection.memoryStatus.safetyMarginMB < 500 && (
                    <span style={{ color: "#ff6b6b", fontWeight: "bold" }}>
                      ⚠️ {videoCollection.memoryStatus.safetyMarginMB}MB margin
                    </span>
                  )}
                </>
              )}
              {groupedAndSortedVideos.length > 100 && (
                <>
                  <span>|</span>
                  <span
                    style={{
                      color:
                        zoomLevel >= getMinimumZoomLevel()
                          ? "#51cf66"
                          : "#ffa726",
                    }}
                  >
                    🔍 {getZoomLabel}{" "}
                    {zoomLevel < getMinimumZoomLevel() ? "(unsafe)" : "(safe)"}
                  </span>
                </>
              )}
              {process.env.NODE_ENV !== "production" && performance.memory && (
                <>
                  <span>|</span>
                  <span style={{ color: "#666", fontSize: "0.7rem" }}>
                    Press Ctrl+Shift+G for manual GC
                  </span>
                </>
              )}
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
                <span>🎹</span>
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
                  min={getMinimumZoomLevel()}
                  max="3"
                  value={zoomLevel}
                  step="1"
                  onChange={(e) =>
                    handleZoomChangeSafe(parseInt(e.target.value))
                  }
                  disabled={isLoadingFolder}
                  style={{
                    accentColor:
                      zoomLevel >= getMinimumZoomLevel()
                        ? "#51cf66"
                        : "#ffa726",
                  }}
                />
                <span>{getZoomLabel}</span>
                {zoomLevel < getMinimumZoomLevel() && (
                  <span style={{ color: "#ffa726", fontSize: "0.7rem" }}>
                    ⚠️
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Home state: show Recent Locations when nothing is loaded */}
          {groupedAndSortedVideos.length === 0 && !isLoadingFolder ? (
            <>
              <RecentFolders
                items={recentFolders}
                onOpen={(path) => handleElectronFolderSelection(path)}
                onRemove={removeRecentFolder}
                onClear={clearRecentFolders}
              />
              <div className="drop-zone">
                <h2>🐝 Welcome to Video Swarm 🐝</h2>
                <p>
                  Click "Select Folder" above to browse your video collection
                </p>
                {window.innerWidth > 2560 && (
                  <p style={{ color: "#ffa726", fontSize: "0.9rem" }}>
                    🖥️ Large display detected - zoom will auto-adjust for memory
                    safety
                  </p>
                )}
              </div>
            </>
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
              {videoCollection.videosToRender.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  ioRoot={gridRef}
                  selected={selectedVideos.has(video.id)}
                  onSelect={(...args) => handleVideoSelect(...args)}
                  onContextMenu={showContextMenu}
                  showFilenames={showFilenames}
                  // Video Collection Management
                  canLoadMoreVideos={() =>
                    videoCollection.canLoadVideo(video.id)
                  }
                  isLoading={loadingVideos.has(video.id)}
                  isLoaded={loadedVideos.has(video.id)}
                  isVisible={visibleVideos.has(video.id)}
                  isPlaying={videoCollection.isVideoPlaying(video.id)}
                  // Lifecycle callbacks
                  onStartLoading={handleVideoStartLoading}
                  onStopLoading={handleVideoStopLoading}
                  onVideoLoad={handleVideoLoaded}
                  onVisibilityChange={handleVideoVisibilityChange}
                  // Media events → update orchestrator + actual playing count
                  onVideoPlay={(id) => {
                    videoCollection.reportStarted(id);
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
                    videoCollection.reportPlayError(id);
                    setActualPlaying((prev) => {
                      const next = new Set(prev);
                      next.delete(id);
                      return next;
                    });
                  }}
                  // Hover for priority
                  onHover={(id) => videoCollection.markHover(id)}
                />
              ))}
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
