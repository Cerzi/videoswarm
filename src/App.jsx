// App.jsx
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import VideoCard from "./components/VideoCard/VideoCard";
import FullScreenModal from "./components/FullScreenModal";
import ContextMenu from "./components/ContextMenu";
import RecentFolders from "./components/RecentFolders";
import MetadataPanel from "./components/MetadataPanel";
import HeaderBar from "./components/HeaderBar";
import DebugSummary from "./components/DebugSummary";

import { useFullScreenModal } from "./hooks/useFullScreenModal";
import useChunkedMasonry from "./hooks/useChunkedMasonry";
import { useVideoCollection } from "./hooks/video-collection";
import useRecentFolders from "./hooks/useRecentFolders";
import useIntersectionObserverRegistry from "./hooks/ui-perf/useIntersectionObserverRegistry";
import useLongTaskFlag from "./hooks/ui-perf/useLongTaskFlag";
import useInitGate from "./hooks/ui-perf/useInitGate";

import useSelectionState from "./hooks/selection/useSelectionState";
import { useContextMenu } from "./hooks/context-menu/useContextMenu";
import useActionDispatch from "./hooks/actions/useActionDispatch";
import { releaseVideoHandlesForAsync } from "./utils/releaseVideoHandles";
import useTrashIntegration from "./hooks/actions/useTrashIntegration";

import {
  SortKey,
  buildComparator,
  groupAndSort,
  buildRandomOrderMap,
} from "./sorting/sorting.js";
import { parseSortValue, formatSortValue } from "./sorting/sortOption.js";

import {
  calculateSafeZoom,
  zoomClassForLevel,
  clampZoomIndex,
} from "./zoom/utils.js";
import useHotkeys from "./hooks/selection/useHotkeys";
import { ZOOM_MIN_INDEX, ZOOM_MAX_INDEX, ZOOM_TILE_WIDTHS } from "./zoom/config";

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

const normalizeVideoFromMain = (video) => {
  if (!video || typeof video !== "object") return video;
  const fingerprint =
    typeof video.fingerprint === "string" && video.fingerprint.length > 0
      ? video.fingerprint
      : null;
  const rating =
    typeof video.rating === "number" && Number.isFinite(video.rating)
      ? Math.max(0, Math.min(5, Math.round(video.rating)))
      : null;
  const tags = Array.isArray(video.tags)
    ? Array.from(
        new Set(
          video.tags
            .map((tag) => (tag ?? "").toString().trim())
            .filter(Boolean)
        )
      )
    : [];

  return {
    ...video,
    fingerprint,
    rating,
    tags,
  };
};

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
  const [videos, setVideos] = useState([]);
  // Selection state (SOLID)
  const selection = useSelectionState(); // { selected, size, selectOnly, toggle, clear, setSelected, selectRange, anchorId }
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true);
  const [maxConcurrentPlaying, setMaxConcurrentPlaying] = useState(250);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [sortKey, setSortKey] = useState(SortKey.NAME);
  const [sortDir, setSortDir] = useState("asc");
  const [groupByFolders, setGroupByFolders] = useState(true);
  const [randomSeed, setRandomSeed] = useState(null);

  // Loading state
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [loadingProgress, setLoadingProgress] = useState(0);

  // Video collection state
  const [actualPlaying, setActualPlaying] = useState(new Set());
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());

  const { scheduleInit } = useInitGate({ perFrame: 6 });

  const [availableTags, setAvailableTags] = useState([]);
  const [isMetadataPanelOpen, setMetadataPanelOpen] = useState(false);
  const [metadataFocusToken, setMetadataFocusToken] = useState(0);

  const gridRef = useRef(null);

  const ioRegistry = useIntersectionObserverRegistry(gridRef, {
    rootMargin: "1600px 0px",
    threshold: [0, 0.15],
    nearPx: 900,
  });

  useEffect(() => {
    const el = gridRef.current;
    const update = () => {
      const h = el?.clientHeight || window.innerHeight;
      ioRegistry.setNearPx(Math.max(700, Math.floor(h * 1.1)));
    };
    update();

    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro && el) ro.observe(el);
    window.addEventListener("resize", update);

    return () => {
      if (ro && el) ro.unobserve(el);
      ro?.disconnect?.();
      window.removeEventListener("resize", update);
    };
  }, [gridRef, ioRegistry]);

  const { hadLongTaskRecently } = useLongTaskFlag();

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
      zoomClassForLevel, // use shared mapping
      getTileWidthForLevel: (level) =>
        ZOOM_TILE_WIDTHS[
          Math.max(0, Math.min(level, ZOOM_TILE_WIDTHS.length - 1))
        ],

      onOrderChange: setVisualOrderedIds,
    });

  // MEMOIZED sorting & grouping
  const randomOrderMap = useMemo(
    () =>
      sortKey === SortKey.RANDOM
        ? buildRandomOrderMap(
            videos.map((v) => v.id),
            randomSeed ?? Date.now()
          )
        : null,
    [sortKey, randomSeed, videos]
  );

  const comparator = useMemo(
    () => buildComparator({ sortKey, sortDir, randomOrderMap }),
    [sortKey, sortDir, randomOrderMap]
  );

  const orderedVideos = useMemo(
    () => groupAndSort(videos, { groupByFolders, comparator }),
    [videos, groupByFolders, comparator]
  );

  // data order ids (fallback)
  const orderedIds = useMemo(
    () => orderedVideos.map((v) => v.id),
    [orderedVideos]
  );

  // Prefer visual order if we have it
  const orderForRange = visualOrderedIds.length ? visualOrderedIds : orderedIds;

  const getById = useCallback(
    (id) => orderedVideos.find((v) => v.id === id),
    [orderedVideos]
  );

  const selectedVideos = useMemo(() => {
    return Array.from(selection.selected)
      .map((id) => getById(id))
      .filter(Boolean);
  }, [selection.selected, getById]);

  const selectedFingerprints = useMemo(() => {
    const set = new Set();
    selectedVideos.forEach((video) => {
      if (video?.fingerprint) {
        set.add(video.fingerprint);
      }
    });
    return Array.from(set);
  }, [selectedVideos]);

  useEffect(() => {
    if (selection.size > 0) {
      setMetadataPanelOpen(true);
    }
  }, [selection.size]);

  const sortStatus = useMemo(() => {
    const keyLabels = {
      [SortKey.NAME]: "Name",
      [SortKey.CREATED]: "Created",
      [SortKey.RANDOM]: "Random",
    };
    const arrow =
      sortKey === SortKey.RANDOM ? "" : sortDir === "asc" ? "↑" : "↓";
    const base = `Sorted by ${keyLabels[sortKey]}${arrow ? ` ${arrow}` : ""}`;
    return groupByFolders ? `${base} • Grouped by folders` : base;
  }, [sortKey, sortDir, groupByFolders]);

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

  const refreshTagList = useCallback(async () => {
    const api = window.electronAPI?.metadata;
    if (!api?.listTags) return;
    try {
      const res = await api.listTags();
      if (Array.isArray(res?.tags)) {
        setAvailableTags(res.tags);
      }
    } catch (error) {
      console.warn("Failed to refresh tags:", error);
    }
  }, []);

  useEffect(() => {
    refreshTagList();
  }, [refreshTagList]);

  const applyMetadataPatch = useCallback((updates) => {
    if (!updates || typeof updates !== "object") return;
    setVideos((prev) =>
      prev.map((video) => {
        const fingerprint = video?.fingerprint;
        if (!fingerprint || !updates[fingerprint]) return video;
        return normalizeVideoFromMain({
          ...video,
          ...updates[fingerprint],
          fingerprint,
        });
      })
    );
  }, []);

  const handleAddTags = useCallback(
    async (tagNames) => {
      const api = window.electronAPI?.metadata;
      if (!api?.addTags) return;
      const fingerprints = selectedFingerprints;
      if (!fingerprints.length) return;
      const cleanNames = Array.isArray(tagNames)
        ? tagNames.map((name) => name.trim()).filter(Boolean)
        : [];
      if (!cleanNames.length) return;
      try {
        const result = await api.addTags(fingerprints, cleanNames);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (Array.isArray(result?.tags)) setAvailableTags(result.tags);
        notify(
          `Added ${cleanNames.join(", ")} to ${fingerprints.length} item(s)`,
          "success"
        );
      } catch (error) {
        console.error("Failed to add tags:", error);
        notify("Failed to add tags", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, notify]
  );

  const handleRemoveTag = useCallback(
    async (tagName) => {
      const api = window.electronAPI?.metadata;
      if (!api?.removeTag) return;
      const fingerprints = selectedFingerprints;
      const cleanName = (tagName ?? "").trim();
      if (!fingerprints.length || !cleanName) return;
      try {
        const result = await api.removeTag(fingerprints, cleanName);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (Array.isArray(result?.tags)) setAvailableTags(result.tags);
        notify(
          `Removed "${cleanName}" from ${fingerprints.length} item(s)`,
          "success"
        );
      } catch (error) {
        console.error("Failed to remove tag:", error);
        notify("Failed to remove tag", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, notify]
  );

  const handleSetRating = useCallback(
    async (value, targetFingerprints = selectedFingerprints) => {
      const api = window.electronAPI?.metadata;
      if (!api?.setRating) return;
      const fingerprints = (targetFingerprints || []).filter(Boolean);
      if (!fingerprints.length) return;
      try {
        const result = await api.setRating(fingerprints, value);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (value === null || value === undefined) {
          notify(`Cleared rating for ${fingerprints.length} item(s)`, "success");
        } else {
          const safeRating = Math.max(0, Math.min(5, Math.round(Number(value))));
          notify(
            `Rated ${fingerprints.length} item(s) ${safeRating} star${
              safeRating === 1 ? "" : "s"
            }`,
            "success"
          );
        }
      } catch (error) {
        console.error("Failed to update rating:", error);
        notify("Failed to update rating", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, notify]
  );

  const handleClearRating = useCallback(() => {
    handleSetRating(null, selectedFingerprints);
  }, [handleSetRating, selectedFingerprints]);

  const handleApplyExistingTag = useCallback(
    (tagName) => handleAddTags([tagName]),
    [handleAddTags]
  );

  const openMetadataPanel = useCallback(() => {
    setMetadataPanelOpen(true);
    setMetadataFocusToken((token) => token + 1);
  }, []);

  const handleContextAction = useCallback(
    (actionId) => {
      if (!actionId) return;
      if (actionId === "metadata:open") {
        openMetadataPanel();
        return;
      }
      if (actionId.startsWith("metadata:rate:")) {
        if (!selectedFingerprints.length) return;
        if (actionId === "metadata:rate:clear") {
          handleSetRating(null, selectedFingerprints);
        } else {
          const value = parseInt(actionId.replace("metadata:rate:", ""), 10);
          if (!Number.isNaN(value)) {
            handleSetRating(value, selectedFingerprints);
          }
        }
        return;
      }
      if (actionId.startsWith("metadata:tag:")) {
        const tagName = actionId.replace("metadata:tag:", "");
        if (tagName) {
          handleApplyExistingTag(tagName);
        }
        return;
      }
      runAction(actionId, selection.selected, contextMenu.contextId);
    },
    [
      openMetadataPanel,
      selectedFingerprints,
      handleSetRating,
      handleApplyExistingTag,
      runAction,
      selection.selected,
      contextMenu.contextId,
    ]
  );

  // --- Composite Video Collection Hook ---
  const videoCollection = useVideoCollection({
    videos: orderedVideos,
    visibleVideos,
    loadedVideos,
    loadingVideos,
    actualPlaying,
    maxConcurrentPlaying,
    scrollRef: gridRef,
    progressive: {
      initial: 120,
      batchSize: 64,
      intervalMs: 100,
      pauseOnScroll: true,
      longTaskAdaptation: true,
    },
    hadLongTaskRecently,
    isNear: ioRegistry.isNear,
  });

  // fullscreen / context menu
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen,
  } = useFullScreenModal(orderedVideos, "masonry-vertical", gridRef);

  const {
    contextMenu,
    showOnItem,
    showOnEmpty,
    hide: hideContextMenu,
  } = useContextMenu();

  // Actions dispatcher (single pipeline for menu/hotkeys/toolbar)
  const deps = useTrashIntegration({
    electronAPI: window.electronAPI, // ← was electronAPI
    notify,
    confirm: window.confirm,
    releaseVideoHandlesForAsync,

    // use your real setters
    setVideos, // ← was setAllVideos
    setSelected: selection.setSelected,
    setLoadedIds: setLoadedVideos,
    setPlayingIds: setActualPlaying,

    // (optional but useful if you want to purge these too)
    setVisibleIds: setVisibleVideos,
    setLoadingIds: setLoadingVideos,
  });
  const { runAction } = useActionDispatch(deps, getById);

  // Hotkeys operate on current selection
  const runForHotkeys = useCallback(
    (actionId, currentSelection) =>
      runAction(actionId, currentSelection, contextMenu.contextId),
    [runAction, contextMenu.contextId]
  );
  // Global hotkeys (Enter / Ctrl+C / Delete) + Zoom (+ / - and Ctrl/⌘ + Wheel)
  useHotkeys(runForHotkeys, () => selection.selected, {
    getZoomIndex: () => zoomLevel,
    setZoomIndexSafe: (z) => handleZoomChangeSafe(z),
    minZoomIndex: ZOOM_MIN_INDEX,
    maxZoomIndex: ZOOM_MAX_INDEX,
    // wheelStepUnits: 100, // optional sensitivity tuning
  });

  // ====== Zoom logic (refactored) ======

  const handleZoomChange = useCallback(
    (z) => {
      const clamped = clampZoomIndex(z);
      if (clamped === zoomLevel) return; // no-op if unchanged
      setZoomLevel(clamped);
      setZoomClass(clamped);
      window.electronAPI?.saveSettingsPartial?.({
        zoomLevel: clamped,
        recursiveMode,
        maxConcurrentPlaying,
        showFilenames,
      });
      // Nudge masonry after zoom change
      scheduleLayout?.();
    },
    [
      zoomLevel,
      setZoomClass,
      recursiveMode,
      maxConcurrentPlaying,
      showFilenames,
      scheduleLayout,
    ]
  );

  const getMinimumZoomLevel = useCallback(() => {
    const videoCount = orderedVideos.length;
    const windowWidth = window.innerWidth;
    if (videoCount > 200 && windowWidth > 2560) return 2;
    if (videoCount > 150 && windowWidth > 1920) return 1;
    return 0;
  }, [orderedVideos.length]);

  const handleZoomChangeSafe = useCallback(
    (newZoom) => {
      const minZoom = getMinimumZoomLevel();
      const safeZoom = Math.max(newZoom, minZoom);
      if (safeZoom === zoomLevel) return; // nothing to do
      if (safeZoom !== newZoom) {
        console.warn(
          `🛡️ Zoom limited to ${getZoomLabelByIndex(
            safeZoom
          )} for memory safety (requested ${getZoomLabelByIndex(newZoom)})`
        );
      }
      handleZoomChange(safeZoom);
    },
    [getMinimumZoomLevel, handleZoomChange, zoomLevel]
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
      const videoCount = orderedVideos.length;
      if (videoCount > 50) {
        const safeZoom = calculateSafeZoom(
          windowWidth,
          windowHeight,
          videoCount
        );
        if (safeZoom > zoomLevel) {
          console.log(
            `📐 Window resized: ${windowWidth}x${windowHeight} with ${videoCount} videos - adjusting zoom to ${getZoomLabelByIndex(
              safeZoom
            )} for safety`
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
  }, [orderedVideos.length, zoomLevel, handleZoomChange]);

  useEffect(() => {
    if (orderedVideos.length > 100) {
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      const safeZoom = calculateSafeZoom(
        windowWidth,
        windowHeight,
        orderedVideos.length
      );
      if (safeZoom > zoomLevel) {
        console.log(
          `📹 Large collection detected (${orderedVideos.length} videos) - adjusting zoom for memory safety`
        );
        handleZoomChange(safeZoom);
      }
    }
  }, [orderedVideos.length, zoomLevel, handleZoomChange]);

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
        if (s.zoomLevel !== undefined)
          setZoomLevel(clampZoomIndex(s.zoomLevel));
        if (s.sortKey) setSortKey(s.sortKey);
        if (s.sortDir) setSortDir(s.sortDir);
        if (s.groupByFolders !== undefined) setGroupByFolders(s.groupByFolders);
        if (s.randomSeed !== undefined) setRandomSeed(s.randomSeed);
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

  // FS listeners
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const handleFileAdded = (videoFile) => {
      const normalized = normalizeVideoFromMain(videoFile);
      setVideos((prev) => {
        const existingIndex = prev.findIndex((v) => v.id === normalized.id);
        if (existingIndex !== -1) {
          const next = prev.slice();
          next[existingIndex] = normalized;
          return next;
        }
        return [...prev, normalized].sort((a, b) =>
          a.basename.localeCompare(b.basename, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        );
      });
      if (normalized.tags.length) {
        refreshTagList();
      }
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
      refreshTagList();
    };
    const handleFileChanged = (videoFile) => {
      const normalized = normalizeVideoFromMain(videoFile);
      setVideos((prev) =>
        prev.map((v) => (v.id === normalized.id ? normalized : v))
      );
      if (normalized.tags.length) {
        refreshTagList();
      }
    };

    api.onFileAdded?.(handleFileAdded);
    api.onFileRemoved?.(handleFileRemoved);
    api.onFileChanged?.(handleFileChanged);

    return () => {
      api?.stopFolderWatch?.().catch(() => {});
    };
  }, [selection.setSelected, refreshTagList]);

  // relayout when list changes
  useEffect(() => {
    if (orderedVideos.length) onItemsChanged();
  }, [orderedVideos.length, onItemsChanged]);

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
        const normalizedFiles = files.map((file) =>
          normalizeVideoFromMain(file)
        );

        setLoadingStage(
          `Found ${files.length} videos — initializing masonry...`
        );
        setLoadingProgress(70);
        await new Promise((r) => setTimeout(r, 200));

        setVideos(normalizedFiles);
        await new Promise((r) => setTimeout(r, 300));

        setLoadingStage("Complete!");
        setLoadingProgress(100);
        await new Promise((r) => setTimeout(r, 250));
        setIsLoadingFolder(false);

        refreshTagList();

        const watchResult = await api.startFolderWatch?.(folderPath);
        if (watchResult?.success && __DEV__) console.log("👁️ watching folder");

        // record in recent folders AFTER successful open
        addRecentFolder(folderPath);
      } catch (e) {
        console.error("Error reading directory:", e);
        setIsLoadingFolder(false);
      }
    },
    [recursiveMode, addRecentFolder, selection, refreshTagList]
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
        basename: f.name,
        dirname: "",
        createdMs: f.lastModified || 0,
        fingerprint: null,
        tags: [],
        rating: null,
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

  const handleSortChange = useCallback(
    (value) => {
      const { sortKey: key, sortDir: dir } = parseSortValue(value);
      setSortKey(key);
      setSortDir(dir);
      let seed = randomSeed;
      if (key === SortKey.RANDOM && seed == null) {
        seed = Date.now();
        setRandomSeed(seed);
      }
      window.electronAPI?.saveSettingsPartial?.({
        sortKey: key,
        sortDir: dir,
        groupByFolders,
        randomSeed: seed,
      });
    },
    [groupByFolders, randomSeed]
  );

  const toggleGroupByFolders = useCallback(() => {
    const next = !groupByFolders;
    setGroupByFolders(next);
    window.electronAPI?.saveSettingsPartial?.({
      sortKey,
      sortDir,
      groupByFolders: next,
      randomSeed,
    });
  }, [groupByFolders, sortKey, sortDir, randomSeed]);

  const reshuffleRandom = useCallback(() => {
    const seed = Date.now();
    setRandomSeed(seed);
    window.electronAPI?.saveSettingsPartial?.({
      sortKey,
      sortDir,
      groupByFolders,
      randomSeed: seed,
    });
  }, [sortKey, sortDir, groupByFolders]);

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
        selection.selectRange(
          orderForRange,
          videoId,
          /* additive */ isCtrlClick
        );
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
  // drive the effect by stable scalars; apply deletions, not replacement; de-bounce one tick
  const maxLoaded = videoCollection.limits?.maxLoaded ?? 0;                 
  const loadedSize = loadedVideos.size;                                    
  const playingSize = actualPlaying.size;                                  
  const loadingSize = loadingVideos.size;                                   

  useEffect(() => {                                                          
    const id = setTimeout(() => {                                            // run after paint to avoid chaining renders
      const victims = videoCollection.performCleanup?.();
      if (Array.isArray(victims) && victims.length) {
        setLoadedVideos((prev) => {
          const ns = new Set(prev);
          for (const vid of victims) ns.delete(vid);
          return ns;
        });
      }
    }, 0);
    return () => clearTimeout(id);
  }, [maxLoaded, loadedSize, playingSize, loadingSize, videoCollection.performCleanup]); 

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
            sortKey={sortKey}
            sortSelection={formatSortValue(sortKey, sortDir)}
            groupByFolders={groupByFolders}
            onSortChange={handleSortChange}
            onGroupByFoldersToggle={toggleGroupByFolders}
            onReshuffle={reshuffleRandom}
            recentFolders={recentFolders}
            onRecentOpen={(path) => handleElectronFolderSelection(path)}
            hasOpenFolder={orderedVideos.length > 0}
          />

          <DebugSummary
            total={videoCollection.stats.total}
            rendered={videoCollection.stats.rendered}
            playing={videoCollection.stats.playing}
            inView={visibleVideos.size}
            memoryStatus={videoCollection.memoryStatus}
            zoomLevel={zoomLevel}
            getMinimumZoomLevel={getMinimumZoomLevel}
            sortStatus={sortStatus}
          />

          {/* Home state: Recent Locations when nothing is loaded */}
          {orderedVideos.length === 0 && !isLoadingFolder ? (
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
            <div className="content-region">
              <div
                ref={gridRef}
                className={`video-grid masonry-vertical ${
                  !showFilenames ? "hide-filenames" : ""
                } ${zoomClassForLevel(zoomLevel)}`}
              >
                {videoCollection.videosToRender.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    ioRoot={gridRef}
                    observeIntersection={ioRegistry.observe}
                    unobserveIntersection={ioRegistry.unobserve}
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
                    scheduleInit={scheduleInit}
                  />
                ))}
              </div>
              <MetadataPanel
                isOpen={isMetadataPanelOpen && selection.size > 0}
                onToggle={() => setMetadataPanelOpen((open) => !open)}
                selectionCount={selection.size}
                selectedVideos={selectedVideos}
                availableTags={availableTags}
                onAddTag={handleAddTags}
                onRemoveTag={handleRemoveTag}
                onApplyTagToSelection={handleApplyExistingTag}
                onSetRating={handleSetRating}
                onClearRating={handleClearRating}
                focusToken={metadataFocusToken}
              />
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
              onAction={handleContextAction}
            />
          )}
        </>
      )}
    </div>
  );
}

export default App;
