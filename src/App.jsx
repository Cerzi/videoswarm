// App.jsx
import React, {
  useState,
  useEffect,
  useLayoutEffect,
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
import WorkspaceSidebar from "./components/WorkspaceSidebar";
import DockedMetadataInspector from "./components/DockedMetadataInspector";
import FolderGroupHeaders from "./components/FolderGroupHeaders";
import DebugSummary from "./components/DebugSummary";
import AboutDialog from "./components/AboutDialog";
import DataLocationDialog from "./components/DataLocationDialog";
import ProfilePromptDialog from "./components/ProfilePromptDialog";
import KeyboardShortcutsDialog from "./components/KeyboardShortcutsDialog";
import ReviewToolbar from "./components/ReviewToolbar";
import ProcessReviewResultsDialog from "./components/ProcessReviewResultsDialog";
import TransferSelectionDialog from "./components/TransferSelectionDialog";
import {
  FullscreenDetailsDock,
  FullscreenHeaderActions,
  FullscreenHeaderContent,
  FullscreenProgressContent,
  FullscreenReviewRail,
} from "./components/fullscreen/FullscreenReviewPanels";

import { useFullScreenModal } from "./hooks/useFullScreenModal";
import { useVideoCollection } from "./hooks/video-collection";
import useRecentFolders from "./hooks/useRecentFolders";
import useInitGate from "./hooks/ui-perf/useInitGate";
import usePlaybackTelemetry from "./hooks/video-collection/usePlaybackTelemetry";
import useAdaptivePlaybackPolicy from "./hooks/video-collection/useAdaptivePlaybackPolicy";

import useSelectionState from "./hooks/selection/useSelectionState";
import { useContextMenu } from "./hooks/context-menu/useContextMenu";
import useActionDispatch from "./hooks/actions/useActionDispatch";
import { ActionIds, actionRegistry } from "./hooks/actions/actions";
import { releaseVideoHandlesForAsync } from "./utils/releaseVideoHandles";
import { updateSetMembership, removeManyFromSet } from "./utils/updateSetMembership";
import useTrashIntegration from "./hooks/actions/useTrashIntegration";
import useReviewWorkflow from "./hooks/review/useReviewWorkflow";
import useReviewSessions from "./hooks/review/useReviewSessions";

import { SortKey } from "./sorting/sorting.js";
import { parseSortValue, formatSortValue } from "./sorting/sortOption.js";

import { zoomClassForLevel, clampZoomIndex } from "./zoom/utils.js";
import useHotkeys from "./hooks/selection/useHotkeys";
import { ZOOM_MIN_INDEX, ZOOM_MAX_INDEX } from "./zoom/config";
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
import {
  REVIEW_FILTERS,
  REVIEW_STATES,
  normalizeReviewState,
} from "./review/reviewState";
import {
  FULLSCREEN_COMMANDS,
  resolveFullscreenShortcut,
} from "./hotkeys/shortcutCatalog";
import {
  buildReviewCheckpointDraft,
  checkpointLocationMatches,
  createReviewCheckpointSignature,
  normalizeReviewCheckpoint,
  requiresRecursiveReviewCoverage,
  resolveContinueReviewCandidate,
  resolveReviewCheckpointLocation,
} from "./review/continueReview";

const createIdleReviewResume = (token = 0) => ({
  token,
  phase: "idle",
  intent: null,
  rootPath: null,
  scanId: null,
  checkpoint: null,
  candidateId: null,
  candidateName: null,
  candidateIndex: -1,
  fallbackDirectory: null,
  message: "",
  explicitFocus: false,
});

const formatSessionSavedAt = (value) => {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formatCheckpointScopeLabel = (checkpoint, rootLabel) => {
  const directory = checkpoint?.directory || rootLabel || "Library root";
  if (checkpoint?.scope === FolderScope.CURRENT_FOLDER) {
    return `Current folder: ${directory}`;
  }
  if (checkpoint?.scope === FolderScope.CURRENT_SUBTREE) {
    return `Current subtree: ${directory}`;
  }
  return `All descendants of ${rootLabel || "the library root"}`;
};

const getKnownRemainingUnreviewed = (root) => {
  if (root?.presentCount == null || root?.reviewedCount == null) return null;
  const present = Number(root.presentCount);
  const reviewed = Number(root.reviewedCount);
  if (!Number.isFinite(present) || !Number.isFinite(reviewed)) return null;
  return Math.max(0, Math.floor(present - reviewed));
};

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
  const [reviewAutoAdvance, setReviewAutoAdvance] = useState(false);
  const [reviewModeEnabled, setReviewModeEnabled] = useState(true);
  const [fullscreenDetailsOpen, setFullscreenDetailsOpen] = useState(true);
  const [fullscreenAudioEnabled, setFullscreenAudioEnabled] = useState(false);
  const [metadataInspectorMode, setMetadataInspectorMode] = useState("floating");
  const [workspaceSidebarTab, setWorkspaceSidebarTab] = useState("library");
  const [metadataGenerationExpanded, setMetadataGenerationExpanded] =
    useState(true);
  const [fullscreenGenerationExpanded, setFullscreenGenerationExpanded] =
    useState(true);
  const [hoveredVideoId, setHoveredVideoId] = useState(null);
  const hoveredVideoIdRef = useRef(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [sortKey, setSortKey] = useState(SortKey.NAME);
  const [sortDir, setSortDir] = useState("asc");
  const [groupByFolders, setGroupByFolders] = useState(true);
  const [randomSeed, setRandomSeed] = useState(null);
  const [isAboutOpen, setAboutOpen] = useState(false);
  const [isDataLocationOpen, setDataLocationOpen] = useState(false);
  const [isHotkeyHelpOpen, setHotkeyHelpOpen] = useState(false);
  const [isProcessResultsOpen, setProcessResultsOpen] = useState(false);
  const [acceptedCopyProgress, setAcceptedCopyProgress] = useState(null);
  const [trashProgress, setTrashProgress] = useState(null);
  const [transferLayout, setTransferLayout] = useState("structured");
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferSelection, setTransferSelection] = useState([]);
  const [libraryTags, setLibraryTags] = useState([]);
  const [tagRefreshToken, setTagRefreshToken] = useState(0);
  const [fullscreenTransientSurface, setFullscreenTransientSurface] =
    useState(null);
  const [fullscreenCanUndo, setFullscreenCanUndo] = useState(false);
  const [profilePromptRequest, setProfilePromptRequest] = useState(null);
  const [profilePromptValue, setProfilePromptValue] = useState("");
  const [reviewProfileEpoch, setReviewProfileEpoch] = useState(0);
  const [webCollectionEpoch, setWebCollectionEpoch] = useState(0);
  const [reviewResume, setReviewResume] = useState(() =>
    createIdleReviewResume()
  );
  const reviewResumeRef = useRef(reviewResume);
  const reviewResumeTokenRef = useRef(0);
  const libraryOpenRequestRef = useRef(0);
  const reviewFocusFramesRef = useRef([]);
  const activeRootPathRef = useRef(null);
  const reviewViewStateRef = useRef(null);
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
    return beforeExternalFolderSelectionRef.current?.();
  }, []);
  const handleBeforeFileRemoved = useCallback((filePath) => {
    if (!Object.is(fullScreenActiveIdRef.current, filePath)) return;
    fullScreenSourceRemovedRef.current?.(filePath);
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
  const fullScreenPlayerRef = useRef(null);
  const fullScreenActiveIdRef = useRef(null);
  const fullScreenSourceRemovedRef = useRef(() => null);
  const fullScreenControllerRef = useRef(null);
  const fullScreenUndoTargetRef = useRef(null);
  const fullOrderedVideosRef = useRef([]);
  const fullScreenFocusFrameRef = useRef(null);
  const cancelFullScreenFocus = useCallback(() => {
    if (
      fullScreenFocusFrameRef.current != null &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(fullScreenFocusFrameRef.current);
    }
    fullScreenFocusFrameRef.current = null;
  }, []);
  useEffect(() => cancelFullScreenFocus, [cancelFullScreenFocus]);
  const resetMediaSchedulerForCollection = useCallback(() => {
    closeFullScreenRef.current?.();
    mediaScheduler.reset();
  }, [mediaScheduler]);

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

  const applyMetadataInspectorModeFromSettings = useCallback((value) => {
    const next = value === "docked" ? "docked" : "floating";
    setMetadataInspectorMode(next);
    if (next === "docked") {
      setWorkspaceSidebarTab("details");
      setLibrarySidebarOpen(true);
      setMetadataPanelOpen(false);
    }
  }, []);

  const {
    videos,
    setVideos,
    activeRootPath,
    libraryRoot,
    tagCollection,
    openTagCollection,
    directorySummaries,
    isLoadingFolder,
    isRefreshingFolder,
    activeScanId,
    cachedHydration,
    cachedHydrationComplete,
    loadingStatus,
    loadingStage,
    loadingProgress,
    settingsLoaded,
    cancelFolderLoad,
    prioritizeActiveDirectoryScan,
    promoteCachedPreview,
    handleElectronFolderSelection,
    reloadCurrentRoot,
    handleFolderSelect,
    handleWebFileSelection,
  } = useElectronFolderLifecycle({
    selection,
    recursiveMode,
    setRecursiveMode,
    setShowFilenames,
    setHoverAudioEnabled,
    setSortKey,
    setSortDir,
    groupByFolders,
    setGroupByFolders,
    setRandomSeed,
    setPlaybackMode,
    setProxyPlaybackEnabled,
    setReviewAutoAdvance,
    setReviewModeEnabled,
    setFullscreenDetailsOpen,
    setFullscreenAudioEnabled,
    setTransferLayout,
    setMetadataInspectorMode: applyMetadataInspectorModeFromSettings,
    setZoomLevelFromSettings: (value) =>
      applyZoomFromSettingsRef.current?.(value),
    setVisibleVideos,
    setLoadedVideos,
    setLoadingVideos,
    setActualPlaying,
    resetMediaScheduler: resetMediaSchedulerForCollection,
    resetThumbnailGeneration: thumbService.resetGeneration,
    refreshTagList: invokeRefreshTagList,
    addRecentFolder,
    beforeExternalFolderSelection: handleBeforeExternalFolderSelection,
    beforeFileRemoved: handleBeforeFileRemoved,
  });

  const {
    roots: catalogRoots,
    pinnedRoots,
    currentRoot: catalogCurrentRoot,
    directories: catalogDirectories,
    refreshRoots: refreshLibraryRoots,
    refreshTree: refreshLibraryTree,
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
  activeRootPathRef.current = activeRootPath;

  useEffect(() => {
    reviewResumeRef.current = reviewResume;
  }, [reviewResume]);

  useEffect(() => {
    setProcessResultsOpen(false);
    setAcceptedCopyProgress(null);
    setTrashProgress(null);
  }, [activeRootPath]);

  useEffect(() => {
    const subscribe = window.electronAPI?.review?.copyAccepted?.onProgress;
    if (typeof subscribe !== "function") return undefined;
    return subscribe((progress) => {
      if (!progress || typeof progress !== "object") return;
      setAcceptedCopyProgress(progress);
    });
  }, []);

  useEffect(() => {
    const subscribe = window.electronAPI?.onTrashProgress;
    if (typeof subscribe !== "function") return undefined;
    return subscribe((progress) => {
      if (!progress || typeof progress !== "object") return;
      setTrashProgress((previous) => {
        // A late event from a superseded operation must not reopen or rewind
        // the bar for the run the user is actually watching.
        const incoming = Number(progress.operationId) || 0;
        if (previous && incoming < (Number(previous.operationId) || 0)) {
          return previous;
        }
        return progress;
      });
    });
  }, []);

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
  reviewViewStateRef.current = {
    filters,
    sortKey,
    sortDir,
    groupByFolders,
    randomSeed,
  };

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
      tagCollection,
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

  // Review progress and result processing follow navigation scope, not the
  // transient tag/rating/review filters applied to the visible grid.
  const reviewScopeVideos = useMemo(
    () =>
      filterVideosByFolderScope(videos, {
        scope: folderScope,
        currentDirectory,
      }),
    [currentDirectory, folderScope, videos]
  );
  const reviewScopeLabel = useMemo(() => {
    const location = currentDirectory
      ? `${rootDisplayName} / ${currentDirectory}`
      : rootDisplayName;
    if (folderScope === FolderScope.CURRENT_FOLDER) {
      return `Current folder: ${location}`;
    }
    if (folderScope === FolderScope.CURRENT_SUBTREE) {
      return `Current subtree: ${location}`;
    }
    return `All descendants of ${rootDisplayName}`;
  }, [currentDirectory, folderScope, rootDisplayName]);
  const reviewScopeHasAuthoritativeCoverage = Boolean(libraryRoot?.recursive) || (
    folderScope === FolderScope.CURRENT_FOLDER && !currentDirectory
  );
  const reviewProcessingReady = Boolean(
    activeRootPath &&
      !isLoadingFolder &&
      !isRefreshingFolder &&
      loadingStatus?.phase === "complete" &&
      (!libraryRoot?.refreshState || libraryRoot.refreshState === "idle") &&
      reviewScopeHasAuthoritativeCoverage
  );
  const reviewProcessingReason = isRefreshingFolder
    ? "Wait for the indexed folder refresh to finish."
    : isLoadingFolder
      ? "Wait for folder loading to finish."
      : loadingStatus?.phase !== "complete"
        ? "Complete an authoritative folder scan before processing results."
        : !reviewScopeHasAuthoritativeCoverage
          ? "Choose Current folder, or enable subfolder indexing, before processing results."
        : "Review results are not ready for this folder scope.";

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
      [REVIEW_FILTERS.PICK]: "Accepted",
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
      ["restoring", "waiting-cache", "waiting-target", "provisional"].includes(
        reviewResume.phase
      ) ||
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
    closeFullScreenRef.current?.();
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
    reviewResume.phase,
  ]);

  useEffect(() => {
    const subscribe = window.electronAPI?.profiles?.onChanged;
    if (!subscribe) return undefined;
    return subscribe(() => {
      closeFullScreenRef.current?.();
      reviewResumeTokenRef.current += 1;
      libraryOpenRequestRef.current += 1;
      if (typeof cancelAnimationFrame === "function") {
        reviewFocusFramesRef.current.forEach((frame) =>
          cancelAnimationFrame(frame)
        );
      }
      reviewFocusFramesRef.current = [];
      setReviewResume(createIdleReviewResume(reviewResumeTokenRef.current));
      folderViewStateRef.current.clear();
      restoredFolderViewKeyRef.current = null;
      setExpandedFolderPaths(new Set([""]));
      setReviewProfileEpoch((epoch) => epoch + 1);
    });
  }, []);

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
  });
  fullOrderedVideosRef.current = orderedVideos;

  const effectiveProgressiveCap = useMemo(() => {
    if (
      !Number.isFinite(progressiveMaxVisibleNumber) ||
      progressiveMaxVisibleNumber <= 0
    ) {
      return undefined;
    }
    return Math.floor(progressiveMaxVisibleNumber);
  }, [progressiveMaxVisibleNumber]);

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
      promoteCachedPreview(activeScanId);
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
    promoteCachedPreview,
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

    // Fullscreen owns its own Details dock. Keep the floating grid inspector
    // dismissed for the loupe's active selection so it cannot reappear over
    // the card as soon as fullscreen closes.
    if (fullScreenActiveIdRef.current != null) {
      previousMetadataSelectionKeyRef.current = metadataSelectionKey;
      setMetadataPanelOpen(false);
      setMetadataDismissedSelectionKey(metadataSelectionKey);
      return;
    }

    if (metadataInspectorMode === "docked") {
      previousMetadataSelectionKeyRef.current = metadataSelectionKey;
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
    metadataInspectorMode,
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
    el.setAttribute("role", type === "error" ? "alert" : "status");
    el.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
    el.setAttribute("aria-atomic", "true");
    el.textContent = `${icons[type] || icons.info} ${message}`;
    document.body.appendChild(el);
    setTimeout(() => {
      if (document.body.contains(el)) document.body.removeChild(el);
    }, 3000);
  }, []);

  const reviewOwnershipKey = useMemo(
    () => JSON.stringify([
      reviewProfileEpoch,
      activeRootPath
        ? `root:${activeRootPath}`
        : tagCollection
          // Includes the load stamp so a refresh is a new collection and any
          // per-clip work owned by the previous snapshot is discarded.
          ? `tags:${tagCollection.tags.join("\u0000")}:${tagCollection.loadedAt}`
          : `web:${webCollectionEpoch}`,
      currentDirectory,
      folderScope,
    ]),
    [
      activeRootPath,
      currentDirectory,
      folderScope,
      reviewProfileEpoch,
      webCollectionEpoch,
    ]
  );

  const {
    handleAddTags: applyAddTags,
    handleRemoveTag: applyRemoveTag,
    handleSetRating,
    handleSetReviewState,
    handleRestoreReviewMetadata,
    handleApplyExistingTag: applyExistingTag,
    refreshTagList,
  } = useMetadataActions({
    selectedFingerprints,
    setVideos,
    setAvailableTags,
    notify,
    ownershipKey: reviewOwnershipKey,
  });

  // Tag membership is what a tag view and the tag catalog are made of, so every
  // successful tag mutation invalidates both. Wrapping here keeps every existing
  // call site unchanged.
  const markTagsChanged = useCallback(
    () => setTagRefreshToken((token) => token + 1),
    []
  );
  const handleAddTags = useCallback(
    async (...args) => {
      const result = await applyAddTags(...args);
      markTagsChanged();
      return result;
    },
    [applyAddTags, markTagsChanged]
  );
  const handleRemoveTag = useCallback(
    async (...args) => {
      const result = await applyRemoveTag(...args);
      markTagsChanged();
      return result;
    },
    [applyRemoveTag, markTagsChanged]
  );
  const handleApplyExistingTag = useCallback(
    async (...args) => {
      const result = await applyExistingTag(...args);
      markTagsChanged();
      return result;
    },
    [applyExistingTag, markTagsChanged]
  );

  const reviewSessions = useReviewSessions({
    activeRootPath,
    activeDirectory: currentDirectory,
    activeScope: folderScope,
    notify,
  });

  const buildActiveReviewCheckpoint = useCallback(
    ({ anchor, rootPath = activeRootPath, directory = currentDirectory,
      scope = folderScope, view = null } = {}) => {
      if (!rootPath) return null;
      const selectedAnchor =
        anchor === undefined
          ? metadataAnchorId == null
            ? null
            : allVideosById.get(metadataAnchorId)
          : anchor;
      return buildReviewCheckpointDraft({
        rootPath,
        directory,
        scope,
        view: view || {
          version: 1,
          filters,
          sort: {
            key: sortKey,
            dir: sortDir,
            groupByFolders,
            randomSeed:
              sortKey === SortKey.RANDOM ? randomSeed ?? 0 : null,
          },
        },
        anchor: selectedAnchor
          ? {
              instanceId: selectedAnchor.instanceId,
              fingerprint: selectedAnchor.fingerprint,
            }
          : null,
      });
    },
    [
      activeRootPath,
      allVideosById,
      currentDirectory,
      filters,
      folderScope,
      groupByFolders,
      metadataAnchorId,
      randomSeed,
      sortDir,
      sortKey,
    ]
  );

  const fullscreenCollectionOwnerKey = reviewOwnershipKey;
  const handleReviewMutationCommitted = useCallback(
    async (event) => {
      if (!event || event.ownershipKey !== reviewOwnershipKey) return;
      const hasExistingCheckpoint = reviewSessions.hasCheckpoint(activeRootPath);
      if (hasExistingCheckpoint && !reviewSessions.isEngaged) {
        refreshLibraryRoots();
        if (activeRootPath) refreshLibraryTree(activeRootPath);
        return;
      }
      const anchor = event.anchor || null;
      const draft = buildActiveReviewCheckpoint({ anchor });
      if (!draft) return;
      try {
        await reviewSessions.saveNow(draft, {
          allowCreate: event.allowCreateSession === true,
          engage: event.allowCreateSession === true,
          signature: createReviewCheckpointSignature(draft),
        });
      } catch (error) {
        console.warn("Review metadata was saved, but its session cursor was not:", error);
      } finally {
        refreshLibraryRoots();
        if (activeRootPath) refreshLibraryTree(activeRootPath);
      }
    },
    [
      activeRootPath,
      buildActiveReviewCheckpoint,
      refreshLibraryRoots,
      refreshLibraryTree,
      reviewOwnershipKey,
      reviewSessions.hasCheckpoint,
      reviewSessions.isEngaged,
      reviewSessions.saveNow,
    ]
  );
  const reviewWorkflow = useReviewWorkflow({
    scopeVideos: reviewScopeVideos,
    orderedVideoIds: orderForRange,
    selectedIds: selection.selected,
    selectExactly: selection.selectExactly,
    setSelectedIds: selection.setSelectedIds,
    scrollToId,
    ownershipKey: reviewOwnershipKey,
    setReviewState: handleSetReviewState,
    setRating: handleSetRating,
    restoreReviewMetadata: handleRestoreReviewMetadata,
    autoAdvance: reviewAutoAdvance,
    notify,
    onMutationCommitted: handleReviewMutationCommitted,
  });

  useLayoutEffect(() => {
    if (
      !reviewSessions.isEngaged ||
      !activeRootPath ||
      reviewSessions.saving ||
      !["idle", "active"].includes(reviewResume.phase)
    ) {
      return;
    }
    const draft = buildActiveReviewCheckpoint();
    if (!draft) return;
    reviewSessions.schedule(draft, {
      signature: createReviewCheckpointSignature(draft),
    });
  }, [
    activeRootPath,
    buildActiveReviewCheckpoint,
    reviewResume.phase,
    reviewSessions.isEngaged,
    reviewSessions.saving,
    reviewSessions.schedule,
  ]);

  const cancelReviewFocus = useCallback(() => {
    if (typeof cancelAnimationFrame === "function") {
      reviewFocusFramesRef.current.forEach((frame) =>
        cancelAnimationFrame(frame)
      );
    }
    reviewFocusFramesRef.current = [];
  }, []);

  const cancelReviewResume = useCallback(() => {
    reviewResumeTokenRef.current += 1;
    cancelReviewFocus();
    setReviewResume(createIdleReviewResume(reviewResumeTokenRef.current));
  }, [cancelReviewFocus]);

  beforeExternalFolderSelectionRef.current = async () => {
    closeFullScreenRef.current?.();
    libraryOpenRequestRef.current += 1;
    await reviewSessions.flush();
    cancelReviewResume();
    captureFolderViewState();
  };

  const handleWebDirectorySelection = useCallback(
    async (event) => {
      const files = event?.target?.files;
      closeFullScreenRef.current?.();
      setWebCollectionEpoch((epoch) => epoch + 1);
      libraryOpenRequestRef.current += 1;
      await reviewSessions.flush();
      cancelReviewResume();
      captureFolderViewState();
      return handleWebFileSelection({ target: { files } });
    },
    [
      cancelReviewResume,
      captureFolderViewState,
      handleWebFileSelection,
      reviewSessions.flush,
    ]
  );

  const focusReviewTarget = useCallback(
    (videoId, token, onMounted, onMissing) => {
      if (videoId == null || typeof requestAnimationFrame !== "function") {
        return false;
      }
      cancelReviewFocus();
      scrollToId(videoId, { align: "center" });
      let attemptsRemaining = 60;
      const attempt = () => {
        reviewFocusFramesRef.current = [];
        if (reviewResumeTokenRef.current !== token) return;
        const cards = gridRef.current?.querySelectorAll?.(
          ".video-item[data-video-id]"
        );
        const card = Array.from(cards || []).find(
          (entry) => entry.dataset?.videoId === String(videoId)
        );
        if (card) {
          card.focus?.({ preventScroll: true });
          onMounted?.();
          return;
        }
        attemptsRemaining -= 1;
        if (attemptsRemaining <= 0) {
          onMissing?.();
          return;
        }
        const frame = requestAnimationFrame(attempt);
        reviewFocusFramesRef.current = [frame];
      };
      const frame = requestAnimationFrame(attempt);
      reviewFocusFramesRef.current = [frame];
      return true;
    },
    [cancelReviewFocus, scrollToId]
  );

  useEffect(
    () => () => {
      reviewResumeTokenRef.current += 1;
      cancelReviewFocus();
    },
    [cancelReviewFocus]
  );

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
      if (metadataInspectorMode === "docked") {
        setLibrarySidebarOpen(true);
        setWorkspaceSidebarTab("details");
        setMetadataPanelOpen(false);
        setMetadataDismissedSelectionKey(null);
        if (focusInput) {
          setMetadataFocusToken((token) => token + 1);
        }
        return;
      }
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
    [metadataAnchorId, metadataInspectorMode, selection.size]
  );

  const handleDockMetadataPanel = useCallback(() => {
    setMetadataInspectorMode("docked");
    setMetadataPanelOpen(false);
    setMetadataDismissedSelectionKey(null);
    setLibrarySidebarOpen(true);
    setWorkspaceSidebarTab("details");
    window.electronAPI?.saveSettingsPartial?.({
      metadataInspectorMode: "docked",
    });
  }, []);

  const handleUndockMetadataPanel = useCallback(() => {
    setMetadataInspectorMode("floating");
    setWorkspaceSidebarTab("library");
    setMetadataDismissedSelectionKey(null);
    if (selection.size > 0) {
      setMetadataPanelOpen(true);
      setMetadataPlacementRequest((previous) => ({
        revision: previous.revision + 1,
        anchorId: metadataAnchorId,
        avoidRect: null,
        reason: "undock",
      }));
    }
    window.electronAPI?.saveSettingsPartial?.({
      metadataInspectorMode: "floating",
    });
  }, [metadataAnchorId, selection.size]);

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
      if (
        fullScreenActiveIdRef.current != null &&
        ids.has(fullScreenActiveIdRef.current)
      ) {
        fullScreenSourceRemovedRef.current?.(fullScreenActiveIdRef.current);
      }
    },
    [mediaScheduler]
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

  const handleRequestTransfer = useCallback((videos) => {
    setTransferSelection(Array.isArray(videos) ? videos : []);
    setTransferDialogOpen(true);
  }, []);

  const deps = useTrashIntegration({
    electronAPI: window.electronAPI,
    notify,
    onRequestTransfer: handleRequestTransfer,
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

  const { runAction, runActionForVideos } = useActionDispatch(deps, getById);

  const handleTrashReviewRejects = useCallback(
    async (rejectVideos) => {
      const executor = actionRegistry[ActionIds.MOVE_TO_TRASH];
      if (typeof executor !== "function") {
        throw new Error("Trash action is unavailable");
      }
      await executor(rejectVideos, deps);
    },
    [deps]
  );

  const handlePrepareAcceptedCopy = useCallback(
    async (destinationPath = null, layout = "structured", reusePlanId = null) => {
      const prepare = window.electronAPI?.review?.copyAccepted?.prepare;
      if (typeof prepare !== "function") {
        throw new Error("Copy Accepted is unavailable");
      }
      setAcceptedCopyProgress(null);
      const result = await prepare({
        rootPath: activeRootPath,
        directory: currentDirectory,
        scope: folderScope,
        destinationPath:
          typeof destinationPath === "string" ? destinationPath : null,
        layout: layout === "flat" ? "flat" : "structured",
        reusePlanId: typeof reusePlanId === "string" ? reusePlanId : null,
      });
      if (result?.success === false) {
        throw new Error(result.error || "Accepted-copy preflight failed");
      }
      return result;
    },
    [activeRootPath, currentDirectory, folderScope]
  );

  const handleTransferLayoutChange = useCallback((value) => {
    const next = value === "flat" ? "flat" : "structured";
    setTransferLayout(next);
    window.electronAPI?.saveSettingsPartial?.({ transferLayout: next });
  }, []);

  // The packaged extractor reads the source file directly, so it yields the
  // frame at full source resolution rather than whatever the player decoded to
  // fit the window. The canvas path is the fallback for web clips and for
  // systems without a usable ffmpeg.
  const handleCopyFullscreenFrame = useCallback(
    async ({ video, atSeconds, captureCanvasFrame }) => {
      const electronAPI = window.electronAPI;
      if (video?.isElectronFile && video?.fullPath && electronAPI?.copyFrameAtTime) {
        try {
          const result = await electronAPI.copyFrameAtTime(
            video.fullPath,
            atSeconds
          );
          if (result?.success) {
            notify("Frame copied to clipboard", "success");
            return true;
          }
        } catch (error) {
          console.warn("[frame] Native frame copy failed", error);
        }
      }

      try {
        const captured = await captureCanvasFrame?.();
        if (!captured) throw new Error("No frame is available to copy");
        if (electronAPI?.copyImageToClipboard) {
          const result = await electronAPI.copyImageToClipboard(captured.dataUrl);
          if (result?.success === false) {
            throw new Error(result?.error || "Clipboard copy failed");
          }
        } else if (navigator?.clipboard?.write && window?.ClipboardItem) {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": captured.blob }),
          ]);
        } else {
          throw new Error("Clipboard image copy is not supported");
        }
        notify("Frame copied to clipboard", "success");
        return true;
      } catch (error) {
        console.error("Failed to copy frame:", error);
        notify("Failed to copy the frame", "error");
        return false;
      }
    },
    [notify]
  );

  const handlePrepareSelectionTransfer = useCallback(
    async ({ instanceIds, destinationPath, layout, reusePlanId }) => {
      const prepare = window.electronAPI?.review?.copyAccepted?.prepare;
      if (typeof prepare !== "function") {
        throw new Error("Transfers are unavailable");
      }
      setAcceptedCopyProgress(null);
      const result = await prepare({
        // Omitted on purpose: a selection can span roots, or come from a
        // rootless tag view, so the host derives the roots from the rows.
        rootPath: null,
        directory: "",
        scope: "all-descendants",
        instanceIds,
        destinationPath:
          typeof destinationPath === "string" ? destinationPath : null,
        layout: layout === "flat" ? "flat" : "structured",
        reusePlanId: typeof reusePlanId === "string" ? reusePlanId : null,
      });
      if (result?.success === false) {
        throw new Error(result.error || "The transfer could not be prepared");
      }
      return result;
    },
    []
  );

  // A tag view is a snapshot, not a watched collection: watching every root a
  // tag can span is exactly the cost the bounded watcher design avoids. It is
  // re-read on open, on explicit refresh, and after an in-app tag edit, because
  // otherwise untagging a clip would leave it sitting in a view defined by that
  // tag.
  const loadTagCollection = useCallback(
    async (tags) => {
      const requested = (Array.isArray(tags) ? tags : [])
        .map((tag) => (tag ?? "").toString().trim())
        .filter(Boolean);
      if (!requested.length) return false;
      const snapshot = window.electronAPI?.library?.taggedSnapshot;
      if (typeof snapshot !== "function") {
        notify("Tag views are unavailable", "error");
        return false;
      }
      try {
        const result = await snapshot(requested);
        const records = Array.isArray(result?.records) ? result.records : [];
        openTagCollection({
          tags: requested,
          records,
          truncated: Boolean(result?.truncated),
        });
        if (result?.truncated) {
          notify(
            `Showing the first ${Number(
              result.recordLimit || records.length
            ).toLocaleString()} tagged clips`,
            "info"
          );
        } else if (!records.length) {
          notify("No clips carry that tag", "info");
        }
        return true;
      } catch (error) {
        console.error("Failed to load tag view:", error);
        notify("Could not load the tag view", "error");
        return false;
      }
    },
    [notify, openTagCollection]
  );

  const refreshTagCollection = useCallback(() => {
    if (!tagCollection?.tags?.length) return false;
    return loadTagCollection(tagCollection.tags);
  }, [loadTagCollection, tagCollection]);

  const handleListLibraryTags = useCallback(async () => {
    const list = window.electronAPI?.library?.listTags;
    if (typeof list !== "function") return [];
    try {
      const result = await list();
      return Array.isArray(result?.tags) ? result.tags : [];
    } catch (error) {
      console.error("Failed to list tags:", error);
      return [];
    }
  }, []);

  const refreshTagCatalog = useCallback(async () => {
    setLibraryTags(await handleListLibraryTags());
  }, [handleListLibraryTags]);

  // The catalog is what the sidebar offers, so it has to track tag edits and
  // profile changes. An open tag view re-reads too, since untagging a visible
  // clip should remove it rather than leave it in a view it no longer matches.
  useEffect(() => {
    refreshTagCatalog();
  }, [refreshTagCatalog, reviewProfileEpoch, tagRefreshToken]);

  const tagViewRefreshRef = useRef(refreshTagCollection);
  tagViewRefreshRef.current = refreshTagCollection;
  const seenTagRefreshRef = useRef(tagRefreshToken);
  useEffect(() => {
    // Only an actual edit re-reads the view; mounting must not re-query.
    if (seenTagRefreshRef.current === tagRefreshToken) return;
    seenTagRefreshRef.current = tagRefreshToken;
    tagViewRefreshRef.current?.();
  }, [tagRefreshToken]);

  const handleListTransferDestinations = useCallback(async () => {
    const list = window.electronAPI?.review?.copyAccepted?.listDestinations;
    if (typeof list !== "function") return [];
    const result = await list();
    return Array.isArray(result?.destinations) ? result.destinations : [];
  }, []);

  const handleStartAcceptedCopy = useCallback(
    async (planId, requestedMode = "copy") => {
      const start = window.electronAPI?.review?.copyAccepted?.start;
      if (typeof start !== "function") {
        throw new Error("Copy Accepted is unavailable");
      }
      setAcceptedCopyProgress(null);
      const transferMode = requestedMode === "move" ? "move" : "copy";
      const actionLabel = transferMode === "move" ? "Move" : "Copy";
      const result = await start(planId, transferMode);
      const copiedMedia = Number(
        result?.copiedCount ?? result?.copiedMedia ?? 0
      );
      const skipped = Number(
        result?.skippedCount ?? result?.skippedCollisions ?? 0
      );
      const failed = Number(result?.failedCount || 0);
      const missing = Number(result?.missingCount || 0);
      if (result?.cancelled) {
        notify(
          `${actionLabel} cancelled after ${copiedMedia.toLocaleString()} clip(s)`,
          "info"
        );
      } else if (
        result?.success &&
        skipped === 0 &&
        failed === 0 &&
        missing === 0
      ) {
        notify(
          `${transferMode === "move" ? "Moved" : "Copied"} ${copiedMedia.toLocaleString()} accepted clip(s)`,
          "success"
        );
      } else if (
        copiedMedia > 0 ||
        skipped > 0 ||
        failed > 0 ||
        missing > 0
      ) {
        notify(
          `${actionLabel} finished with issues: ${copiedMedia.toLocaleString()} clip(s) ${transferMode === "move" ? "moved" : "copied"}, ${skipped.toLocaleString()} skipped, ${(failed + missing).toLocaleString()} unavailable or failed`,
          "warning"
        );
      }
      return result;
    },
    [notify]
  );

  const handleCancelAcceptedCopy = useCallback(async (planId) => {
    const cancel = window.electronAPI?.review?.copyAccepted?.cancel;
    if (typeof cancel !== "function") return { cancelled: false };
    return cancel(planId);
  }, []);

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
        if (!reviewModeEnabled) return;
        const reviewState = actionId.replace("metadata:review:", "");
        if (contextMetadataFingerprints.length) {
          reviewWorkflow.applyReviewState(reviewState, {
            fingerprints: contextMetadataFingerprints,
            allowAdvance: false,
            anchorId: contextMenu.contextId,
          });
        }
        return;
      }
      if (actionId.startsWith("metadata:rate:")) {
        if (!contextMetadataFingerprints.length) return;
        if (actionId === "metadata:rate:clear") {
          reviewWorkflow.applyRating(null, {
            fingerprints: contextMetadataFingerprints,
            allowAdvance: false,
            anchorId: contextMenu.contextId,
          });
        } else {
          const value = parseInt(actionId.replace("metadata:rate:", ""), 10);
          if (!Number.isNaN(value)) {
            reviewWorkflow.applyRating(value, {
              fingerprints: contextMetadataFingerprints,
              allowAdvance: false,
              anchorId: contextMenu.contextId,
            });
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
      reviewWorkflow.applyRating,
      reviewWorkflow.applyReviewState,
      reviewModeEnabled,
      handleApplyExistingTag,
      runAction,
      selection.selectOnly,
      selection.size,
      selection.selected,
      contextMenu.contextId,
    ]
  );

  // Fullscreen is a bounded controller over the complete visual order. The
  // modal owns its media element separately from the virtualized grid.
  const fullscreenController = useFullScreenModal({
    collectionOwnerKey: fullscreenCollectionOwnerKey,
    orderedVideos,
  });
  const controllerVideo = fullscreenController.fullScreenVideo;
  const fullScreenVideo = controllerVideo
    ? allVideosById.get(controllerVideo.id) || controllerVideo
    : null;
  const fullscreenPositionLabel = fullscreenController.isCurrentInView
    ? `${Math.max(1, fullscreenController.currentViewIndex + 1).toLocaleString()} of ${Math.max(
        1,
        fullscreenController.fullScreenCount
      ).toLocaleString()}`
    : `Outside view · ${Math.max(
        0,
        fullscreenController.fullScreenCount
      ).toLocaleString()} clip${
        fullscreenController.fullScreenCount === 1 ? "" : "s"
      }`;
  fullScreenControllerRef.current = fullscreenController;
  fullScreenActiveIdRef.current = fullScreenVideo?.id ?? null;

  const selectedGenerationInstanceId =
    selectedVideos.length === 1 ? selectedVideos[0]?.instanceId : null;
  const metadataInspectorVisible =
    metadataInspectorMode === "floating"
      ? isMetadataPanelOpen
      : isLibrarySidebarOpen && workspaceSidebarTab === "details";
  const generationMetadata = useGenerationMetadata({
    instanceId: selectedGenerationInstanceId,
    enabled: Boolean(
      !fullScreenVideo &&
        metadataInspectorVisible &&
        metadataGenerationExpanded &&
        selectedGenerationInstanceId
    ),
  });
  const generationMetadataState = useMemo(
    () =>
      selectedGenerationInstanceId
        ? { ...generationMetadata, onRefresh: generationMetadata.refresh }
        : null,
    [generationMetadata, selectedGenerationInstanceId]
  );

  const releaseFullScreenNow = useCallback((options) => {
    fullScreenPlayerRef.current?.releaseNow?.(options);
  }, []);

  const closeFullScreenForOwnershipChange = useCallback(() => {
    cancelFullScreenFocus();
    releaseFullScreenNow();
    const controller = fullScreenControllerRef.current;
    (controller?.close || controller?.closeFullScreen)?.();
    fullScreenUndoTargetRef.current = null;
    setFullscreenCanUndo(false);
    setFullscreenTransientSurface(null);
  }, [cancelFullScreenFocus, releaseFullScreenNow]);
  closeFullScreenRef.current = closeFullScreenForOwnershipChange;

  const openFullScreen = useCallback(
    (video) => {
      if (!video?.id) return null;
      cancelFullScreenFocus();
      const controller = fullScreenControllerRef.current;
      const opened = (controller?.open || controller?.openFullScreen)?.(video) || null;
      if (!opened) return null;
      const fullscreenSelectionKey = JSON.stringify([String(opened.id)]);
      previousMetadataSelectionKeyRef.current = fullscreenSelectionKey;
      setMetadataPanelOpen(false);
      setMetadataDismissedSelectionKey(fullscreenSelectionKey);
      fullScreenUndoTargetRef.current = null;
      setFullscreenCanUndo(false);
      setFullscreenTransientSurface(null);
      selection.selectExactly(opened.id);
      return opened;
    },
    [cancelFullScreenFocus, selection.selectExactly]
  );

  const scheduleEngagedFullscreenCheckpoint = useCallback(
    (video) => {
      if (!video || !reviewSessions.isEngaged) return;
      const draft = buildActiveReviewCheckpoint({ anchor: video });
      if (!draft) return;
      reviewSessions.schedule(draft, {
        signature: createReviewCheckpointSignature(draft),
      });
    },
    [
      buildActiveReviewCheckpoint,
      reviewSessions.isEngaged,
      reviewSessions.schedule,
    ]
  );

  const navigateFullScreen = useCallback(
    (direction, options) => {
      const controller = fullScreenControllerRef.current;
      const candidate = controller?.peekNavigation?.(direction, options);
      if (!candidate) {
        notify(
          direction === "next"
            ? "End of current view"
            : "Start of current view",
          "info"
        );
        return null;
      }
      setFullscreenTransientSurface(null);
      releaseFullScreenNow({ resetAudio: false });
      const next = controller?.navigateFullScreen?.(
        direction,
        options
      );
      if (!next) {
        notify(
          direction === "next"
            ? "End of current view"
            : "Start of current view",
          "info"
        );
        return null;
      }
      selection.selectExactly(next.id);
      scheduleEngagedFullscreenCheckpoint(next);
      return next;
    },
    [
      notify,
      releaseFullScreenNow,
      scheduleEngagedFullscreenCheckpoint,
      selection.selectExactly,
    ]
  );

  const handleFullScreenSourceRemoved = useCallback(
    (videoId) => {
      releaseFullScreenNow({ resetAudio: false });
      const next = fullScreenControllerRef.current?.sourceRemoved?.(videoId);
      if (Object.is(fullScreenUndoTargetRef.current?.id, videoId)) {
        fullScreenUndoTargetRef.current = null;
        setFullscreenCanUndo(false);
      }
      setFullscreenTransientSurface(null);
      if (!next) {
        notify("The fullscreen clip is no longer available", "warning");
        return null;
      }
      selection.selectExactly(next.id);
      scheduleEngagedFullscreenCheckpoint(next);
      notify("The removed clip was closed; showing the next available clip", "info");
      return next;
    },
    [
      notify,
      releaseFullScreenNow,
      scheduleEngagedFullscreenCheckpoint,
      selection.selectExactly,
    ]
  );
  fullScreenSourceRemovedRef.current = handleFullScreenSourceRemoved;

  useLayoutEffect(() => {
    const activeId = fullScreenActiveIdRef.current;
    const activeRecord = activeId == null ? null : allVideosById.get(activeId);
    if (activeId == null || (activeRecord && activeRecord.present !== false)) return;
    handleFullScreenSourceRemoved(activeId);
  }, [allVideosById, handleFullScreenSourceRemoved]);

  const fullscreenGenerationInstanceId = fullScreenVideo?.instanceId ?? null;
  const fullscreenGenerationMetadata = useGenerationMetadata({
    instanceId: fullscreenGenerationInstanceId,
    enabled: Boolean(
      fullScreenVideo &&
        fullscreenDetailsOpen &&
        fullscreenGenerationExpanded &&
        fullscreenGenerationInstanceId &&
        !workSuspended
    ),
  });
  const fullscreenGenerationMetadataState = useMemo(
    () =>
      fullscreenGenerationInstanceId
        ? {
            ...fullscreenGenerationMetadata,
            onRefresh: fullscreenGenerationMetadata.refresh,
          }
        : null,
    [fullscreenGenerationInstanceId, fullscreenGenerationMetadata]
  );

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
  // Hotkeys operate on current selection
  const runForHotkeys = useCallback(
    (actionId, currentSelection) =>
      runAction(actionId, currentSelection, contextMenu.contextId),
    [runAction, contextMenu.contextId]
  );
  const handleReviewHotkey = useCallback(
    (reviewState) =>
      reviewModeEnabled
        ? reviewWorkflow.applyReviewState(reviewState)
        : false,
    [reviewModeEnabled, reviewWorkflow.applyReviewState]
  );
  const handleRatingHotkey = useCallback(
    (rating) => reviewWorkflow.applyRating(rating),
    [reviewWorkflow.applyRating]
  );
  const handleReviewUndo = useCallback(
    () => (reviewModeEnabled ? reviewWorkflow.undo() : false),
    [reviewModeEnabled, reviewWorkflow.undo]
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
    closeFullScreenRef.current?.();
    await reviewSessions.flush();
    captureFolderViewState();
    setRecursiveMode(next);
    window.electronAPI?.saveSettingsPartial?.({
      recursiveMode: next,
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
    reviewSessions.flush,
    showFilenames,
    zoomLevel,
  ]);

  const toggleRecursive = useCallback(() => {
    handleRecursiveChange(!recursiveMode);
  }, [handleRecursiveChange, recursiveMode]);

  const handleFolderNavigate = useCallback(
    async (relativePath) => {
      if (!activeRootPath) return;
      closeFullScreenRef.current?.();
      await reviewSessions.flush();
      cancelReviewResume();
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
      cancelReviewResume,
      captureFolderViewState,
      folderScope,
      handleRecursiveChange,
      recursiveMode,
      reviewSessions.flush,
    ]
  );

  const handleFolderScopeChange = useCallback(
    async (nextScope) => {
      if (!activeRootPath) return;
      closeFullScreenRef.current?.();
      await reviewSessions.flush();
      cancelReviewResume();
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
    [
      activeRootPath,
      cancelReviewResume,
      captureFolderViewState,
      currentDirectory,
      reviewSessions.flush,
    ]
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
    !isFiltersOpen &&
    !isProcessResultsOpen;

  useHotkeys(runForHotkeys, () => selection.selected, {
    enabled: appHotkeysEnabled,
    getZoomIndex: () => zoomLevel,
    setZoomIndexSafe: (z) => handleZoomChangeSafe(z),
    minZoomIndex: ZOOM_MIN_INDEX,
    maxZoomIndex: ZOOM_MAX_INDEX,
    onSetReviewState: reviewModeEnabled ? handleReviewHotkey : null,
    onSetRating: handleRatingHotkey,
    onUndoReview: reviewModeEnabled ? handleReviewUndo : null,
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
      closeFullScreenRef.current?.();
      const requestId = ++libraryOpenRequestRef.current;
      try {
        await reviewSessions.flush();
        if (requestId !== libraryOpenRequestRef.current) return;
        cancelReviewResume();
        const authorization =
          await window.electronAPI?.library?.authorizeRoot?.(rootPath);
        if (requestId !== libraryOpenRequestRef.current) return;
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
        if (requestId !== libraryOpenRequestRef.current) return;
        console.error("Failed to open library root:", error);
        notify("Could not open that library root", "error");
      }
    },
    [
      cancelReviewResume,
      captureFolderViewState,
      handleElectronFolderSelection,
      notify,
      reviewSessions.flush,
    ]
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
      closeFullScreenRef.current?.();
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
    closeFullScreenRef.current?.();
    await reviewSessions.flush();
    cancelReviewResume();
    captureFolderViewState();
    restoredFolderViewKeyRef.current = null;
    await handleFolderSelect();
  }, [
    cancelReviewResume,
    captureFolderViewState,
    handleFolderSelect,
    reviewSessions.flush,
  ]);

  const toggleFilenames = useCallback(() => {
    const next = !showFilenames;
    setShowFilenames(next);
    window.electronAPI?.saveSettingsPartial?.({
      showFilenames: next,
      recursiveMode,
      zoomLevel,
    });
  }, [showFilenames, recursiveMode, zoomLevel]);

  const toggleHoverAudio = useCallback(() => {
    setHoverAudioEnabled((previous) => {
      const next = !previous;
      window.electronAPI?.saveSettingsPartial?.({ hoverAudioEnabled: next });
      return next;
    });
  }, []);

  const toggleReviewMode = useCallback(() => {
    const next = !reviewModeEnabled;
    setReviewModeEnabled(next);
    window.electronAPI?.saveSettingsPartial?.({ reviewModeEnabled: next });
    if (!next) {
      setProcessResultsOpen(false);
      cancelReviewResume();
      updateFilters((previous) => ({
        ...previous,
        reviewFilter: REVIEW_FILTERS.ANY,
      }));
    }
  }, [cancelReviewResume, reviewModeEnabled, updateFilters]);

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

  const handleReviewAutoAdvanceChange = useCallback((value) => {
    const next = value === true;
    setReviewAutoAdvance(next);
    window.electronAPI?.saveSettingsPartial?.({ reviewAutoAdvance: next });
  }, []);

  const handleFullscreenDetailsOpenChange = useCallback((value) => {
    const next = value === true;
    setFullscreenDetailsOpen(next);
    window.electronAPI?.saveSettingsPartial?.({
      fullscreenDetailsOpen: next,
    });
  }, []);

  const handleFullscreenAudioEnabledChange = useCallback((value) => {
    const next = value === true;
    setFullscreenAudioEnabled(next);
    window.electronAPI?.saveSettingsPartial?.({
      fullscreenAudioEnabled: next,
    });
  }, []);

  const handleCloseFullScreen = useCallback(() => {
    cancelFullScreenFocus();
    const controller = fullScreenControllerRef.current;
    const current = controller?.currentVideo || null;
    const currentIndex = controller?.currentViewIndex ?? -1;
    const inCurrentView = controller?.isInCurrentView === true;
    releaseFullScreenNow();
    (controller?.close || controller?.closeFullScreen)?.();
    fullScreenUndoTargetRef.current = null;
    setFullscreenCanUndo(false);
    setFullscreenTransientSurface(null);

    if (!current?.id) {
      scrollContainerRef.current?.focus?.();
      return;
    }

    selection.selectExactly(current.id);
    if (!inCurrentView || currentIndex < 0) {
      notify(
        "The reviewed clip no longer matches the current view; it remains selected",
        "info"
      );
      scrollContainerRef.current?.focus?.();
      return;
    }

    scrollToId(current.id, { align: "center" });
    let attempts = 36;
    const focusWhenMounted = () => {
      const cards = gridRef.current?.querySelectorAll?.(
        ".video-item[data-video-id]"
      );
      const card = Array.from(cards || []).find(
        (element) => element.dataset?.videoId === String(current.id)
      );
      if (card) {
        fullScreenFocusFrameRef.current = null;
        card.focus?.();
        return;
      }
      attempts -= 1;
      if (attempts > 0 && typeof requestAnimationFrame === "function") {
        fullScreenFocusFrameRef.current = requestAnimationFrame(focusWhenMounted);
      } else if (attempts <= 0) {
        fullScreenFocusFrameRef.current = null;
        scrollContainerRef.current?.focus?.();
      }
    };
    if (typeof requestAnimationFrame === "function") {
      fullScreenFocusFrameRef.current = requestAnimationFrame(focusWhenMounted);
    } else {
      scrollContainerRef.current?.focus?.();
    }
  }, [
    cancelFullScreenFocus,
    notify,
    releaseFullScreenNow,
    scrollToId,
    selection.selectExactly,
  ]);

  const captureFullscreenTarget = useCallback(() => {
    const controller = fullScreenControllerRef.current;
    const current = controller?.currentVideo;
    if (!current?.id) return null;
    const video = allVideosById.get(current.id) || current;
    const ordered = fullOrderedVideosRef.current;
    const currentIndex = ordered.findIndex((candidate) =>
      Object.is(candidate?.id, video.id)
    );
    const successor = currentIndex >= 0
      ? ordered
          .slice(currentIndex + 1)
          .find(
            (candidate) =>
              candidate?.present !== false &&
              !Object.is(candidate?.fingerprint, video.fingerprint)
          )
      : null;
    return {
      video,
      id: video.id,
      fingerprint: video.fingerprint || null,
      instanceId: video.instanceId ?? null,
      successorId: successor?.id ?? null,
      ownerKey: controller.collectionOwnerKey,
      sessionToken: controller.sessionToken,
    };
  }, [allVideosById]);

  const isFullscreenTargetCurrent = useCallback((target) => {
    const controller = fullScreenControllerRef.current;
    return Boolean(
      target &&
        controller?.sessionToken === target.sessionToken &&
        Object.is(controller?.collectionOwnerKey, target.ownerKey) &&
        Object.is(controller?.currentVideo?.id, target.id)
    );
  }, []);

  const advanceFullscreenAfterMutation = useCallback(
    (target) => {
      if (!isFullscreenTargetCurrent(target)) return null;
      const successor = fullOrderedVideosRef.current.find((video) =>
        Object.is(video?.id, target.successorId)
      );
      if (successor?.present !== false && successor?.id != null) {
        setFullscreenTransientSurface(null);
        releaseFullScreenNow({ resetAudio: false });
        const next = fullScreenControllerRef.current?.goToFullScreen?.(
          successor.id
        );
        if (next) {
          selection.selectExactly(next.id);
          scheduleEngagedFullscreenCheckpoint(next);
          return next;
        }
      }
      return navigateFullScreen("next", {
        skipFingerprint: target.fingerprint,
      });
    },
    [
      isFullscreenTargetCurrent,
      navigateFullScreen,
      releaseFullScreenNow,
      scheduleEngagedFullscreenCheckpoint,
      selection.selectExactly,
    ]
  );

  const handleFullscreenReviewState = useCallback(
    async (reviewState) => {
      const target = captureFullscreenTarget();
      if (!target?.fingerprint) {
        notify("This clip cannot be reviewed until it has a fingerprint", "warning");
        return false;
      }
      const result = await reviewWorkflow.applyReviewState(reviewState, {
        fingerprints: [target.fingerprint],
        anchorId: target.id,
        allowAdvance: false,
        completionGuard: () => isFullscreenTargetCurrent(target),
      });
      if (!result) return false;
      if (!isFullscreenTargetCurrent(target)) {
        const current = fullScreenControllerRef.current?.currentVideo;
        if (current) scheduleEngagedFullscreenCheckpoint(current);
        return true;
      }
      fullScreenUndoTargetRef.current = target;
      setFullscreenCanUndo(true);
      if (
        reviewAutoAdvance &&
        normalizeReviewState(reviewState) !== REVIEW_STATES.UNREVIEWED
      ) {
        advanceFullscreenAfterMutation(target);
      }
      return true;
    },
    [
      advanceFullscreenAfterMutation,
      captureFullscreenTarget,
      isFullscreenTargetCurrent,
      notify,
      reviewAutoAdvance,
      reviewWorkflow.applyReviewState,
      scheduleEngagedFullscreenCheckpoint,
    ]
  );

  const handleFullscreenRating = useCallback(
    async (rating) => {
      const target = captureFullscreenTarget();
      if (!target?.fingerprint) {
        notify("This clip cannot be rated until it has a fingerprint", "warning");
        return false;
      }
      const result = await reviewWorkflow.applyRating(rating, {
        fingerprints: [target.fingerprint],
        anchorId: target.id,
        allowAdvance: false,
        completionGuard: () => isFullscreenTargetCurrent(target),
      });
      if (!result) return false;
      if (!isFullscreenTargetCurrent(target)) {
        const current = fullScreenControllerRef.current?.currentVideo;
        if (current) scheduleEngagedFullscreenCheckpoint(current);
        return true;
      }
      fullScreenUndoTargetRef.current = target;
      setFullscreenCanUndo(true);
      if (reviewAutoAdvance && rating != null && Number(rating) > 0) {
        advanceFullscreenAfterMutation(target);
      }
      return true;
    },
    [
      advanceFullscreenAfterMutation,
      captureFullscreenTarget,
      isFullscreenTargetCurrent,
      notify,
      reviewAutoAdvance,
      reviewWorkflow.applyRating,
      scheduleEngagedFullscreenCheckpoint,
    ]
  );

  const handleFullscreenUndo = useCallback(async () => {
    const target = fullScreenUndoTargetRef.current;
    const result = await reviewWorkflow.undo();
    if (!result || !target) return result;
    fullScreenUndoTargetRef.current = null;
    setFullscreenCanUndo(false);

    let attempts = 16;
    const restoreAffectedClip = () => {
      const controller = fullScreenControllerRef.current;
      if (
        controller?.sessionToken !== target.sessionToken ||
        !Object.is(controller?.collectionOwnerKey, target.ownerKey)
      ) {
        return;
      }
      if (Object.is(controller.currentVideo?.id, target.id)) {
        selection.selectExactly(target.id);
        return;
      }
      const targetAvailable = fullOrderedVideosRef.current.some((video) =>
        Object.is(video?.id, target.id)
      );
      if (!targetAvailable) {
        attempts -= 1;
        if (attempts > 0 && typeof requestAnimationFrame === "function") {
          requestAnimationFrame(restoreAffectedClip);
        }
        return;
      }
      releaseFullScreenNow({ resetAudio: false });
      const restored = controller.goToFullScreen?.(target.id);
      if (restored) {
        selection.selectExactly(restored.id);
        scheduleEngagedFullscreenCheckpoint(restored);
        return;
      }
      attempts -= 1;
      if (attempts > 0 && typeof requestAnimationFrame === "function") {
        requestAnimationFrame(restoreAffectedClip);
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(restoreAffectedClip);
    } else {
      restoreAffectedClip();
    }
    return true;
  }, [
    releaseFullScreenNow,
    reviewWorkflow.undo,
    scheduleEngagedFullscreenCheckpoint,
    selection.selectExactly,
  ]);

  const handleFullscreenAddTags = useCallback(
    (tagNames) => {
      const target = captureFullscreenTarget();
      if (!target?.fingerprint) return Promise.resolve(false);
      return handleAddTags(tagNames, [target.fingerprint], {
        completionGuard: () => isFullscreenTargetCurrent(target),
      });
    },
    [captureFullscreenTarget, handleAddTags, isFullscreenTargetCurrent]
  );
  const handleFullscreenRemoveTag = useCallback(
    (tagName) => {
      const target = captureFullscreenTarget();
      if (!target?.fingerprint) return Promise.resolve(false);
      return handleRemoveTag(tagName, [target.fingerprint], {
        completionGuard: () => isFullscreenTargetCurrent(target),
      });
    },
    [captureFullscreenTarget, handleRemoveTag, isFullscreenTargetCurrent]
  );
  const handleFullscreenApplyTag = useCallback(
    (tagName) => {
      const target = captureFullscreenTarget();
      if (!target?.fingerprint) return Promise.resolve(false);
      return handleApplyExistingTag(tagName, [target.fingerprint], {
        completionGuard: () => isFullscreenTargetCurrent(target),
      });
    },
    [captureFullscreenTarget, handleApplyExistingTag, isFullscreenTargetCurrent]
  );

  const handleFullscreenSafeAction = useCallback(
    async (actionId) => {
      const target = captureFullscreenTarget();
      if (!target?.video || typeof runActionForVideos !== "function") return false;
      try {
        return await runActionForVideos(actionId, [target.video]);
      } catch (error) {
        console.error("Fullscreen file action failed", error);
        notify(error?.message || "Could not complete that file action", "error");
        return false;
      }
    },
    [captureFullscreenTarget, notify, runActionForVideos]
  );

  const handleFullscreenShortcut = useCallback(
    ({ key }) => {
      const binding = resolveFullscreenShortcut(key);
      if (!binding) return false;
      if (binding.command === FULLSCREEN_COMMANDS.REVIEW_STATE) {
        if (!reviewModeEnabled) return false;
        void handleFullscreenReviewState(binding.value);
        return true;
      }
      if (
        binding.command === FULLSCREEN_COMMANDS.RATING ||
        binding.command === FULLSCREEN_COMMANDS.CLEAR_RATING
      ) {
        void handleFullscreenRating(binding.value);
        return true;
      }
      if (binding.command === FULLSCREEN_COMMANDS.UNDO) {
        if (!reviewModeEnabled) return false;
        void handleFullscreenUndo();
        return true;
      }
      return false;
    },
    [
      handleFullscreenRating,
      handleFullscreenReviewState,
      handleFullscreenUndo,
      reviewModeEnabled,
    ]
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

  const applyReviewCheckpointView = useCallback(
    (checkpoint) => {
      closeFullScreenRef.current?.();
      const normalized = normalizeReviewCheckpoint(checkpoint);
      if (!normalized.rootPath) return null;
      const { view } = normalized;
      const snapshot = {
        scrollTop: 0,
        selectedIds: [],
        sortKey: view.sort.key,
        sortDir: view.sort.dir,
        groupByFolders: view.sort.groupByFolders,
        randomSeed: view.sort.randomSeed,
        filters: view.filters,
      };
      folderViewStateRef.current.set(
        normalized.rootPath,
        normalized.directory,
        normalized.scope,
        snapshot
      );
      restoredFolderViewKeyRef.current = null;
      setFolderLocation({
        rootPath: normalized.rootPath,
        directory: normalized.directory,
        scope: normalized.scope,
      });
      setExpandedFolderPaths((previous) =>
        expandFolderAncestors(previous, normalized.directory)
      );
      setSortKey(view.sort.key);
      setSortDir(view.sort.dir);
      setGroupByFolders(view.sort.groupByFolders);
      setRandomSeed(view.sort.randomSeed);
      updateFilters(view.filters);
      selection.clear();
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      return normalized;
    },
    [selection.clear, updateFilters]
  );

  const beginContinueReview = useCallback(
    async (requestedRootPath) => {
      if (!requestedRootPath) return null;
      closeFullScreenRef.current?.();
      const openRequestId = ++libraryOpenRequestRef.current;
      const token = ++reviewResumeTokenRef.current;
      cancelReviewFocus();
      setReviewResume({
        ...createIdleReviewResume(token),
        phase: "restoring",
        intent: "continue",
        rootPath: requestedRootPath,
        explicitFocus: true,
        message: "Loading the saved review position…",
      });

      try {
        await reviewSessions.flush();
        const [loaded, authorization] = await Promise.all([
          reviewSessions.load(requestedRootPath),
          window.electronAPI?.library?.authorizeRoot?.(requestedRootPath),
        ]);
        if (
          token !== reviewResumeTokenRef.current ||
          openRequestId !== libraryOpenRequestRef.current
        ) {
          return null;
        }
        if (authorization?.success === false) {
          throw new Error(
            authorization.error || "Could not authorize the saved library root"
          );
        }
        const checkpoint = normalizeReviewCheckpoint(
          loaded?.checkpoint || loaded || {}
        );
        if (!checkpoint.rootPath) {
          throw new Error("This review position is no longer available");
        }
        const authorizedRootPath =
          authorization?.rootPath || checkpoint.rootPath || requestedRootPath;
        const normalizedCheckpoint = {
          ...checkpoint,
          rootPath: authorizedRootPath,
        };
        applyReviewCheckpointView(normalizedCheckpoint);
        reviewSessions.engage(
          authorizedRootPath,
          normalizedCheckpoint
        );
        setReviewResume({
          ...createIdleReviewResume(token),
          phase: "waiting-cache",
          intent: "continue",
          rootPath: authorizedRootPath,
          scanId:
            activeRootPath === authorizedRootPath ? activeScanId : null,
          checkpoint: normalizedCheckpoint,
          explicitFocus: true,
          message: "Restoring the saved review…",
        });

        if (activeRootPath !== authorizedRootPath) {
          const openPromise = handleElectronFolderSelection(authorizedRootPath);
          openPromise?.catch?.((error) => {
            if (token !== reviewResumeTokenRef.current) return;
            console.error("Failed to resume saved review:", error);
          });
        }
        return normalizedCheckpoint;
      } catch (error) {
        if (token !== reviewResumeTokenRef.current) return null;
        console.error("Failed to continue review:", error);
        setReviewResume((previous) => ({
          ...previous,
          phase: "unverified",
          message:
            error?.message || "The saved review position could not be restored",
        }));
        notify(
          error?.message || "The saved review position could not be restored",
          "error"
        );
        return null;
      }
    },
    [
      activeRootPath,
      activeScanId,
      applyReviewCheckpointView,
      cancelReviewFocus,
      handleElectronFolderSelection,
      notify,
      reviewSessions.engage,
      reviewSessions.flush,
      reviewSessions.load,
    ]
  );

  const beginResolutionForCheckpoint = useCallback(
    (checkpoint, intent = "start") => {
      const normalized = normalizeReviewCheckpoint(checkpoint);
      if (!normalized.rootPath) return false;
      const token = ++reviewResumeTokenRef.current;
      cancelReviewFocus();
      reviewSessions.engage(
        normalized.rootPath,
        normalized
      );
      setReviewResume({
        ...createIdleReviewResume(token),
        phase: "waiting-cache",
        intent,
        rootPath: normalized.rootPath,
        scanId: activeScanId,
        checkpoint: normalized,
        explicitFocus: true,
        message: "Finding the next Unreviewed clip…",
      });
      return true;
    },
    [activeScanId, cancelReviewFocus, reviewSessions.engage]
  );

  const saveAndResolveReviewCheckpoint = useCallback(
    async (draft, intent = "start") => {
      if (!draft?.rootPath) return null;
      try {
        const saved = await reviewSessions.saveNow(draft, {
          allowCreate: true,
          engage: false,
          signature: createReviewCheckpointSignature(draft),
        });
        if (!saved) return null;
        const checkpoint = normalizeReviewCheckpoint(
          saved?.checkpoint || saved
        );
        if (!checkpoint.rootPath) {
          throw new Error("The review position could not be saved");
        }
        beginResolutionForCheckpoint(checkpoint, intent);
        refreshLibraryRoots();
        if (activeRootPath) refreshLibraryTree(activeRootPath);
        return checkpoint;
      } catch (error) {
        console.error("Failed to save review position:", error);
        notify(error?.message || "The review position could not be saved", "error");
        return null;
      }
    },
    [
      activeRootPath,
      beginResolutionForCheckpoint,
      notify,
      refreshLibraryRoots,
      refreshLibraryTree,
      reviewSessions.saveNow,
    ]
  );

  const handleStartReviewSession = useCallback(() => {
    const draft = buildActiveReviewCheckpoint();
    return saveAndResolveReviewCheckpoint(draft, "start");
  }, [buildActiveReviewCheckpoint, saveAndResolveReviewCheckpoint]);

  const handleMoveReviewSession = useCallback(() => {
    const draft = buildActiveReviewCheckpoint();
    return saveAndResolveReviewCheckpoint(draft, "move");
  }, [buildActiveReviewCheckpoint, saveAndResolveReviewCheckpoint]);

  const handleForgetReviewSession = useCallback(async () => {
    const rootPath = activeRootPath || reviewSessions.checkpointRootPath;
    if (!rootPath) return;
    try {
      const deleted = await reviewSessions.clear(rootPath);
      if (!deleted) return;
      cancelReviewResume();
      refreshLibraryRoots();
      notify("Cleared the review resume point", "success");
    } catch (error) {
      notify(error?.message || "Could not forget the review position", "error");
    }
  }, [
    activeRootPath,
    cancelReviewResume,
    notify,
    refreshLibraryRoots,
    reviewSessions.checkpointRootPath,
    reviewSessions.clear,
  ]);

  const handleReviewAllUnreviewed = useCallback(() => {
    if (!activeRootPath) return null;
    const deterministicSortKey =
      sortKey === SortKey.RANDOM ? SortKey.NAME : sortKey;
    const draft = buildActiveReviewCheckpoint({
      anchor: null,
      rootPath: activeRootPath,
      directory: "",
      scope: FolderScope.ALL_DESCENDANTS,
      view: {
        version: 1,
        filters: {
          includeTags: [],
          excludeTags: [],
          minRating: null,
          exactRating: null,
          reviewFilter: REVIEW_FILTERS.ANY,
        },
        sort: {
          key: deterministicSortKey,
          dir: deterministicSortKey === SortKey.NAME && sortKey === SortKey.RANDOM
            ? "asc"
            : sortDir,
          groupByFolders,
          randomSeed: null,
        },
      },
    });
    const checkpoint = normalizeReviewCheckpoint(draft);
    applyReviewCheckpointView(checkpoint);
    return saveAndResolveReviewCheckpoint(checkpoint, "review-all");
  }, [
    activeRootPath,
    applyReviewCheckpointView,
    buildActiveReviewCheckpoint,
    groupByFolders,
    saveAndResolveReviewCheckpoint,
    sortDir,
    sortKey,
  ]);

  const handleShowReviewTarget = useCallback(() => {
    const { candidateId, token } = reviewResumeRef.current;
    if (candidateId == null) return;
    setReviewResume((previous) => ({
      ...previous,
      phase: "waiting-target",
      message: "Showing the saved review target…",
    }));
    scrollToId(candidateId, { align: "center" });
    reviewResumeTokenRef.current = token;
  }, [scrollToId]);

  const handleIndexSubfoldersForReview = useCallback(async () => {
    const checkpoint = reviewResumeRef.current.checkpoint;
    if (!checkpoint) return;
    setReviewResume((previous) => ({
      ...previous,
      phase: "restoring",
      message: "Indexing subfolders before continuing…",
    }));
    try {
      await handleRecursiveChange(true);
      const token = reviewResumeTokenRef.current;
      setReviewResume((previous) => ({
        ...previous,
        token,
        phase: "waiting-cache",
        scanId: null,
        message: "Finding the next Unreviewed clip…",
      }));
    } catch (error) {
      setReviewResume((previous) => ({
        ...previous,
        phase: "unverified",
        message: error?.message || "Subfolder indexing did not complete",
      }));
    }
  }, [handleRecursiveChange]);

  useEffect(() => {
    const state = reviewResumeRef.current;
    if (
      !["waiting-cache", "provisional"].includes(state.phase) ||
      !state.checkpoint ||
      !state.rootPath ||
      activeRootPath !== state.rootPath
    ) {
      return;
    }

    const refreshFailed = ["cancelled", "error"].includes(
      loadingStatus?.phase
    );
    const authoritative = Boolean(
      !isLoadingFolder &&
        !isRefreshingFolder &&
        loadingStatus?.phase === "complete"
    );
    const cacheReady = Boolean(
      cachedHydrationComplete &&
        activeScanId &&
        cachedHydration?.scanId === activeScanId
    );
    if (!cacheReady && !authoritative && !refreshFailed) return;
    if (state.phase === "provisional" && !authoritative && !refreshFailed) {
      return;
    }

    if (requiresRecursiveReviewCoverage(state.checkpoint, recursiveMode)) {
      setReviewResume((previous) =>
        previous.token === state.token
          ? {
              ...previous,
              phase: "index-required",
              scanId: activeScanId,
              message:
                "Index subfolders before continuing this saved review scope.",
            }
          : previous
      );
      return;
    }

    const resolvedLocation = resolveReviewCheckpointLocation(
      state.checkpoint,
      catalogDirectories
    );
    if (
      folderLocation.rootPath !== resolvedLocation.rootPath ||
      currentDirectory !== resolvedLocation.directory ||
      folderScope !== resolvedLocation.scope
    ) {
      const applied = applyReviewCheckpointView({
        ...state.checkpoint,
        directory: resolvedLocation.directory,
        scope: resolvedLocation.scope,
      });
      if (applied) {
        reviewSessions.engage(
          applied.rootPath,
          applied
        );
      }
      setReviewResume((previous) =>
        previous.token === state.token
          ? {
              ...previous,
              phase: "waiting-cache",
              scanId: activeScanId,
              fallbackDirectory: resolvedLocation.didFallback
                ? resolvedLocation.directory
                : null,
              message: resolvedLocation.didFallback
                ? `The saved folder is missing; using ${
                    resolvedLocation.directory || "the library root"
                  }.`
                : previous.message,
            }
          : previous
      );
      return;
    }

    let candidate = null;
    if (state.phase === "provisional" && authoritative && state.candidateId) {
      const candidateIndex = orderedVideos.findIndex(
        (video) => video.id === state.candidateId
      );
      const video = candidateIndex >= 0 ? orderedVideos[candidateIndex] : null;
      if (
        video &&
        video.present !== false &&
        normalizeReviewState(video.reviewState) === REVIEW_STATES.UNREVIEWED
      ) {
        candidate = {
          candidateId: video.id,
          candidateInstanceId: video.instanceId ?? null,
          candidateFingerprint: video.fingerprint ?? null,
          candidateName: video.basename || video.name || "Unreviewed clip",
          candidateIndex,
          wrapped: state.wrapped === true,
          reason: "authoritative-keep",
        };
      }
    }
    candidate ||= resolveContinueReviewCandidate(
      orderedVideos,
      state.checkpoint
    );

    if (!candidate?.candidateId) {
      if (!authoritative) {
        setReviewResume((previous) =>
          previous.token === state.token
            ? {
                ...previous,
                phase: refreshFailed ? "unverified" : "provisional",
                scanId: activeScanId,
                candidateId: null,
                candidateName: null,
                candidateIndex: -1,
                message: refreshFailed
                  ? "The folder refresh did not finish, so completion could not be verified."
                  : "Checking the refreshed folder for Unreviewed clips…",
              }
            : previous
        );
        return;
      }

      const root =
        (catalogRoots || []).find((entry) => entry?.rootPath === activeRootPath) ||
        catalogCurrentRoot ||
        libraryRoot;
      const remaining = Math.max(
        0,
        Number(root?.presentCount || 0) - Number(root?.reviewedCount || 0)
      );
      setReviewResume((previous) =>
        previous.token === state.token
          ? {
              ...previous,
              phase: remaining > 0 ? "complete-view" : "complete",
              scanId: activeScanId,
              candidateId: null,
              candidateName: null,
              candidateIndex: -1,
              message:
                remaining > 0
                  ? "Review complete for this saved view."
                  : "Review complete.",
            }
          : previous
      );
      return;
    }

    const candidateBaseline = buildReviewCheckpointDraft({
      ...state.checkpoint,
      directory: resolvedLocation.directory,
      scope: resolvedLocation.scope,
      anchor: {
        instanceId: candidate.candidateInstanceId,
        fingerprint: candidate.candidateFingerprint,
      },
    });
    reviewSessions.engage(
      state.rootPath,
      candidateBaseline
    );
    selection.selectExactly(candidate.candidateId);

    const fallbackMessage = state.fallbackDirectory !== null
      ? ` Saved folder missing; using ${state.fallbackDirectory || "the library root"}.`
      : "";
    if (
      state.phase === "provisional" &&
      authoritative &&
      state.candidateId === candidate.candidateId
    ) {
      setReviewResume((previous) =>
        previous.token === state.token
          ? {
              ...previous,
              phase: "active",
              scanId: activeScanId,
              message: `Review restored at ${candidate.candidateName}.${fallbackMessage}`,
            }
          : previous
      );
      return;
    }

    setReviewResume((previous) =>
      previous.token === state.token
        ? {
            ...previous,
            phase: "restoring",
            scanId: activeScanId,
            candidateId: candidate.candidateId,
            candidateName: candidate.candidateName,
            candidateIndex: candidate.candidateIndex,
            wrapped: candidate.wrapped,
            message: `Focusing ${candidate.candidateName}…`,
          }
        : previous
    );
    focusReviewTarget(
      candidate.candidateId,
      state.token,
      () => {
        if (reviewResumeTokenRef.current !== state.token) return;
        setReviewResume((previous) =>
          previous.token === state.token &&
          previous.candidateId === candidate.candidateId
            ? {
                ...previous,
                phase: authoritative
                  ? "active"
                  : refreshFailed
                    ? "unverified"
                    : "provisional",
                message: authoritative
                  ? `Review restored at ${candidate.candidateName}.${fallbackMessage}`
                  : refreshFailed
                    ? `Review target ${candidate.candidateName} restored, but the folder refresh did not finish.`
                    : `Review target ${candidate.candidateName} restored from the index.${fallbackMessage}`,
              }
            : previous
        );
      },
      () => {
        if (reviewResumeTokenRef.current !== state.token) return;
        setReviewResume((previous) =>
          previous.token === state.token &&
          previous.candidateId === candidate.candidateId
            ? {
                ...previous,
                phase: "waiting-target",
                message: `The saved target ${candidate.candidateName} is not mounted yet.`,
              }
            : previous
        );
      }
    );
  }, [
    activeRootPath,
    activeScanId,
    applyReviewCheckpointView,
    cachedHydration,
    cachedHydrationComplete,
    catalogCurrentRoot,
    catalogDirectories,
    catalogRoots,
    currentDirectory,
    displayVideos,
    focusReviewTarget,
    folderLocation.rootPath,
    folderScope,
    isLoadingFolder,
    isRefreshingFolder,
    libraryRoot,
    loadingStatus?.phase,
    orderedVideos,
    recursiveMode,
    reviewResume.candidateId,
    reviewResume.checkpoint,
    reviewResume.phase,
    reviewResume.rootPath,
    reviewResume.token,
    reviewSessions.engage,
    selection.selectExactly,
  ]);

  useEffect(() => {
    const state = reviewResumeRef.current;
    if (
      !["complete", "complete-view"].includes(state.phase) ||
      !state.checkpoint ||
      state.rootPath !== activeRootPath ||
      isLoadingFolder ||
      isRefreshingFolder ||
      loadingStatus?.phase !== "complete"
    ) {
      return;
    }
    const hasNewCandidate = orderedVideos.some(
      (video) =>
        video?.present !== false &&
        normalizeReviewState(video?.reviewState) === REVIEW_STATES.UNREVIEWED
    );
    const root =
      (catalogRoots || []).find((entry) => entry?.rootPath === activeRootPath) ||
      catalogCurrentRoot ||
      libraryRoot;
    const remaining = getKnownRemainingUnreviewed(root);
    if (
      !hasNewCandidate &&
      (!(remaining > 0) || state.phase === "complete-view")
    ) {
      return;
    }
    setReviewResume((previous) =>
      previous.token === state.token &&
      ["complete", "complete-view"].includes(previous.phase)
        ? {
            ...previous,
            phase: hasNewCandidate ? "available" : "complete-view",
            message: hasNewCandidate
              ? "New Unreviewed clips found. Continue when you are ready."
              : "New Unreviewed clips are outside this saved view.",
          }
        : previous
    );
  }, [
    activeRootPath,
    catalogCurrentRoot,
    catalogRoots,
    isLoadingFolder,
    isRefreshingFolder,
    libraryRoot,
    loadingStatus?.phase,
    orderedVideos,
    reviewResume.phase,
    reviewResume.rootPath,
    reviewResume.token,
  ]);

  useEffect(() => {
    const state = reviewResumeRef.current;
    if (state.phase !== "waiting-target" || state.candidateId == null) return;
    if (!displayVideos.some((video) => video.id === state.candidateId)) return;
    setReviewResume((previous) => ({
      ...previous,
      phase: "restoring",
      message: `Focusing ${previous.candidateName || "the review target"}…`,
    }));
    focusReviewTarget(
      state.candidateId,
      state.token,
      () => {
        if (reviewResumeTokenRef.current !== state.token) return;
        const authoritative =
          !isLoadingFolder &&
          !isRefreshingFolder &&
          loadingStatus?.phase === "complete";
        setReviewResume((previous) =>
          previous.token === state.token
            ? {
                ...previous,
                phase: authoritative ? "active" : "provisional",
                message: `Review restored at ${
                  previous.candidateName || "the saved target"
                }.`,
              }
            : previous
        );
      },
      () => {
        if (reviewResumeTokenRef.current !== state.token) return;
        setReviewResume((previous) =>
          previous.token === state.token
            ? {
                ...previous,
                phase: "waiting-target",
                message: "The review target is still outside the mounted grid.",
              }
            : previous
        );
      }
    );
  }, [
    displayVideos,
    focusReviewTarget,
    isLoadingFolder,
    isRefreshingFolder,
    loadingStatus?.phase,
    reviewResume.candidateId,
    reviewResume.phase,
    reviewResume.token,
  ]);

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
      if (
        ["restoring", "waiting-cache", "waiting-target", "provisional"].includes(
          reviewResumeRef.current.phase
        )
      ) {
        cancelReviewResume();
      }
      if (!isDoubleClick && video && reviewSessions.isEngaged) {
        const draft = buildActiveReviewCheckpoint({ anchor: video });
        if (draft) {
          reviewSessions.schedule(draft, {
            signature: createReviewCheckpointSignature(draft),
          });
        }
      }
      if (isDoubleClick && video) {
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
    [
      buildActiveReviewCheckpoint,
      cancelReviewResume,
      reviewSessions.isEngaged,
      reviewSessions.schedule,
    ]
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

  useEffect(() => {
    const checkpoint = reviewSessions.checkpoint;
    if (
      !checkpoint ||
      reviewSessions.isEngaged ||
      reviewResume.phase !== "idle" ||
      !checkpointLocationMatches(checkpoint, {
        rootPath: activeRootPath,
        directory: currentDirectory,
        scope: folderScope,
      })
    ) {
      return;
    }
    const baseline = buildActiveReviewCheckpoint();
    reviewSessions.engage(
      activeRootPath,
      baseline || checkpoint
    );
  }, [
    activeRootPath,
    buildActiveReviewCheckpoint,
    currentDirectory,
    folderScope,
    reviewResume.phase,
    reviewSessions.checkpoint,
    reviewSessions.engage,
    reviewSessions.isEngaged,
  ]);

  const rootCountStateByPath = useMemo(() => {
    const result = {};
    for (const root of pinnedRoots) {
      const rootPath = root?.rootPath;
      if (!rootPath) continue;
      const remainingUnreviewed = getKnownRemainingUnreviewed(root);
      const isUpdating = Boolean(
        (rootPath === activeRootPath &&
          (isLoadingFolder || isRefreshingFolder)) ||
          (root?.refreshState && root.refreshState !== "idle")
      );
      const parsedTotal = Number(root?.presentCount);
      result[rootPath] = {
        totalClips:
          root?.presentCount == null || !Number.isFinite(parsedTotal)
            ? null
            : Math.max(0, Math.floor(parsedTotal)),
        remainingUnreviewed,
        isUpdating,
      };
    }
    return result;
  }, [
    activeRootPath,
    isLoadingFolder,
    isRefreshingFolder,
    pinnedRoots,
    reviewSessions.summaryByRoot,
  ]);

  const reviewSessionModel = useMemo(() => {
    const checkpoint =
      reviewResume.rootPath === activeRootPath && reviewResume.checkpoint
        ? reviewResume.checkpoint
        : reviewSessions.checkpoint;
    const hasCheckpoint = Boolean(
      activeRootPath &&
        (checkpoint?.rootPath === activeRootPath ||
          reviewSessions.hasCheckpoint(activeRootPath))
    );
    let mode = "none";
    if (reviewResume.rootPath === activeRootPath) {
      if (
        ["restoring", "waiting-cache", "waiting-target", "provisional"].includes(
          reviewResume.phase
        )
      ) {
        mode = "restoring";
      } else if (reviewResume.phase === "complete") {
        mode = "complete";
      } else if (reviewResume.phase === "complete-view") {
        mode = "complete-view";
      } else if (reviewResume.phase === "available") {
        mode = "available";
      } else if (reviewResume.phase === "index-required") {
        mode = "index-required";
      } else if (hasCheckpoint) {
        mode = "active";
      }
    } else if (hasCheckpoint && checkpoint) {
      mode = checkpointLocationMatches(checkpoint, {
        rootPath: activeRootPath,
        directory: currentDirectory,
        scope: folderScope,
      })
        ? "active"
        : "elsewhere";
    }

    const directoryLabel = checkpoint?.directory
      ? checkpoint.directory
      : "Library root";
    const savedAt = formatSessionSavedAt(checkpoint?.updatedAt);
    const catalogRoot =
      (catalogRoots || []).find((entry) => entry?.rootPath === activeRootPath) ||
      catalogCurrentRoot ||
      libraryRoot;
    const rootRemaining = getKnownRemainingUnreviewed(catalogRoot);
    return {
      mode,
      savedAtLabel: savedAt ? `Saved ${savedAt}` : "",
      message: reviewResume.rootPath === activeRootPath
        ? reviewResume.message
        : "",
      candidateName: reviewResume.rootPath === activeRootPath
        ? reviewResume.candidateName
        : "",
      locationLabel: directoryLabel,
      startActionContext: `${reviewScopeLabel}, ${Math.max(
        0,
        Number(reviewWorkflow.progress.unreviewed) || 0
      ).toLocaleString()} unreviewed`,
      savedActionContext: `${formatCheckpointScopeLabel(
        checkpoint,
        rootDisplayName
      )}${
        rootRemaining === null
          ? ""
          : `, ${rootRemaining.toLocaleString()} unreviewed in the root`
      }`,
      showTarget:
        reviewResume.rootPath === activeRootPath &&
        reviewResume.phase === "waiting-target",
      checkingForFiles: Boolean(
        hasCheckpoint &&
          (isRefreshingFolder || reviewResume.phase === "provisional")
      ),
      disabled: reviewSessions.saving,
    };
  }, [
    activeRootPath,
    catalogCurrentRoot,
    catalogRoots,
    currentDirectory,
    folderScope,
    isRefreshingFolder,
    libraryRoot,
    reviewResume,
    reviewScopeLabel,
    reviewWorkflow.progress.unreviewed,
    rootDisplayName,
    reviewSessions.checkpoint,
    reviewSessions.hasCheckpoint,
    reviewSessions.saving,
  ]);

  const masonryGridStyle = useMemo(
    () => ({ height: `${Math.max(0, masonryTotalHeight)}px` }),
    [masonryTotalHeight]
  );

  return (
    <div
      className={`app ${reviewModeEnabled ? "review-mode-active" : "review-mode-off"}`}
      onContextMenu={handleBackgroundContextMenu}
    >
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
            handleWebFileSelection={handleWebDirectorySelection}
            recursiveMode={recursiveMode}
            toggleRecursive={toggleRecursive}
            showFilenames={showFilenames}
            toggleFilenames={toggleFilenames}
            hoverAudioEnabled={hoverAudioEnabled}
            onHoverAudioToggle={toggleHoverAudio}
            reviewModeEnabled={reviewModeEnabled}
            onReviewModeToggle={toggleReviewMode}
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

          {activeRootPath && reviewModeEnabled && (
            <ReviewToolbar
              progress={reviewWorkflow.progress}
              selectedCount={selection.size}
              autoAdvance={reviewAutoAdvance}
              canUndo={reviewWorkflow.canUndo}
              isBusy={reviewWorkflow.isBusy}
              canProcessResults={reviewProcessingReady}
              processResultsReason={reviewProcessingReason}
              session={reviewSessionModel}
              onSetReviewState={reviewWorkflow.applyReviewState}
              onAutoAdvanceChange={handleReviewAutoAdvanceChange}
              onUndo={reviewWorkflow.undo}
              onProcessResults={() => setProcessResultsOpen(true)}
              onStartSession={handleStartReviewSession}
              onContinueSession={() => beginContinueReview(activeRootPath)}
              onMoveSession={handleMoveReviewSession}
              onForgetSession={handleForgetReviewSession}
              onReviewAllUnreviewed={handleReviewAllUnreviewed}
              onShowReviewTarget={handleShowReviewTarget}
              onIndexSubfolders={handleIndexSubfoldersForReview}
            />
          )}

          {isFiltersOpen && (
            <FiltersPopover
              ref={filtersPopoverRef}
              filters={filters}
              reviewModeEnabled={reviewModeEnabled}
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
            reviewModeEnabled={reviewModeEnabled}
          />
          <ProcessReviewResultsDialog
            open={isProcessResultsOpen}
            videos={reviewScopeVideos}
            scopeLabel={reviewScopeLabel}
            processingReady={reviewProcessingReady}
            readinessMessage={reviewProcessingReason}
            busy={reviewWorkflow.isBusy}
            onClose={() => setProcessResultsOpen(false)}
            onTrashRejects={handleTrashReviewRejects}
            onPrepareAcceptedCopy={handlePrepareAcceptedCopy}
            onListTransferDestinations={handleListTransferDestinations}
            transferLayout={transferLayout}
            onTransferLayoutChange={handleTransferLayoutChange}
            onStartAcceptedCopy={handleStartAcceptedCopy}
            onCancelAcceptedCopy={handleCancelAcceptedCopy}
            acceptedCopyProgress={acceptedCopyProgress}
            trashProgress={trashProgress}
          />
          <TransferSelectionDialog
            open={transferDialogOpen}
            videos={transferSelection}
            onClose={() => setTransferDialogOpen(false)}
            onPrepareTransfer={handlePrepareSelectionTransfer}
            onStartTransfer={handleStartAcceptedCopy}
            onCancelTransfer={handleCancelAcceptedCopy}
            onListTransferDestinations={handleListTransferDestinations}
            transferLayout={transferLayout}
            onTransferLayoutChange={handleTransferLayoutChange}
            transferProgress={acceptedCopyProgress}
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

              {reviewModeEnabled && reviewFilterSummary && (
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
                  rootCountStateByPath={rootCountStateByPath}
                  savedViews={savedViews}
                  libraryTags={libraryTags}
                  activeTagView={tagCollection}
                  onOpenTagView={loadTagCollection}
                  onRefreshTagView={refreshTagCollection}
                  onApplySavedView={handleApplySavedView}
                  onSaveCurrentView={handleSaveCurrentView}
                  onDeleteSavedView={handleDeleteSavedView}
                  smartViewsEnabled={false}
                  reviewModeEnabled={reviewModeEnabled}
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
                  metadataInspectorMode === "docked" ? (
                    <WorkspaceSidebar
                      activeTab={workspaceSidebarTab}
                      onTabChange={setWorkspaceSidebarTab}
                      selectionCount={selection.size}
                      libraryProps={{
                        tree: folderTree,
                        currentPath: currentDirectory,
                        expandedPaths: expandedFolderPaths,
                        onToggleExpanded: handleFolderExpandedToggle,
                        onSelectFolder: handleFolderNavigate,
                        pinnedRoots,
                        currentRoot: catalogCurrentRoot || libraryRoot,
                        onOpenRoot: handleOpenLibraryRoot,
                        onTogglePin: handleToggleLibraryPin,
                        rootCountStateByPath,
                        savedViews,
                        onApplySavedView: handleApplySavedView,
                        onSaveCurrentView: handleSaveCurrentView,
                        onDeleteSavedView: handleDeleteSavedView,
                        disabled: isLoadingFolder,
                        reviewModeEnabled,
                      }}
                      detailsContent={
                        selection.size > 0 ? (
                          <DockedMetadataInspector
                            selectionKey={metadataSelectionKey}
                            selectionCount={selection.size}
                            selectedVideos={selectedVideos}
                            availableTags={availableTags}
                            onAddTag={handleAddTags}
                            onRemoveTag={handleRemoveTag}
                            onApplyTagToSelection={handleApplyExistingTag}
                            onSetRating={reviewWorkflow.applyRating}
                            onClearRating={() => reviewWorkflow.applyRating(null)}
                            onSetReviewState={reviewWorkflow.applyReviewState}
                            reviewModeEnabled={reviewModeEnabled}
                            generationMetadataState={generationMetadataState}
                            generationExpanded={metadataGenerationExpanded}
                            onGenerationExpandedChange={setMetadataGenerationExpanded}
                            onFocusSelection={focusSelection}
                            onTransferSelection={handleRequestTransfer}
                            onUndock={handleUndockMetadataPanel}
                          />
                        ) : null
                      }
                    />
                  ) : (
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
                      rootCountStateByPath={rootCountStateByPath}
                      savedViews={savedViews}
                  libraryTags={libraryTags}
                  activeTagView={tagCollection}
                  onOpenTagView={loadTagCollection}
                  onRefreshTagView={refreshTagCollection}
                      onApplySavedView={handleApplySavedView}
                      onSaveCurrentView={handleSaveCurrentView}
                      onDeleteSavedView={handleDeleteSavedView}
                      disabled={isLoadingFolder}
                      reviewModeEnabled={reviewModeEnabled}
                    />
                  )
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
                              reviewModeEnabled={reviewModeEnabled}
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
              {metadataInspectorMode === "floating" ? (
                <MetadataPanel
                isOpen={isMetadataPanelOpen}
                onClose={closeMetadataPanel}
                selectionKey={metadataSelectionKey}
                anchorId={metadataPlacementRequest.anchorId ?? metadataAnchorId}
                resolveAnchorRect={resolveMetadataAnchorRect}
                resolveBoundsRect={resolveMetadataBoundsRect}
                resolveContainerRect={resolveMetadataContainerRect}
                placementRequest={metadataPlacementRequest}
                boundsVersion={`${isLibrarySidebarOpen}:${metadataInspectorMode}:${
                  activeRootPath || "home"
                }`}
                selectionCount={selection.size}
                selectedVideos={selectedVideos}
                availableTags={availableTags}
                onAddTag={handleAddTags}
                onRemoveTag={handleRemoveTag}
                onApplyTagToSelection={handleApplyExistingTag}
                onSetRating={reviewWorkflow.applyRating}
                onClearRating={() => reviewWorkflow.applyRating(null)}
                onSetReviewState={reviewWorkflow.applyReviewState}
                reviewModeEnabled={reviewModeEnabled}
                generationMetadataState={generationMetadataState}
                generationExpanded={metadataGenerationExpanded}
                onGenerationExpandedChange={setMetadataGenerationExpanded}
                focusToken={metadataFocusToken}
                onFocusSelection={focusSelection}
                onTransferSelection={handleRequestTransfer}
                onDock={activeRootPath ? handleDockMetadataPanel : undefined}
                />
              ) : null}
            </div>
          )}

          {fullScreenVideo && (
            <FullScreenModal
              ref={fullScreenPlayerRef}
              video={fullScreenVideo}
              onClose={handleCloseFullScreen}
              onNavigate={navigateFullScreen}
              showFilenames={showFilenames}
              mediaScheduler={mediaScheduler}
              workSuspended={workSuspended}
              collectionOwnerKey={fullscreenCollectionOwnerKey}
              canNavigatePrevious={fullscreenController.hasPrevious}
              canNavigateNext={fullscreenController.hasNext}
              positionLabel={fullscreenPositionLabel}
              dialogLabel={fullScreenVideo.name || "Fullscreen review"}
              headerContent={
                <FullscreenHeaderContent
                  video={fullScreenVideo}
                  isCurrentInView={fullscreenController.isCurrentInView}
                  reviewModeEnabled={reviewModeEnabled}
                />
              }
              progressContent={reviewModeEnabled ? (
                <FullscreenProgressContent progress={reviewWorkflow.progress} />
              ) : null}
              actionsContent={({ retryPlayback }) => (
                <FullscreenHeaderActions
                  video={fullScreenVideo}
                  surface={fullscreenTransientSurface}
                  onSurfaceChange={setFullscreenTransientSurface}
                  onSafeAction={handleFullscreenSafeAction}
                  onRetry={retryPlayback}
                  reviewModeEnabled={reviewModeEnabled}
                />
              )}
              reviewRail={
                <FullscreenReviewRail
                  video={fullScreenVideo}
                  busy={reviewWorkflow.isBusy}
                  canUndo={fullscreenCanUndo && reviewWorkflow.canUndo}
                  autoAdvance={reviewAutoAdvance}
                  reviewModeEnabled={reviewModeEnabled}
                  onSetReviewState={handleFullscreenReviewState}
                  onSetRating={handleFullscreenRating}
                  onUndo={handleFullscreenUndo}
                  onAutoAdvanceChange={handleReviewAutoAdvanceChange}
                />
              }
              detailsOpen={fullscreenDetailsOpen}
              onToggleDetails={() =>
                handleFullscreenDetailsOpenChange(!fullscreenDetailsOpen)
              }
              audioEnabled={fullscreenAudioEnabled}
              onAudioEnabledChange={handleFullscreenAudioEnabledChange}
              onCopyFrame={handleCopyFullscreenFrame}
              detailsDock={
                <FullscreenDetailsDock
                  video={fullScreenVideo}
                  availableTags={availableTags}
                  generationMetadataState={fullscreenGenerationMetadataState}
                  generationExpanded={fullscreenGenerationExpanded}
                  onGenerationExpandedChange={setFullscreenGenerationExpanded}
                  onAddTags={handleFullscreenAddTags}
                  onRemoveTag={handleFullscreenRemoveTag}
                  onApplyTag={handleFullscreenApplyTag}
                />
              }
              transientOpen={Boolean(fullscreenTransientSurface)}
              onDismissTransient={() => setFullscreenTransientSurface(null)}
              onOpenHelp={() => setFullscreenTransientSurface("help")}
              onShortcut={handleFullscreenShortcut}
              onBoundary={(_direction, message) => notify(message, "info")}
              fallbackFocusRef={scrollContainerRef}
              appRootId="root"
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
              reviewModeEnabled={reviewModeEnabled}
            />
          )}
        </>
      )}
    </div>
  );
}

export default App;
