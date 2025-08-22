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
import HeaderBar from "./components/HeaderBar";
import DebugSummary from "./components/DebugSummary";

import { useFullScreenModal } from "./hooks/useFullScreenModal";
import useChunkedMasonry from "./hooks/useChunkedMasonry";
import { useVideoCollection } from "./hooks/video-collection";
import useRecentFolders from "./hooks/useRecentFolders";

import useSelectionState from "./hooks/selection/useSelectionState";
import { useContextMenu } from "./hooks/context-menu/useContextMenu";
import useActionDispatch from "./hooks/actions/useActionDispatch";
import useHotkeys from "./hooks/selection/useHotkeys";

import LoadingProgress from "./components/LoadingProgress";
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

const LoadingOverlay = ({ show, stage, progress }) => {
  if (!show) return null;
  return (
    <LoadingProgress
      progress={{
        current: typeof progress === "number" ? progress : 0,
        total: 100,
        stage: stage || "",
      }}
    />
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
  // Selection state (SOLID)
  const selection = useSelectionState(); // { selected, size, selectOnly, toggle, clear, setSelected, selectRange, anchorId }
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

  // Track visual (masonry) order for Shift-range selection
  const [visualOrderedIds, setVisualOrderedIds] = useState([]);

  // ----- Masonry hook -----
  const { updateAspectRatio, onItemsChanged, setZoomClass, scheduleLayout } =
    useChunkedMasonry({
      gridRef,
      // we emit visual order (top-to-bottom by y, then x) so Shift works intuitively
      onOrderChange: setVisualOrderedIds,
    });

  // MEMOIZED grouped & sorted (data order)
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

  // data order ids (fallback)
  const orderedIds = useMemo(
    () => groupedAndSortedVideos.map((v) => v.id),
    [groupedAndSortedVideos]
  );

  // Prefer visual order if we have it
  const orderForRange = visualOrderedIds.length ? visualOrderedIds : orderedIds;

  const getById = useCallback(
    (id) => groupedAndSortedVideos.find((v) => v.id === id),
    [groupedAndSortedVideos]
  );

  // Simple toast used by actions layer
  const notify = useCallback((message, type = "info") => {
    const colors = {
      error: "#ff4444",
      success: "#4CAF50",
      warning: "#ff9800",
      info: "#007acc",
    };
    const icons = { error: "❌", success: "✅", warning: "⚠️", info: "ℹ️" };
    const el = document.createElement("div");
    el.style.cssText = `
      position: fixed; top: 80px; right: 20px;
      background: ${colors[type] || colors.info};
      color: white; padding: 12px 16px; border-radius: 8px; z-index: 10001;
      font-family: system-ui, -apple-system, sans-serif; font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 300px; display:flex; gap:8px;
      animation: slideInFromRight 0.2s ease-out;
    `;
    el.textContent = `${icons[type] || icons.info} ${message}`;
    document.body.appendChild(el);
    setTimeout(() => {
      if (document.body.contains(el)) document.body.removeChild(el);
    }, 3000);
  }, []);

  useEffect(() => {
    if (window.electronAPI?.getAppVersion) {
      window.electronAPI
        .getAppVersion()
        .then((v) => v && setVersion(v))
        .catch(() => { });
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

  const { contextMenu, showOnItem, showOnEmpty, hide: hideContextMenu } =
    useContextMenu();

  // Actions dispatcher (single pipeline for menu/hotkeys/toolbar)
  const { runAction } = useActionDispatch(
    {
      electronAPI: window.electronAPI,
      notify,
      // showProperties: (videos) => { /* optional UI modal */ },
      // confirm: (msg) => window.confirm(msg),
    },
    getById
  );

  // Hotkeys operate on current selection
  const runForHotkeys = useCallback(
    (actionId, currentSelection) =>
      runAction(actionId, currentSelection, contextMenu.contextId),
    [runAction, contextMenu.contextId]
  );
  useHotkeys(runForHotkeys, () => selection.selected);

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
            `🧠 Safe zoom level ${i} (${["75%", "100%", "150%", "200%"][i]
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
      // Nudge masonry after zoom change
      scheduleLayout?.();
    },
    [setZoomClass, recursiveMode, maxConcurrentPlaying, showFilenames, scheduleLayout]
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
          `🛡️ Zoom limited to ${["75%", "100%", "150%", "200%"][safeZoom]
          } for memory safety (requested ${["75%", "100%", "150%", "200%"][newZoom]
          })`
        );
      }
      handleZoomChange(safeZoom);
    },
    [getMinimumZoomLevel, handleZoomChange]
  );

  // === MEMORY MONITORING (dev helpers) ===
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

  // === DYNAMIC ZOOM RESIZE / COUNT ===
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
            `📐 Window resized: ${windowWidth}x${windowHeight} with ${videoCount} videos - adjusting zoom to ${["75%", "100%", "150%", "200%"][safeZoom]
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
      } catch { }
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

  // FS listeners
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
      selection.setSelected((prev) => {
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
      api?.stopFolderWatch?.().catch(() => { });
    };
  }, [selection.setSelected]);

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
        selection.clear();
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

        // record in recent folders AFTER successful open
        addRecentFolder(folderPath);
      } catch (e) {
        console.error("Error reading directory:", e);
        setIsLoadingFolder(false);
      }
    },
    [recursiveMode, addRecentFolder, selection]
  );

  const handleFolderSelect = useCallback(async () => {
    const res = await window.electronAPI?.selectFolder?.();
    if (res?.folderPath) await handleElectronFolderSelection(res.folderPath);
  }, [handleElectronFolderSelection]);

  const handleWebFileSelection = useCallback(
    (event) => {
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
      selection.clear();
      setVisibleVideos(new Set());
      setLoadedVideos(new Set());
      setLoadingVideos(new Set());
      setActualPlaying(new Set());
    },
    [selection]
  );

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

  // Selection via clicks on cards (single / ctrl-multi / shift-range / double → fullscreen)
  const handleVideoSelect = useCallback(
    (videoId, isCtrlClick, isShiftClick, isDoubleClick) => {
      const video = getById(videoId);
      if (isDoubleClick && video) {
        openFullScreen(video, videoCollection.playingVideos);
        return;
      }
      if (isShiftClick) {
        // Shift: range selection (additive if Ctrl also held)
        selection.selectRange(orderForRange, videoId, /* additive */ isCtrlClick);
        return;
      }
      if (isCtrlClick) {
        // Ctrl only: toggle
        selection.toggle(videoId);
      } else {
        // Plain click: single select + set anchor
        selection.selectOnly(videoId);
      }
    },
    [
      getById,
      openFullScreen,
      videoCollection.playingVideos,
      selection,
      orderForRange,
    ]
  );

  // Right-click on a card: select it (if not in selection) and open menu
  const handleCardContextMenu = useCallback(
    (e, video) => {
      const isSelected = selection.selected.has(video.id);
      showOnItem(e, video.id, isSelected, selection.selectOnly);
    },
    [selection.selected, selection.selectOnly, showOnItem]
  );

  // Right-click on empty background: clear selection and open menu
  const handleBackgroundContextMenu = useCallback(
    (e) => showOnEmpty(e, selection.clear),
    [showOnEmpty, selection.clear]
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
    <div className="app" onContextMenu={handleBackgroundContextMenu}>
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

          <HeaderBar
            version={version}
            isLoadingFolder={isLoadingFolder}
            handleFolderSelect={handleFolderSelect}
            handleWebFileSelection={handleWebFileSelection}
            recursiveMode={recursiveMode}
            toggleRecursive={toggleRecursive}
            showFilenames={showFilenames}
            toggleFilenames={toggleFilenames}
            maxConcurrentPlaying={maxConcurrentPlaying}
            handleVideoLimitChange={handleVideoLimitChange}
            zoomLevel={zoomLevel}
            handleZoomChangeSafe={handleZoomChangeSafe}
            getMinimumZoomLevel={getMinimumZoomLevel}
            getZoomLabel={() => getZoomLabel}
          />

          <DebugSummary
            total={videoCollection.stats.total}
            rendered={videoCollection.stats.rendered}
            playing={videoCollection.stats.playing}
            inView={visibleVideos.size}
            memoryStatus={videoCollection.memoryStatus}
            zoomLevel={zoomLevel}
            getMinimumZoomLevel={getMinimumZoomLevel}
            getZoomLabel={() => getZoomLabel}
          />

          {/* Home state: Recent Locations when nothing is loaded */}
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
              className={`video-grid masonry-vertical ${!showFilenames ? "hide-filenames" : ""
                } ${["zoom-small", "zoom-medium", "zoom-large", "zoom-xlarge"][
                zoomLevel
                ]
                }`}
            >
              {videoCollection.videosToRender.map((video) => (
                <VideoCard
                  key={video.id}
                  video={video}
                  ioRoot={gridRef}
                  selected={selection.selected.has(video.id)}
                  onSelect={(...args) => handleVideoSelect(...args)}
                  onContextMenu={handleCardContextMenu}
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
              visible={contextMenu.visible}
              position={contextMenu.position}
              contextId={contextMenu.contextId}
              getById={getById}
              selectionCount={selection.size}
              electronAPI={window.electronAPI}
              onClose={hideContextMenu}
              onAction={(actionId) =>
                runAction(actionId, selection.selected, contextMenu.contextId)
              }
            />
          )}
        </>
      )}
    </div>
  );
}

export default App;
