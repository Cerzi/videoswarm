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
import FiltersPopover from "./components/FiltersPopover";
import DebugSummary from "./components/DebugSummary";
import AboutDialog from "./components/AboutDialog";
import DataLocationDialog from "./components/DataLocationDialog";
import ProfilePromptDialog from "./components/ProfilePromptDialog";

import { useFullScreenModal } from "./hooks/useFullScreenModal";
import { useVideoCollection } from "./hooks/video-collection";
import useRecentFolders from "./hooks/useRecentFolders";
import useLongTaskFlag from "./hooks/ui-perf/useLongTaskFlag";
import useInitGate from "./hooks/ui-perf/useInitGate";

import useSelectionState from "./hooks/selection/useSelectionState";
import useStableViewAnchoring from "./hooks/selection/useStableViewAnchoring";
import { useContextMenu } from "./hooks/context-menu/useContextMenu";
import useActionDispatch from "./hooks/actions/useActionDispatch";
import { releaseVideoHandlesForAsync } from "./utils/releaseVideoHandles";
import { updateSetMembership, removeManyFromSet } from "./utils/updateSetMembership";
import useTrashIntegration from "./hooks/actions/useTrashIntegration";
import { shouldAutoOpenMetadataPanel } from "./utils/metadataPanelState";

import { SortKey } from "./sorting/sorting.js";
import { parseSortValue, formatSortValue } from "./sorting/sortOption.js";

import { zoomClassForLevel, clampZoomIndex } from "./zoom/utils.js";
import useHotkeys from "./hooks/selection/useHotkeys";
import { ZOOM_MIN_INDEX, ZOOM_MAX_INDEX } from "./zoom/config";
import {
  RENDER_LIMIT_STEPS,
  resolveRenderLimit,
  clampRenderLimitStep,
} from "./utils/renderLimit";

import feature from "./config/featureFlags";
import "./App.css";

import LoadingOverlay from "./app/components/LoadingOverlay";
import MemoryAlert from "./app/components/MemoryAlert";
import { useFilterState } from "./app/hooks/useFilterState";
import { useMasonryLayout } from "./app/hooks/useMasonryLayout";
import { useMetadataActions } from "./app/hooks/useMetadataActions";
import { useZoomControls } from "./app/hooks/useZoomControls";
import { useElectronFolderLifecycle } from "./app/hooks/useElectronFolderLifecycle";

const clampNumber = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const MIN_METADATA_DOCK_HEIGHT = 200;
const MAX_METADATA_DOCK_HEIGHT = 520;
const DEFAULT_METADATA_DOCK_HEIGHT = 280;

function computeActivationWindow(orderedIds, metrics = {}, explicitTarget) {
  const list = Array.isArray(orderedIds) ? orderedIds : [];
  const total = list.length;
  const columnCount = Math.max(
    1,
    Math.floor(Number(metrics.columnCount) || 1)
  );
  const approxHeight = Math.max(1, Number(metrics.approxTileHeight) || 1);
  const scrollTop = Math.max(0, Number(metrics.scrollTop) || 0);
  const viewportRows = Math.max(
    1,
    Math.floor(Number(metrics.viewportRows) || 1)
  );

  if (total === 0) {
    const safeTarget = Number.isFinite(explicitTarget)
      ? Math.max(0, Math.floor(explicitTarget))
      : 0;
    return {
      ids: [],
      idSet: new Set(),
      startIndex: 0,
      endIndex: 0,
      target: safeTarget,
    };
  }

  const fallbackTarget = columnCount * viewportRows * 2;
  const desiredTarget = Number.isFinite(explicitTarget) && explicitTarget > 0
    ? Math.floor(explicitTarget)
    : fallbackTarget;
  const safeTarget = clampNumber(desiredTarget, 1, Math.min(600, total));

  const topRow = Math.max(0, Math.floor(scrollTop / approxHeight));
  const bufferRows = viewportRows;
  let startRow = Math.max(0, topRow - bufferRows);
  const rowsNeeded = Math.max(
    Math.ceil(safeTarget / columnCount),
    viewportRows * 2
  );
  let endRow = startRow + rowsNeeded;

  let startIndex = Math.min(total, startRow * columnCount);
  let endIndex = Math.min(total, endRow * columnCount);

  if (endIndex - startIndex < safeTarget) {
    const deficit = safeTarget - (endIndex - startIndex);
    endIndex = Math.min(total, endIndex + deficit);
  }

  if (endIndex - startIndex < safeTarget) {
    const deficit = safeTarget - (endIndex - startIndex);
    startIndex = Math.max(0, startIndex - deficit);
  }

  if (endIndex - startIndex > safeTarget) {
    endIndex = Math.min(total, startIndex + safeTarget);
  }

  if (endIndex - startIndex > safeTarget) {
    startIndex = Math.max(0, endIndex - safeTarget);
  }

  if (startIndex >= endIndex) {
    startIndex = Math.max(0, Math.min(total, startIndex));
    endIndex = Math.min(total, Math.max(startIndex, startIndex + safeTarget));
  }

  const ids = list.slice(startIndex, endIndex);
  const idSet = new Set(ids);
  return { ids, idSet, startIndex, endIndex, target: safeTarget };
}

function App() {
  // Selection state (SOLID)
  const selection = useSelectionState(); // { selected, size, selectOnly, toggle, clear, setSelected, selectRange, anchorId }
  const selectionSetSelected = selection.setSelected;
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true);
  const [renderLimitStep, setRenderLimitStep] = useState(RENDER_LIMIT_STEPS);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [sortKey, setSortKey] = useState(SortKey.NAME);
  const [sortDir, setSortDir] = useState("asc");
  const [groupByFolders, setGroupByFolders] = useState(true);
  const [randomSeed, setRandomSeed] = useState(null);
  const [isAboutOpen, setAboutOpen] = useState(false);
  const [isDataLocationOpen, setDataLocationOpen] = useState(false);
  const [profilePromptRequest, setProfilePromptRequest] = useState(null);
  const [profilePromptValue, setProfilePromptValue] = useState("");

  // Video collection state
  const [actualPlaying, setActualPlaying] = useState(new Set());
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());

  const { scheduleInit } = useInitGate({ perFrame: 6 });

  const [availableTags, setAvailableTags] = useState([]);
  const [isMetadataPanelOpen, setMetadataPanelOpen] = useState(false);
  const [metadataPanelDismissed, setMetadataPanelDismissed] = useState(false);
  const [metadataFocusToken, setMetadataFocusToken] = useState(0);
  const [metadataDockHeight, setMetadataDockHeight] = useState(
    DEFAULT_METADATA_DOCK_HEIGHT
  );
  const scrollContainerRef = useRef(null);
  const gridRef = useRef(null);
  const contentRegionRef = useRef(null);
  const metadataPanelRef = useRef(null);
  const filtersButtonRef = useRef(null);
  const filtersPopoverRef = useRef(null);
  const refreshTagListRef = useRef(() => {});
  const applyZoomFromSettingsRef = useRef((value) => {
    setZoomLevel(clampZoomIndex(value));
  });
  const invokeRefreshTagList = useCallback(() => {
    const fn = refreshTagListRef.current;
    if (typeof fn === "function") {
      fn();
    }
  }, []);

  const respondToProfilePrompt = useCallback((requestId, value) => {
    const profilesApi = window.electronAPI?.profiles;
    profilesApi?.respondToPrompt?.(requestId, value);
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onOpenDataLocation?.(() => {
      setDataLocationOpen(true);
    });
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, []);

  useEffect(() => {
    const profilesApi = window.electronAPI?.profiles;
    if (!profilesApi?.onPromptInput) {
      return undefined;
    }

    return profilesApi.onPromptInput((payload) => {
      if (!payload?.requestId) {
        return;
      }

      setProfilePromptRequest((current) => {
        if (current?.requestId && current.requestId !== payload.requestId) {
          respondToProfilePrompt(current.requestId, null);
        }
        return {
          requestId: payload.requestId,
          title: payload.title,
          message: payload.message,
        };
      });
      setProfilePromptValue(payload.defaultValue ?? "");
    });
  }, [respondToProfilePrompt]);

  const handleProfilePromptDismiss = useCallback(() => {
    setProfilePromptRequest(null);
    setProfilePromptValue("");
  }, []);

  const handleProfilePromptConfirm = useCallback(
    (nextValue) => {
      if (!profilePromptRequest) {
        return;
      }
      const resolvedValue =
        typeof nextValue === "string" ? nextValue : profilePromptValue;
      const trimmed = resolvedValue.trim();
      respondToProfilePrompt(
        profilePromptRequest.requestId,
        trimmed.length ? trimmed : null
      );
      handleProfilePromptDismiss();
    },
    [
      profilePromptRequest,
      profilePromptValue,
      respondToProfilePrompt,
      handleProfilePromptDismiss,
    ]
  );

  const handleProfilePromptCancel = useCallback(() => {
    if (profilePromptRequest) {
      respondToProfilePrompt(profilePromptRequest.requestId, null);
    }
    handleProfilePromptDismiss();
  }, [profilePromptRequest, respondToProfilePrompt, handleProfilePromptDismiss]);
  // ----- Recent Folders hook -----
  const {
    items: recentFolders,
    add: addRecentFolder,
    remove: removeRecentFolder,
    clear: clearRecentFolders,
  } = useRecentFolders();

  const {
    videos,
    setVideos,
    isLoadingFolder,
    loadingStage,
    loadingProgress,
    settingsLoaded,
    handleElectronFolderSelection,
    handleFolderSelect,
    handleWebFileSelection,
  } = useElectronFolderLifecycle({
    selection,
    recursiveMode,
    setRecursiveMode,
    setShowFilenames,
    renderLimitStep,
    setRenderLimitStep,
    setSortKey,
    setSortDir,
    groupByFolders,
    setGroupByFolders,
    setRandomSeed,
    setZoomLevelFromSettings: (value) =>
      applyZoomFromSettingsRef.current?.(value),
    setVisibleVideos,
    setLoadedVideos,
    setLoadingVideos,
    setActualPlaying,
    refreshTagList: invokeRefreshTagList,
    addRecentFolder,
  });

  const {
    filters,
    setFiltersOpen,
    isFiltersOpen,
    updateFilters,
    resetFilters,
    filteredVideos,
    filteredVideoIds,
    filtersActiveCount,
    ratingSummary,
    handleRemoveIncludeFilter,
    handleRemoveExcludeFilter,
  } = useFilterState({
    videos,
    filtersButtonRef,
    filtersPopoverRef,
  });

  const {
    orderedVideos,
    orderedIds,
    orderForRange,
    ioRegistry,
    layoutEpoch,
    scheduleLayout,
    updateAspectRatio,
    onItemsChanged,
    setZoomClass,
    progressiveMaxVisibleNumber,
    activationTarget: activationTargetCount,
    viewportMetrics,
    withLayoutHold,
    isLayoutTransitioning,
  } = useMasonryLayout({
    videos,
    filteredVideos,
    sortKey,
    sortDir,
    groupByFolders,
    randomSeed,
    zoomLevel,
    scrollContainerRef,
    gridRef,
  });

  const totalVideoCount = videos.length;
  const renderLimitValue = useMemo(
    () => resolveRenderLimit(renderLimitStep, totalVideoCount),
    [renderLimitStep, totalVideoCount]
  );
  const renderLimitLabel = useMemo(
    () => (renderLimitValue === null ? "Max" : String(renderLimitValue)),
    [renderLimitValue]
  );
  const effectiveProgressiveCap = useMemo(() => {
    const layoutLimit =
      Number.isFinite(progressiveMaxVisibleNumber) &&
      progressiveMaxVisibleNumber > 0
        ? Math.floor(progressiveMaxVisibleNumber)
        : null;
    if (renderLimitValue === 0) return 0;
    const userLimit =
      renderLimitValue !== null &&
      Number.isFinite(renderLimitValue) &&
      renderLimitValue > 0
        ? Math.floor(renderLimitValue)
        : null;

    if (layoutLimit == null && userLimit == null) return undefined;
    if (layoutLimit == null) return userLimit ?? undefined;
    if (userLimit == null) return layoutLimit;
    return Math.min(layoutLimit, userLimit);
  }, [progressiveMaxVisibleNumber, renderLimitValue]);

  const activationWindow = useMemo(
    () =>
      computeActivationWindow(
        orderedIds,
        viewportMetrics,
        activationTargetCount
      ),
    [orderedIds, viewportMetrics, activationTargetCount]
  );

  const activationWindowRef = useRef(activationWindow.idSet);
  useEffect(() => {
    activationWindowRef.current = activationWindow.idSet;
  }, [activationWindow.idSet]);

  const isWithinActivation = useCallback(
    (id) => activationWindowRef.current.has(id),
    []
  );

  const { hadLongTaskRecently } = useLongTaskFlag();

  useEffect(() => {
    if (!selection.size) return;
    selectionSetSelected((prev) => {
      let changed = false;
      const next = new Set();
      prev.forEach((id) => {
        if (filteredVideoIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [filteredVideoIds, selection.size, selectionSetSelected]);


  const anchorDefaults = useMemo(
    () =>
      feature.stableViewFixes
        ? { settleFrames: 2, stabilizeFrames: 2, maxWaitMs: 700 }
        : { settleFrames: 1, stabilizeFrames: 1, maxWaitMs: 400 },
    []
  );

  const sidebarAnchorOptions = useMemo(
    () => ({
      capture: "fresh",
      settleFrames: anchorDefaults.settleFrames,
      stabilizeFrames: anchorDefaults.stabilizeFrames,
      maxWaitMs: anchorDefaults.maxWaitMs,
    }),
    [
      anchorDefaults.maxWaitMs,
      anchorDefaults.settleFrames,
      anchorDefaults.stabilizeFrames,
    ]
  );

  const zoomAnchorOptions = useMemo(
    () =>
      feature.stableViewFixes
        ? { capture: "fresh", settleFrames: 1, stabilizeFrames: 2, maxWaitMs: 600 }
        : { capture: "fresh", settleFrames: 1, stabilizeFrames: 1, maxWaitMs: 400 },
    []
  );

  const { runWithStableAnchor, focusCurrentAnchor } = useStableViewAnchoring({
    enabled: feature.stableViewAnchoring,
    scrollRef: scrollContainerRef,
    gridRef,
    observeRef: contentRegionRef,
    selection,
    orderedIds: orderForRange,
    anchorMode: "last",
    settleFrames: anchorDefaults.settleFrames,
    stabilizeFrames: anchorDefaults.stabilizeFrames,
    maxWaitMs: anchorDefaults.maxWaitMs,
  });

  const {
    handleZoomChangeSafe,
    getMinimumZoomLevel,
    applyZoomFromSettings,
  } = useZoomControls({
    zoomLevel,
    setZoomLevel,
    orderedVideoCount: orderedVideos.length,
    recursiveMode,
    renderLimitStep,
    showFilenames,
    setZoomClass,
    scheduleLayout,
    runWithStableAnchor,
    withLayoutHold,
    zoomAnchorOptions,
  });

  useEffect(() => {
    applyZoomFromSettingsRef.current =
      typeof applyZoomFromSettings === "function"
        ? applyZoomFromSettings
        : (value) => setZoomLevel(clampZoomIndex(value));
  }, [applyZoomFromSettings]);

  const waitForTransitionEnd = useCallback(
    (element, properties = ["width"], timeoutMs = anchorDefaults.maxWaitMs) => {
      if (!feature.stableViewFixes) return Promise.resolve();
      if (!element || typeof window === "undefined") return Promise.resolve();

      let computed;
      try {
        computed = window.getComputedStyle(element);
      } catch (error) {
        console.debug("[stable-anchor] Failed to read computed style", error);
        return Promise.resolve();
      }

      const parseTime = (value) => {
        if (!value) return 0;
        const trimmed = String(value).trim();
        if (!trimmed) return 0;
        if (trimmed.endsWith("ms")) return parseFloat(trimmed);
        if (trimmed.endsWith("s")) return parseFloat(trimmed) * 1000;
        const parsed = parseFloat(trimmed);
        return Number.isFinite(parsed) ? parsed * 1000 : 0;
      };

      const durations = (computed?.transitionDuration || "")
        .split(",")
        .map(parseTime);
      const delays = (computed?.transitionDelay || "")
        .split(",")
        .map(parseTime);
      const hasDuration = durations.some((duration, index) => {
        const delay = delays[index] ?? delays[delays.length - 1] ?? 0;
        return duration + delay > 0;
      });
      if (!hasDuration) {
        return Promise.resolve();
      }

      const propertySet = Array.isArray(properties) && properties.length > 0
        ? new Set(properties.filter(Boolean))
        : null;

      return new Promise((resolve) => {
        if (!element) {
          resolve();
          return;
        }

        let resolved = false;
        let timer = null;

        function cleanup() {
          if (!element) return;
          element.removeEventListener("transitionend", onTransitionDone);
          element.removeEventListener("transitioncancel", onTransitionDone);
          if (timer != null) {
            window.clearTimeout(timer);
          }
        }

        function finalize() {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve();
        }

        function onTransitionDone(event) {
          if (propertySet && propertySet.size && !propertySet.has(event.propertyName)) {
            return;
          }
          if (propertySet && propertySet.size) {
            propertySet.delete(event.propertyName);
            if (propertySet.size > 0) {
              return;
            }
          }
          finalize();
        }

        element.addEventListener("transitionend", onTransitionDone);
        element.addEventListener("transitioncancel", onTransitionDone);
        timer = window.setTimeout(finalize, timeoutMs ?? anchorDefaults.maxWaitMs);
      });
    },
    [anchorDefaults.maxWaitMs]
  );

  const runSidebarTransition = useCallback(
    (triggerType, applyState) =>
      withLayoutHold(() =>
        runWithStableAnchor(
          triggerType,
          () => {
            const promise = waitForTransitionEnd(
              metadataPanelRef.current,
              ["transform"],
              anchorDefaults.maxWaitMs
            );
            if (typeof applyState === "function") {
              applyState();
            }
            scheduleLayout?.();
            return promise;
          },
          sidebarAnchorOptions
        )
      ),
    [
      anchorDefaults.maxWaitMs,
      metadataPanelRef,
      runWithStableAnchor,
      scheduleLayout,
      sidebarAnchorOptions,
      waitForTransitionEnd,
      withLayoutHold,
    ]
  );

  const focusSelection = useCallback(() => {
    const selectedSet = selection?.selected;
    if (!(selectedSet instanceof Set) || selectedSet.size === 0) {
      return;
    }

    if (typeof focusCurrentAnchor === "function") {
      const handled = focusCurrentAnchor({ align: "center" });
      if (handled) {
        return;
      }
    }

    const scrollEl = scrollContainerRef?.current;
    const gridEl = gridRef?.current;
    if (!scrollEl || !gridEl) return;

    let fallbackId = null;
    if (selection?.anchorId && selectedSet.has(selection.anchorId)) {
      fallbackId = selection.anchorId;
    } else {
      const iterator = selectedSet.values();
      const next = iterator.next();
      fallbackId = next?.value ?? null;
    }

    if (!fallbackId) return;

    const nodes = gridEl.querySelectorAll("[data-video-id]");
    let target = null;
    for (const node of nodes) {
      if (node?.dataset?.videoId === String(fallbackId)) {
        target = node;
        break;
      }
    }

    if (!target) return;

    const viewportRect =
      typeof scrollEl.getBoundingClientRect === "function"
        ? scrollEl.getBoundingClientRect()
        : null;

    if (viewportRect) {
      const rect =
        typeof target.getBoundingClientRect === "function"
          ? target.getBoundingClientRect()
          : null;
      if (rect) {
        const delta =
          rect.top - viewportRect.top - viewportRect.height / 2 + rect.height / 2;
        if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
          scrollEl.scrollTop += delta;
        }
        return;
      }
    }

    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }, [focusCurrentAnchor, gridRef, scrollContainerRef, selection]);

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

  const handleNativeDragStart = useCallback(
    (nativeEvent, video) => {
      if (!video?.isElectronFile || !video?.fullPath) return;
      const electronAPI = window?.electronAPI;
      if (!electronAPI?.startFileDragSync) return;

      const selectedIds = selection?.selected;
      const isInSelection = selectedIds instanceof Set && selectedIds.has(video.id);
      const pool = isInSelection ? selectedVideos : [video];
      const localFiles = pool
        .filter((entry) => entry?.isElectronFile && entry?.fullPath)
        .map((entry) => entry.fullPath);

      if (!localFiles.length) return;

      if (nativeEvent?.dataTransfer) {
        try {
          nativeEvent.dataTransfer.effectAllowed = "copy";
          nativeEvent.dataTransfer.dropEffect = "copy";
        } catch (err) {}
      }

      electronAPI.startFileDragSync(localFiles);
    },
    [selection?.selected, selectedVideos]
  );

  useEffect(() => {
    if (
      !metadataPanelDismissed &&
      shouldAutoOpenMetadataPanel(selection.size, isMetadataPanelOpen)
    ) {
      runSidebarTransition("sidebar:auto-open", () => {
        setMetadataPanelOpen(true);
        setMetadataPanelDismissed(false);
        setMetadataFocusToken((token) => token + 1);
      });
    }
  }, [
    isMetadataPanelOpen,
    metadataPanelDismissed,
    runSidebarTransition,
    selection.size,
    setMetadataFocusToken,
    setMetadataPanelDismissed,
    setMetadataPanelOpen,
    shouldAutoOpenMetadataPanel,
  ]);

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

  const {
    applyMetadataPatch,
    handleAddTags,
    handleRemoveTag,
    handleSetRating,
    handleClearRating,
    handleApplyExistingTag,
    refreshTagList,
  } = useMetadataActions({
    selectedFingerprints,
    setVideos,
    setAvailableTags,
    notify,
  });

  refreshTagListRef.current = refreshTagList;

  useEffect(() => {
    refreshTagList();
  }, [refreshTagList]);

  const openMetadataPanel = useCallback(() => {
    runSidebarTransition("sidebar:open", () => {
      setMetadataPanelOpen(true);
      setMetadataPanelDismissed(false);
      setMetadataFocusToken((token) => token + 1);
    });
  }, [
    runSidebarTransition,
    setMetadataFocusToken,
    setMetadataPanelDismissed,
    setMetadataPanelOpen,
  ]);

  const toggleMetadataPanel = useCallback(() => {
    runSidebarTransition("sidebarToggle", () => {
      setMetadataPanelOpen((open) => {
        if (open) {
          setMetadataPanelDismissed(true);
          return false;
        }

        setMetadataPanelDismissed(false);
        setMetadataFocusToken((token) => token + 1);
        return true;
      });
    });
  }, [
    runSidebarTransition,
    setMetadataFocusToken,
    setMetadataPanelDismissed,
    setMetadataPanelOpen,
  ]);

  const { contextMenu, showOnItem, hide: hideContextMenu } = useContextMenu();

  const captureLastFocusSelector = useCallback(() => {
    if (typeof document === "undefined") return null;
    const active = document.activeElement;
    if (!active || active === document.body) return null;

    const cssEscape = (value) => {
      if (typeof value !== "string" || !value) return "";
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return CSS.escape(value);
      }
      return value.replace(/([\0-\x1F\x7F-\x9F!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~ ])/g, "\\$1");
    };

    const attrSelector = (attr, value) => {
      if (!value) return null;
      const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${active.tagName?.toLowerCase?.() || "*"}[${attr}="${escaped}"]`;
    };

    if (active.id) {
      return `#${cssEscape(active.id)}`;
    }

    const datasetKey = active.getAttribute?.("data-focus-target");
    if (datasetKey) {
      const escaped = datasetKey.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `[data-focus-target="${escaped}"]`;
    }

    if (active.name) {
      return attrSelector("name", active.name);
    }

    const placeholder = active.getAttribute?.("placeholder");
    if (placeholder) {
      return attrSelector("placeholder", placeholder);
    }

    return null;
  }, []);

  const scheduleAnimationFrame = useCallback((cb) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(cb);
    }
    return setTimeout(cb, 16);
  }, []);

  const preTrashCleanup = useCallback(() => {
    hideContextMenu();
  }, [hideContextMenu]);

  const postConfirmRecovery = useCallback(
    ({ cancelled: _cancelled, lastFocusedSelector } = {}) => {
      if (typeof document === "undefined") return;

      const query = (selector) => {
        if (!selector) return null;
        try {
          return document.querySelector(selector);
        } catch (error) {
          console.warn("[trash] failed to query focus selector", selector, error);
          return null;
        }
      };

      const visible = (el) => {
        if (!el) return false;
        if (typeof el.offsetParent !== "undefined") return !!el.offsetParent;
        const rect = el.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
      };

      const pickCandidate = () => {
        const last = query(lastFocusedSelector);
        if (visible(last)) return last;
        const tagInput = query('input[placeholder="Add tag and press Enter"]');
        if (visible(tagInput)) return tagInput;
        const searchInput = query('input[placeholder="Search available tags"]');
        if (visible(searchInput)) return searchInput;
        return null;
      };

      const attemptFocus = () => {
        const el = pickCandidate();
        if (!el) return false;
        if (typeof el.focus === "function") {
          el.focus({ preventScroll: true });
        }
        return document.activeElement === el;
      };

      if (attemptFocus()) return;

      const enqueue = typeof queueMicrotask === "function"
        ? queueMicrotask
        : (fn) => Promise.resolve().then(fn);

      enqueue(() => {
        if (attemptFocus()) return;
        scheduleAnimationFrame(() => {
          if (attemptFocus()) return;
          if (typeof window !== "undefined") {
            window.blur?.();
            window.focus?.();
          }
          attemptFocus();
        });
      });
    },
    [scheduleAnimationFrame]
  );

  const deps = useTrashIntegration({
    electronAPI: window.electronAPI,
    notify,
    confirm: window.confirm,
    preTrashCleanup,
    postConfirmRecovery,
    captureLastFocusSelector,
    releaseVideoHandlesForAsync,
    setVideos,
    setSelected: selection.setSelected,
    setLoadedIds: setLoadedVideos,
    setPlayingIds: setActualPlaying,
    setVisibleIds: setVisibleVideos,
    setLoadingIds: setLoadingVideos,
  });

  const { runAction } = useActionDispatch(deps, getById);

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
    scrollRef: scrollContainerRef,
    progressive: {
      initial: 120,
      batchSize: 64,
      intervalMs: 100,
      pauseOnScroll: true,
      longTaskAdaptation: true,
      maxVisible: effectiveProgressiveCap,
    },
    hadLongTaskRecently,
    isNear: isWithinActivation,
    activationTarget: activationWindow.target,
    activationWindowIds: activationWindow.ids,
    suspendEvictions: isLayoutTransitioning,
    renderLimit: renderLimitValue,
  });

  // fullscreen / context menu
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen,
  } = useFullScreenModal(orderedVideos, "masonry-vertical", gridRef);

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

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onOpenAbout?.(() => {
      setAboutOpen(true);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

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
  // relayout when list changes
  useEffect(() => {
    if (orderedVideos.length) onItemsChanged();
  }, [orderedVideos.length, onItemsChanged]);

  // aspect ratio updates from cards
    const handleVideoLoaded = useCallback(
      (videoId, aspectRatio) => {
        setLoadedVideos((prev) => updateSetMembership(prev, videoId, true));
        updateAspectRatio(videoId, aspectRatio);
      },
      [updateAspectRatio]
    );

    const handleVideoStartLoading = useCallback((videoId) => {
      setLoadingVideos((prev) => updateSetMembership(prev, videoId, true));
    }, []);

    const handleVideoStopLoading = useCallback((videoId) => {
      setLoadingVideos((prev) => updateSetMembership(prev, videoId, false));
    }, []);

    const handleVideoVisibilityChange = useCallback((videoId, isVisible) => {
      setVisibleVideos((prev) => updateSetMembership(prev, videoId, Boolean(isVisible)));
    }, []);

  const toggleRecursive = useCallback(() => {
    const next = !recursiveMode;
    setRecursiveMode(next);
    window.electronAPI?.saveSettingsPartial?.({
      recursiveMode: next,
      renderLimitStep,
      zoomLevel,
      showFilenames,
    });
  }, [recursiveMode, renderLimitStep, zoomLevel, showFilenames]);

  const toggleFilenames = useCallback(() => {
    const next = !showFilenames;
    setShowFilenames(next);
    window.electronAPI?.saveSettingsPartial?.({
      showFilenames: next,
      recursiveMode,
      renderLimitStep,
      zoomLevel,
    });
  }, [showFilenames, recursiveMode, renderLimitStep, zoomLevel]);

  const handleRenderLimitStepChange = useCallback(
    (step) => {
      const clamped = clampRenderLimitStep(step);
      setRenderLimitStep(clamped);
      window.electronAPI?.saveSettingsPartial?.({
        renderLimitStep: clamped,
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
        renderLimitStep,
      });
    },
    [groupByFolders, randomSeed, renderLimitStep]
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

  // Right-click on a card: open the item context menu without altering selection
  const handleCardContextMenu = useCallback(
    (e, video) => {
      if (!video?.id) return;
      showOnItem(e, video.id);
    },
    [showOnItem]
  );

  // Right-click on empty background: allow native behavior while hiding custom menu
  const handleBackgroundContextMenu = useCallback(
    (e) => {
      const target = e?.target;
      if (typeof target?.closest === "function" && target.closest(".video-item")) {
        return;
      }
      hideContextMenu();
    },
    [hideContextMenu]
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
    if (isLayoutTransitioning) return undefined;
    const id = setTimeout(() => {
      const victims = videoCollection.performCleanup?.();
        if (Array.isArray(victims) && victims.length) {
          setLoadedVideos((prev) => removeManyFromSet(prev, victims));
        }
    }, 0);
    return () => clearTimeout(id);
  }, [
    isLayoutTransitioning,
    maxLoaded,
    loadedSize,
    playingSize,
    loadingSize,
    videoCollection.performCleanup,
  ]);

  const shouldRenderCollapsedHint = metadataPanelDismissed || selection.size > 0;

  const contentRegionClassName = [
    "content-region",
    shouldRenderCollapsedHint ? "content-region--dock-hint" : "",
    isMetadataPanelOpen ? "content-region--dock-open" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const contentRegionStyle = useMemo(
    () => ({ "--metadata-dock-height": `${Math.round(metadataDockHeight)}px` }),
    [metadataDockHeight]
  );

  const handleMetadataDockHeightChange = useCallback((nextHeight) => {
    if (!Number.isFinite(nextHeight)) return;
    const viewportHeight =
      typeof window !== "undefined" && Number.isFinite(window.innerHeight)
        ? window.innerHeight
        : null;
    const dynamicMax = viewportHeight
      ? Math.max(
          MIN_METADATA_DOCK_HEIGHT,
          Math.min(MAX_METADATA_DOCK_HEIGHT, viewportHeight - 96)
        )
      : MAX_METADATA_DOCK_HEIGHT;

    setMetadataDockHeight((prev) => {
      const clamped = clampNumber(
        nextHeight,
        MIN_METADATA_DOCK_HEIGHT,
        dynamicMax
      );
      return prev === clamped ? prev : clamped;
    });
  }, []);

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
            renderLimitStep={renderLimitStep}
            renderLimitLabel={renderLimitLabel}
            renderLimitMaxStep={RENDER_LIMIT_STEPS}
            handleRenderLimitChange={handleRenderLimitStepChange}
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
            hasOpenFolder={videos.length > 0}
            onFiltersToggle={() => setFiltersOpen((open) => !open)}
            filtersActiveCount={filtersActiveCount}
            filtersAreOpen={isFiltersOpen}
            filtersButtonRef={filtersButtonRef}
          />

          {isFiltersOpen && (
            <FiltersPopover
              ref={filtersPopoverRef}
              filters={filters}
              availableTags={availableTags}
              onChange={updateFilters}
              onReset={resetFilters}
              onClose={() => setFiltersOpen(false)}
            />
          )}

          <AboutDialog open={isAboutOpen} onClose={() => setAboutOpen(false)} />
          <DataLocationDialog
            open={isDataLocationOpen}
            onClose={() => setDataLocationOpen(false)}
          />

          {profilePromptRequest ? (
            <ProfilePromptDialog
              request={profilePromptRequest}
              value={profilePromptValue}
              onChange={setProfilePromptValue}
              onSubmit={handleProfilePromptConfirm}
              onCancel={handleProfilePromptCancel}
            />
          ) : null}

          {filtersActiveCount > 0 && (
            <div className="filters-summary">
              {filters.includeTags.length > 0 && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Include</span>
                  <div className="filters-summary__chips">
                    {filters.includeTags.map((tag) => (
                      <button
                        type="button"
                        key={`include-${tag}`}
                        className="filters-summary__chip filters-summary__chip--include"
                        onClick={() => handleRemoveIncludeFilter(tag)}
                        title={`Remove include filter for ${tag}`}
                      >
                        #{tag}
                        <span className="filters-summary__chip-remove">×</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {filters.excludeTags.length > 0 && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Exclude</span>
                  <div className="filters-summary__chips">
                    {filters.excludeTags.map((tag) => (
                      <button
                        type="button"
                        key={`exclude-${tag}`}
                        className="filters-summary__chip filters-summary__chip--exclude"
                        onClick={() => handleRemoveExcludeFilter(tag)}
                        title={`Remove exclude filter for ${tag}`}
                      >
                        #{tag}
                        <span className="filters-summary__chip-remove">×</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {ratingSummary && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Rating</span>
                  <div className="filters-summary__chips">
                    <button
                      type="button"
                      className="filters-summary__chip filters-summary__chip--rating"
                      onClick={ratingSummary.onClear}
                      title="Clear rating filter"
                    >
                      {ratingSummary.label}
                      <span className="filters-summary__chip-remove">×</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <DebugSummary
            total={videoCollection.stats.total}
            rendered={videoCollection.stats.rendered}
            playing={videoCollection.stats.playing}
            inView={visibleVideos.size}
            activeWindow={activationWindow.ids.length}
            activationTarget={activationWindow.target}
            progressiveVisible={videoCollection.stats.progressiveVisible}
            memoryStatus={videoCollection.memoryStatus}
            zoomLevel={zoomLevel}
            getMinimumZoomLevel={getMinimumZoomLevel}
            sortStatus={sortStatus}
          />

          {/* Home state: Recent Locations when nothing is loaded */}
          {videos.length === 0 && !isLoadingFolder ? (
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
                  Click the green folder icon in the top left to open a directory of videos.
                </p>
                <p>
                  Use the Subfolders toggle to enable recursive loading, which will recursively load all videos in all subfolders as well.
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
              className={contentRegionClassName}
              ref={contentRegionRef}
              style={contentRegionStyle}
            >
              <div
                className="content-region__viewport"
                ref={scrollContainerRef}
              >
                <div
                  ref={gridRef}
                  className={`video-grid masonry-vertical ${
                    !showFilenames ? "hide-filenames" : ""
                  } ${zoomClassForLevel(zoomLevel)}`}
                >
                {orderedVideos.length === 0 &&
                  videos.length > 0 &&
                  !isLoadingFolder && (
                    <div className="filters-empty-state">
                      No videos match your current filters.
                    </div>
                  )}

                {videoCollection.videosToRender.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    observeIntersection={ioRegistry.observe}
                    unobserveIntersection={ioRegistry.unobserve}
                    scrollRootRef={scrollContainerRef}
                    selected={selection.selected.has(video.id)}
                    onSelect={(...args) => handleVideoSelect(...args)}
                    onContextMenu={handleCardContextMenu}
                    onNativeDragStart={handleNativeDragStart}
                    showFilenames={showFilenames}
                    // Video Collection Management
                    canLoadMoreVideos={(opts) =>
                      videoCollection.canLoadVideo(video.id, opts)
                    }
                    isLoading={loadingVideos.has(video.id)}
                    isLoaded={loadedVideos.has(video.id)}
                    isVisible={visibleVideos.has(video.id)}
                    isPlaying={videoCollection.isVideoPlaying(video.id)}
                    isNear={ioRegistry.isNear}
                    layoutEpoch={layoutEpoch}
                    // Lifecycle callbacks
                    onStartLoading={handleVideoStartLoading}
                    onStopLoading={handleVideoStopLoading}
                    onVideoLoad={handleVideoLoaded}
                    onVisibilityChange={handleVideoVisibilityChange}
                    // Media events → update orchestrator + actual playing count
                    onVideoPlay={(id) => {
                      videoCollection.reportStarted(id);
                      setActualPlaying((prev) => updateSetMembership(prev, id, true));
                    }}
                    onVideoPause={(id) => {
                      setActualPlaying((prev) => updateSetMembership(prev, id, false));
                    }}
                    onPlayError={(id) => {
                      videoCollection.reportPlayError(id);
                      setActualPlaying((prev) => updateSetMembership(prev, id, false));
                    }}
                    // Hover for priority
                    onHover={(id) => videoCollection.markHover(id)}
                    scheduleInit={scheduleInit}
                  />
                ))}
                </div>
              </div>
              <MetadataPanel
                ref={metadataPanelRef}
                isOpen={isMetadataPanelOpen}
                onToggle={toggleMetadataPanel}
                showCollapsedHint={shouldRenderCollapsedHint}
                selectionCount={selection.size}
                selectedVideos={selectedVideos}
                availableTags={availableTags}
                onAddTag={handleAddTags}
                onRemoveTag={handleRemoveTag}
                onApplyTagToSelection={handleApplyExistingTag}
                onSetRating={handleSetRating}
                onClearRating={handleClearRating}
                focusToken={metadataFocusToken}
                onFocusSelection={focusSelection}
                dockHeight={metadataDockHeight}
                minDockHeight={MIN_METADATA_DOCK_HEIGHT}
                maxDockHeight={MAX_METADATA_DOCK_HEIGHT}
                onDockHeightChange={handleMetadataDockHeightChange}
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
