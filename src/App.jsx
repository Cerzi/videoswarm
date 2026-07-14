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
import CollectionNavigationBar from "./components/CollectionNavigationBar";
import LibrarySidebar from "./components/LibrarySidebar";
import FolderGroupHeaders from "./components/FolderGroupHeaders";
import DebugSummary from "./components/DebugSummary";
import AboutDialog from "./components/AboutDialog";
import DataLocationDialog from "./components/DataLocationDialog";
import ProfilePromptDialog from "./components/ProfilePromptDialog";
import KeyboardShortcutsDialog from "./components/KeyboardShortcutsDialog";

import { useFullScreenModal } from "./hooks/useFullScreenModal";
import { useVideoCollection } from "./hooks/video-collection";
import useRecentFolders from "./hooks/useRecentFolders";
import useInitGate from "./hooks/ui-perf/useInitGate";
import usePlaybackTelemetry from "./hooks/video-collection/usePlaybackTelemetry";
import useAdaptivePlaybackPolicy from "./hooks/video-collection/useAdaptivePlaybackPolicy";

import useSelectionState from "./hooks/selection/useSelectionState";
import { useContextMenu } from "./hooks/context-menu/useContextMenu";
import useActionDispatch from "./hooks/actions/useActionDispatch";
import { releaseVideoHandlesForAsync } from "./utils/releaseVideoHandles";
import { updateSetMembership, removeManyFromSet } from "./utils/updateSetMembership";
import useTrashIntegration from "./hooks/actions/useTrashIntegration";

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
import { useLibraryCatalog } from "./app/hooks/useLibraryCatalog";
import { useSavedViews } from "./app/hooks/useSavedViews";
import { useGenerationMetadata } from "./app/hooks/useGenerationMetadata";
import useWindowWorkSuspension from "./app/hooks/useWindowWorkSuspension";
import usePlaybackCapabilities from "./app/hooks/usePlaybackCapabilities";
import {
  FOLDER_OPEN_MILESTONES,
  recordFolderOpenMilestone,
} from "./app/performance/folderOpenMetrics";
import { createMediaSlotScheduler } from "./services/mediaSlotScheduler";
import { thumbService } from "./services/thumbService";
import {
  DEFAULT_PLAYBACK_MODE,
  PLAYBACK_MODES,
  normalizePlaybackMode,
} from "./playback/playbackPolicy";
import {
  FolderScope,
  buildBreadcrumbs,
  buildFolderTree,
  filterVideosByFolderScope,
  findFolderNode,
  getParentDirectory,
  getSiblingNavigation,
  normalizeRelativePath,
} from "./library/folderModel";
import { FolderViewStateCache, makeFolderViewKey } from "./library/folderViewState";
import { REVIEW_FILTERS } from "./review/reviewState";

const expandFolderAncestors = (previous, relativePath) => {
  const next = new Set(previous instanceof Set ? previous : [""]);
  next.add("");
  let cursor = normalizeRelativePath(relativePath);
  while (cursor) {
    next.add(cursor);
    cursor = getParentDirectory(cursor);
  }
  return next;
};

function App() {
  // Selection state (SOLID)
  const selection = useSelectionState(); // { selected, size, selectOnly, toggle, clear, setSelected, selectRange, anchorId }
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true);
  const [hoverAudioEnabled, setHoverAudioEnabled] = useState(false);
  const [playbackMode, setPlaybackMode] = useState(DEFAULT_PLAYBACK_MODE);
  const [proxyPlaybackEnabled, setProxyPlaybackEnabled] = useState(false);
  const [hoveredVideoId, setHoveredVideoId] = useState(null);
  const hoveredVideoIdRef = useRef(null);
  const [renderLimitStep, setRenderLimitStep] = useState(RENDER_LIMIT_STEPS);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [sortKey, setSortKey] = useState(SortKey.NAME);
  const [sortDir, setSortDir] = useState("asc");
  const [groupByFolders, setGroupByFolders] = useState(true);
  const [randomSeed, setRandomSeed] = useState(null);
  const [fullScreenPinnedId, setFullScreenPinnedId] = useState(null);
  const [isAboutOpen, setAboutOpen] = useState(false);
  const [isDataLocationOpen, setDataLocationOpen] = useState(false);
  const [isHotkeyHelpOpen, setHotkeyHelpOpen] = useState(false);
  const [profilePromptRequest, setProfilePromptRequest] = useState(null);
  const [profilePromptValue, setProfilePromptValue] = useState("");
  const [folderLocation, setFolderLocation] = useState({
    rootPath: null,
    directory: "",
    scope: FolderScope.ALL_DESCENDANTS,
  });
  const [isLibrarySidebarOpen, setLibrarySidebarOpen] = useState(true);
  const [expandedFolderPaths, setExpandedFolderPaths] = useState(
    () => new Set([""])
  );
  const [showFolderHeaders, setShowFolderHeaders] = useState(false);
  const folderViewStateRef = useRef(new FolderViewStateCache());
  const restoredFolderViewKeyRef = useRef(null);
  const restoreScrollFrameRef = useRef([]);
  const beforeExternalFolderSelectionRef = useRef(null);
  const handleBeforeExternalFolderSelection = useCallback(() => {
    beforeExternalFolderSelectionRef.current?.();
  }, []);

  // Video collection state
  const [actualPlaying, setActualPlaying] = useState(new Set());
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());
  const mediaSchedulerRef = useRef(null);
  if (!mediaSchedulerRef.current) {
    mediaSchedulerRef.current = createMediaSlotScheduler();
  }
  const mediaScheduler = mediaSchedulerRef.current;
  const closeFullScreenRef = useRef(() => {});

  const { isSuspended: workSuspended, reason: workSuspensionReason } =
    useWindowWorkSuspension();
  const { capabilities: playbackCapabilities, statusText: playbackCapabilityStatus } =
    usePlaybackCapabilities();
  const uncappedAllMotion = playbackMode === PLAYBACK_MODES.ALL_MOTION;
  const {
    telemetry: playbackTelemetry,
    hadLongTaskRecently,
    registerMediaElement,
  } = usePlaybackTelemetry({
    suspended: workSuspended,
    detailed: !uncappedAllMotion,
  });
  const { scheduleInit } = useInitGate({
    perFrame: 6,
    suspended: workSuspended,
  });

  useEffect(() => {
    thumbService.setSuspended(workSuspended);
    return () => thumbService.setSuspended(true);
  }, [workSuspended]);

  const [availableTags, setAvailableTags] = useState([]);
  const [isMetadataPanelOpen, setMetadataPanelOpen] = useState(false);
  const [metadataDismissedSelectionKey, setMetadataDismissedSelectionKey] =
    useState(null);
  const [metadataFocusToken, setMetadataFocusToken] = useState(0);
  const [metadataPlacementRequest, setMetadataPlacementRequest] = useState(
    () => ({
      revision: 0,
      anchorId: null,
      avoidRect: null,
      reason: "initial",
    })
  );
  const scrollContainerRef = useRef(null);
  const gridRef = useRef(null);
  const galleryRef = useRef(null);
  const [scrollContainerElement, setScrollContainerElement] = useState(null);
  const [gridElement, setGridElement] = useState(null);
  const attachScrollContainer = useCallback((element) => {
    scrollContainerRef.current = element;
    setScrollContainerElement((previous) =>
      previous === element ? previous : element
    );
  }, []);
  const attachGrid = useCallback((element) => {
    gridRef.current = element;
    setGridElement((previous) => (previous === element ? previous : element));
  }, []);
  const contentRegionRef = useRef(null);
  const lastContextMenuPlacementRef = useRef(null);
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
    activeRootPath,
    libraryRoot,
    directorySummaries,
    isLoadingFolder,
    isRefreshingFolder,
    activeScanId,
    loadingStatus,
    loadingStage,
    loadingProgress,
    settingsLoaded,
    cancelFolderLoad,
    prioritizeActiveDirectoryScan,
    handleElectronFolderSelection,
    reloadCurrentRoot,
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
    setPlaybackMode,
    setProxyPlaybackEnabled,
    setZoomLevelFromSettings: (value) =>
      applyZoomFromSettingsRef.current?.(value),
    setVisibleVideos,
    setLoadedVideos,
    setLoadingVideos,
    setActualPlaying,
    resetMediaScheduler: mediaScheduler.reset,
    resetThumbnailGeneration: thumbService.resetGeneration,
    refreshTagList: invokeRefreshTagList,
    addRecentFolder,
    beforeExternalFolderSelection: handleBeforeExternalFolderSelection,
  });

  const {
    pinnedRoots,
    currentRoot: catalogCurrentRoot,
    directories: catalogDirectories,
    setPinned: setLibraryRootPinned,
  } = useLibraryCatalog({
    activeRootPath,
    scannedRoot: libraryRoot,
    scannedDirectories: directorySummaries,
  });
  const {
    savedViews,
    createSavedView,
    deleteSavedView,
  } = useSavedViews();

  const currentDirectory =
    folderLocation.rootPath === activeRootPath
      ? folderLocation.directory
      : "";
  const folderScope =
    folderLocation.rootPath === activeRootPath
      ? folderLocation.scope
      : FolderScope.ALL_DESCENDANTS;

  const {
    filters,
    setFiltersOpen,
    isFiltersOpen,
    updateFilters,
    resetFilters,
    filteredVideos,
    filtersActiveCount,
    ratingSummary,
    handleRemoveIncludeFilter,
    handleRemoveExcludeFilter,
    clearReviewFilter,
  } = useFilterState({
    videos,
    filtersButtonRef,
    filtersPopoverRef,
  });

  const rootDisplayName = useMemo(() => {
    const fromCatalog = catalogCurrentRoot?.name || catalogCurrentRoot?.label;
    if (fromCatalog) return fromCatalog;
    const parts = String(activeRootPath || "")
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean);
    return parts.at(-1) || activeRootPath || "Root";
  }, [activeRootPath, catalogCurrentRoot]);

  const folderTree = useMemo(
    () =>
      activeRootPath
        ? buildFolderTree({
            directorySummaries: catalogDirectories,
            videos,
            matchingVideos: filteredVideos,
            rootName: rootDisplayName,
          })
        : null,
    [
      activeRootPath,
      catalogDirectories,
      filteredVideos,
      rootDisplayName,
      videos,
    ]
  );

  const scopedFilteredVideos = useMemo(
    () =>
      filterVideosByFolderScope(filteredVideos, {
        scope: folderScope,
        currentDirectory,
      }),
    [currentDirectory, filteredVideos, folderScope]
  );

  const folderBreadcrumb = useMemo(
    () =>
      activeRootPath
        ? buildBreadcrumbs(activeRootPath, currentDirectory, {
            rootLabel: rootDisplayName,
          })
        : [],
    [activeRootPath, currentDirectory, rootDisplayName]
  );

  const siblingFolders = useMemo(
    () => getSiblingNavigation(folderTree, currentDirectory, folderScope),
    [currentDirectory, folderScope, folderTree]
  );

  const reviewFilterSummary = useMemo(() => {
    const value = filters.reviewFilter || REVIEW_FILTERS.ANY;
    if (value === REVIEW_FILTERS.ANY) return null;
    const labels = {
      [REVIEW_FILTERS.UNREVIEWED]: "Unreviewed",
      [REVIEW_FILTERS.REVIEWED]: "Reviewed",
      [REVIEW_FILTERS.PICK]: "Picks",
      [REVIEW_FILTERS.REJECT]: "Rejects",
    };
    return labels[value] || null;
  }, [filters.reviewFilter]);

  const captureFolderViewState = useCallback(() => {
    if (!activeRootPath || folderLocation.rootPath !== activeRootPath) return null;
    return folderViewStateRef.current.set(
      activeRootPath,
      currentDirectory,
      folderScope,
      {
        scrollTop: scrollContainerRef.current?.scrollTop || 0,
        selectedIds: selection.selected,
        sortKey,
        sortDir,
        groupByFolders,
        randomSeed,
        filters,
      }
    );
  }, [
    activeRootPath,
    currentDirectory,
    filters,
    folderLocation.rootPath,
    folderScope,
    groupByFolders,
    randomSeed,
    selection.selected,
    sortDir,
    sortKey,
  ]);
  beforeExternalFolderSelectionRef.current = captureFolderViewState;

  useEffect(() => {
    if (typeof cancelAnimationFrame === "function") {
      restoreScrollFrameRef.current.forEach((frame) => cancelAnimationFrame(frame));
    }
    restoreScrollFrameRef.current = [];

    if (!activeRootPath) {
      setFolderLocation({
        rootPath: null,
        directory: "",
        scope: FolderScope.ALL_DESCENDANTS,
      });
      restoredFolderViewKeyRef.current = null;
      return;
    }

    setFolderLocation((previous) => {
      if (previous.rootPath === activeRootPath) return previous;
      const saved = folderViewStateRef.current.getLocation(activeRootPath);
      return {
        rootPath: activeRootPath,
        directory: saved?.directory || "",
        scope: saved?.scope || FolderScope.ALL_DESCENDANTS,
      };
    });
    const saved = folderViewStateRef.current.getLocation(activeRootPath);
    setExpandedFolderPaths((previous) =>
      expandFolderAncestors(previous, saved?.directory || "")
    );
    restoredFolderViewKeyRef.current = null;
  }, [activeRootPath]);

  useEffect(() => {
    if (
      !activeRootPath ||
      folderLocation.rootPath !== activeRootPath ||
      isLoadingFolder
    ) {
      return undefined;
    }

    const viewKey = makeFolderViewKey(
      activeRootPath,
      currentDirectory,
      folderScope
    );
    if (restoredFolderViewKeyRef.current === viewKey) return undefined;
    restoredFolderViewKeyRef.current = viewKey;

    const snapshot = folderViewStateRef.current.get(
      activeRootPath,
      currentDirectory,
      folderScope
    );
    if (snapshot) {
      setSortKey(snapshot.sortKey);
      setSortDir(snapshot.sortDir);
      setGroupByFolders(snapshot.groupByFolders);
      setRandomSeed(snapshot.randomSeed);
      updateFilters(snapshot.filters);
      const validIds = new Set(videos.map((video) => video.id));
      selection.setSelected(
        new Set(snapshot.selectedIds.filter((id) => validIds.has(id)))
      );
    } else {
      selection.clear();
    }

    const scrollTop = snapshot?.scrollTop || 0;
    if (typeof requestAnimationFrame !== "function") {
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = scrollTop;
      return undefined;
    }
    const firstFrame = requestAnimationFrame(() => {
      const secondFrame = requestAnimationFrame(() => {
        if (scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = scrollTop;
        }
        restoreScrollFrameRef.current = [];
      });
      restoreScrollFrameRef.current = [secondFrame];
    });
    restoreScrollFrameRef.current = [firstFrame];

    return () => {
      if (typeof cancelAnimationFrame === "function") {
        restoreScrollFrameRef.current.forEach((frame) => cancelAnimationFrame(frame));
      }
      restoreScrollFrameRef.current = [];
    };
  }, [
    activeRootPath,
    currentDirectory,
    folderLocation.rootPath,
    folderScope,
    isLoadingFolder,
    selection.clear,
    selection.setSelected,
    updateFilters,
    videos,
  ]);

  useEffect(() => {
    if (
      !activeRootPath ||
      isLoadingFolder ||
      folderLocation.rootPath !== activeRootPath ||
      !currentDirectory ||
      !folderTree ||
      findFolderNode(folderTree, currentDirectory)
    ) {
      return;
    }

    folderViewStateRef.current.setLocation(
      activeRootPath,
      "",
      FolderScope.ALL_DESCENDANTS
    );
    restoredFolderViewKeyRef.current = null;
    setFolderLocation({
      rootPath: activeRootPath,
      directory: "",
      scope: FolderScope.ALL_DESCENDANTS,
    });
  }, [
    activeRootPath,
    currentDirectory,
    folderLocation.rootPath,
    folderTree,
    isLoadingFolder,
  ]);

  useEffect(() => {
    const subscribe = window.electronAPI?.profiles?.onChanged;
    if (!subscribe) return undefined;
    return subscribe(() => {
      folderViewStateRef.current.clear();
      restoredFolderViewKeyRef.current = null;
      setExpandedFolderPaths(new Set([""]));
    });
  }, []);

  const totalVideoCount = videos.length;
  const renderLimitValue = useMemo(
    () => resolveRenderLimit(renderLimitStep, totalVideoCount),
    [renderLimitStep, totalVideoCount]
  );
  const renderLimitLabel = useMemo(
    () => (renderLimitValue === null ? "Max" : String(renderLimitValue)),
    [renderLimitValue]
  );
  const pinnedLayoutIds = useMemo(
    () => (fullScreenPinnedId ? [fullScreenPinnedId] : []),
    [fullScreenPinnedId]
  );

  const {
    orderedVideos,
    displayVideos,
    orderForRange,
    ioRegistry,
    scheduleLayout,
    updateAspectRatio,
    setZoomClass,
    progressiveMaxVisibleNumber,
    activationTarget: activationTargetCount,
    activationIds,
    centerPriorityIds,
    activationIdSet,
    virtualItems,
    totalHeight: masonryTotalHeight,
    scrollToId,
    withLayoutHold,
    isLayoutTransitioning,
  } = useMasonryLayout({
    videos,
    filteredVideos: scopedFilteredVideos,
    sortKey,
    sortDir,
    groupByFolders,
    randomSeed,
    zoomLevel,
    scrollContainerRef,
    gridRef,
    scrollContainerElement,
    gridElement,
    renderLimit: renderLimitValue,
    pinnedIds: pinnedLayoutIds,
  });

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
    () => ({
      ids: activationIds,
      idSet: activationIdSet,
      target: activationTargetCount,
    }),
    [activationIdSet, activationIds, activationTargetCount]
  );

  const activationWindowRef = useRef(activationWindow.idSet);
  useEffect(() => {
    activationWindowRef.current = activationWindow.idSet;
  }, [activationWindow.idSet]);

  useEffect(() => {
    if (!activeScanId) return;
    prioritizeActiveDirectoryScan(activationIds);
  }, [activeScanId, activationIds, prioritizeActiveDirectoryScan]);

  useEffect(() => {
    if (!activeScanId) return undefined;
    const hasUsableGrid = virtualItems.length > 0;
    const hasCompletedEmptyGrid =
      Boolean(activeRootPath) &&
      videos.length === 0 &&
      !isLoadingFolder &&
      !isRefreshingFolder;
    if (!hasUsableGrid && !hasCompletedEmptyGrid) return undefined;

    let cancelled = false;
    const reportCommittedGrid = () => {
      if (cancelled) return;
      recordFolderOpenMilestone(
        activeScanId,
        FOLDER_OPEN_MILESTONES.FIRST_USABLE_GRID,
        {
          recordCount: videos.length,
          renderedCount: virtualItems.length,
          empty: hasCompletedEmptyGrid,
        }
      );
    };
    const frameId = requestAnimationFrame(reportCommittedGrid);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [
    activeRootPath,
    activeScanId,
    isLoadingFolder,
    isRefreshingFolder,
    videos.length,
    virtualItems.length,
  ]);

  const isWithinActivation = useCallback(
    (id) => activationWindowRef.current.has(id),
    []
  );

  const zoomAnchorOptions = useMemo(
    () =>
      feature.stableViewFixes
        ? { capture: "fresh", settleFrames: 1, stabilizeFrames: 2, maxWaitMs: 600 }
        : { capture: "fresh", settleFrames: 1, stabilizeFrames: 1, maxWaitMs: 400 },
    []
  );

  const runWithStableAnchor = useCallback(
    (_triggerType, update) =>
      typeof update === "function" ? update() : undefined,
    []
  );

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

  const focusSelection = useCallback(() => {
    const selectedSet = selection.selected;
    if (!(selectedSet instanceof Set) || selectedSet.size === 0) {
      return;
    }

    const fallbackId =
      selection.anchorId && selectedSet.has(selection.anchorId)
        ? selection.anchorId
        : selectedSet.values().next().value;
    if (fallbackId != null) {
      scrollToId(fallbackId, { align: "center" });
    }
  }, [scrollToId, selection.anchorId, selection.selected]);

  const videosById = useMemo(
    () => new Map(orderedVideos.map((video) => [video.id, video])),
    [orderedVideos]
  );
  const allVideosById = useMemo(
    () => new Map(videos.map((video) => [video.id, video])),
    [videos]
  );
  const allVideoIds = useMemo(() => new Set(allVideosById.keys()), [allVideosById]);
  const getById = useCallback((id) => videosById.get(id), [videosById]);

  useEffect(() => {
    selection.pruneTo?.(allVideoIds);
  }, [allVideoIds, selection.pruneTo]);

  const { contextMenu, showOnItem, hide: hideContextMenu } = useContextMenu();

  const selectedVideos = useMemo(() => {
    return Array.from(selection.selected)
      .map((id) => allVideosById.get(id))
      .filter(Boolean);
  }, [allVideosById, selection.selected]);

  const metadataSelectionKey = useMemo(
    () => JSON.stringify(Array.from(selection.selected, String).sort()),
    [selection.selected]
  );
  const metadataAnchorId = useMemo(() => {
    if (
      selection.anchorId != null &&
      selection.selected.has(selection.anchorId)
    ) {
      return selection.anchorId;
    }

    const firstVisibleSelected = orderedVideos.find((video) =>
      selection.selected.has(video.id)
    );
    return (
      firstVisibleSelected?.id ??
      selection.selected.values().next().value ??
      null
    );
  }, [orderedVideos, selection.anchorId, selection.selected]);

  const resolveMetadataAnchorRect = useCallback(
    (videoId) => {
      const cards = gridRef.current?.querySelectorAll?.(
        ".video-item[data-video-id]"
      );
      if (!cards) return null;
      const cardsById = new Map();
      for (const card of cards) {
        if (card.dataset?.videoId != null) {
          cardsById.set(card.dataset.videoId, card);
        }
      }
      const requestedCard =
        videoId == null ? null : cardsById.get(String(videoId));
      if (requestedCard) {
        return requestedCard.getBoundingClientRect?.() || null;
      }
      for (const video of orderedVideos) {
        if (!selection.selected.has(video.id)) continue;
        const mountedCard = cardsById.get(String(video.id));
        if (mountedCard) {
          return mountedCard.getBoundingClientRect?.() || null;
        }
      }
      return null;
    },
    [orderedVideos, selection.selected]
  );
  const resolveMetadataBoundsRect = useCallback(
    () => galleryRef.current?.getBoundingClientRect?.() || null,
    []
  );
  const resolveMetadataContainerRect = useCallback(
    () => contentRegionRef.current?.getBoundingClientRect?.() || null,
    []
  );

  const selectedGenerationInstanceId =
    selectedVideos.length === 1 ? selectedVideos[0]?.instanceId : null;
  const generationMetadata = useGenerationMetadata({
    instanceId: selectedGenerationInstanceId,
    enabled: Boolean(isMetadataPanelOpen && selectedGenerationInstanceId),
  });
  const generationMetadataState = useMemo(
    () =>
      selectedGenerationInstanceId
        ? { ...generationMetadata, onRefresh: generationMetadata.refresh }
        : null,
    [generationMetadata, selectedGenerationInstanceId]
  );

  const selectedFingerprints = useMemo(() => {
    const set = new Set();
    selectedVideos.forEach((video) => {
      if (video?.fingerprint) {
        set.add(video.fingerprint);
      }
    });
    return Array.from(set);
  }, [selectedVideos]);

  const contextMetadataFingerprints = useMemo(() => {
    if (selection.size > 1 || !contextMenu?.contextId) {
      return selectedFingerprints;
    }
    const contextVideo = getById(contextMenu.contextId);
    return contextVideo?.fingerprint
      ? [contextVideo.fingerprint]
      : selectedFingerprints;
  }, [contextMenu?.contextId, getById, selectedFingerprints, selection.size]);

  const selectedIdsRef = useRef(selection.selected);
  const selectedVideosRef = useRef(selectedVideos);
  selectedIdsRef.current = selection.selected;
  selectedVideosRef.current = selectedVideos;

  const handleNativeDragStart = useCallback(
    (nativeEvent, video) => {
      if (!video?.isElectronFile || !video?.fullPath) return;
      const electronAPI = window?.electronAPI;
      if (!electronAPI?.startFileDragSync) return;

      const selectedIds = selectedIdsRef.current;
      const isInSelection = selectedIds instanceof Set && selectedIds.has(video.id);
      const pool = isInSelection ? selectedVideosRef.current : [video];
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
    []
  );

  const previousMetadataSelectionKeyRef = useRef("");
  useEffect(() => {
    const previousKey = previousMetadataSelectionKeyRef.current;

    if (selection.size === 0) {
      previousMetadataSelectionKeyRef.current = "";
      setMetadataPanelOpen(false);
      setMetadataDismissedSelectionKey(null);
      return;
    }

    if (
      metadataSelectionKey !== previousKey &&
      metadataDismissedSelectionKey !== metadataSelectionKey
    ) {
      previousMetadataSelectionKeyRef.current = metadataSelectionKey;
      setMetadataDismissedSelectionKey(null);
      setMetadataPanelOpen(true);
      setMetadataPlacementRequest((previous) => ({
        revision: previous.revision + 1,
        anchorId: metadataAnchorId,
        avoidRect: null,
        reason: "selection-change",
      }));
    }
  }, [
    metadataAnchorId,
    metadataDismissedSelectionKey,
    metadataSelectionKey,
    selection.size,
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
    handleAddTags,
    handleRemoveTag,
    handleSetRating,
    handleClearRating,
    handleSetReviewState,
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

  const closeMetadataPanel = useCallback(() => {
    const activeElement =
      typeof document !== "undefined" ? document.activeElement : null;
    const restoreGalleryFocus = Boolean(
      activeElement?.closest?.(".metadata-panel")
    );
    setMetadataPanelOpen(false);
    setMetadataDismissedSelectionKey(metadataSelectionKey);
    if (restoreGalleryFocus) {
      const enqueue =
        typeof queueMicrotask === "function"
          ? queueMicrotask
          : (callback) => Promise.resolve().then(callback);
      enqueue(() =>
        scrollContainerRef.current?.focus?.({ preventScroll: true })
      );
    }
  }, [metadataSelectionKey]);

  const openMetadataPanel = useCallback(
    ({
      focusInput = false,
      anchorId = metadataAnchorId,
      avoidRect = null,
      reason = "explicit",
    } = {}) => {
      if (anchorId == null && selection.size === 0) return;
      setMetadataPanelOpen(true);
      setMetadataDismissedSelectionKey(null);
      setMetadataPlacementRequest((previous) => ({
        revision: previous.revision + 1,
        anchorId,
        avoidRect,
        reason,
      }));
      if (focusInput) {
        setMetadataFocusToken((token) => token + 1);
      }
    },
    [metadataAnchorId, selection.size]
  );

  const handleContextMenuPlacementChange = useCallback(
    (placement) => {
      lastContextMenuPlacementRef.current = placement || null;
      if (!placement?.rect || !isMetadataPanelOpen) return;
      setMetadataPlacementRequest((previous) => ({
        revision: previous.revision + 1,
        anchorId: metadataAnchorId,
        avoidRect: placement.rect,
        reason: "context-menu-placement",
      }));
    },
    [isMetadataPanelOpen, metadataAnchorId]
  );

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

  const invalidateMediaIds = useCallback(
    (paths = []) => {
      const ids = new Set(paths.filter(Boolean));
      if (!ids.size) return;

      for (const id of ids) mediaScheduler.releaseId(id);
      setLoadedVideos((previous) => removeManyFromSet(previous, ids));
      setLoadingVideos((previous) => removeManyFromSet(previous, ids));
      setActualPlaying((previous) => removeManyFromSet(previous, ids));
      if (fullScreenPinnedId && ids.has(fullScreenPinnedId)) {
        closeFullScreenRef.current?.();
      }
    },
    [fullScreenPinnedId, mediaScheduler]
  );

  const releaseManagedVideoHandlesForAsync = useCallback(
    async (paths) => {
      // The helper performs its first physical pause/detach synchronously
      // before yielding. Only then release scheduler authority and mirrors.
      const releasePromise = releaseVideoHandlesForAsync(paths);
      invalidateMediaIds(paths);
      await releasePromise;
    },
    [invalidateMediaIds]
  );

  const beginMediaMutation = useCallback(
    (paths) => mediaScheduler.blockIds(paths),
    [mediaScheduler]
  );
  const endMediaMutation = useCallback(
    (paths, movedPaths = []) => {
      mediaScheduler.discardIds(movedPaths);
      mediaScheduler.unblockIds(paths);
    },
    [mediaScheduler]
  );

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
    releaseVideoHandlesForAsync: releaseManagedVideoHandlesForAsync,
    beginMediaMutation,
    endMediaMutation,
    mediaScheduler,
    workSuspended,
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
        const contextId = contextMenu.contextId;
        const useContextTarget =
          contextId != null &&
          selection.size <= 1 &&
          !selection.selected.has(contextId);
        if (useContextTarget) {
          previousMetadataSelectionKeyRef.current = JSON.stringify([
            String(contextId),
          ]);
          selection.selectOnly(contextId);
        }
        const lastPlacement = lastContextMenuPlacementRef.current;
        openMetadataPanel({
          focusInput: true,
          anchorId:
            selection.size > 1
              ? metadataAnchorId
              : contextId ?? metadataAnchorId,
          avoidRect:
            lastPlacement?.contextId === contextId
              ? lastPlacement.rect
              : null,
          reason: "context-menu-open-details",
        });
        return;
      }
      if (actionId.startsWith("metadata:review:")) {
        const reviewState = actionId.replace("metadata:review:", "");
        if (contextMetadataFingerprints.length) {
          handleSetReviewState(reviewState, contextMetadataFingerprints);
        }
        return;
      }
      if (actionId.startsWith("metadata:rate:")) {
        if (!contextMetadataFingerprints.length) return;
        if (actionId === "metadata:rate:clear") {
          handleSetRating(null, contextMetadataFingerprints);
        } else {
          const value = parseInt(actionId.replace("metadata:rate:", ""), 10);
          if (!Number.isNaN(value)) {
            handleSetRating(value, contextMetadataFingerprints);
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
      metadataAnchorId,
      contextMetadataFingerprints,
      handleSetRating,
      handleSetReviewState,
      handleApplyExistingTag,
      runAction,
      selection.selectOnly,
      selection.size,
      selection.selected,
      contextMenu.contextId,
    ]
  );

  // fullscreen / context menu
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen,
  } = useFullScreenModal(displayVideos);
  closeFullScreenRef.current = closeFullScreen;

  const visibleAveragePixelArea = useMemo(() => {
    let total = 0;
    let count = 0;
    const candidateIds = visibleVideos.size
      ? visibleVideos
      : activationWindow.ids;
    for (const id of candidateIds) {
      const dimensions = videosById.get(id)?.dimensions;
      const width = Number(dimensions?.width);
      const height = Number(dimensions?.height);
      if (width > 0 && height > 0) {
        total += width * height;
        count += 1;
      }
    }
    return count ? total / count : 1280 * 720;
  }, [activationWindow.ids, videosById, visibleVideos]);

  const playbackDecision = useAdaptivePlaybackPolicy({
    mode: playbackMode,
    visibleCount: visibleVideos.size,
    telemetry: playbackTelemetry,
    capabilities: playbackCapabilities,
    averagePixelArea: visibleAveragePixelArea,
    suspended: workSuspended || Boolean(fullScreenVideo),
  });

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
    hoverAudioEnabled,
    mediaScheduler,
    playbackSuspended: Boolean(fullScreenVideo),
    workSuspended,
    playbackMode,
    decoderTarget: playbackDecision.target,
    selectedIds: selection.selected,
    centerPriorityIds,
    hoveredId: hoveredVideoId,
  });

  useEffect(() => {
    setFullScreenPinnedId(fullScreenVideo?.id ?? null);
  }, [fullScreenVideo?.id]);

  const collectionCallbacksRef = useRef(null);
  collectionCallbacksRef.current = {
    canLoadVideo: videoCollection.canLoadVideo,
    reserveLoadSlot: videoCollection.reserveLoadSlot,
    queueLoadSlot: videoCollection.queueLoadSlot,
    cancelQueuedLoadSlot: videoCollection.cancelQueuedLoadSlot,
    finishLoadSlot: videoCollection.finishLoadSlot,
    releaseMediaSlot: videoCollection.releaseMediaSlot,
    isCurrentMediaLease: videoCollection.isCurrentMediaLease,
    reportStarted: videoCollection.reportStarted,
    reportPlayError: videoCollection.reportPlayError,
    reportPaused: videoCollection.reportPaused,
    reportPlayerCreationFailure: videoCollection.reportPlayerCreationFailure,
    markHover: videoCollection.markHover,
    onCardHoverAudioStart: videoCollection.onCardHoverAudioStart,
    onCardHoverAudioEnd: videoCollection.onCardHoverAudioEnd,
    openFullScreen,
  };

  const handleCanLoadVideo = useCallback(
    (videoId, options) =>
      collectionCallbacksRef.current?.canLoadVideo?.(videoId, options) ?? false,
    []
  );
  const handleReserveLoadSlot = useCallback((videoId, options) => {
    return collectionCallbacksRef.current?.reserveLoadSlot?.(videoId, options) ?? null;
  }, []);
  const handleQueueLoadSlot = useCallback((videoId, options, onGranted) => {
    return collectionCallbacksRef.current?.queueLoadSlot?.(
      videoId,
      options,
      onGranted
    ) ?? null;
  }, []);
  const handleCancelQueuedLoadSlot = useCallback((waiterLease) => {
    return collectionCallbacksRef.current?.cancelQueuedLoadSlot?.(waiterLease) ?? false;
  }, []);
  const handleFinishLoadSlot = useCallback((lease, outcome) => {
    return collectionCallbacksRef.current?.finishLoadSlot?.(lease, outcome) ?? null;
  }, []);
  const handleReleaseMediaSlot = useCallback((lease) => {
    return collectionCallbacksRef.current?.releaseMediaSlot?.(lease) ?? false;
  }, []);
  const handleVideoPlay = useCallback((videoId, decoderLease) => {
    const accepted =
      collectionCallbacksRef.current?.reportStarted?.(videoId, decoderLease) ?? false;
    if (accepted) {
      setActualPlaying((prev) => updateSetMembership(prev, videoId, true));
    }
    return accepted;
  }, []);
  const handleVideoPause = useCallback((videoId, decoderLease) => {
    const accepted =
      collectionCallbacksRef.current?.reportPaused?.(videoId, decoderLease) ?? false;
    if (accepted) {
      setActualPlaying((prev) => updateSetMembership(prev, videoId, false));
    }
    return accepted;
  }, []);
  const handleVideoPlayError = useCallback((
    videoId,
    error,
    decoderLease,
    mediaLease
  ) => {
    const accepted = decoderLease
      ? collectionCallbacksRef.current?.reportPlayError?.(
          videoId,
          error,
          decoderLease
        ) ?? false
      : mediaLease
        ? collectionCallbacksRef.current?.isCurrentMediaLease?.(mediaLease) ?? false
        : true;
    if (!accepted) return false;
    setActualPlaying((prev) => updateSetMembership(prev, videoId, false));
    setLoadedVideos((prev) => updateSetMembership(prev, videoId, false));
    setLoadingVideos((prev) => updateSetMembership(prev, videoId, false));
    return true;
  }, []);
  const handlePlayerCreationFailure = useCallback(() => {
    collectionCallbacksRef.current?.reportPlayerCreationFailure?.();
  }, []);
  const handleVideoHover = useCallback((videoId) => {
    const nextId = videoId || null;
    hoveredVideoIdRef.current = nextId;
    setHoveredVideoId(nextId);
    collectionCallbacksRef.current?.markHover?.(nextId);
  }, []);
  const handleHoverAudioStart = useCallback((videoId) => {
    collectionCallbacksRef.current?.onCardHoverAudioStart?.(videoId);
  }, []);
  const handleHoverAudioEnd = useCallback((videoId) => {
    collectionCallbacksRef.current?.onCardHoverAudioEnd?.(videoId);
  }, []);
  const handleCloseFullScreen = useCallback(() => {
    closeFullScreen();
  }, [closeFullScreen]);

  // Hotkeys operate on current selection
  const runForHotkeys = useCallback(
    (actionId, currentSelection) =>
      runAction(actionId, currentSelection, contextMenu.contextId),
    [runAction, contextMenu.contextId]
  );
  const handleReviewHotkey = useCallback(
    (reviewState) =>
      handleSetReviewState(reviewState, selectedFingerprints),
    [handleSetReviewState, selectedFingerprints]
  );
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

  const handleVideoUnmount = useCallback((videoId) => {
      setVisibleVideos((prev) => updateSetMembership(prev, videoId, false));
      setLoadedVideos((prev) => updateSetMembership(prev, videoId, false));
      setLoadingVideos((prev) => updateSetMembership(prev, videoId, false));
      setActualPlaying((prev) => updateSetMembership(prev, videoId, false));
      if (hoveredVideoIdRef.current === videoId) {
        hoveredVideoIdRef.current = null;
        setHoveredVideoId(null);
        collectionCallbacksRef.current?.markHover?.(null);
      }
    }, []);

    const handleMediaInvalidated = useCallback((videoId) => {
      setLoadedVideos((prev) => updateSetMembership(prev, videoId, false));
      setLoadingVideos((prev) => updateSetMembership(prev, videoId, false));
      setActualPlaying((prev) => updateSetMembership(prev, videoId, false));
    }, []);

  const handleRecursiveChange = useCallback(async (nextValue) => {
    const next = Boolean(nextValue);
    if (next === recursiveMode) return;
    captureFolderViewState();
    setRecursiveMode(next);
    window.electronAPI?.saveSettingsPartial?.({
      recursiveMode: next,
      renderLimitStep,
      zoomLevel,
      showFilenames,
    });
    if (activeRootPath) {
      if (!next && currentDirectory) {
        folderViewStateRef.current.setLocation(
          activeRootPath,
          "",
          FolderScope.ALL_DESCENDANTS
        );
        setFolderLocation({
          rootPath: activeRootPath,
          directory: "",
          scope: FolderScope.ALL_DESCENDANTS,
        });
      }
      restoredFolderViewKeyRef.current = null;
      await reloadCurrentRoot?.(next);
    }
  }, [
    activeRootPath,
    captureFolderViewState,
    currentDirectory,
    recursiveMode,
    reloadCurrentRoot,
    renderLimitStep,
    showFilenames,
    zoomLevel,
  ]);

  const toggleRecursive = useCallback(() => {
    handleRecursiveChange(!recursiveMode);
  }, [handleRecursiveChange, recursiveMode]);

  const handleFolderNavigate = useCallback(
    async (relativePath) => {
      if (!activeRootPath) return;
      captureFolderViewState();
      const directory = normalizeRelativePath(relativePath);
      const nextScope =
        !directory
          ? FolderScope.ALL_DESCENDANTS
          : folderScope === FolderScope.ALL_DESCENDANTS
            ? FolderScope.CURRENT_FOLDER
            : folderScope;
      folderViewStateRef.current.setLocation(
        activeRootPath,
        directory,
        nextScope
      );
      restoredFolderViewKeyRef.current = null;
      setFolderLocation({
        rootPath: activeRootPath,
        directory,
        scope: nextScope,
      });
      setExpandedFolderPaths((previous) =>
        expandFolderAncestors(previous, directory)
      );

      if (directory && !recursiveMode) {
        await handleRecursiveChange(true);
      }
    },
    [
      activeRootPath,
      captureFolderViewState,
      folderScope,
      handleRecursiveChange,
      recursiveMode,
    ]
  );

  const handleFolderScopeChange = useCallback(
    (nextScope) => {
      if (!activeRootPath) return;
      captureFolderViewState();
      const normalizedScope = Object.values(FolderScope).includes(nextScope)
        ? nextScope
        : FolderScope.ALL_DESCENDANTS;
      folderViewStateRef.current.setLocation(
        activeRootPath,
        currentDirectory,
        normalizedScope
      );
      restoredFolderViewKeyRef.current = null;
      setFolderLocation({
        rootPath: activeRootPath,
        directory: currentDirectory,
        scope: normalizedScope,
      });
    },
    [activeRootPath, captureFolderViewState, currentDirectory]
  );

  const handleFolderExpandedToggle = useCallback((path, expanded) => {
    const normalized = normalizeRelativePath(path);
    setExpandedFolderPaths((previous) => {
      const next = new Set(previous);
      if (expanded) next.add(normalized);
      else next.delete(normalized);
      next.add("");
      return next;
    });
  }, []);

  const handlePreviousFolder = useCallback(
    (node) => handleFolderNavigate(node?.path),
    [handleFolderNavigate]
  );
  const handleNextFolder = useCallback(
    (node) => handleFolderNavigate(node?.path),
    [handleFolderNavigate]
  );

  const appHotkeysEnabled =
    !isHotkeyHelpOpen &&
    !isAboutOpen &&
    !isDataLocationOpen &&
    !profilePromptRequest &&
    !fullScreenVideo &&
    !contextMenu.visible &&
    !isFiltersOpen;

  useHotkeys(runForHotkeys, () => selection.selected, {
    enabled: appHotkeysEnabled,
    getZoomIndex: () => zoomLevel,
    setZoomIndexSafe: (z) => handleZoomChangeSafe(z),
    minZoomIndex: ZOOM_MIN_INDEX,
    maxZoomIndex: ZOOM_MAX_INDEX,
    onSetReviewState: handleReviewHotkey,
    onPreviousFolder:
      !isLoadingFolder && siblingFolders.previous
        ? () => handlePreviousFolder(siblingFolders.previous)
        : null,
    onNextFolder:
      !isLoadingFolder && siblingFolders.next
        ? () => handleNextFolder(siblingFolders.next)
        : null,
    onOpenDetails: () => openMetadataPanel(),
    onOpenHelp: () => setHotkeyHelpOpen(true),
  });

  const handleOpenLibraryRoot = useCallback(
    async (rootPath) => {
      if (!rootPath) return;
      try {
        const authorization =
          await window.electronAPI?.library?.authorizeRoot?.(rootPath);
        if (authorization?.success === false) {
          throw new Error(
            authorization.error || "Could not authorize library root"
          );
        }
        const authorizedRootPath = authorization?.rootPath || rootPath;
        captureFolderViewState();
        const saved = folderViewStateRef.current.getLocation(authorizedRootPath);
        setFolderLocation({
          rootPath: authorizedRootPath,
          directory: saved?.directory || "",
          scope: saved?.scope || FolderScope.ALL_DESCENDANTS,
        });
        setExpandedFolderPaths((previous) =>
          expandFolderAncestors(previous, saved?.directory || "")
        );
        restoredFolderViewKeyRef.current = null;
        await handleElectronFolderSelection(authorizedRootPath);
      } catch (error) {
        console.error("Failed to open library root:", error);
        notify("Could not open that library root", "error");
      }
    },
    [captureFolderViewState, handleElectronFolderSelection, notify]
  );

  const handleToggleLibraryPin = useCallback(
    async (rootPath, pinned) => {
      try {
        await setLibraryRootPinned(rootPath, pinned);
        notify(pinned ? "Pinned library root" : "Unpinned library root", "success");
      } catch (error) {
        console.error("Failed to update library pin:", error);
        notify("Failed to update library pin", "error");
      }
    },
    [notify, setLibraryRootPinned]
  );

  const handleSaveCurrentView = useCallback(
    async (name) => {
      const definition = {
        version: 1,
        filters: {
          includeTags: filters.includeTags || [],
          excludeTags: filters.excludeTags || [],
          minRating: filters.minRating ?? null,
          exactRating: filters.exactRating ?? null,
          reviewFilter: filters.reviewFilter || REVIEW_FILTERS.ANY,
        },
        sort: {
          key: sortKey,
          dir: sortDir,
          groupByFolders,
          randomSeed,
        },
        scope: { mode: folderScope },
      };
      try {
        const view = await createSavedView(name, definition);
        if (!view) throw new Error("Saved views are unavailable");
        notify(`Saved smart view “${view.name}”`, "success");
        return view;
      } catch (error) {
        console.error("Failed to save smart view:", error);
        notify(error?.message || "Failed to save smart view", "error");
        throw error;
      }
    }, [
      createSavedView,
      filters,
      folderScope,
      groupByFolders,
      notify,
      randomSeed,
      sortDir,
      sortKey,
    ]
  );

  const handleApplySavedView = useCallback(
    (view) => {
      const definition = view?.definition;
      if (!definition || definition.version !== 1) return;
      captureFolderViewState();
      updateFilters(definition.filters || {});
      setSortKey(definition.sort?.key || SortKey.NAME);
      setSortDir(definition.sort?.dir === "desc" ? "desc" : "asc");
      setGroupByFolders(definition.sort?.groupByFolders !== false);
      setRandomSeed(definition.sort?.randomSeed ?? null);
      selection.clear();
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;

      const nextScope = Object.values(FolderScope).includes(definition.scope?.mode)
        ? definition.scope.mode
        : FolderScope.ALL_DESCENDANTS;
      if (activeRootPath) {
        folderViewStateRef.current.setLocation(
          activeRootPath,
          currentDirectory,
          nextScope
        );
        restoredFolderViewKeyRef.current = makeFolderViewKey(
          activeRootPath,
          currentDirectory,
          nextScope
        );
        setFolderLocation({
          rootPath: activeRootPath,
          directory: currentDirectory,
          scope: nextScope,
        });
      }
      notify(`Applied smart view “${view.name}”`, "success");
    }, [
      activeRootPath,
      captureFolderViewState,
      currentDirectory,
      notify,
      selection.clear,
      updateFilters,
    ]
  );

  const handleDeleteSavedView = useCallback(
    async (id, view) => {
      try {
        const deleted = await deleteSavedView(id);
        if (deleted) notify(`Deleted smart view “${view?.name || "view"}”`, "success");
      } catch (error) {
        console.error("Failed to delete smart view:", error);
        notify(error?.message || "Failed to delete smart view", "error");
      }
    },
    [deleteSavedView, notify]
  );

  const handleChooseFolder = useCallback(async () => {
    captureFolderViewState();
    restoredFolderViewKeyRef.current = null;
    await handleFolderSelect();
  }, [captureFolderViewState, handleFolderSelect]);

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

  const toggleHoverAudio = useCallback(() => {
    setHoverAudioEnabled((prev) => !prev);
  }, []);

  const handlePlaybackModeChange = useCallback((value) => {
    const next = normalizePlaybackMode(value);
    setPlaybackMode(next);
    window.electronAPI?.saveSettingsPartial?.({ playbackMode: next });
  }, []);

  const toggleProxyPlayback = useCallback(() => {
    setProxyPlaybackEnabled((previous) => {
      const next = !previous;
      window.electronAPI?.saveSettingsPartial?.({
        proxyPlaybackEnabled: next,
      });
      return next;
    });
  }, []);

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

  const videoSelectStateRef = useRef(null);
  videoSelectStateRef.current = {
    getById,
    orderForRange,
    selectRange: selection.selectRange,
    toggle: selection.toggle,
    selectOnly: selection.selectOnly,
  };

  // Selection via clicks on cards (single / ctrl-multi / shift-range / double → fullscreen)
  const handleVideoSelect = useCallback(
    (videoId, isCtrlClick, isShiftClick, isDoubleClick) => {
      const current = videoSelectStateRef.current;
      const video = current?.getById?.(videoId);
      if (isDoubleClick && video) {
        setFullScreenPinnedId(video.id);
        collectionCallbacksRef.current?.openFullScreen?.(video);
        return;
      }
      if (isShiftClick) {
        current?.selectRange?.(
          current.orderForRange,
          videoId,
          /* additive */ isCtrlClick
        );
        return;
      }
      if (isCtrlClick) {
        current?.toggle?.(videoId);
      } else {
        current?.selectOnly?.(videoId);
      }
    },
    []
  );

  // Right-click on a card: open the item context menu without altering selection
  const handleCardContextMenu = useCallback(
    (e, video) => {
      if (!video?.id) return;
      lastContextMenuPlacementRef.current = null;
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
      if (
        e.key === "Escape" &&
        (isLoadingFolder || isRefreshingFolder)
      ) {
        cancelFolderLoad();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancelFolderLoad, isLoadingFolder, isRefreshingFolder]);

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

  const masonryGridStyle = useMemo(
    () => ({ height: `${Math.max(0, masonryTotalHeight)}px` }),
    [masonryTotalHeight]
  );

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
            status={loadingStatus}
            stage={loadingStage}
            progress={loadingProgress}
            memoryStatus={videoCollection.memoryStatus}
            playbackDecision={playbackDecision}
            playbackMode={playbackMode}
            playbackTelemetry={playbackTelemetry}
            workSuspensionReason={workSuspensionReason}
            onCancel={cancelFolderLoad}
          />

          <HeaderBar
            isLoadingFolder={isLoadingFolder}
            handleFolderSelect={handleChooseFolder}
            handleWebFileSelection={handleWebFileSelection}
            recursiveMode={recursiveMode}
            toggleRecursive={toggleRecursive}
            showFilenames={showFilenames}
            toggleFilenames={toggleFilenames}
            hoverAudioEnabled={hoverAudioEnabled}
            onHoverAudioToggle={toggleHoverAudio}
            playbackMode={playbackMode}
            onPlaybackModeChange={handlePlaybackModeChange}
            playbackDecision={playbackDecision}
            playbackCapabilityStatus={playbackCapabilityStatus}
            proxyPlaybackEnabled={proxyPlaybackEnabled}
            onProxyPlaybackToggle={toggleProxyPlayback}
            proxyPlaybackAvailable={playbackCapabilities.proxyAvailable}
            workSuspended={workSuspended}
            isRefreshingFolder={isRefreshingFolder}
            onHotkeyHelp={() => setHotkeyHelpOpen(true)}
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
            onRecentOpen={handleOpenLibraryRoot}
            hasOpenFolder={Boolean(activeRootPath) || videos.length > 0}
            onFiltersToggle={() => setFiltersOpen((open) => !open)}
            filtersActiveCount={filtersActiveCount}
            filtersAreOpen={isFiltersOpen}
            filtersButtonRef={filtersButtonRef}
          />

          {activeRootPath && (
            <CollectionNavigationBar
              breadcrumb={folderBreadcrumb}
              onBreadcrumbSelect={handleFolderNavigate}
              scope={folderScope}
              onScopeChange={handleFolderScopeChange}
              previousSibling={siblingFolders.previous}
              nextSibling={siblingFolders.next}
              onPreviousFolder={handlePreviousFolder}
              onNextFolder={handleNextFolder}
              recursive={recursiveMode}
              onRecursiveChange={handleRecursiveChange}
              sidebarOpen={isLibrarySidebarOpen}
              onSidebarToggle={setLibrarySidebarOpen}
              showFolderHeaders={showFolderHeaders}
              onFolderHeadersToggle={setShowFolderHeaders}
              folderHeadersAvailable={groupByFolders}
              matchingCount={scopedFilteredVideos.length}
              totalCount={videos.length}
              disabled={isLoadingFolder}
            />
          )}

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
          <KeyboardShortcutsDialog
            open={isHotkeyHelpOpen}
            onClose={() => setHotkeyHelpOpen(false)}
          />
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

              {reviewFilterSummary && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Review</span>
                  <div className="filters-summary__chips">
                    <button
                      type="button"
                      className="filters-summary__chip filters-summary__chip--review"
                      onClick={clearReviewFilter}
                      title="Clear review-state filter"
                    >
                      {reviewFilterSummary}
                      <span className="filters-summary__chip-remove">×</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <DebugSummary
            total={videoCollection.stats.total}
            rendered={virtualItems.length}
            playing={videoCollection.stats.playing}
            inView={visibleVideos.size}
            activeWindow={activationWindow.ids.length}
            activationTarget={activationWindow.target}
            progressiveVisible={videoCollection.stats.progressiveVisible}
            memoryStatus={videoCollection.memoryStatus}
            zoomLevel={zoomLevel}
            getMinimumZoomLevel={getMinimumZoomLevel}
            sortStatus={sortStatus}
            playbackDecision={playbackDecision}
            playbackMode={playbackMode}
            playbackTelemetry={playbackTelemetry}
            workSuspensionReason={workSuspensionReason}
          />

          {/* Home state: pinned library roots and recent locations */}
          {!activeRootPath && videos.length === 0 && !isLoadingFolder ? (
            <div className="library-home-workspace">
              {isLibrarySidebarOpen &&
                (pinnedRoots.length > 0 || savedViews.length > 0) && (
                <LibrarySidebar
                  tree={null}
                  pinnedRoots={pinnedRoots}
                  currentRoot={null}
                  onOpenRoot={handleOpenLibraryRoot}
                  onTogglePin={handleToggleLibraryPin}
                  savedViews={savedViews}
                  onApplySavedView={handleApplySavedView}
                  onSaveCurrentView={handleSaveCurrentView}
                  onDeleteSavedView={handleDeleteSavedView}
                  smartViewsEnabled={false}
                />
              )}
              <div className="library-home-content">
                <RecentFolders
                  items={recentFolders}
                  onOpen={handleOpenLibraryRoot}
                  onRemove={removeRecentFolder}
                  onClear={clearRecentFolders}
                />
                <div className="drop-zone">
                  <h2>🐝 Welcome to Video Swarm 🐝</h2>
                  <p>
                    Open a directory, or choose a pinned library root to continue reviewing.
                  </p>
                  <p>
                    Index subfolders to browse large generation runs as a tree while keeping the flattened swarm available.
                  </p>
                  {window.innerWidth > 2560 && (
                    <p style={{ color: "#ffa726", fontSize: "0.9rem" }}>
                      🖥️ Large display detected - zoom will auto-adjust for memory
                      safety
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="content-region" ref={contentRegionRef}>
              <div className="content-region__workspace">
                {activeRootPath && isLibrarySidebarOpen && (
                  <LibrarySidebar
                    tree={folderTree}
                    currentPath={currentDirectory}
                    expandedPaths={expandedFolderPaths}
                    onToggleExpanded={handleFolderExpandedToggle}
                    onSelectFolder={handleFolderNavigate}
                    pinnedRoots={pinnedRoots}
                    currentRoot={catalogCurrentRoot || libraryRoot}
                    onOpenRoot={handleOpenLibraryRoot}
                    onTogglePin={handleToggleLibraryPin}
                    savedViews={savedViews}
                    onApplySavedView={handleApplySavedView}
                    onSaveCurrentView={handleSaveCurrentView}
                    onDeleteSavedView={handleDeleteSavedView}
                    disabled={isLoadingFolder}
                  />
                )}

                <div className="content-region__gallery" ref={galleryRef}>
                  {activeRootPath &&
                    !isLibrarySidebarOpen &&
                    showFolderHeaders &&
                    groupByFolders && (
                      <FolderGroupHeaders
                        tree={folderTree}
                        currentPath={currentDirectory}
                        onSelectFolder={handleFolderNavigate}
                      />
                    )}

                  <div
                    className="content-region__viewport"
                    ref={attachScrollContainer}
                    role="region"
                    aria-label="Video gallery"
                    tabIndex={-1}
                  >
                    {orderedVideos.length === 0 && !isLoadingFolder && (
                      <div className="collection-empty-state" role="status">
                        <h3>
                          {videos.length === 0
                            ? "No videos in this collection"
                            : filteredVideos.length === 0
                            ? "No videos match the active filters"
                            : "No matching videos in this folder scope"}
                        </h3>
                        {activeRootPath && (
                          <p>{folderBreadcrumb.at(-1)?.fullPath || activeRootPath}</p>
                        )}
                      </div>
                    )}

                    <div
                      ref={attachGrid}
                      className={`video-grid masonry-vertical virtualized-masonry ${
                        !showFilenames ? "hide-filenames" : ""
                      } ${zoomClassForLevel(zoomLevel)}`}
                      style={masonryGridStyle}
                    >
                      {virtualItems.map((position) => {
                        const video = position.item;
                        return (
                          <div
                            key={position.id}
                            className="masonry-slot"
                            data-masonry-id={position.id}
                            style={position.style}
                          >
                            <VideoCard
                              video={video}
                              observeIntersection={ioRegistry.observe}
                              unobserveIntersection={ioRegistry.unobserve}
                              scrollRootRef={scrollContainerRef}
                              selected={selection.selected.has(video.id)}
                              onSelect={handleVideoSelect}
                              onContextMenu={handleCardContextMenu}
                              onNativeDragStart={handleNativeDragStart}
                              showFilenames={showFilenames}
                              canLoadVideo={handleCanLoadVideo}
                              reserveLoadSlot={handleReserveLoadSlot}
                              queueLoadSlot={handleQueueLoadSlot}
                              cancelQueuedLoadSlot={handleCancelQueuedLoadSlot}
                              finishLoadSlot={handleFinishLoadSlot}
                              releaseMediaSlot={handleReleaseMediaSlot}
                              decoderLease={videoCollection.getDecoderLease(video.id)}
                              isLoading={loadingVideos.has(video.id)}
                              isLoaded={loadedVideos.has(video.id)}
                              isVisible={visibleVideos.has(video.id)}
                              isPlaying={videoCollection.isVideoPlaying(video.id)}
                              playbackSuspended={Boolean(fullScreenVideo)}
                              workSuspended={workSuspended}
                              proxyPlaybackEnabled={proxyPlaybackEnabled}
                              isNear={ioRegistry.isNear}
                              onStartLoading={handleVideoStartLoading}
                              onStopLoading={handleVideoStopLoading}
                              onVideoLoad={handleVideoLoaded}
                              onVisibilityChange={handleVideoVisibilityChange}
                              onUnmount={handleVideoUnmount}
                              onMediaInvalidated={handleMediaInvalidated}
                              onVideoPlay={handleVideoPlay}
                              onVideoPause={handleVideoPause}
                              onPlayError={handleVideoPlayError}
                              reportPlayerCreationFailure={handlePlayerCreationFailure}
                              onHover={handleVideoHover}
                              hoverAudioEnabled={hoverAudioEnabled}
                              isHoverAudioActive={
                                hoverAudioEnabled &&
                                videoCollection.activeHoverAudioId === video.id
                              }
                              onHoverAudioStart={handleHoverAudioStart}
                              onHoverAudioEnd={handleHoverAudioEnd}
                              scheduleInit={scheduleInit}
                              registerMediaElement={registerMediaElement}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
              <MetadataPanel
                isOpen={isMetadataPanelOpen}
                onClose={closeMetadataPanel}
                selectionKey={metadataSelectionKey}
                anchorId={metadataPlacementRequest.anchorId ?? metadataAnchorId}
                resolveAnchorRect={resolveMetadataAnchorRect}
                resolveBoundsRect={resolveMetadataBoundsRect}
                resolveContainerRect={resolveMetadataContainerRect}
                placementRequest={metadataPlacementRequest}
                boundsVersion={`${isLibrarySidebarOpen}:${
                  activeRootPath || "home"
                }`}
                selectionCount={selection.size}
                selectedVideos={selectedVideos}
                availableTags={availableTags}
                onAddTag={handleAddTags}
                onRemoveTag={handleRemoveTag}
                onApplyTagToSelection={handleApplyExistingTag}
                onSetRating={handleSetRating}
                onClearRating={handleClearRating}
                onSetReviewState={handleSetReviewState}
                generationMetadataState={generationMetadataState}
                focusToken={metadataFocusToken}
                onFocusSelection={focusSelection}
              />
            </div>
          )}

          {fullScreenVideo && (
            <FullScreenModal
              video={fullScreenVideo}
              onClose={handleCloseFullScreen}
              onNavigate={navigateFullScreen}
              showFilenames={showFilenames}
              mediaScheduler={mediaScheduler}
              workSuspended={workSuspended}
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
              onPlacementChange={handleContextMenuPlacementChange}
            />
          )}
        </>
      )}
    </div>
  );
}

export default App;
