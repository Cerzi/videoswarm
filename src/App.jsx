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
import StackBar from "./components/StackBar";
import VersionsBar from "./components/VersionsBar";
import ReviewPassBar from "./components/ReviewPassBar";
import {
  buildVersionMembers,
  versionCardLabel,
  versionLocation,
} from "./app/versions/versionView";
import { normalizeVideoFromMain } from "./app/videoNormalization";
import FullScreenModal from "./components/FullScreenModal";
import ContextMenu from "./components/ContextMenu";
import RecentFolders from "./components/RecentFolders";
import MetadataPanel from "./components/MetadataPanel";
import TopBar from "./components/TopBar";
import FiltersPopover from "./components/FiltersPopover";
import LibrarySidebar from "./components/LibrarySidebar";
import WorkspaceSidebar, { buildWorkspacePanels } from "./components/WorkspaceSidebar";
import DockedMetadataInspector, { DockedGenerationPanel } from "./components/DockedMetadataInspector";
import FolderGroupHeaders from "./components/FolderGroupHeaders";
import DebugSummary from "./components/DebugSummary";
import BackgroundActivityStatus from "./components/BackgroundActivityStatus";
import AboutDialog from "./components/AboutDialog";
import DataLocationDialog from "./components/DataLocationDialog";
import PreferencesDialog from "./components/preferences/PreferencesDialog";
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
import useReviewWorkflow, { singleSelectionUnit } from "./hooks/review/useReviewWorkflow";
import useReviewSessions from "./hooks/review/useReviewSessions";

import {
  SortKey,
  buildComparator,
  buildRandomOrderMap,
  folderGroupKey,
  groupAndSort,
} from "./sorting/sorting.js";
import { describeSort, parseSortValue, formatSortValue } from "./sorting/sortOption.js";
import { showToast } from "./app/toastStack";
import { openDonationPage } from "./utils/support";

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
import { emptyTagSearchMessage } from "./app/tagSearchMessage";
import {
  librarySearchCriteria,
  librarySearchKey,
} from "./app/librarySearch";
import { useGenerationMetadata } from "./app/hooks/useGenerationMetadata";
import useWindowWorkSuspension from "./app/hooks/useWindowWorkSuspension";
import usePlaybackCapabilities from "./app/hooks/usePlaybackCapabilities";
import {
  FOLDER_OPEN_MILESTONES,
  recordFolderOpenMilestone,
} from "./app/performance/folderOpenMetrics";
import { createMediaSlotScheduler } from "./services/mediaSlotScheduler";
import { thumbService } from "./services/thumbService";
import { posterFrames } from "./services/posterFrameCache";
import {
  createDefaultFilters,
  parseWorkflowWords,
  sanitizeFrameRate,
  sanitizeSteps,
} from "./app/filters/filtersUtils";
import { buildTagHierarchy } from "./app/filters/tagHierarchy";
import { getOpaqueMediaSource } from "./utils/mediaSource";
import { posterWidthFor, proxyIsSharpEnough } from "./utils/cardMediaSize";
import {
  resetTurnedDownTags,
  turnDownLikelyTag,
  useLikelyTagStatus,
} from "./app/tags/likelyTags";
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
import useGenerationVersionIndex from "./app/hooks/useGenerationVersionIndex";
import useGenerationVersionSummaries from "./app/hooks/useGenerationVersionSummaries";
import {
  VERSION_FILTER_LABELS,
  buildGenerationVersionIndex,
  normalizeVersionFilter,
} from "./app/filters/generationVersions";
import {
  buildPromptStacks,
  collapsePromptStacks,
  createStackSelectionUnits,
  emptyPromptStacks,
  neighbouringStack,
  stackOrderOf,
  unreviewedStackFingerprints,
} from "./app/stacks/promptStacks";
import { useCompanions } from "./app/companion/useCompanion";
import CompanionSendDialog from "./components/CompanionSendDialog";
import { useViewHistory } from "./app/hooks/useViewHistory";
import { useStackFrames } from "./app/stacks/useStackFrames";
import { applyStackFaces } from "./app/stacks/stackFaces";
import {
  createCompanionChipCache,
  createCompanionQuickActionCache,
  withQuickShortcuts,
} from "./app/companion/companionCard";
import {
  COMPANION_SEND_CHUNK,
  companionRowsOf,
  formatEstimate,
  sendWithoutReview,
  summarizeSendResults,
} from "./app/companion/companionSend";
import {
  COMPANION_PHASE_LABELS,
  normalizeCompanionFilters,
  parseCompanionFilterKey,
} from "./app/companion/companionFilters";
import {
  DEFAULT_STACK_SIMILARITY,
  normalizeStackSimilarity,
  useSimilarPrompts,
} from "./app/stacks/useSimilarPrompts";
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

const NO_STRIP_IDS = Object.freeze([]);
const NO_VERSION_GUESTS = Object.freeze([]);
// As many clips as a library view holds (main's REVIEW_PASS_MAX_CLIPS).
const REVIEW_PASS_MAX_CLIPS = 50_000;

function App() {
  // Selection state (SOLID). While prompt stacks are collapsed, every run of
  // a stack selects together; the units are filled in once stacks are known
  // (docs/architecture/prompt-stacks.md, Section 5).
  const selectionUnitsRef = useRef(null);
  const selection = useSelectionState({ unitsRef: selectionUnitsRef }); // { selected, size, selectOnly, toggle, clear, setSelected, selectRange, anchorId }
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true);
  const [hoverAudioEnabled, setHoverAudioEnabled] = useState(false);
  // UX redesign D2: the status line shows counts and sort unless asked for
  // the playback diagnostics.
  const [playbackDetailsVisible, setPlaybackDetailsVisible] = useState(false);
  const [playbackMode, setPlaybackMode] = useState(DEFAULT_PLAYBACK_MODE);
  // On by default (main/proxy-playback-settings.js); the profile's setting
  // replaces this once it loads.
  const [proxyPlaybackEnabled, setProxyPlaybackEnabled] = useState(true);
  // Optional: freeze the grid while other windows fully cover the app (X11).
  const [pauseWhenCovered, setPauseWhenCovered] = useState(false);
  const [windowCovered, setWindowCovered] = useState(false);
  const [reviewAutoAdvance, setReviewAutoAdvance] = useState(false);
  const [reviewModeEnabled, setReviewModeEnabled] = useState(true);
  const [fullscreenDetailsOpen, setFullscreenDetailsOpen] = useState(true);
  const [fullscreenAudioEnabled, setFullscreenAudioEnabled] = useState(false);
  const [fullscreenAutoContinue, setFullscreenAutoContinue] = useState(false);
  const [metadataInspectorMode, setMetadataInspectorMode] = useState("floating");
  const [workspaceSidebarTab, setWorkspaceSidebarTab] = useState("library");
  const [metadataGenerationExpanded, setMetadataGenerationExpanded] =
    useState(true);
  const [fullscreenGenerationExpanded, setFullscreenGenerationExpanded] =
    useState(true);
  // Hover is not React state: the playback orchestrator reads it through its
  // own ref, so pointer movement over the grid does not re-render the app.
  const hoveredVideoIdRef = useRef(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [sortKey, setSortKey] = useState(SortKey.NAME);
  const [sortDir, setSortDir] = useState("asc");
  const [groupByFolders, setGroupByFolders] = useState(true);
  // Prompt stacks: collapse every run of one prompt into one card, and the
  // stack open in its own view with the stack order it was opened from.
  const [stackByPrompt, setStackByPrompt] = useState(false);
  const [stackSimilarity, setStackSimilarityState] = useState(DEFAULT_STACK_SIMILARITY);
  // Masonry columns, or rows of one height in reading order (View › Layout).
  const [gridLayout, setGridLayout] = useState("masonry");
  const [openStackKey, setOpenStackKey] = useState(null);
  const [openStackOrder, setOpenStackOrder] = useState([]);
  // One clip's versions side by side (generation-versions.md, Section 8):
  // `{ originId, records, status, truncated }`, over whatever grid it was
  // opened from.
  const [versionView, setVersionView] = useState(null);
  // A review pass (docs/architecture/review-passes.md): a frozen list of
  // clips under review, `{ id, name, source, definition, location, records,
  // positions: Map<fingerprint, position> }`, over whatever grid was open.
  const [reviewPass, setReviewPass] = useState(null);
  // Opens it from anywhere: the card pill and the details panel.
  const handleOpenVersionsRef = useRef(null);
  const [randomSeed, setRandomSeed] = useState(null);
  const [isAboutOpen, setAboutOpen] = useState(false);
  const [isDataLocationOpen, setDataLocationOpen] = useState(false);
  const [isPreferencesOpen, setPreferencesOpen] = useState(false);
  const [isHotkeyHelpOpen, setHotkeyHelpOpen] = useState(false);
  const [isProcessResultsOpen, setProcessResultsOpen] = useState(false);
  const [acceptedCopyProgress, setAcceptedCopyProgress] = useState(null);
  const [trashProgress, setTrashProgress] = useState(null);
  const [transferLayout, setTransferLayout] = useState("structured");
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferSelection, setTransferSelection] = useState([]);
  // Clips on their way to a companion app's action:
  // `{ companion: { id, name, refresh }, action, videos }`.
  const [companionSend, setCompanionSend] = useState(null);
  const [tagRefreshToken, setTagRefreshToken] = useState(0);
  const [librarySearchScope, setLibrarySearchScope] = useState("folder");
  // Bumped to re-run the library search even when its tags did not change,
  // as applying a library-scoped smart view does.
  const [librarySearchRequest, setLibrarySearchRequest] = useState(0);
  // Remembered so leaving a library search returns to where it was entered
  // from, rather than to an empty app.
  const folderScopeReturnRef = useRef(null);
  const openLibraryRootRef = useRef(null);
  const [fullscreenTransientSurface, setFullscreenTransientSurface] =
    useState(null);
  const [fullscreenCanUndo, setFullscreenCanUndo] = useState(false);
  const [profilePromptRequest, setProfilePromptRequest] = useState(null);
  const [profilePromptValue, setProfilePromptValue] = useState("");
  const [reviewProfileEpoch, setReviewProfileEpoch] = useState(0);
  const [webCollectionEpoch] = useState(0);
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
  // scrollToId, for restoring a folder view onto one clip; the masonry layout
  // that provides it is set up further down.
  const revealScrollRef = useRef(null);
  const goToFolderRef = useRef(null);
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
    publishDiagnostics: playbackDetailsVisible,
  });
  const { scheduleInit } = useInitGate({
    perFrame: 6,
    suspended: workSuspended,
  });

  // Main watches for covering only while this is on; it reports changes.
  useEffect(() => {
    window.electronAPI?.playback?.setPauseWhenCovered?.(pauseWhenCovered)?.catch?.(
      () => {}
    );
    if (!pauseWhenCovered) setWindowCovered(false);
  }, [pauseWhenCovered]);
  useEffect(() => {
    const unsubscribe = window.electronAPI?.playback?.onWindowCovered?.((covered) =>
      setWindowCovered(covered === true)
    );
    return () => unsubscribe?.();
  }, []);
  // Covered or showing fullscreen: grid clips freeze on their frame and stay
  // loaded, so they resume at once.
  const gridPlaybackPaused = pauseWhenCovered && windowCovered;

  useEffect(() => {
    thumbService.setSuspended(workSuspended);
    posterFrames.setSuspended(workSuspended);
    return () => {
      thumbService.setSuspended(true);
      posterFrames.setSuspended(true);
    };
  }, [workSuspended]);

  const [availableTags, setAvailableTags] = useState([]);
  // The tag tree from the tag list: filters and inspectors read it.
  const tagHierarchy = useMemo(() => buildTagHierarchy(availableTags), [availableTags]);
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
    const unsubscribe = window.electronAPI?.onOpenPreferences?.(() => {
      setPreferencesOpen(true);
    });
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
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

  // A saved mode sets where Details appears, not which sidebar tab shows:
  // docked is the default (UX redesign D1), and switching to Details on every
  // launch would hide the Library just when a folder is being chosen. Docking
  // by hand, I and Open details still bring the Details tab forward.
  const applyMetadataInspectorModeFromSettings = useCallback((value) => {
    const next = value === "docked" ? "docked" : "floating";
    setMetadataInspectorMode(next);
    if (next === "docked") {
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
  } = useElectronFolderLifecycle({
    selection,
    recursiveMode,
    setRecursiveMode,
    setShowFilenames,
    setHoverAudioEnabled,
    setPlaybackDetailsVisible,
    setStackByPrompt,
    setStackSimilarity: setStackSimilarityState,
    setGridLayout,
    setSortKey,
    setSortDir,
    groupByFolders,
    setGroupByFolders,
    setRandomSeed,
    setPlaybackMode,
    setProxyPlaybackEnabled,
    setPauseWhenCovered,
    setReviewAutoAdvance,
    setReviewModeEnabled,
    setFullscreenDetailsOpen,
    setFullscreenAudioEnabled,
    setFullscreenAutoContinue,
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

  // Generation versions are keyed per collection rather than per folder view:
  // navigating subfolders inside one root must not restart indexing.
  const generationCollectionKey = activeRootPath
    ? `${reviewProfileEpoch}:root:${activeRootPath}`
    : tagCollection
      ? `${reviewProfileEpoch}:tags:${tagCollection.tags.join("\u0000")}:${tagCollection.loadedAt}`
      : null;
  const {
    summaries: generationVersionSummaries,
    refresh: refreshGenerationVersionSummaries,
  } = useGenerationVersionSummaries(videos);
  const generationIndex = useGenerationVersionIndex({
    videos,
    setVideos,
    collectionKey: generationCollectionKey,
    busy: isLoadingFolder || isRefreshingFolder,
    onBatch: refreshGenerationVersionSummaries,
  });
  const generationVersionIndex = useMemo(
    () => buildGenerationVersionIndex(videos, generationVersionSummaries),
    [videos, generationVersionSummaries]
  );

  // Companion apps' view of the collection (docs/architecture/companion-app.md):
  // every app the profile connects, each with its own session. A profile
  // switch asks for the profile's list again. Clips shown from outside the
  // collection (versionGuests, below) are asked about too.
  const [companionGuests, setCompanionGuests] = useState(NO_VERSION_GUESTS);
  const companions = useCompanions({
    videos,
    guests: companionGuests,
    suspended: workSuspended,
    refreshKey: reviewProfileEpoch,
  });
  const onlineCompanions = useMemo(
    () => companions.filter((companion) => companion.status === "online"),
    [companions]
  );
  // Every online app's actions, each with its app; read by the context-menu
  // handler through a ref, so new answers do not re-create it.
  const companionActions = useMemo(
    () =>
      onlineCompanions.flatMap((companion) =>
        companion.actions.map((action) => ({
          ...action,
          companionId: companion.id,
          companionName: companion.name,
        }))
      ),
    [onlineCompanions]
  );
  const companionActionsRef = useRef(companionActions);
  companionActionsRef.current = companionActions;
  const companionPanels = useMemo(
    () =>
      companions.map(({ id, name, actions, status }) => ({ id, name, actions, status })),
    [companions]
  );
  // One chip per app on a card, the same array while it reads the same.
  const companionChipsFor = useMemo(() => createCompanionChipCache(), []);
  // A card's one-click buttons, the same array while they read the same.
  const companionQuickActionsFor = useMemo(() => createCompanionQuickActionCache(), []);
  const companionsRef = useRef(companions);
  companionsRef.current = companions;

  const {
    filters,
    setFiltersOpen,
    isFiltersOpen,
    updateFilters,
    resetFilters,
    filteredVideos,
    companionUnchecked,
    filtersActiveCount,
    ratingSummary,
    resolutionSummary,
    handleRemoveIncludeFilter,
    handleRemoveExcludeFilter,
    clearReviewFilter,
    clearVersionFilter,
    promptSearch,
    mightBe,
    workflowSearch,
  } = useFilterState({
    videos,
    filtersButtonRef,
    filtersPopoverRef,
    generationVersionIndex,
    tagHierarchy,
    companions,
    // Workflows are read with generation keys; ask again as that goes on.
    workflowRefreshKey: `${generationIndex.status?.running ? 1 : 0}:${
      generationIndex.status?.processed || 0
    }`,
  });
  // Which tags can be suggested, for Filters › Might be; asked while Filters
  // is open and again after a tag edit.
  const likelyTagStatus = useLikelyTagStatus({
    enabled: isFiltersOpen,
    revision: tagRefreshToken,
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

  // The grid's random order, shared with the masonry layout so stacks walk
  // exactly the order on screen.
  const randomFallbackSeedRef = useRef(Date.now());
  const randomOrderMap = useMemo(
    () =>
      sortKey === SortKey.RANDOM
        ? buildRandomOrderMap(
            videos.map((video) => video.id),
            randomSeed ?? randomFallbackSeedRef.current
          )
        : null,
    [randomSeed, sortKey, videos]
  );

  // Prompt stacks are runs of neighbours in the grid's order: clips of one
  // prompt, or of alike prompts (Section 7), next to each other. Runs are
  // found in the folder scope before filters, so filters never regroup them
  // and give the "5 of 20" total; a stack stands only for the clips that
  // pass. See docs/architecture/prompt-stacks.md, Section 3.
  const promptsAlike = useSimilarPrompts({
    videos: reviewScopeVideos,
    enabled: stackByPrompt,
    similarity: stackSimilarity,
  });
  const stackRunOrder = useMemo(
    () =>
      stackByPrompt
        ? groupAndSort(reviewScopeVideos, {
            groupByFolders,
            comparator: buildComparator({ sortKey, sortDir, randomOrderMap }),
          })
        : null,
    [groupByFolders, randomOrderMap, reviewScopeVideos, sortDir, sortKey, stackByPrompt]
  );
  const stackRuns = useMemo(
    () =>
      stackRunOrder
        ? buildPromptStacks(stackRunOrder, {
            visible: new Set(scopedFilteredVideos.map((video) => video.id)),
            alike: promptsAlike,
            folderOf: groupByFolders ? folderGroupKey : null,
          })
        : emptyPromptStacks(),
    [groupByFolders, promptsAlike, scopedFilteredVideos, stackRunOrder]
  );
  // Each stack card's header and strip, chosen from its clips' first frames
  // (Section 8). The strips' stills are asked for only for cards on screen,
  // which the layout reports further down.
  const [stripStillIds, setStripStillIds] = useState(NO_STRIP_IDS);
  const stackFrames = useStackFrames({
    stacks: stackRuns.stacks,
    enabled: stackByPrompt,
    stillIds: stripStillIds,
    resetKey: `${activeRootPath || ""}\u0000${tagCollection?.loadedAt || ""}`,
  });
  const promptStacks = useMemo(
    () => applyStackFaces(stackRuns, stackFrames.hashOf),
    [stackFrames.hashOf, stackRuns]
  );
  // An open stack follows its clips when runs re-form (alike prompts arrive,
  // a clip is added): it is whichever stack now holds them.
  const openStackMemberIdsRef = useRef([]);
  const openStack = useMemo(() => {
    if (!openStackKey) return null;
    const direct = promptStacks.stacks.get(openStackKey);
    if (direct) return direct;
    for (const id of openStackMemberIdsRef.current) {
      const key = promptStacks.keyById.get(id);
      if (key) return promptStacks.stacks.get(key) || null;
    }
    return null;
  }, [openStackKey, promptStacks]);
  if (openStack) openStackMemberIdsRef.current = openStack.members.map((member) => member.id);
  useEffect(() => {
    if (openStack && openStack.key !== openStackKey) setOpenStackKey(openStack.key);
  }, [openStack, openStackKey]);
  // The versions view shows every version whatever the filters and folder:
  // the collection's own clips where it holds them, and guests from main for
  // the rest (generation-versions.md, Section 8).
  const versionViewClips = useMemo(
    () =>
      versionView
        ? buildVersionMembers(versionView.records, {
            videos,
            originId: versionView.originId,
          })
        : null,
    [versionView, videos]
  );
  const reviewPassClips = useMemo(
    () =>
      reviewPass ? buildVersionMembers(reviewPass.records, { videos, originId: null }) : null,
    [reviewPass, videos]
  );
  // Clips shown from outside the open collection: versions and a review
  // pass's clips from folders that are not open.
  const versionGuests = useMemo(() => {
    const versions = versionViewClips?.guests || NO_VERSION_GUESTS;
    const pass = reviewPassClips?.guests || NO_VERSION_GUESTS;
    if (!pass.length) return versions;
    return versions.length ? [...versions, ...pass] : pass;
  }, [reviewPassClips, versionViewClips]);
  useEffect(() => setCompanionGuests(versionGuests), [versionGuests]);
  const versionLabelById = useMemo(() => {
    const labels = new Map();
    versionViewClips?.members.forEach((video, index) => {
      labels.set(video.id, versionCardLabel(index, video));
    });
    return labels;
  }, [versionViewClips]);
  const gridVideos = useMemo(() => {
    if (versionViewClips) return versionViewClips.members;
    // A review pass shows its frozen list, whatever the filters say now.
    if (reviewPassClips) return reviewPassClips.members;
    if (openStack) return openStack.members;
    return collapsePromptStacks(scopedFilteredVideos, promptStacks);
  }, [openStack, promptStacks, reviewPassClips, scopedFilteredVideos, versionViewClips]);
  // Inside an open stack, among versions or in a pass, every clip selects on
  // its own.
  const stackSelectionUnits = useMemo(
    () =>
      openStack || versionView || reviewPass ? null : createStackSelectionUnits(promptStacks),
    [openStack, promptStacks, reviewPass, versionView]
  );
  selectionUnitsRef.current = stackSelectionUnits;
  // A stack is never left partly selected, so an action on it can never
  // touch some of its runs and silently skip the rest.
  useLayoutEffect(() => {
    if (stackSelectionUnits) selection.expandToUnits();
  }, [selection.expandToUnits, stackSelectionUnits]);
  // A stack whose runs are all filtered out or gone closes by itself.
  useEffect(() => {
    if (openStackKey && !openStack) setOpenStackKey(null);
  }, [openStack, openStackKey]);
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
  const reviewProcessingReason = !activeRootPath && tagCollection
    ? "Open a folder to process review results; a library view spans several."
    : isRefreshingFolder
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
      [REVIEW_FILTERS.PICK]: "Accept",
      [REVIEW_FILTERS.REJECT]: "Reject",
    };
    return labels[value] || null;
  }, [filters.reviewFilter]);

  // Folder navigation callbacks reach every folder-tree row, so the selection
  // is read through a ref rather than changing their identity on each click.
  const selectedIdsRef = useRef(selection.selected);
  selectedIdsRef.current = selection.selected;
  const captureFolderViewState = useCallback(() => {
    if (!activeRootPath || folderLocation.rootPath !== activeRootPath) return null;
    return folderViewStateRef.current.set(
      activeRootPath,
      currentDirectory,
      folderScope,
      {
        scrollTop: scrollContainerRef.current?.scrollTop || 0,
        selectedIds: selectedIdsRef.current,
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

    // "Go to folder" from a library view lands on its clip, once.
    const revealId =
      snapshot?.revealId != null && videos.some((video) => video.id === snapshot.revealId)
        ? snapshot.revealId
        : null;
    if (snapshot?.revealId != null) {
      folderViewStateRef.current.clearReveal(activeRootPath, currentDirectory, folderScope);
    }
    const scrollTop = snapshot?.scrollTop || 0;
    const applyScroll = () => {
      if (revealId != null && revealScrollRef.current?.(revealId, { align: "center" })) {
        return;
      }
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = scrollTop;
    };
    if (typeof requestAnimationFrame !== "function") {
      applyScroll();
      return undefined;
    }
    const firstFrame = requestAnimationFrame(() => {
      const secondFrame = requestAnimationFrame(() => {
        applyScroll();
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
      // Content fingerprints repeat across profiles; what was turned down
      // in one is not turned down in the next.
      resetTurnedDownTags();
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
    filteredVideos: gridVideos,
    sortKey,
    sortDir,
    groupByFolders,
    randomSeed,
    randomOrderMap,
    gridLayout,
    zoomLevel,
    scrollContainerRef,
    gridRef,
    scrollContainerElement,
    gridElement,
    comparison: Boolean(versionView),
    // A pass keeps the order it was frozen in.
    keepOrder: Boolean(reviewPass),
  });
  fullOrderedVideosRef.current = orderedVideos;
  revealScrollRef.current = scrollToId;

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
  // Versions from folders that are not open count as clips while they are
  // shown, so they can be selected, rated, tagged and acted on.
  const allVideosById = useMemo(() => {
    const map = new Map(videos.map((video) => [video.id, video]));
    for (const guest of versionGuests) {
      if (!map.has(guest.id)) map.set(guest.id, guest);
    }
    return map;
  }, [versionGuests, videos]);
  const allVideoIds = useMemo(() => new Set(allVideosById.keys()), [allVideosById]);

  // Sibling versions are named by catalog instance id; resolve them to clips
  // in this collection and say why one cannot be revealed.
  const videoIdByInstanceId = useMemo(() => {
    const map = new Map();
    videos.forEach((video) => {
      if (video?.instanceId) map.set(video.instanceId, video.id);
    });
    versionGuests.forEach((video) => {
      if (video?.instanceId && !map.has(video.instanceId)) map.set(video.instanceId, video.id);
    });
    return map;
  }, [versionGuests, videos]);
  const resolveVersionTarget = useCallback(
    (instanceId) => {
      const id = videoIdByInstanceId.get(instanceId);
      if (!id) return "elsewhere";
      return videosById.has(id) ? "available" : "filtered";
    },
    [videoIdByInstanceId, videosById]
  );
  const gridGenerationVersions = useMemo(
    () => ({
      index: generationVersionIndex,
      resolveTarget: resolveVersionTarget,
      // The details panel's way into the versions view, unless it is open.
      onOpenView: versionView
        ? null
        : (videoId) => {
            void handleOpenVersionsRef.current?.(videoId);
          },
      onSelect: (instanceId) => {
        const id = videoIdByInstanceId.get(instanceId);
        if (!id || !videosById.has(id)) return;
        selection.selectExactly(id);
        scrollToId(id, { align: "center" });
      },
    }),
    [
      generationVersionIndex,
      resolveVersionTarget,
      scrollToId,
      selection.selectExactly,
      versionView,
      videoIdByInstanceId,
      videosById,
    ]
  );
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

  const selectedVideosRef = useRef(selectedVideos);
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

    // Docked Details follows the selection the way the floating panel does:
    // a new selection brings its tab forward unless the user went back to
    // the Library for this one. Generation, the other clip panel, stays put,
    // so prompts can be read clip after clip. A hidden sidebar stays hidden.
    if (metadataInspectorMode === "docked") {
      setMetadataPanelOpen(false);
      if (
        metadataSelectionKey !== previousKey &&
        metadataDismissedSelectionKey !== metadataSelectionKey
      ) {
        previousMetadataSelectionKeyRef.current = metadataSelectionKey;
        setMetadataDismissedSelectionKey(null);
        if (isLibrarySidebarOpen) {
          setWorkspaceSidebarTab((tab) => (tab === "generation" ? tab : "details"));
        }
      }
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
    isLibrarySidebarOpen,
    metadataAnchorId,
    metadataDismissedSelectionKey,
    metadataInspectorMode,
    metadataSelectionKey,
    selection.size,
  ]);

  const handleWorkspaceSidebarTabChange = useCallback(
    (tab) => {
      setWorkspaceSidebarTab(tab);
      if (tab === "library" && metadataInspectorMode === "docked" && selection.size > 0) {
        setMetadataDismissedSelectionKey(metadataSelectionKey);
      }
    },
    [metadataInspectorMode, metadataSelectionKey, selection.size]
  );

  // The rail's icons open their panel; the open panel's icon collapses the
  // sidebar (WorkspaceSidebar calls onCollapse for that).
  const handleSidebarPanelSelect = useCallback(
    (panel) => {
      setLibrarySidebarOpen(true);
      handleWorkspaceSidebarTabChange(panel);
    },
    [handleWorkspaceSidebarTabChange]
  );

  const sortStatus = useMemo(
    () => describeSort(sortKey, sortDir, groupByFolders),
    [sortKey, sortDir, groupByFolders]
  );

  // Simple toast used by actions layer
  const notify = useCallback((message, type = "info") => {
    showToast(message, type);
  }, []);

  // Sending to a companion app's action in one click
  // (docs/architecture/companion-app.md): when the dry run says every clip
  // would be sent, they are, with a toast; one clip that would not be says
  // why; several with some skipped or refused open the send dialog.
  const handleCompanionSend = useCallback(
    async ({ companion, action, videos: targets }) => {
      const { instanceIds } = companionRowsOf(targets);
      if (!instanceIds.length) {
        notify("Only indexed local clips can be sent", "info");
        return;
      }
      if (instanceIds.length > COMPANION_SEND_CHUNK) {
        notify(`Checking ${instanceIds.length.toLocaleString()} clips with ${companion.name}…`, "info");
      }
      const outcome = await sendWithoutReview({
        companionId: companion.id,
        actionId: action.id,
        instanceIds,
      });
      const owner = companionsRef.current.find((entry) => entry.id === companion.id);
      if (outcome.status === "sent") {
        owner?.refresh?.(outcome.rows);
        const summary = summarizeSendResults(outcome.final);
        const estimate = formatEstimate(summary.estimate);
        notify(
          `${action.label}: sent ${summary.sent.toLocaleString()} clip${summary.sent === 1 ? "" : "s"}${
            estimate ? ` (${estimate})` : ""
          }`,
          "success"
        );
      } else if (outcome.status === "review") {
        if (instanceIds.length === 1) {
          const entry = outcome.dry.get(instanceIds[0]);
          notify(
            `${action.label}: ${entry?.result === "skipped" ? "skipped" : "not sent"}${
              entry?.why ? ` · ${entry.why}` : ""
            }`,
            "info"
          );
        } else {
          setCompanionSend({ companion, action, videos: targets });
        }
      } else {
        notify(`${companion.name || "The companion app"}: ${outcome.error}`, "error");
      }
    },
    [notify]
  );
  // A card's one-click button: that clip, that app's action. Cards get a
  // stable callback.
  const handleQuickActionRef = useRef(null);
  handleQuickActionRef.current = (videoId, companionId, actionId) => {
    const action = companionActionsRef.current.find(
      (entry) => entry.companionId === companionId && entry.id === actionId
    );
    const video = allVideosById.get(videoId);
    if (!action || !video) return;
    void handleCompanionSend({
      companion: { id: companionId, name: action.companionName },
      action,
      videos: [video],
    });
  };
  const handleQuickAction = useCallback(
    (videoId, companionId, actionId) => handleQuickActionRef.current?.(videoId, companionId, actionId),
    []
  );

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
      // A review pass is its own scope: entering or leaving one starts a new
      // undo history.
      reviewPass?.id ?? null,
    ]),
    [
      activeRootPath,
      currentDirectory,
      folderScope,
      reviewPass?.id,
      reviewProfileEpoch,
      webCollectionEpoch,
    ]
  );


  // Edits reach versions from folders that are not open too: every list-wide
  // update (metadata, trash) is an updater over the clip list, applied to the
  // versions view's records as well.
  const setVideosAndVersions = useCallback(
    (update) => {
      setVideos(update);
      if (typeof update !== "function") return;
      setVersionView((previous) =>
        previous?.records?.length
          ? { ...previous, records: update(previous.records) }
          : previous
      );
      setReviewPass((previous) =>
        previous?.records?.length
          ? { ...previous, records: update(previous.records) }
          : previous
      );
    },
    [setVideos]
  );

  const {
    handleAddTags: applyAddTags,
    handleRemoveTag: applyRemoveTag,
    handleSetRating,
    handleSetReviewState,
    handleRestoreReviewMetadata,
    handleApplyExistingTag: applyExistingTag,
    handleSetTagParent: setTagParent,
    refreshTagList,
  } = useMetadataActions({
    selectedFingerprints,
    setVideos: setVideosAndVersions,
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
    // In a review pass, progress, targets and advancing are the pass's.
    scopeVideos: reviewPassClips ? reviewPassClips.members : reviewScopeVideos,
    // Every version shown, even one outside the folder scope or the folder.
    extraVideos: versionViewClips?.members || NO_VERSION_GUESTS,
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
    selectionUnitsRef,
  });

  // ----- Prompt stacks: toggle, open, step and close ------------------------
  // See docs/architecture/prompt-stacks.md, Sections 3 to 5.

  // The order of stacks in the collapsed grid, kept while that grid is shown
  // so an open stack can step to its neighbours.
  const collapsedStackOrder = useMemo(
    () => (stackByPrompt && !openStack ? stackOrderOf(orderedVideos, promptStacks) : null),
    [openStack, orderedVideos, promptStacks, stackByPrompt]
  );
  const collapsedStackOrderRef = useRef([]);
  if (collapsedStackOrder) collapsedStackOrderRef.current = collapsedStackOrder;
  const pendingStackRevealRef = useRef(null);

  const toggleStackByPrompt = useCallback(() => {
    setOpenStackKey(null);
    setStackByPrompt((previous) => {
      const next = !previous;
      window.electronAPI?.saveSettingsPartial?.({ stackByPrompt: next });
      return next;
    });
  }, []);

  const handleGridLayoutChange = useCallback((value) => {
    const next = value === "rows" ? "rows" : "masonry";
    setGridLayout(next);
    window.electronAPI?.saveSettingsPartial?.({ gridLayout: next });
  }, []);

  // Choosing how alike prompts must be also turns stacking on.
  const handleStackSimilarityChange = useCallback((value) => {
    const next = normalizeStackSimilarity(value);
    setOpenStackKey(null);
    setStackSimilarityState(next);
    setStackByPrompt(true);
    window.electronAPI?.saveSettingsPartial?.({
      stackSimilarity: next,
      stackByPrompt: true,
    });
  }, []);

  // A clip to bring into view once an opened stack is laid out.
  const pendingStackFocusRef = useRef(null);
  const showStack = useCallback(
    (key, focusId = null) => {
      const stack = promptStacks.stacks.get(key);
      if (!stack) return false;
      setOpenStackKey(key);
      // Inside a stack each run selects on its own. The units go now rather
      // than at the next render, so the chosen clip is selected alone and
      // becomes the anchor for shift-range selection inside the stack.
      selectionUnitsRef.current = null;
      const focus = stack.members.some((member) => member.id === focusId) ? focusId : null;
      selection.selectExactly(focus ?? stack.cover.id);
      pendingStackFocusRef.current = focus;
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      return true;
    },
    [promptStacks, selection.selectExactly]
  );

  // Opens the stack a collapsed card stands for; false for any other card.
  // `focusId` opens it at one of its clips (a still in the card's strip).
  const handleOpenStack = useCallback(
    (videoId, focusId = null) => {
      if (openStackKey) return false;
      const key = promptStacks.keyById.get(videoId);
      if (!key) return false;
      setOpenStackOrder(collapsedStackOrderRef.current);
      return showStack(key, focusId);
    },
    [openStackKey, promptStacks, showStack]
  );

  // Cards get a stable callback, so stacks recomputing on every metadata
  // update never re-renders every mounted card.
  const handleOpenStackRef = useRef(handleOpenStack);
  handleOpenStackRef.current = handleOpenStack;
  const handleOpenStackFromCard = useCallback(
    (videoId, focusId) => handleOpenStackRef.current(videoId, focusId),
    []
  );

  const handleStepStack = useCallback(
    (direction) => {
      if (!openStackKey) return;
      const next = neighbouringStack(
        openStackOrder,
        openStackKey,
        direction,
        promptStacks.stacks
      );
      if (!next) {
        notify(direction < 0 ? "This is the first stack" : "This is the last stack", "info");
        return;
      }
      showStack(next);
    },
    [notify, openStackKey, openStackOrder, promptStacks, showStack]
  );

  const handleCloseStack = useCallback(() => {
    if (!openStackKey) return;
    const cover = promptStacks.stacks.get(openStackKey)?.cover;
    setOpenStackKey(null);
    if (!cover) return;
    // Back in the collapsed grid the stack's card is selected again, widened
    // to the whole stack once its units return, and scrolled into view once
    // it is laid out.
    selection.selectExactly(cover.id);
    pendingStackRevealRef.current = cover.id;
  }, [openStackKey, promptStacks, selection.selectExactly]);

  useEffect(() => {
    const id = pendingStackRevealRef.current;
    if (id == null || openStack) return;
    if (!orderedVideos.some((video) => video.id === id)) return;
    pendingStackRevealRef.current = null;
    scrollToId(id, { align: "center" });
  }, [openStack, orderedVideos, scrollToId]);

  // A stack opened at one of its clips brings that clip into view.
  useEffect(() => {
    const id = pendingStackFocusRef.current;
    if (id == null || !openStack) return;
    if (!orderedVideos.some((video) => video.id === id)) return;
    pendingStackFocusRef.current = null;
    scrollToId(id, { align: "center" });
  }, [openStack, orderedVideos, scrollToId]);

  // ----- Versions side by side -------------------------------------------
  // See docs/architecture/generation-versions.md, Section 8.
  const versionRequestRef = useRef(0);
  const pendingVersionRevealRef = useRef(null);
  const handleOpenVersions = useCallback(
    async (videoId) => {
      const origin = allVideosById.get(videoId);
      const api = window.electronAPI?.generationVersions;
      if (!origin?.instanceId || typeof api?.open !== "function") return false;
      const request = ++versionRequestRef.current;
      setVersionView({ originId: videoId, records: [], status: "loading", truncated: false });
      // Each version selects on its own; the clip it was opened from starts
      // selected.
      selectionUnitsRef.current = null;
      selection.selectExactly(videoId);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
      let result = null;
      try {
        result = await api.open(origin.instanceId);
      } catch (error) {
        result = { success: false, error: error?.message || String(error) };
      }
      if (request !== versionRequestRef.current) return true;
      if (!result || result.success === false) {
        notify("The other versions could not be read", "error");
        setVersionView((previous) =>
          previous?.originId === videoId ? { ...previous, status: "failed" } : previous
        );
        return true;
      }
      const seen = new Set();
      const records = [];
      for (const record of Array.isArray(result.records) ? result.records : []) {
        const video = normalizeVideoFromMain(record);
        if (video?.id == null || seen.has(video.id)) continue;
        seen.add(video.id);
        records.push(video);
      }
      setVersionView((previous) =>
        previous?.originId === videoId
          ? { ...previous, records, status: "ready", truncated: result.truncated === true }
          : previous
      );
      return true;
    },
    [allVideosById, notify, selection.selectExactly]
  );
  // Cards get a stable callback, as for stacks.
  handleOpenVersionsRef.current = handleOpenVersions;
  const handleOpenVersionsFromCard = useCallback((videoId) => {
    void handleOpenVersionsRef.current(videoId);
  }, []);

  // Back to the grid it was opened from, with that clip (or the collapsed
  // stack holding it) selected and in view.
  const handleCloseVersions = useCallback(() => {
    if (!versionView) return;
    versionRequestRef.current += 1;
    const originId = versionView.originId;
    setVersionView(null);
    if (originId == null || !videos.some((video) => video.id === originId)) return;
    selection.selectExactly(originId);
    const stackKey = stackByPrompt && !openStack ? promptStacks.keyById.get(originId) : null;
    pendingVersionRevealRef.current =
      (stackKey && promptStacks.stacks.get(stackKey)?.cover?.id) ?? originId;
  }, [openStack, promptStacks, selection.selectExactly, stackByPrompt, versionView, videos]);

  useEffect(() => {
    const id = pendingVersionRevealRef.current;
    if (id == null || versionView) return;
    pendingVersionRevealRef.current = null;
    if (orderedVideos.some((video) => video.id === id)) scrollToId(id, { align: "center" });
  }, [orderedVideos, scrollToId, versionView]);

  // Another folder, scope or collection closes the view, as it closes a
  // stack; so does every version going away.
  const versionCollectionKey = `${activeRootPath || ""}\u0000${currentDirectory || ""}\u0000${folderScope}\u0000${
    tagCollection?.loadedAt || ""
  }`;
  const versionCollectionKeyRef = useRef(versionCollectionKey);
  useEffect(() => {
    if (versionCollectionKeyRef.current === versionCollectionKey) return;
    versionCollectionKeyRef.current = versionCollectionKey;
    versionRequestRef.current += 1;
    setVersionView(null);
    // A review pass closes too; it stays listed to resume.
    setReviewPass(null);
  }, [versionCollectionKey]);
  useEffect(() => {
    if (versionView && versionView.status !== "loading" && versionViewClips?.members.length === 0) {
      setVersionView(null);
    }
  }, [versionView, versionViewClips]);

  // Every version back to its first frame at once, to compare the same
  // moment.
  const handleRestartVersions = useCallback(() => {
    const cards = gridRef.current?.querySelectorAll?.(".video-item video") || [];
    for (const element of cards) {
      try {
        element.currentTime = 0;
      } catch {
        // A card between sources has nothing to rewind.
      }
    }
  }, []);

  // The stills wanted now: the strips of stack cards that are mounted.
  useEffect(() => {
    const ids = [];
    if (stackSelectionUnits) {
      for (const item of virtualItems) {
        const stack = promptStacks.stacks.get(promptStacks.keyById.get(item.id));
        if (!stack || stack.cover?.id !== item.id) continue;
        for (const member of stack.strip || []) {
          const id = Number(member.instanceId);
          if (Number.isSafeInteger(id) && id > 0) ids.push(id);
        }
      }
    }
    ids.sort((a, b) => a - b);
    setStripStillIds((previous) =>
      previous.length === ids.length && previous.every((id, at) => id === ids[at])
        ? previous
        : ids.length
          ? ids
          : NO_STRIP_IDS
    );
  }, [promptStacks, stackSelectionUnits, virtualItems]);

  // Each stack card's strip as one array that only changes when its clips or
  // stills do, so memoized cards skip renders.
  const stripCacheRef = useRef(new Map());
  const stackStripFor = (stack) => {
    if (!stack?.strip?.length) return null;
    // Each still with what plays it on hover (StackPeek): the clip's catalog
    // row and opaque media source, for local files only.
    const value = stack.strip.map((member) => ({
      id: member.id,
      src: stackFrames.stillOf(member),
      instanceId: member.isElectronFile ? member.instanceId ?? null : null,
      sourceUrl: member.isElectronFile ? getOpaqueMediaSource(member) : null,
    }));
    const signature = value
      .map((still) => `${still.id}\u0000${still.src ? still.src.length : 0}\u0000${still.sourceUrl || ""}`)
      .join("\u0001");
    const cached = stripCacheRef.current.get(stack.key);
    if (cached?.signature === signature) return cached.value;
    if (stripCacheRef.current.size > 2000) stripCacheRef.current.clear();
    stripCacheRef.current.set(stack.key, { signature, value });
    return value;
  };

  // Another folder, scope or collection is a different set of stacks.
  useEffect(() => {
    setOpenStackKey(null);
  }, [activeRootPath, currentDirectory, folderScope, tagCollection]);

  const openStackUnreviewed = useMemo(
    () => (openStack ? unreviewedStackFingerprints(openStack) : []),
    [openStack]
  );
  // Pick the best run, then reject the rest: one undoable step that leaves
  // picks, ratings and earlier rejects alone.
  const handleRejectUnreviewedInStack = useCallback(() => {
    if (!openStack || !reviewModeEnabled) return;
    const fingerprints = openStackUnreviewed;
    if (fingerprints.length === 0) {
      notify("Every run in this stack already has a decision", "info");
      return;
    }
    void reviewWorkflow
      .applyReviewState(REVIEW_STATES.REJECT, { fingerprints, allowAdvance: false })
      .then((applied) => {
        if (applied) {
          notify(
            `Rejected ${fingerprints.length} unreviewed run${fingerprints.length === 1 ? "" : "s"} · Z undoes`,
            "success"
          );
        }
      });
  }, [notify, openStack, openStackUnreviewed, reviewModeEnabled, reviewWorkflow.applyReviewState]);

  const openStackSummary = useMemo(() => {
    if (!openStack) return null;
    const live = openStackOrder.filter((key) => promptStacks.stacks.has(key));
    const seeds = new Set(
      openStack.members.map((video) => video.generationKey).filter(Boolean)
    ).size;
    const prompts = new Set(openStack.members.map((video) => video.promptKey)).size;
    return {
      position: live.indexOf(openStack.key) + 1,
      count: live.length,
      runs: openStack.members.length,
      total: openStack.total,
      seeds,
      prompts,
      hasPrevious:
        neighbouringStack(openStackOrder, openStack.key, -1, promptStacks.stacks) != null,
      hasNext:
        neighbouringStack(openStackOrder, openStack.key, 1, promptStacks.stacks) != null,
    };
  }, [openStack, openStackOrder, promptStacks]);

  // Enter on exactly one selected stack opens it.
  const handleOpenSelectedStack = useCallback(
    (selected) => {
      if (!stackSelectionUnits || !(selected instanceof Set)) return false;
      const id = singleSelectionUnit(selected, stackSelectionUnits);
      return id != null && handleOpenStack(id);
    },
    [handleOpenStack, stackSelectionUnits]
  );

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
    setVideos: setVideosAndVersions,
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
        throw new Error("Transfer is unavailable");
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
    async (
      tags,
      matchMode = "all",
      { minRating = null, exactRating = null, promptQuery = "", mightBe = "" } = {}
    ) => {
      const requested = (Array.isArray(tags) ? tags : [])
        .map((tag) => (tag ?? "").toString().trim())
        .filter(Boolean);
      // A rating, prompt words and a tag clips might be narrow the search as
      // tags do.
      const rating = {
        minRating,
        exactRating,
        promptQuery: (promptQuery || "").trim(),
        mightBe: (mightBe || "").trim(),
      };

      // With nothing to narrow it, a library search is the whole library, up
      // to main's record cap; past the cap it keeps the newest clips and says
      // so.
      const snapshot = window.electronAPI?.library?.taggedSnapshot;
      if (typeof snapshot !== "function") {
        notify("Tag views are unavailable", "error");
        return false;
      }
      try {
        const result = await snapshot(requested, matchMode, rating);
        // A refused read is not an empty library. Reporting "no clips" for a
        // search that never ran sends the user hunting for missing tags
        // instead of telling them the search itself failed.
        if (result?.success === false) {
          throw new Error(result.error || "The library could not be searched");
        }
        const records = Array.isArray(result?.records) ? result.records : [];
        openTagCollection({
          tags: requested,
          matchMode,
          ...rating,
          records,
          truncated: Boolean(result?.truncated),
        });
        if (result?.truncated) {
          notify(
            `Showing the ${Number(
              result.recordLimit || records.length
            ).toLocaleString()} newest matching clips`,
            "info"
          );
        } else if (!records.length) {
          notify(emptyTagSearchMessage(requested, matchMode, rating), "info");
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
    if (!tagCollection) return false;
    return loadTagCollection(tagCollection.tags, tagCollection.matchMode, {
      minRating: tagCollection.minRating ?? null,
      exactRating: tagCollection.exactRating ?? null,
      promptQuery: tagCollection.promptQuery || "",
      mightBe: tagCollection.mightBe || "",
    });
  }, [loadTagCollection, tagCollection]);

  const tagViewRefreshRef = useRef(refreshTagCollection);
  tagViewRefreshRef.current = refreshTagCollection;
  const seenTagRefreshRef = useRef(tagRefreshToken);
  useEffect(() => {
    // Only an actual edit re-reads the view; mounting must not re-query.
    if (seenTagRefreshRef.current === tagRefreshToken) return;
    seenTagRefreshRef.current = tagRefreshToken;
    tagViewRefreshRef.current?.();
  }, [tagRefreshToken]);

  const handleSearchScopeChange = useCallback(
    async (nextScope) => {
      const scope = nextScope === "library" ? "library" : "folder";
      if (scope === librarySearchScope) return;
      if (scope === "library") {
        // Remember where this was entered from before the root is cleared.
        folderScopeReturnRef.current = activeRootPath || null;
        setLibrarySearchScope("library");
        const criteria = librarySearchCriteria(filters);
        await loadTagCollection(criteria.tags, criteria.matchMode, criteria);
        return;
      }
      setLibrarySearchScope("folder");
      const returnTo = folderScopeReturnRef.current;
      folderScopeReturnRef.current = null;
      // Read through a ref: the folder opener is declared much later in this
      // component, so naming it as a dependency here would be a use-before-init.
      if (returnTo) await openLibraryRootRef.current?.(returnTo);
    },
    [activeRootPath, filters, librarySearchScope, loadTagCollection]
  );

  const libraryCriteria = useMemo(() => librarySearchCriteria(filters), [filters]);

  // Tags and the rating narrow the library query itself rather than only the
  // loaded grid, so changing them while searching the library re-runs the read.
  const includeTagsKey = librarySearchKey(libraryCriteria);
  const lastLibraryTagsRef = useRef(includeTagsKey);
  const lastLibraryRequestRef = useRef(librarySearchRequest);
  useEffect(() => {
    if (librarySearchScope !== "library") {
      lastLibraryTagsRef.current = includeTagsKey;
      lastLibraryRequestRef.current = librarySearchRequest;
      return;
    }
    if (
      lastLibraryTagsRef.current === includeTagsKey &&
      lastLibraryRequestRef.current === librarySearchRequest
    ) {
      return;
    }
    lastLibraryTagsRef.current = includeTagsKey;
    lastLibraryRequestRef.current = librarySearchRequest;
    loadTagCollection(libraryCriteria.tags, libraryCriteria.matchMode, libraryCriteria);
  }, [
    libraryCriteria,
    includeTagsKey,
    librarySearchRequest,
    librarySearchScope,
    loadTagCollection,
  ]);

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
        throw new Error("Transfer is unavailable");
      }
      setAcceptedCopyProgress(null);
      const transferMode =
        requestedMode === "move" || requestedMode === "link" ? requestedMode : "copy";
      const words = {
        copy: ["Copy", "Copied", "copied"],
        move: ["Move", "Moved", "moved"],
        link: ["Link", "Linked", "linked"],
      }[transferMode];
      const actionLabel = words[0];
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
          // Shared by the review flow and a plain selection, so it does not say
          // "accepted".
          `${words[1]} ${copiedMedia.toLocaleString()} clip(s)`,
          "success"
        );
      } else if (
        copiedMedia > 0 ||
        skipped > 0 ||
        failed > 0 ||
        missing > 0
      ) {
        notify(
          `${actionLabel} finished with issues: ${copiedMedia.toLocaleString()} clip(s) ${words[2]}, ${skipped.toLocaleString()} skipped, ${(failed + missing).toLocaleString()} unavailable or failed`,
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

  // A clip's embedded workflow in a ComfyUI window of its own
  // (docs/architecture/comfy-workflow-window.md).
  const handleOpenWorkflow = useCallback(
    async (video) => {
      const instanceId = Number(video?.instanceId);
      const openWorkflow = window.electronAPI?.comfy?.openWorkflow;
      if (!Number.isSafeInteger(instanceId) || instanceId <= 0) return;
      if (typeof openWorkflow !== "function") return;
      let result;
      try {
        result = await openWorkflow(instanceId);
      } catch (error) {
        result = { success: false, error: error?.message };
      }
      if (result?.success) return;
      notify(
        result?.code === "COMFY_UNAVAILABLE"
          ? "ComfyUI is not answering. Start it, or set its address in Preferences › ComfyUI."
          : result?.error || "The workflow could not be opened",
        "error"
      );
    },
    [notify]
  );

  const handleContextAction = useCallback(
    (actionId) => {
      if (!actionId) return;
      if (actionId === "library:go-to-folder") {
        // Declared further down, so reached through a ref.
        const video = getById(contextMenu.contextId);
        if (video) void goToFolderRef.current?.(video);
        return;
      }
      if (actionId === "comfy:open-workflow") {
        const video = getById(contextMenu.contextId);
        if (video) void handleOpenWorkflow(video);
        return;
      }
      if (actionId.startsWith("companion:send:")) {
        const action = companionActionsRef.current.find(
          (entry) => `companion:send:${entry.companionId}:${entry.id}` === actionId
        );
        const ids =
          selection.size > 1 ? [...selection.selected] : [contextMenu.contextId];
        const targets = ids.map((id) => getById(id)).filter(Boolean);
        if (action && targets.length) {
          void handleCompanionSend({
            companion: { id: action.companionId, name: action.companionName },
            action,
            videos: targets,
          });
        }
        return;
      }
      if (actionId === "likely-tag:accept" || actionId === "likely-tag:dismiss") {
        // Working through Filters › Might be: either way the clips leave it.
        const tag = (filters.mightBe || "").trim();
        const targets = contextMetadataFingerprints;
        if (!tag || !targets.length) return;
        if (actionId === "likely-tag:accept") {
          void handleApplyExistingTag(tag, targets);
          return;
        }
        void turnDownLikelyTag(targets, tag).then((result) =>
          result.success
            ? notify(`Won't suggest "${tag}" for ${targets.length} item(s) again`, "success")
            : notify("Could not turn the suggestion down", "error")
        );
        return;
      }
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
      handleOpenWorkflow,
      reviewWorkflow.applyRating,
      reviewWorkflow.applyReviewState,
      reviewModeEnabled,
      handleApplyExistingTag,
      filters.mightBe,
      notify,
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
  const fullscreenGenerationVersions = useMemo(
    () => ({
      ...gridGenerationVersions,
      onSelect: (instanceId) => {
        const id = videoIdByInstanceId.get(instanceId);
        if (!id || !videosById.has(id)) return;
        if (fullscreenController.goTo(id)) selection.selectExactly(id);
      },
    }),
    [
      fullscreenController.goTo,
      gridGenerationVersions,
      selection.selectExactly,
      videoIdByInstanceId,
      videosById,
    ]
  );
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
  // Reading a clip's embedded graph costs a file read, so it runs only while
  // the generation details are on screen: the Generation panel when Details
  // is docked, or the expanded section at the foot of floating Details.
  const generationDetailsVisible =
    metadataInspectorMode === "floating"
      ? isMetadataPanelOpen && metadataGenerationExpanded
      : isLibrarySidebarOpen && workspaceSidebarTab === "generation";
  const generationMetadata = useGenerationMetadata({
    instanceId: selectedGenerationInstanceId,
    enabled: Boolean(
      !fullScreenVideo &&
        generationDetailsVisible &&
        selectedGenerationInstanceId
    ),
  });
  const generationMetadataState = useMemo(
    () =>
      selectedGenerationInstanceId
        ? {
            ...generationMetadata,
            onRefresh: generationMetadata.refresh,
            onOpenWorkflow: () =>
              handleOpenWorkflow({ instanceId: selectedGenerationInstanceId }),
          }
        : null,
    [generationMetadata, handleOpenWorkflow, selectedGenerationInstanceId]
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
      // Wrapping to the first clip is auto-continue's, and finding nothing to
      // wrap to is not a boundary the viewer asked to hear about.
      if (!candidate) {
        if (direction === "first") return null;
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
            onOpenWorkflow: () =>
              handleOpenWorkflow({ instanceId: fullscreenGenerationInstanceId }),
          }
        : null,
    [fullscreenGenerationInstanceId, fullscreenGenerationMetadata, handleOpenWorkflow]
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
    suspended: workSuspended || Boolean(fullScreenVideo) || gridPlaybackPaused,
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
    playbackSuspended: Boolean(fullScreenVideo) || gridPlaybackPaused,
    workSuspended,
    playbackMode,
    decoderTarget: playbackDecision.target,
    selectedIds: selection.selected,
    centerPriorityIds,
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
  const handleClearRating = useCallback(
    () => reviewWorkflow.applyRating(null),
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

  // Ctrl/⌘+A: every clip the grid shows, on screen or not. A collapsed
  // stack's card stands for all its runs, so they are selected too.
  const handleSelectAll = useCallback(() => {
    if (!orderedVideos.length) return;
    selection.setSelectedIds(orderedVideos.map((video) => video.id));
  }, [orderedVideos, selection.setSelectedIds]);

  // Review pass keys reach handlers defined further down.
  const reviewPassKeysRef = useRef({});

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
    // While a stack is open, the folder keys step between stacks.
    onPreviousFolder: versionView
      ? null
      : openStack
      ? () => handleStepStack(-1)
      : !isLoadingFolder && siblingFolders.previous
        ? () => handlePreviousFolder(siblingFolders.previous)
        : null,
    onNextFolder: versionView
      ? null
      : openStack
      ? () => handleStepStack(1)
      : !isLoadingFolder && siblingFolders.next
        ? () => handleNextFolder(siblingFolders.next)
        : null,
    onToggleStacks: !isLoadingFolder && !versionView ? toggleStackByPrompt : null,
    onOpenStack: stackSelectionUnits ? handleOpenSelectedStack : null,
    // Esc leaves the versions view first, then an open stack.
    onCloseStack: versionView
      ? handleCloseVersions
      : openStack && !isLoadingFolder
        ? handleCloseStack
        : null,
    onRejectUnreviewedInStack:
      openStack && !versionView && reviewModeEnabled ? handleRejectUnreviewedInStack : null,
    onSelectAll: orderedVideos.length ? handleSelectAll : null,
    // Shift+R freezes what is shown into a review pass; Shift+1/2 accept and
    // send to a companion's quick action.
    onStartReviewPass: reviewModeEnabled && !reviewPass
      ? () => reviewPassKeysRef.current.start?.()
      : null,
    onQuickReview: reviewModeEnabled
      ? (index) => reviewPassKeysRef.current.quick?.(index)
      : null,
    onClearSelection: selection.clear,
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
        const savedDirectory = saved?.directory || "";
        const savedScope = saved?.scope || FolderScope.ALL_DESCENDANTS;
        // Opening a root from the library or recent list always starts at the
        // top; only in-root folder navigation restores a scroll offset.
        folderViewStateRef.current.resetScroll(
          authorizedRootPath,
          savedDirectory,
          savedScope
        );
        setFolderLocation({
          rootPath: authorizedRootPath,
          directory: savedDirectory,
          scope: savedScope,
        });
        setExpandedFolderPaths((previous) =>
          expandFolderAncestors(previous, savedDirectory)
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
  openLibraryRootRef.current = handleOpenLibraryRoot;

  // Back and forward between views (mouse buttons 4 and 5, Alt+←/→): the
  // folder, library search or open stack the user came from.
  const viewLocation = useMemo(() => {
    if (!activeRootPath && tagCollection) {
      const library = {
        tags: tagCollection.tags,
        matchMode: tagCollection.matchMode,
        minRating: tagCollection.minRating ?? null,
        exactRating: tagCollection.exactRating ?? null,
        promptQuery: tagCollection.promptQuery || "",
        mightBe: tagCollection.mightBe || "",
      };
      return { library };
    }
    if (!activeRootPath) return null;
    return { rootPath: activeRootPath, directory: currentDirectory, scope: folderScope };
  }, [activeRootPath, currentDirectory, folderScope, tagCollection]);
  const viewLocationKey = viewLocation ? JSON.stringify(viewLocation) : "";
  const currentView = useMemo(
    () => (viewLocation ? { ...viewLocation, stackKey: openStackKey || null } : null),
    [openStackKey, viewLocation]
  );
  // A stack to reopen once its folder or search has loaded.
  const pendingViewStackRef = useRef(null);

  const openStackFromHistory = useCallback(
    (stackKey) => {
      if (!stackKey) {
        if (openStackKey) handleCloseStack();
        return true;
      }
      if (openStackKey === stackKey) return true;
      if (!promptStacks.stacks.has(stackKey)) return false;
      setOpenStackOrder(collapsedStackOrderRef.current);
      showStack(stackKey);
      return true;
    },
    [handleCloseStack, openStackKey, promptStacks, showStack]
  );

  const navigateToView = useCallback(
    (entry) => {
      if (!entry) return;
      const { stackKey = null, ...location } = entry;
      if (JSON.stringify(location) === viewLocationKey) {
        openStackFromHistory(stackKey);
        return;
      }
      pendingViewStackRef.current = {
        locationKey: JSON.stringify(location),
        stackKey,
        since: Date.now(),
      };
      if (location.library) {
        const {
          tags,
          matchMode,
          minRating,
          exactRating,
          promptQuery = "",
          mightBe: mightBeTag = "",
        } = location.library;
        updateFilters({
          includeTags: tags,
          includeTagsMode: matchMode,
          minRating,
          exactRating,
          promptQuery,
          mightBe: mightBeTag,
        });
        if (librarySearchScope !== "library") {
          folderScopeReturnRef.current = activeRootPath || null;
          setLibrarySearchScope("library");
        }
        setLibrarySearchRequest((request) => request + 1);
        return;
      }
      if (librarySearchScope === "library") {
        folderScopeReturnRef.current = null;
        setLibrarySearchScope("folder");
      }
      captureFolderViewState();
      folderViewStateRef.current.setLocation(location.rootPath, location.directory, location.scope);
      restoredFolderViewKeyRef.current = null;
      if (location.rootPath !== activeRootPath) {
        void openLibraryRootRef.current?.(location.rootPath);
        return;
      }
      setFolderLocation({
        rootPath: location.rootPath,
        directory: location.directory,
        scope: location.scope,
      });
      setExpandedFolderPaths((previous) => expandFolderAncestors(previous, location.directory));
      if (location.directory && !recursiveMode) void handleRecursiveChange(true);
    },
    [
      activeRootPath,
      captureFolderViewState,
      handleRecursiveChange,
      librarySearchScope,
      openStackFromHistory,
      recursiveMode,
      updateFilters,
      viewLocationKey,
    ]
  );

  useEffect(() => {
    const pending = pendingViewStackRef.current;
    if (!pending) return;
    if (Date.now() - pending.since > 8000) {
      pendingViewStackRef.current = null;
      return;
    }
    if (pending.locationKey !== viewLocationKey) return;
    if (openStackFromHistory(pending.stackKey)) pendingViewStackRef.current = null;
  }, [openStackFromHistory, viewLocationKey]);

  useViewHistory({
    current: currentView,
    navigate: navigateToView,
    // In fullscreen, back leaves the player first.
    onBack: () => {
      if (!fullScreenVideo) return false;
      closeFullScreenRef.current?.();
      return true;
    },
  });

  // From a library-wide view: leave the search and drop its filters, open
  // the clip's root at the clip's own folder, and land on the clip there,
  // selected and scrolled into view (see the folder-view restore above).
  const handleGoToFolder = useCallback(
    async (video) => {
      const rootPath = typeof video?.rootPath === "string" ? video.rootPath : "";
      if (!rootPath || video?.id == null) return false;
      let canonicalRoot = rootPath;
      try {
        const authorization =
          await window.electronAPI?.library?.authorizeRoot?.(rootPath);
        if (authorization?.success === false) throw new Error(authorization.error);
        canonicalRoot = authorization?.rootPath || rootPath;
      } catch (error) {
        console.error("Failed to open the clip's folder:", error);
        notify("Could not open that clip's folder", "error");
        return false;
      }
      const directory = normalizeRelativePath(video.dirname || "");
      const scope = FolderScope.CURRENT_FOLDER;
      const existing = folderViewStateRef.current.get(canonicalRoot, directory, scope);
      folderViewStateRef.current.set(canonicalRoot, directory, scope, {
        sortKey: existing?.sortKey ?? sortKey,
        sortDir: existing?.sortDir ?? sortDir,
        groupByFolders: existing?.groupByFolders ?? groupByFolders,
        randomSeed: existing?.randomSeed ?? randomSeed,
        filters: createDefaultFilters(),
        selectedIds: [video.id],
        scrollTop: 0,
        revealId: video.id,
      });
      folderScopeReturnRef.current = null;
      setLibrarySearchScope("folder");
      resetFilters();
      // A subfolder is only scanned in recursive mode, as when navigating.
      if (directory && !recursiveMode) await handleRecursiveChange(true);
      await openLibraryRootRef.current?.(canonicalRoot);
      return true;
    },
    [
      groupByFolders,
      handleRecursiveChange,
      notify,
      randomSeed,
      recursiveMode,
      resetFilters,
      sortDir,
      sortKey,
    ]
  );
  goToFolderRef.current = handleGoToFolder;

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

  // The current filters, sort and scope as a smart view's definition: what
  // a smart view saves, and what a review pass started from results keeps.
  const buildCurrentViewDefinition = useCallback(
    () => ({
      version: 1,
      filters: {
        includeTags: filters.includeTags || [],
        excludeTags: filters.excludeTags || [],
        minRating: filters.minRating ?? null,
        exactRating: filters.exactRating ?? null,
        reviewFilter: filters.reviewFilter || REVIEW_FILTERS.ANY,
        // A worklist that loses its resolution bound on save is a different
        // list, so every filter the panel offers is saved.
        includeTagsMode: filters.includeTagsMode === "any" ? "any" : "all",
        minMegapixels: filters.minMegapixels ?? null,
        maxMegapixels: filters.maxMegapixels ?? null,
        versionFilter: normalizeVersionFilter(filters.versionFilter),
        companionFilters: filters.companionFilters || {},
        companionHideSent: filters.companionHideSent === true,
        promptQuery: (filters.promptQuery || "").trim(),
        mightBe: (filters.mightBe || "").trim(),
        // docs/architecture/workflow-filters.md
        minFrameRate: filters.minFrameRate ?? null,
        maxFrameRate: filters.maxFrameRate ?? null,
        minSteps: filters.minSteps ?? null,
        maxSteps: filters.maxSteps ?? null,
        workflowInclude: (filters.workflowInclude || "").trim(),
        workflowExclude: (filters.workflowExclude || "").trim(),
      },
      sort: {
        key: sortKey,
        dir: sortDir,
        groupByFolders,
        randomSeed,
      },
      scope: { mode: folderScope },
      // Saved during a library search, the view searches the library
      // wherever it is applied; otherwise it applies to the open folder.
      searchScope: librarySearchScope === "library" ? "library" : "folder",
    }),
    [filters, folderScope, groupByFolders, librarySearchScope, randomSeed, sortDir, sortKey]
  );

  const handleSaveCurrentView = useCallback(
    async (name) => {
      const definition = buildCurrentViewDefinition();
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
    }, [buildCurrentViewDefinition, createSavedView, notify]
  );

  const handleApplySavedView = useCallback(
    (view) => {
      const definition = view?.definition;
      if (!definition || definition.version !== 1) return;
      closeFullScreenRef.current?.();
      captureFolderViewState();
      // A view stands for all of the filters: one it does not mention (saved
      // before that filter existed, or left unset) is cleared, not kept.
      updateFilters({ ...createDefaultFilters(), ...(definition.filters || {}) });
      setSortKey(definition.sort?.key || SortKey.NAME);
      setSortDir(definition.sort?.dir === "desc" ? "desc" : "asc");
      setGroupByFolders(definition.sort?.groupByFolders !== false);
      setRandomSeed(definition.sort?.randomSeed ?? null);
      selection.clear();
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;

      const nextScope = Object.values(FolderScope).includes(definition.scope?.mode)
        ? definition.scope.mode
        : FolderScope.ALL_DESCENDANTS;
      const searchesLibrary = definition.searchScope === "library";
      if (searchesLibrary) {
        // The same search wherever it is applied from, the home screen
        // included: every indexed root, not the open folder.
        if (librarySearchScope !== "library") {
          folderScopeReturnRef.current = activeRootPath || null;
          setLibrarySearchScope("library");
        }
        setLibrarySearchRequest((request) => request + 1);
      } else if (activeRootPath) {
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
      librarySearchScope,
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

  // ----- Review passes -----------------------------------------------------
  // See docs/architecture/review-passes.md. A pass freezes the clips being
  // looked at (or the selection) in their order; it is kept in the profile to
  // resume, and progress counts it alone.
  const [reviewPassList, setReviewPassList] = useState([]);
  const refreshReviewPasses = useCallback(async () => {
    const list = window.electronAPI?.reviewPasses?.list;
    if (typeof list !== "function") return;
    try {
      const result = await list();
      if (result?.success !== false) {
        setReviewPassList(Array.isArray(result?.passes) ? result.passes : []);
      }
    } catch {
      // Keep the last list.
    }
  }, []);
  useEffect(() => {
    void refreshReviewPasses();
  }, [refreshReviewPasses, reviewProfileEpoch]);

  // The clips a new pass would freeze, in on-screen order: the selection when
  // two or more are selected, else everything the grid shows, a collapsed
  // stack standing for all of its runs.
  const reviewPassCandidates = useCallback(() => {
    const expand = (video) => {
      const key = stackSelectionUnits ? promptStacks.keyById.get(video.id) : null;
      return (key && promptStacks.stacks.get(key)?.members) || [video];
    };
    const chosen = selection.size >= 2 ? selection.selected : null;
    const clips = [];
    for (const video of orderedVideos) {
      for (const member of expand(video)) {
        if (!chosen || chosen.has(member.id)) clips.push(member);
      }
    }
    return { source: chosen ? "selection" : "results", clips };
  }, [orderedVideos, promptStacks, selection.selected, selection.size, stackSelectionUnits]);
  const reviewPassCandidateCount =
    selection.size >= 2
      ? selection.size
      : stackSelectionUnits
        ? scopedFilteredVideos.length
        : orderedVideos.length;

  const pendingPassRevealRef = useRef(null);
  const passCursorRef = useRef(null);
  const showReviewPass = useCallback((pass, records, positions, cursorPosition = 0) => {
    setVersionView(null);
    setReviewPass({ ...pass, records, positions });
    passCursorRef.current = { id: pass.id, position: cursorPosition, dirty: false };
    selectionUnitsRef.current = null;
    const at =
      records.find((record) => (positions.get(record.fingerprint) ?? 0) >= cursorPosition) ||
      records[0];
    pendingPassRevealRef.current = at?.fingerprint || null;
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, []);

  const handleStartReviewPass = useCallback(async () => {
    const api = window.electronAPI?.reviewPasses;
    if (typeof api?.create !== "function") return;
    const { source, clips } = reviewPassCandidates();
    const positions = new Map();
    const records = [];
    for (const video of clips) {
      if (!video?.fingerprint || positions.has(video.fingerprint)) continue;
      positions.set(video.fingerprint, records.length);
      records.push(video);
    }
    if (!records.length) {
      notify("Nothing here can be reviewed as a pass yet", "info");
      return;
    }
    if (records.length > REVIEW_PASS_MAX_CLIPS) {
      notify(
        `A review pass holds at most ${REVIEW_PASS_MAX_CLIPS.toLocaleString()} clips; narrow the search first`,
        "error"
      );
      return;
    }
    const place = tagCollection
      ? "Library search"
      : `${rootDisplayName || "Folder"}${currentDirectory ? ` / ${currentDirectory}` : ""}`;
    let result = null;
    try {
      result = await api.create({
        name: source === "selection" ? `${records.length.toLocaleString()} selected clips` : place,
        source,
        definition: source === "results" ? buildCurrentViewDefinition() : null,
        location: tagCollection ? null : { rootPath: activeRootPath, directory: currentDirectory || "" },
        clips: records.map((video) => ({
          fingerprint: video.fingerprint,
          instanceId: Number.isSafeInteger(Number(video.instanceId)) ? Number(video.instanceId) : null,
        })),
      });
    } catch (error) {
      result = { success: false, error: error?.message };
    }
    if (!result?.pass) {
      notify(result?.error || "The review pass could not be started", "error");
      return;
    }
    showReviewPass(result.pass, records, positions, 0);
    notify(`Reviewing ${records.length.toLocaleString()} clips`, "info");
    void refreshReviewPasses();
  }, [
    activeRootPath,
    buildCurrentViewDefinition,
    currentDirectory,
    notify,
    refreshReviewPasses,
    reviewPassCandidates,
    rootDisplayName,
    showReviewPass,
    tagCollection,
  ]);

  const handleOpenReviewPass = useCallback(
    async (id) => {
      const api = window.electronAPI?.reviewPasses;
      if (typeof api?.open !== "function") return;
      let result = null;
      try {
        result = await api.open(id);
      } catch (error) {
        result = { success: false, error: error?.message };
      }
      if (!result?.pass) {
        notify(result?.error || "That review pass could not be opened", "error");
        void refreshReviewPasses();
        return;
      }
      const positions = new Map();
      const records = [];
      for (const record of Array.isArray(result.records) ? result.records : []) {
        const video = normalizeVideoFromMain(record);
        if (!video?.fingerprint || positions.has(video.fingerprint)) continue;
        const position = Number(record.passPosition);
        positions.set(video.fingerprint, Number.isSafeInteger(position) ? position : records.length);
        records.push(video);
      }
      if (!records.length) {
        notify("None of that pass's clips can be found any more", "info");
        return;
      }
      showReviewPass(result.pass, records, positions, result.pass.cursorPosition || 0);
    },
    [notify, refreshReviewPasses, showReviewPass]
  );

  // Where a pass has got to, saved as the selection moves through it.
  const saveReviewPassCursor = useCallback(() => {
    const cursor = passCursorRef.current;
    if (!cursor?.dirty) return;
    cursor.dirty = false;
    void window.electronAPI?.reviewPasses?.setCursor?.(cursor.id, cursor.position);
  }, []);
  useEffect(() => {
    if (!reviewPass || metadataAnchorId == null) return undefined;
    const fingerprint = allVideosById.get(metadataAnchorId)?.fingerprint;
    const position = fingerprint ? reviewPass.positions.get(fingerprint) : undefined;
    const cursor = passCursorRef.current;
    if (position === undefined || !cursor || cursor.id !== reviewPass.id || cursor.position === position) {
      return undefined;
    }
    cursor.position = position;
    cursor.dirty = true;
    const timer = setTimeout(saveReviewPassCursor, 800);
    return () => clearTimeout(timer);
  }, [allVideosById, metadataAnchorId, reviewPass, saveReviewPassCursor]);

  // A pass opened (or resumed) lands on its clip once it is laid out.
  useEffect(() => {
    const fingerprint = pendingPassRevealRef.current;
    if (!fingerprint || !reviewPassClips) return;
    const target = reviewPassClips.members.find((video) => video.fingerprint === fingerprint);
    if (!target || !orderedVideos.some((video) => video.id === target.id)) return;
    pendingPassRevealRef.current = null;
    selection.selectExactly(target.id);
    scrollToId(target.id, { align: "center" });
  }, [orderedVideos, reviewPassClips, scrollToId, selection.selectExactly]);

  // Done once every clip has a decision; it then leaves the list to resume.
  const reviewPassDone = Boolean(
    reviewPass && reviewWorkflow.progress.total > 0 && reviewWorkflow.progress.unreviewed === 0
  );
  const finishedPassRef = useRef(null);
  useEffect(() => {
    if (!reviewPassDone || finishedPassRef.current === reviewPass?.id) return;
    finishedPassRef.current = reviewPass.id;
    Promise.resolve(window.electronAPI?.reviewPasses?.finish?.(reviewPass.id)).finally(() => {
      void refreshReviewPasses();
    });
  }, [refreshReviewPasses, reviewPass, reviewPassDone]);

  const handleExitReviewPass = useCallback(() => {
    if (!reviewPass) return;
    saveReviewPassCursor();
    setReviewPass(null);
    void refreshReviewPasses();
  }, [refreshReviewPasses, reviewPass, saveReviewPassCursor]);

  // From the end of a pass made from results: the same search again, which
  // now shows what has started matching since.
  const handleRerunReviewPass = useCallback(() => {
    const pass = reviewPass;
    if (!pass?.definition) return;
    setReviewPass(null);
    handleApplySavedView({ name: pass.name, definition: pass.definition });
  }, [handleApplySavedView, reviewPass]);

  const handleDeleteReviewPass = useCallback(
    async (id) => {
      try {
        await window.electronAPI?.reviewPasses?.remove?.(id);
      } catch (error) {
        notify(error?.message || "That review pass could not be removed", "error");
      }
      if (reviewPass?.id === id) setReviewPass(null);
      void refreshReviewPasses();
    },
    [notify, refreshReviewPasses, reviewPass]
  );

  // The first or second quick action the connected apps offer, in their
  // order; a toast says so when there is none.
  const quickActionAt = useCallback(
    (index) => {
      const action = companionActionsRef.current.filter((entry) => entry.quick === true)[index];
      if (!action) {
        notify(
          index === 0
            ? "No connected app offers a quick action"
            : "No connected app offers a second quick action",
          "info"
        );
      }
      return action || null;
    },
    [notify]
  );

  // Shift+1 / Shift+2: accept the selection and send it to the first or
  // second quick action the connected apps offer, in their order.
  const handleQuickReview = useCallback(
    (index) => {
      if (!reviewModeEnabled) return;
      const action = quickActionAt(index);
      if (!action) return;
      const targets = [...selection.selected].map((id) => allVideosById.get(id)).filter(Boolean);
      if (!targets.length) return;
      void handleCompanionSend({
        companion: { id: action.companionId, name: action.companionName },
        action,
        videos: targets,
      });
      void reviewWorkflow.applyReviewState(REVIEW_STATES.PICK);
    },
    [
      allVideosById,
      handleCompanionSend,
      quickActionAt,
      reviewModeEnabled,
      reviewWorkflow.applyReviewState,
      selection.selected,
    ]
  );

  reviewPassKeysRef.current = { start: handleStartReviewPass, quick: handleQuickReview };

  // The status line on companion apps: any not answering, and the clips a
  // phase filter hides while they wait for an app's answer.
  const companionNote = useMemo(() => {
    const parts = [];
    const offline = companions
      .filter((companion) => companion.status === "offline")
      .map((companion) => companion.name || "A companion app");
    if (offline.length) parts.push(`${offline.join(", ")} not answering`);
    for (const [id, count] of companionUnchecked) {
      const name = companions.find((companion) => companion.id === id)?.name || "the companion app";
      parts.push(`${count.toLocaleString()} clip${count === 1 ? "" : "s"} not checked yet by ${name}`);
    }
    return parts.length ? parts.join(" · ") : null;
  }, [companionUnchecked, companions]);

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

  const togglePlaybackDetails = useCallback(() => {
    setPlaybackDetailsVisible((previous) => {
      const next = !previous;
      window.electronAPI?.saveSettingsPartial?.({ playbackDetailsVisible: next });
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

  // A library tag view is a snapshot, so it is refreshed when the tree under
  // its tags changes; a folder view re-filters from the tag list by itself.
  const handleSetTagParent = useCallback(
    async (tagName, parentName) => {
      const result = await setTagParent(tagName, parentName);
      if (result?.success && tagCollection) refreshTagCollection();
      return result;
    },
    [refreshTagCollection, setTagParent, tagCollection]
  );

  const handlePlaybackModeChange = useCallback((value) => {
    const next = normalizePlaybackMode(value);
    setPlaybackMode(next);
    window.electronAPI?.saveSettingsPartial?.({ playbackMode: next });
  }, []);

  const togglePauseWhenCovered = useCallback(() => {
    setPauseWhenCovered((previous) => {
      const next = !previous;
      window.electronAPI?.saveSettingsPartial?.({ pauseWhenCovered: next });
      return next;
    });
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

  const handleFullscreenAutoContinueChange = useCallback((value) => {
    const next = value === true;
    setFullscreenAutoContinue(next);
    window.electronAPI?.saveSettingsPartial?.({
      fullscreenAutoContinue: next,
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
      // A rating marks an unreviewed clip as reviewed as a side effect, but it
      // is not the act of marking that "advance after marking" describes:
      // advancing here would carry the clip away before it could also be
      // accepted or rejected, making rate-then-decide impossible. Only an
      // explicit review state advances.
      return true;
    },
    [
      captureFullscreenTarget,
      isFullscreenTargetCurrent,
      notify,
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

  // Shift+1 / Shift+2 in fullscreen: the clip on screen is sent and
  // accepted, advancing as marking it does.
  const handleFullscreenQuickReview = useCallback(
    (index) => {
      const action = quickActionAt(index);
      const target = captureFullscreenTarget();
      if (!action || !target?.video) return;
      void handleCompanionSend({
        companion: { id: action.companionId, name: action.companionName },
        action,
        videos: [target.video],
      });
      void handleFullscreenReviewState(REVIEW_STATES.PICK);
    },
    [captureFullscreenTarget, handleCompanionSend, handleFullscreenReviewState, quickActionAt]
  );

  const handleFullscreenShortcut = useCallback(
    ({ event, key }) => {
      // By physical key, as in the grid, and before the printed key: some
      // layouts print a digit with Shift held.
      if (
        event?.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.code === "Digit1" || event.code === "Digit2")
      ) {
        if (!reviewModeEnabled) return false;
        handleFullscreenQuickReview(event.code === "Digit1" ? 0 : 1);
        return true;
      }
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
      handleFullscreenQuickReview,
      handleFullscreenRating,
      handleFullscreenReviewState,
      handleFullscreenUndo,
      reviewModeEnabled,
    ]
  );

  // A sort the user picks starts from the top of its new order. Layout
  // anchoring (useMasonryLayout) keeps the place only for reorders they did
  // not ask for, such as a rating moving a clip.
  const returnToTop = useCallback(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, []);

  const handleSortChange = useCallback(
    (value) => {
      const { sortKey: key, sortDir: dir } = parseSortValue(value);
      if (key === sortKey && dir === sortDir) return;
      returnToTop();
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
    [groupByFolders, randomSeed, returnToTop, sortDir, sortKey]
  );

  const toggleGroupByFolders = useCallback(() => {
    const next = !groupByFolders;
    returnToTop();
    setGroupByFolders(next);
    window.electronAPI?.saveSettingsPartial?.({
      sortKey,
      sortDir,
      groupByFolders: next,
      randomSeed,
    });
  }, [groupByFolders, sortKey, sortDir, randomSeed, returnToTop]);

  const reshuffleRandom = useCallback(() => {
    const seed = Date.now();
    returnToTop();
    setRandomSeed(seed);
    window.electronAPI?.saveSettingsPartial?.({
      sortKey,
      sortDir,
      groupByFolders,
      randomSeed: seed,
    });
  }, [sortKey, sortDir, groupByFolders, returnToTop]);

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
      // As for a smart view: the saved filters, and every other one cleared.
      updateFilters({ ...createDefaultFilters(), ...(view.filters || {}) });
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
                "Include subfolders before continuing this saved review scope.",
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

  // Every card receives handleVideoSelect, so it must keep one identity:
  // anything that changes with the selection is read through this ref.
  // Otherwise each click would re-render every mounted card.
  const videoSelectStateRef = useRef(null);
  videoSelectStateRef.current = {
    getById,
    orderForRange,
    selectRange: selection.selectRange,
    toggle: selection.toggle,
    selectOnly: selection.selectOnly,
    buildActiveReviewCheckpoint,
    cancelReviewResume,
    reviewSessionEngaged: reviewSessions.isEngaged,
    scheduleReviewCheckpoint: reviewSessions.schedule,
    openStack: handleOpenStack,
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
        current?.cancelReviewResume?.();
      }
      if (!isDoubleClick && video && current?.reviewSessionEngaged) {
        const draft = current.buildActiveReviewCheckpoint({ anchor: video });
        if (draft) {
          current.scheduleReviewCheckpoint(draft, {
            signature: createReviewCheckpointSignature(draft),
          });
        }
      }
      if (isDoubleClick && video) {
        // A collapsed stack opens as its own view; any other card plays.
        if (current?.openStack?.(videoId)) return;
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
    // A library view spans several roots, and resume points are saved per
    // root, so there is nothing to resume here. Say so rather than showing
    // nothing: reviewing and rating still work.
    if (!activeRootPath && tagCollection) {
      return {
        mode: "unavailable",
        reason:
          "Resume points belong to a folder. Open one of this view's folders to save or resume one.",
        savedAtLabel: "",
        message: "",
        candidateName: "",
        disabled: false,
      };
    }
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
    tagCollection,
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
        <div className="app-settings-loading">Loading settings...</div>
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

          <TopBar
            isLoadingFolder={isLoadingFolder}
            onOpenFolder={handleChooseFolder}
            recentFolders={recentFolders}
            pinnedFolders={pinnedRoots}
            onOpenLocation={handleOpenLibraryRoot}
            hasOpenFolder={Boolean(activeRootPath)}
            breadcrumb={folderBreadcrumb}
            onBreadcrumbSelect={handleFolderNavigate}
            previousSibling={siblingFolders.previous}
            nextSibling={siblingFolders.next}
            onPreviousFolder={handlePreviousFolder}
            onNextFolder={handleNextFolder}
            matchingCount={scopedFilteredVideos.length}
            totalCount={videos.length}
            scope={folderScope}
            onScopeChange={handleFolderScopeChange}
            recursive={recursiveMode}
            onRecursiveChange={handleRecursiveChange}
            isRefreshingFolder={isRefreshingFolder}
            onFiltersToggle={() => setFiltersOpen((open) => !open)}
            filtersActiveCount={filtersActiveCount}
            onFiltersClear={resetFilters}
            filtersAreOpen={isFiltersOpen}
            filtersButtonRef={filtersButtonRef}
            sortKey={sortKey}
            sortSelection={formatSortValue(sortKey, sortDir)}
            onSortChange={handleSortChange}
            onReshuffle={reshuffleRandom}
            zoomLevel={zoomLevel}
            onZoomChange={handleZoomChangeSafe}
            minimumZoomLevel={getMinimumZoomLevel()}
            reviewModeEnabled={reviewModeEnabled}
            onReviewModeToggle={toggleReviewMode}
            showFilenames={showFilenames}
            onFilenamesToggle={toggleFilenames}
            hoverAudioEnabled={hoverAudioEnabled}
            onHoverAudioToggle={toggleHoverAudio}
            groupByFolders={groupByFolders}
            onGroupByFoldersToggle={toggleGroupByFolders}
            stackByPrompt={stackByPrompt}
            onStackByPromptToggle={toggleStackByPrompt}
            stackSimilarity={stackSimilarity}
            onStackSimilarityChange={handleStackSimilarityChange}
            gridLayout={gridLayout}
            onGridLayoutChange={handleGridLayoutChange}
            showFolderHeaders={showFolderHeaders}
            onFolderHeadersToggle={setShowFolderHeaders}
            playbackMode={playbackMode}
            onPlaybackModeChange={handlePlaybackModeChange}
            playbackDecision={playbackDecision}
            playbackCapabilityStatus={playbackCapabilityStatus}
            proxyPlaybackEnabled={proxyPlaybackEnabled}
            onProxyPlaybackToggle={toggleProxyPlayback}
            proxyPlaybackAvailable={playbackCapabilities.proxyAvailable}
            workSuspended={workSuspended}
            playbackDetailsVisible={playbackDetailsVisible}
            onPlaybackDetailsToggle={togglePlaybackDetails}
            onHotkeyHelp={() => setHotkeyHelpOpen(true)}
            onOpenAbout={() => setAboutOpen(true)}
            onOpenPreferences={() => setPreferencesOpen(true)}
            onOpenSupport={() => {
              void openDonationPage();
            }}
          />

          {(activeRootPath || tagCollection) && reviewModeEnabled && (
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
              passControl={
                reviewPass
                  ? null
                  : {
                      count: reviewPassCandidateCount,
                      selection: selection.size >= 2,
                      onStart: handleStartReviewPass,
                    }
              }
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
              librarySearchScope={librarySearchScope}
              onSearchScopeChange={handleSearchScopeChange}
              onRefreshLibrary={refreshTagCollection}
              canReturnToFolder={Boolean(
                activeRootPath || folderScopeReturnRef.current
              )}
              libraryResultCount={tagCollection ? videos.length : null}
              libraryTruncated={Boolean(tagCollection?.truncated)}
              versionIndexStatus={generationIndex.status}
              versionPendingCount={generationIndex.pendingCount}
              onFindVersionsInLibrary={
                window.electronAPI?.generationVersions
                  ? generationIndex.indexLibrary
                  : undefined
              }
              onSetTagParent={handleSetTagParent}
            companions={companionPanels}
            promptSearch={promptSearch}
            likelyTagStatus={likelyTagStatus}
            mightBe={mightBe}
            workflowSearch={workflowSearch}
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
            companions={onlineCompanions}
          />
          <CompanionSendDialog
            open={Boolean(companionSend)}
            companionId={companionSend?.companion.id || null}
            action={companionSend?.action || null}
            companionName={companionSend?.companion.name || undefined}
            videos={companionSend?.videos || []}
            onClose={() => setCompanionSend(null)}
            onSent={(rows) =>
              companions.find((companion) => companion.id === companionSend?.companion.id)?.refresh(rows)
            }
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
          <PreferencesDialog
            open={isPreferencesOpen}
            onClose={() => setPreferencesOpen(false)}
            suspended={isDataLocationOpen}
            dataLocationOpen={isDataLocationOpen}
            onOpenDataLocation={() => setDataLocationOpen(true)}
            playbackMode={playbackMode}
            onPlaybackModeChange={handlePlaybackModeChange}
            proxyPlaybackEnabled={proxyPlaybackEnabled}
            proxyPlaybackAvailable={playbackCapabilities.proxyAvailable}
            onProxyPlaybackToggle={toggleProxyPlayback}
            pauseWhenCovered={pauseWhenCovered}
            pauseWhenCoveredAvailable={playbackCapabilities.coverPauseAvailable}
            pauseWhenCoveredUnavailableReason={
              playbackCapabilities.coverPauseUnavailableReason
            }
            onPauseWhenCoveredToggle={togglePauseWhenCovered}
            hoverAudioEnabled={hoverAudioEnabled}
            onHoverAudioToggle={toggleHoverAudio}
            playbackDetailsVisible={playbackDetailsVisible}
            onPlaybackDetailsToggle={togglePlaybackDetails}
            playbackCapabilityStatus={playbackCapabilityStatus}
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

              {resolutionSummary?.length > 0 && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Resolution</span>
                  <div className="filters-summary__chips">
                    {resolutionSummary.map((chip) => (
                      <button
                        key={chip.key}
                        type="button"
                        className="filters-summary__chip filters-summary__chip--rating"
                        onClick={chip.onClear}
                        title="Clear this resolution bound"
                      >
                        {chip.label}
                        <span className="filters-summary__chip-remove">×</span>
                      </button>
                    ))}
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

              {(filters.mightBe || "").trim() && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Might be</span>
                  <div className="filters-summary__chips">
                    <button
                      type="button"
                      className="filters-summary__chip filters-summary__chip--review"
                      onClick={() => updateFilters((prev) => ({ ...prev, mightBe: "" }))}
                      title="Clear the might-be filter"
                    >
                      {filters.mightBe.trim()}
                      <span className="filters-summary__chip-remove">×</span>
                    </button>
                  </div>
                </div>
              )}

              {(filters.promptQuery || "").trim() && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Prompt</span>
                  <div className="filters-summary__chips">
                    <button
                      type="button"
                      className="filters-summary__chip filters-summary__chip--review"
                      onClick={() => updateFilters((prev) => ({ ...prev, promptQuery: "" }))}
                      title="Clear prompt search"
                    >
                      {filters.promptQuery.trim()}
                      <span className="filters-summary__chip-remove">×</span>
                    </button>
                  </div>
                </div>
              )}

              {normalizeVersionFilter(filters.versionFilter) !== "any" && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Versions</span>
                  <div className="filters-summary__chips">
                    <button
                      type="button"
                      className="filters-summary__chip filters-summary__chip--review"
                      onClick={clearVersionFilter}
                      title="Clear version filter"
                    >
                      {VERSION_FILTER_LABELS[normalizeVersionFilter(filters.versionFilter)]}
                      <span className="filters-summary__chip-remove">×</span>
                    </button>
                  </div>
                </div>
              )}

              {(() => {
                // Frame rate and workflow (docs/architecture/workflow-filters.md).
                const chips = [];
                const minFps = sanitizeFrameRate(filters.minFrameRate);
                const maxFps = sanitizeFrameRate(filters.maxFrameRate);
                const minSteps = sanitizeSteps(filters.minSteps);
                const maxSteps = sanitizeSteps(filters.maxSteps);
                const uses = parseWorkflowWords(filters.workflowInclude);
                const without = parseWorkflowWords(filters.workflowExclude);
                if (minFps !== null) chips.push(["minFrameRate", `\u2265 ${minFps} fps`, null]);
                if (maxFps !== null) chips.push(["maxFrameRate", `\u2264 ${maxFps} fps`, null]);
                if (minSteps !== null) chips.push(["minSteps", `\u2265 ${minSteps} steps`, null]);
                if (maxSteps !== null) chips.push(["maxSteps", `\u2264 ${maxSteps} steps`, null]);
                if (uses.length) chips.push(["workflowInclude", `Uses ${uses.join(", ")}`, ""]);
                if (without.length) chips.push(["workflowExclude", `Without ${without.join(", ")}`, ""]);
                if (!chips.length) return null;
                return (
                  <div className="filters-summary__section">
                    <span className="filters-summary__label">Workflow</span>
                    <div className="filters-summary__chips">
                      {chips.map(([field, label, cleared]) => (
                        <button
                          key={field}
                          type="button"
                          className="filters-summary__chip filters-summary__chip--review"
                          onClick={() => updateFilters((prev) => ({ ...prev, [field]: cleared }))}
                          title="Clear this filter"
                        >
                          {label}
                          <span className="filters-summary__chip-remove">×</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {(Object.keys(normalizeCompanionFilters(filters.companionFilters)).length > 0 ||
                filters.companionHideSent) && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">
                    {companions.length === 1 ? companions[0].name || "Companion app" : "Companion apps"}
                  </span>
                  <div className="filters-summary__chips">
                    {Object.entries(normalizeCompanionFilters(filters.companionFilters)).map(
                      ([key, phase]) => {
                        const { companionId, actionId } = parseCompanionFilterKey(key) || {};
                        const owner = companions.find((entry) => entry.id === companionId);
                        const actionLabel =
                          owner?.actions.find((action) => action.id === actionId)?.label || actionId;
                        return (
                          <button
                            key={key}
                            type="button"
                            className="filters-summary__chip filters-summary__chip--review"
                            onClick={() =>
                              updateFilters((prev) => {
                                const next = { ...normalizeCompanionFilters(prev.companionFilters) };
                                delete next[key];
                                return { ...prev, companionFilters: next };
                              })
                            }
                            title="Clear this filter"
                          >
                            {`${
                              companions.length > 1 && owner?.name ? `${owner.name} · ` : ""
                            }${actionLabel}: ${COMPANION_PHASE_LABELS[phase]}`}
                            <span className="filters-summary__chip-remove">×</span>
                          </button>
                        );
                      }
                    )}
                    {filters.companionHideSent && (
                      <button
                        type="button"
                        className="filters-summary__chip filters-summary__chip--review"
                        onClick={() =>
                          updateFilters((prev) => ({ ...prev, companionHideSent: false }))
                        }
                        title="Show clips already sent again"
                      >
                        Hiding clips already sent
                        <span className="filters-summary__chip-remove">×</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <DebugSummary
            detailed={playbackDetailsVisible}
            total={videoCollection.stats.total}
            stackedClips={stackSelectionUnits ? scopedFilteredVideos.length : null}
            stackCount={stackSelectionUnits ? promptStacks.stacks.size : 0}
            companionNote={companionNote}
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
            selectedCount={selection.size}
            onClearSelection={selection.clear}
            trailing={<BackgroundActivityStatus />}
          />

          {/* Home state: pinned library roots and recent locations */}
          {!activeRootPath && !tagCollection && videos.length === 0 && !isLoadingFolder ? (
            <div className="library-home-workspace">
              {isLibrarySidebarOpen &&
                (pinnedRoots.length > 0 || savedViews.length > 0 || reviewPassList.length > 0) && (
                <LibrarySidebar
                  tree={null}
                  pinnedRoots={pinnedRoots}
                  currentRoot={null}
                  onOpenRoot={handleOpenLibraryRoot}
                  onTogglePin={handleToggleLibraryPin}
                  rootCountStateByPath={rootCountStateByPath}
                  savedViews={savedViews}

                  onApplySavedView={handleApplySavedView}
                  onSaveCurrentView={handleSaveCurrentView}
                  onDeleteSavedView={handleDeleteSavedView}
                  reviewPasses={reviewPassList}
                  activeReviewPassId={reviewPass?.id ?? null}
                  onOpenReviewPass={handleOpenReviewPass}
                  onDeleteReviewPass={handleDeleteReviewPass}
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
                    Include subfolders to browse large generation runs as a tree while keeping the flattened swarm available.
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
                {activeRootPath && (
                  <WorkspaceSidebar
                    open={isLibrarySidebarOpen}
                    activePanel={workspaceSidebarTab}
                    onSelectPanel={handleSidebarPanelSelect}
                    onCollapse={() => setLibrarySidebarOpen(false)}
                    panels={buildWorkspacePanels({
                      detailsDocked: metadataInspectorMode === "docked",
                      selectionCount: selection.size,
                      libraryProps: {
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
                        reviewPasses: reviewPassList,
                        activeReviewPassId: reviewPass?.id ?? null,
                        onOpenReviewPass: handleOpenReviewPass,
                        onDeleteReviewPass: handleDeleteReviewPass,
                        disabled: isLoadingFolder,
                        reviewModeEnabled,
                      },
                      detailsContent: selection.size > 0 ? (
                        <DockedMetadataInspector
                          selectionKey={metadataSelectionKey}
                          selectionCount={selection.size}
                          selectedVideos={selectedVideos}
                          availableTags={availableTags}
                          onAddTag={handleAddTags}
                          onRemoveTag={handleRemoveTag}
                          onApplyTagToSelection={handleApplyExistingTag}
                          onSetRating={reviewWorkflow.applyRating}
                          onClearRating={handleClearRating}
                          onSetReviewState={reviewWorkflow.applyReviewState}
                          reviewModeEnabled={reviewModeEnabled}
                          generationVersions={gridGenerationVersions}
                          onFocusSelection={focusSelection}
                          onTransferSelection={handleRequestTransfer}
                          onUndock={handleUndockMetadataPanel}
                        />
                      ) : null,
                      generationContent: selection.size === 1 ? (
                        <DockedGenerationPanel
                          filename={selectedVideos[0]?.name}
                          generationMetadataState={generationMetadataState}
                        />
                      ) : null,
                    })}
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

                  {reviewPass && !versionView ? (
                    <ReviewPassBar
                      name={reviewPass.name}
                      decided={reviewWorkflow.progress.total - reviewWorkflow.progress.unreviewed}
                      total={reviewWorkflow.progress.total}
                      done={reviewPassDone}
                      canRerun={Boolean(reviewPass.definition)}
                      onExit={handleExitReviewPass}
                      onRerun={handleRerunReviewPass}
                    />
                  ) : null}
                  {versionView ? (
                    <VersionsBar
                      count={versionViewClips?.members.length || 0}
                      elsewhere={versionGuests.length}
                      loading={versionView.status === "loading"}
                      failed={versionView.status === "failed"}
                      truncated={versionView.truncated}
                      onClose={handleCloseVersions}
                      onRestart={handleRestartVersions}
                    />
                  ) : !reviewPass && openStackSummary && (
                    <StackBar
                      {...openStackSummary}
                      unreviewedCount={openStackUnreviewed.length}
                      reviewModeEnabled={reviewModeEnabled}
                      onClose={handleCloseStack}
                      onPrevious={() => handleStepStack(-1)}
                      onNext={() => handleStepStack(1)}
                      onRejectUnreviewed={handleRejectUnreviewedInStack}
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
                        const pixelRatio = window.devicePixelRatio || 1;
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
                              playbackSuspended={Boolean(fullScreenVideo) || gridPlaybackPaused}
                              workSuspended={workSuspended}
                              proxyPlaybackEnabled={
                                proxyPlaybackEnabled &&
                                proxyIsSharpEnough(
                                  video.dimensions,
                                  position.width,
                                  position.height,
                                  pixelRatio
                                )
                              }
                              posterWidth={posterWidthFor(position.width, pixelRatio)}
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
                              versionCount={
                                generationVersionIndex.get(video.id)?.versionCount || 0
                              }
                              versionSuperseded={
                                generationVersionIndex.get(video.id)?.superseded === true
                              }
                              versionLabel={versionLabelById.get(video.id) || null}
                              versionLocation={
                                versionView ? versionLocation(video) : null
                              }
                              onOpenVersions={
                                versionView ? null : handleOpenVersionsFromCard
                              }
                              stackCount={
                                stackSelectionUnits
                                  ? promptStacks.stacks.get(promptStacks.keyById.get(video.id))
                                      ?.members.length || 0
                                  : 0
                              }
                              stackTotal={
                                stackSelectionUnits
                                  ? promptStacks.stacks.get(promptStacks.keyById.get(video.id))
                                      ?.total || 0
                                  : 0
                              }
                              companionChips={companionChipsFor(companions, video.instanceId)}
                              quickActions={companionQuickActionsFor(companions, video.instanceId)}
                              onQuickAction={handleQuickAction}
                              stackSimilar={
                                stackSelectionUnits
                                  ? promptStacks.stacks.get(promptStacks.keyById.get(video.id))
                                      ?.similar === true
                                  : false
                              }
                              stackStrip={
                                stackSelectionUnits
                                  ? stackStripFor(
                                      promptStacks.stacks.get(promptStacks.keyById.get(video.id))
                                    )
                                  : null
                              }
                              stackPeekScheduler={mediaScheduler}
                              onOpenStack={handleOpenStackFromCard}
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
                generationVersions={gridGenerationVersions}
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
              dialogLabel={fullScreenVideo.name || "Fullscreen"}
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
                  companionChips={companionChipsFor(companions, fullScreenVideo.instanceId)}
                  quickActions={withQuickShortcuts(
                    companionQuickActionsFor(companions, fullScreenVideo.instanceId),
                    companionActions
                  )}
                  onQuickAction={(companionId, actionId) =>
                    handleQuickAction(fullScreenVideo.id, companionId, actionId)
                  }
                />
              }
              detailsOpen={fullscreenDetailsOpen}
              onToggleDetails={() =>
                handleFullscreenDetailsOpenChange(!fullscreenDetailsOpen)
              }
              audioEnabled={fullscreenAudioEnabled}
              onAudioEnabledChange={handleFullscreenAudioEnabledChange}
              autoContinue={fullscreenAutoContinue}
              onAutoContinueChange={handleFullscreenAutoContinueChange}
              onCopyFrame={handleCopyFullscreenFrame}
              detailsDock={
                <FullscreenDetailsDock
                  video={fullScreenVideo}
                  availableTags={availableTags}
                  generationMetadataState={fullscreenGenerationMetadataState}
                  generationExpanded={fullscreenGenerationExpanded}
                  onGenerationExpandedChange={setFullscreenGenerationExpanded}
                  generationVersions={fullscreenGenerationVersions}
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
              canGoToFolder={Boolean(tagCollection)}
              companionActions={companionActions.length ? companionActions : undefined}
              mightBeTag={(filters.mightBe || "").trim()}
            />
          )}
        </>
      )}
    </div>
  );
}

export default App;
