import React from "react";
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, act, waitFor, within } from "@testing-library/react";
import { ActionIds } from "./hooks/actions/actions";

const selectionMock = {
  selected: new Set(),
  size: 0,
  anchorId: null,
  setSelected: vi.fn(),
  pruneTo: vi.fn(),
  clear: vi.fn(),
  toggle: vi.fn(),
  selectOnly: vi.fn(),
  selectExactly: vi.fn(),
  setSelectedIds: vi.fn(),
  selectRange: vi.fn(),
  expandToUnits: vi.fn(),
};

const useSelectionStateMock = vi.fn(() => selectionMock);

const recentFoldersMock = {
  items: [],
  add: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
};
const useRecentFoldersMock = vi.fn(() => recentFoldersMock);

const runWithStableAnchorMock = vi.fn((_, fn) => (typeof fn === "function" ? fn() : undefined));
const focusCurrentAnchorMock = vi.fn(() => false);
const useStableViewAnchoringMock = vi.fn(() => ({
  runWithStableAnchor: runWithStableAnchorMock,
  focusCurrentAnchor: focusCurrentAnchorMock,
}));

const scheduleInitMock = vi.fn();
const useInitGateMock = vi.fn(() => ({ scheduleInit: scheduleInitMock }));
const registerMediaElementMock = vi.fn();
const playbackTelemetry = {
  sampleCount: 7,
  droppedFrameRatio: 0.02,
  frameDelayMs: 8,
  longTaskRate: 0,
  averagePixelArea: 921600,
};
const usePlaybackTelemetryMock = vi.fn(() => ({
  telemetry: playbackTelemetry,
  hadLongTaskRecently: false,
  registerMediaElement: registerMediaElementMock,
}));
const playbackCapabilities = {
  platform: "linux",
  logicalCores: 8,
  totalMemoryMB: 32768,
  hardwareDecodeDetected: false,
  hardwareDecodeGuaranteed: false,
  proxyAvailable: true,
};
const playbackCapabilityStatus =
  "Linux: hardware video decode was not detected; software decoding is likely.";
const usePlaybackCapabilitiesMock = vi.fn(() => ({
  capabilities: playbackCapabilities,
  statusText: playbackCapabilityStatus,
}));
const activeWindowWork = {
  isSuspended: false,
  reason: null,
  activity: { active: true },
};
const useWindowWorkSuspensionMock = vi.fn(() => activeWindowWork);
const playbackDecision = {
  mode: "balanced",
  target: 3,
  safetyCap: 6,
  cleanWindows: 2,
  health: "healthy",
  reasons: [],
};
const useAdaptivePlaybackPolicyMock = vi.fn(() => playbackDecision);
const setThumbSuspendedMock = vi.fn();
const resetThumbnailGenerationMock = vi.fn();
const contextMenuReturn = {
  contextMenu: { visible: false, position: { x: 0, y: 0 }, contextId: null },
  showOnItem: vi.fn(),
  showOnEmpty: vi.fn(),
  hide: vi.fn(),
};
const useContextMenuMock = vi.fn(() => contextMenuReturn);
const useTrashIntegrationMock = vi.fn(() => ({}));
const runActionMock = vi.fn();
const runActionForVideosMock = vi.fn();
const useActionDispatchMock = vi.fn(() => ({
  runAction: runActionMock,
  runActionForVideos: runActionForVideosMock,
}));
const createFullscreenControllerMock = () => ({
  fullScreenVideo: null,
  openFullScreen: vi.fn(),
  closeFullScreen: vi.fn(),
  navigateFullScreen: vi.fn(),
});
const useFullScreenModalMock = vi.fn(createFullscreenControllerMock);
const useHotkeysMock = vi.fn();

const electronVideos = [{ id: "video-1" }];
const openTagCollectionMock = vi.fn();
const electronLifecycleReturn = {
  videos: electronVideos,
  setVideos: vi.fn(),
  activeRootPath: null,
  libraryRoot: null,
  tagCollection: null,
  openTagCollection: openTagCollectionMock,
  directorySummaries: [],
  isLoadingFolder: false,
  isRefreshingFolder: false,
  activeScanId: null,
  loadingStatus: null,
  loadingStage: "",
  loadingProgress: 0,
  settingsLoaded: true,
  cancelFolderLoad: vi.fn(),
  prioritizeActiveDirectoryScan: vi.fn(),
  promoteCachedPreview: vi.fn(),
  handleElectronFolderSelection: vi.fn(),
  reloadCurrentRoot: vi.fn(),
  handleFolderSelect: vi.fn(),
  handleWebFileSelection: vi.fn(),
};
const useElectronLifecycleMock = vi.fn(() => electronLifecycleReturn);

const createDeferredPromise = () => {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const flushPromiseTurns = async (count = 12) => {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
};

const reviewSessionView = (filterOverrides = {}) => ({
  version: 1,
  filters: {
    includeTags: [],
    excludeTags: [],
    minRating: null,
    exactRating: null,
    reviewFilter: "any",
    ...filterOverrides,
  },
  sort: {
    key: "name",
    dir: "asc",
    groupByFolders: true,
    randomSeed: null,
  },
});

const reviewCheckpoint = (rootPath, overrides = {}) => ({
  rootPath,
  directory: "",
  scope: "all-descendants",
  view: reviewSessionView(),
  anchorInstanceId: null,
  anchorFingerprint: null,
  updatedAt: 1234,
  ...overrides,
});

const installReviewSessionsApi = ({
  checkpoint = null,
  save = vi.fn(async (draft) => ({
    checkpoint: { ...draft, updatedAt: 1234 },
  })),
  clear = vi.fn().mockResolvedValue({ deleted: true }),
} = {}) => {
  const summaries = checkpoint
    ? [{
        rootPath: checkpoint.rootPath,
        directory: checkpoint.directory,
        scope: checkpoint.scope,
        updatedAt: checkpoint.updatedAt,
      }]
    : [];
  const sessions = {
    list: vi.fn().mockResolvedValue({ sessions: summaries }),
    get: vi.fn().mockResolvedValue({ checkpoint }),
    save,
    clear,
    onFlushRequested: vi.fn(() => vi.fn()),
    acknowledgeFlush: vi.fn(),
  };
  window.electronAPI = {
    ...window.electronAPI,
    review: { sessions },
  };
  return sessions;
};

const filterStateReturn = {
  filters: {
    includeTags: [],
    excludeTags: [],
    minRating: null,
    exactRating: null,
    reviewFilter: "any",
  },
  setFiltersOpen: vi.fn(),
  isFiltersOpen: false,
  updateFilters: vi.fn(),
  resetFilters: vi.fn(),
  filteredVideos: [],
  filteredVideoIds: new Set(),
  companionUnchecked: new Map(),
  filtersActiveCount: 0,
  ratingSummary: {},
  handleRemoveIncludeFilter: vi.fn(),
  handleRemoveExcludeFilter: vi.fn(),
  clearReviewFilter: vi.fn(),
};
const useFilterStateMock = vi.fn(() => filterStateReturn);

const masonryReturn = {
  orderedVideos: [],
  displayVideos: [],
  orderedIds: [],
  orderForRange: [],
  ioRegistry: {
    isNear: () => false,
    observe: vi.fn(),
    unobserve: vi.fn(),
  },
  layoutEpoch: 0,
  scheduleLayout: vi.fn(),
  updateAspectRatio: vi.fn(),
  onItemsChanged: vi.fn(),
  setZoomClass: vi.fn(),
  progressiveMaxVisibleNumber: 0,
  activationTarget: 0,
  activationIds: [],
  centerPriorityIds: [],
  activationIdSet: new Set(),
  virtualItems: [],
  totalHeight: 0,
  scrollToId: vi.fn(() => false),
  viewportMetrics: {
    columnCount: 1,
    viewportRows: 1,
    approxTileHeight: 100,
    viewportHeight: 1000,
    scrollTop: 0,
  },
  withLayoutHold: (fn) => (typeof fn === "function" ? fn() : undefined),
  isLayoutTransitioning: false,
};
const useMasonryLayoutMock = vi.fn(() => masonryReturn);

const useZoomControlsMock = vi.fn(() => ({
  handleZoomChangeSafe: vi.fn(),
  getMinimumZoomLevel: vi.fn(() => 0),
  applyZoomFromSettings: vi.fn(),
}));

const metadataActionsReturn = {
  applyMetadataPatch: vi.fn(),
  handleAddTags: vi.fn(),
  handleRemoveTag: vi.fn(),
  handleSetRating: vi.fn(),
  handleClearRating: vi.fn(),
  handleSetReviewState: vi.fn(),
  handleRestoreReviewMetadata: vi.fn(),
  handleApplyExistingTag: vi.fn(),
  refreshTagList: vi.fn(),
};
const useMetadataActionsMock = vi.fn(() => metadataActionsReturn);

const useVideoCollectionMock = vi.fn(() => ({
  memoryStatus: null,
  playingVideos: [],
  limits: { maxLoaded: 0 },
  performCleanup: vi.fn(() => []),
  stats: {
    total: 0,
    rendered: 0,
    playing: 0,
    progressiveVisible: 0,
    activationTarget: 0,
    activeWindow: 0,
  },
  videosToRender: [],
  canLoadVideo: vi.fn(() => true),
  reserveLoadSlot: vi.fn(() => ({ token: 1 })),
  queueLoadSlot: vi.fn(() => null),
  cancelQueuedLoadSlot: vi.fn(() => true),
  finishLoadSlot: vi.fn(() => ({ token: 1 })),
  releaseMediaSlot: vi.fn(() => true),
  isCurrentMediaLease: vi.fn(() => true),
  getDecoderLease: vi.fn(() => null),
  isVideoPlaying: vi.fn(() => false),
  reportStarted: vi.fn(() => true),
  reportPlayError: vi.fn(() => true),
  reportPaused: vi.fn(() => true),
  reportPlayerCreationFailure: vi.fn(),
  markHover: vi.fn(),
  activeHoverAudioId: null,
  onCardHoverAudioStart: vi.fn(),
  onCardHoverAudioEnd: vi.fn(),
}));
const topBarSpy = vi.fn();
const filtersPopoverSpy = vi.fn();
const videoCardSpy = vi.fn();
const loadingOverlaySpy = vi.fn();
const metadataPanelSpy = vi.fn();
const contextMenuSpy = vi.fn();
const fullScreenModalSpy = vi.fn();
const debugSummarySpy = vi.fn();
const fullScreenReleaseNowSpy = vi.fn();
const setLibraryRootPinnedMock = vi.fn();
const refreshLibraryRootsMock = vi.fn();
const refreshLibraryTreeMock = vi.fn();
const useLibraryCatalogMock = vi.fn((args = {}) => ({
  roots: [],
  pinnedRoots: [],
  currentRoot: args.scannedRoot ?? null,
  directories: args.scannedDirectories ?? [],
  refreshRoots: refreshLibraryRootsMock,
  refreshTree: refreshLibraryTreeMock,
  setPinned: setLibraryRootPinnedMock,
}));
const savedViewsReturn = {
  savedViews: [],
  createSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
};
const useSavedViewsMock = vi.fn(() => savedViewsReturn);
const useGenerationMetadataMock = vi.fn(() => ({
  loading: false,
  found: false,
  cached: false,
  metadata: null,
  error: null,
  refresh: vi.fn(),
}));

vi.mock("./components/VideoCard/VideoCard", async () => {
  const ReactModule = await vi.importActual("react");
  return {
    __esModule: true,
    default: ReactModule.default.memo((props) => {
      videoCardSpy(props);
      return (
        <div
          className="video-item"
          data-testid="video-card"
          data-video-id={props.video.id}
        />
      );
    }),
  };
});
vi.mock("./components/FullScreenModal", async () => {
  const ReactModule = await vi.importActual("react");
  return {
    __esModule: true,
    default: ReactModule.default.forwardRef((props, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        releaseNow: fullScreenReleaseNowSpy,
      }));
      fullScreenModalSpy(props);
      return null;
    }),
  };
});
vi.mock("./components/ContextMenu", () => ({
  __esModule: true,
  default: (props) => {
    contextMenuSpy(props);
    return null;
  },
}));
vi.mock("./components/RecentFolders", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("./components/MetadataPanel", async () => {
  const ReactModule = await vi.importActual("react");
  return {
    __esModule: true,
    default: ReactModule.default.forwardRef((props, _ref) => {
      metadataPanelSpy(props);
      return null;
    }),
  };
});
vi.mock("./components/TopBar", async () => {
  const { FolderScope } = await vi.importActual("./library/folderModel");
  return {
  __esModule: true,
  default: (props) => {
    topBarSpy(props);
    const busy = Boolean(props.isLoadingFolder);
    return (
      <>
        {props.hasOpenFolder ? (
          <nav aria-label="Location">
            {(props.breadcrumb || []).map((crumb) => crumb.label).join(" / ")}
          </nav>
        ) : null}
        {props.hasOpenFolder ? (
          <select
            aria-label="Folder scope"
            value={props.scope}
            disabled={busy}
            onChange={(event) => props.onScopeChange?.(event.target.value)}
          >
            {Object.values(FolderScope).map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        ) : null}
        <label>
          <input
            type="checkbox"
            checked={Boolean(props.recursive)}
            disabled={busy}
            onChange={(event) => props.onRecursiveChange?.(event.target.checked)}
          />
          Include subfolders
        </label>
        <button
          type="button"
          aria-label="Player audio on hover"
          aria-pressed={Boolean(props.hoverAudioEnabled)}
          onClick={() => props.onHoverAudioToggle?.()}
        >
          Hover audio
        </button>
        <button
          type="button"
          aria-label="Review"
          aria-pressed={Boolean(props.reviewModeEnabled)}
          onClick={() => props.onReviewModeToggle?.()}
        >
          Review
        </button>
        <button
          type="button"
          aria-label="Use Static + Hover playback"
          onClick={() => props.onPlaybackModeChange?.("static-hover")}
        >
          Static + Hover
        </button>
        <button
          type="button"
          aria-label="Use All Motion playback"
          onClick={() => props.onPlaybackModeChange?.("all-motion")}
        >
          All Motion
        </button>
        <button
          type="button"
          aria-label="Toggle proxy playback"
          aria-pressed={Boolean(props.proxyPlaybackEnabled)}
          onClick={() => props.onProxyPlaybackToggle?.()}
        >
          Proxy playback
        </button>
        <button
          type="button"
          aria-label="Keyboard shortcuts"
          onClick={() => props.onHotkeyHelp?.()}
        >
          ?
        </button>
      </>
    );
  },
};
});
vi.mock("./components/FiltersPopover", async () => {
  const ReactModule = await vi.importActual("react");
  return {
    __esModule: true,
    default: ReactModule.default.forwardRef((props) => {
      filtersPopoverSpy(props);
      return null;
    }),
  };
});
vi.mock("./components/DebugSummary", () => ({
  __esModule: true,
  default: (props) => {
    debugSummarySpy(props);
    return null;
  },
}));

vi.mock("./hooks/useFullScreenModal", () => ({
  __esModule: true,
  useFullScreenModal: (...args) => useFullScreenModalMock(...args),
}));
vi.mock("./hooks/video-collection", () => ({
  __esModule: true,
  useVideoCollection: (...args) => useVideoCollectionMock(...args),
}));
vi.mock("./hooks/useRecentFolders", () => ({
  __esModule: true,
  default: (...args) => useRecentFoldersMock(...args),
}));
vi.mock("./hooks/video-collection/usePlaybackTelemetry", () => ({
  __esModule: true,
  default: (...args) => usePlaybackTelemetryMock(...args),
}));
vi.mock("./hooks/video-collection/useAdaptivePlaybackPolicy", () => ({
  __esModule: true,
  default: (...args) => useAdaptivePlaybackPolicyMock(...args),
}));
vi.mock("./hooks/ui-perf/useInitGate", () => ({
  __esModule: true,
  default: (...args) => useInitGateMock(...args),
}));
vi.mock("./hooks/selection/useSelectionState", () => ({
  __esModule: true,
  default: (...args) => useSelectionStateMock(...args),
}));
vi.mock("./hooks/selection/useStableViewAnchoring", () => ({
  __esModule: true,
  default: (...args) => useStableViewAnchoringMock(...args),
}));
vi.mock("./hooks/context-menu/useContextMenu", () => ({
  __esModule: true,
  useContextMenu: (...args) => useContextMenuMock(...args),
}));
vi.mock("./hooks/actions/useActionDispatch", () => ({
  __esModule: true,
  default: (...args) => useActionDispatchMock(...args),
}));
vi.mock("./hooks/actions/useTrashIntegration", () => ({
  __esModule: true,
  default: (...args) => useTrashIntegrationMock(...args),
}));
vi.mock("./hooks/selection/useHotkeys", () => ({
  __esModule: true,
  default: (...args) => useHotkeysMock(...args),
}));
vi.mock("./app/components/LoadingOverlay", () => ({
  __esModule: true,
  default: (props) => {
    loadingOverlaySpy(props);
    return null;
  },
}));
vi.mock("./app/components/MemoryAlert", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("./app/hooks/useFilterState", () => ({
  __esModule: true,
  useFilterState: (...args) => useFilterStateMock(...args),
}));
vi.mock("./app/hooks/useMasonryLayout", () => ({
  __esModule: true,
  useMasonryLayout: (...args) => useMasonryLayoutMock(...args),
}));
vi.mock("./app/hooks/useMetadataActions", () => ({
  __esModule: true,
  useMetadataActions: (...args) => useMetadataActionsMock(...args),
}));
vi.mock("./app/hooks/useZoomControls", () => ({
  __esModule: true,
  useZoomControls: (...args) => useZoomControlsMock(...args),
}));
vi.mock("./app/hooks/useElectronFolderLifecycle", () => ({
  __esModule: true,
  useElectronFolderLifecycle: (...args) => useElectronLifecycleMock(...args),
}));
vi.mock("./app/hooks/useLibraryCatalog", () => ({
  __esModule: true,
  useLibraryCatalog: (...args) => useLibraryCatalogMock(...args),
}));
vi.mock("./app/hooks/useSavedViews", () => ({
  __esModule: true,
  useSavedViews: (...args) => useSavedViewsMock(...args),
}));
vi.mock("./app/hooks/useGenerationMetadata", () => ({
  __esModule: true,
  useGenerationMetadata: (...args) => useGenerationMetadataMock(...args),
}));
vi.mock("./app/hooks/useWindowWorkSuspension", () => ({
  __esModule: true,
  default: (...args) => useWindowWorkSuspensionMock(...args),
}));
vi.mock("./app/hooks/usePlaybackCapabilities", () => ({
  __esModule: true,
  default: (...args) => usePlaybackCapabilitiesMock(...args),
}));
vi.mock("./services/thumbService", () => ({
  thumbService: {
    setSuspended: (...args) => setThumbSuspendedMock(...args),
    resetGeneration: (...args) => resetThumbnailGenerationMock(...args),
  },
}));
vi.mock("./config/featureFlags", () => ({
  __esModule: true,
  default: { stableViewFixes: false, stableViewAnchoring: false },
}));
vi.mock("./App.css", () => ({}), { virtual: true });

afterEach(() => {
  cleanup();
  // Toasts live outside React, so cleanup() leaves them behind.
  document.getElementById("app-toast-stack")?.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
  useElectronLifecycleMock.mockImplementation(() => electronLifecycleReturn);
  useFullScreenModalMock.mockImplementation(createFullscreenControllerMock);
  useFilterStateMock.mockImplementation(() => filterStateReturn);
  useLibraryCatalogMock.mockImplementation((args = {}) => ({
    roots: [],
    pinnedRoots: [],
    currentRoot: args.scannedRoot ?? null,
    directories: args.scannedDirectories ?? [],
    refreshRoots: refreshLibraryRootsMock,
    refreshTree: refreshLibraryTreeMock,
    setPinned: setLibraryRootPinnedMock,
  }));
  useSavedViewsMock.mockImplementation(() => savedViewsReturn);
  useMetadataActionsMock.mockImplementation(() => metadataActionsReturn);
  Object.assign(masonryReturn, {
    orderedVideos: [],
    displayVideos: [],
    orderedIds: [],
    orderForRange: [],
    activationIds: [],
    centerPriorityIds: [],
    activationIdSet: new Set(),
    virtualItems: [],
    totalHeight: 0,
  });
  useWindowWorkSuspensionMock.mockReturnValue(activeWindowWork);
  usePlaybackCapabilitiesMock.mockReturnValue({
    capabilities: playbackCapabilities,
    statusText: playbackCapabilityStatus,
  });
  usePlaybackTelemetryMock.mockReturnValue({
    telemetry: playbackTelemetry,
    hadLongTaskRecently: false,
    registerMediaElement: registerMediaElementMock,
  });
  useAdaptivePlaybackPolicyMock.mockReturnValue(playbackDecision);
  delete window.electronAPI;
  selectionMock.selected = new Set();
  selectionMock.size = 0;
  selectionMock.anchorId = null;
  Object.assign(contextMenuReturn.contextMenu, {
    visible: false,
    position: { x: 0, y: 0 },
    contextId: null,
  });
});

describe("App hook composition", () => {
  test("provides stable dependencies to extracted hooks", async () => {
    vi.resetModules();
    const { default: App } = await import("./App.jsx");

    const result = render(<App />);

    expect(useElectronLifecycleMock).toHaveBeenCalled();
    expect(useFilterStateMock).toHaveBeenCalled();
    expect(useMasonryLayoutMock).toHaveBeenCalled();
    expect(useZoomControlsMock).toHaveBeenCalled();
    expect(useWindowWorkSuspensionMock).toHaveBeenCalledWith();
    expect(usePlaybackCapabilitiesMock).toHaveBeenCalledWith();
    expect(usePlaybackTelemetryMock).toHaveBeenCalledWith({
      suspended: false,
      detailed: true,
      publishDiagnostics: false,
    });
    expect(useInitGateMock).toHaveBeenCalledWith({
      perFrame: 6,
      suspended: false,
    });

    const electronArgs = useElectronLifecycleMock.mock.calls[0][0];
    expect(typeof electronArgs.setZoomLevelFromSettings).toBe("function");
    expect(typeof electronArgs.setPlaybackMode).toBe("function");
    expect(typeof electronArgs.setProxyPlaybackEnabled).toBe("function");
    expect(typeof electronArgs.resetThumbnailGeneration).toBe("function");
    expect(typeof electronArgs.beforeExternalFolderSelection).toBe("function");
    electronArgs.resetThumbnailGeneration("folder-change");
    expect(resetThumbnailGenerationMock).toHaveBeenCalledWith("folder-change");

    const filterArgs = useFilterStateMock.mock.calls[0][0];
    expect(filterArgs.videos).toBe(electronVideos);

    expect(useElectronLifecycleMock.mock.invocationCallOrder[0]).toBeLessThan(
      useFilterStateMock.mock.invocationCallOrder[0]
    );

    const zoomArgs = useZoomControlsMock.mock.calls[0][0];
    expect(typeof zoomArgs.runWithStableAnchor).toBe("function");

    expect(useAdaptivePlaybackPolicyMock).toHaveBeenCalledWith({
      mode: "balanced",
      visibleCount: 0,
      telemetry: playbackTelemetry,
      capabilities: playbackCapabilities,
      averagePixelArea: 1280 * 720,
      suspended: false,
    });

    const collectionArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(collectionArgs).toMatchObject({
      workSuspended: false,
      playbackMode: "balanced",
      decoderTarget: playbackDecision.target,
      selectedIds: selectionMock.selected,
      centerPriorityIds: masonryReturn.centerPriorityIds,
    });
    // Hover reaches the orchestrator through markHover, not as App state.
    expect(collectionArgs).not.toHaveProperty("hoveredId");
    expect(typeof electronArgs.resetMediaScheduler).toBe("function");
    expect(() => act(() => electronArgs.resetMediaScheduler())).not.toThrow();
    expect(
      useFullScreenModalMock.mock.results.some(
        ({ value }) => value.closeFullScreen.mock.calls.length > 0
      )
    ).toBe(true);

    const trashArgs = useTrashIntegrationMock.mock.calls.at(-1)?.[0];
    expect(trashArgs).toMatchObject({
      workSuspended: false,
      mediaScheduler: collectionArgs.mediaScheduler,
    });

    const headerProps = topBarSpy.mock.calls.at(-1)?.[0];
    expect(headerProps).toMatchObject({
      playbackMode: "balanced",
      playbackDecision,
      playbackCapabilityStatus,
      proxyPlaybackEnabled: true,
      proxyPlaybackAvailable: true,
      workSuspended: false,
      isRefreshingFolder: false,
    });
    expect(setThumbSuspendedMock).toHaveBeenCalledWith(false);

    result.unmount();
    expect(setThumbSuspendedMock).toHaveBeenCalledWith(true);
  });

  test("promotes a progressive cached collection after the first grid commits", async () => {
    const video = { id: "cached-video", name: "cached.mp4" };
    const promoteCachedPreview = vi.fn();
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [video],
      activeRootPath: "/large",
      libraryRoot: { rootPath: "/large", recursive: true },
      activeScanId: "scan-cached",
      isRefreshingFolder: true,
      promoteCachedPreview,
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [video],
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [video],
      displayVideos: [video],
      orderedIds: [video.id],
      orderForRange: [video.id],
      activationIds: [video.id],
      centerPriorityIds: [video.id],
      activationIdSet: new Set([video.id]),
      virtualItems: [
        { id: video.id, item: video, style: {}, column: 0, top: 0 },
      ],
      totalHeight: 100,
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    await waitFor(() =>
      expect(promoteCachedPreview).toHaveBeenCalledWith("scan-cached")
    );
  });

  test("authorizes a catalog root on demand before opening it", async () => {
    const handleElectronFolderSelection = vi.fn().mockResolvedValue(undefined);
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [],
      handleElectronFolderSelection,
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [],
    }));
    useLibraryCatalogMock.mockImplementation(() => ({
      pinnedRoots: [
        { id: 300, rootPath: "/library/root-300", label: "Run 300" },
      ],
      currentRoot: null,
      directories: [],
      setPinned: setLibraryRootPinnedMock,
    }));
    const authorizeRoot = vi.fn().mockResolvedValue({
      success: true,
      rootPath: "/canonical/library/root-300",
    });
    window.electronAPI = { library: { authorizeRoot } };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    fireEvent.click(screen.getByTitle("/library/root-300"));

    await waitFor(() =>
      expect(authorizeRoot).toHaveBeenCalledWith("/library/root-300")
    );
    expect(handleElectronFolderSelection).toHaveBeenCalledWith(
      "/canonical/library/root-300"
    );
  });

  test("shows a companion app's chips on cards and hands its answers to the filters", async () => {
    const clip = { id: "/library/a.mp4", name: "a.mp4", dirname: "", instanceId: 7, isElectronFile: true };
    useElectronLifecycleMock.mockImplementation(() => ({ ...electronLifecycleReturn, videos: [clip] }));
    const companion = {
      getConnections: vi.fn().mockResolvedValue([{ id: "c1", enabled: true, url: "http://127.0.0.1:9" }]),
      onConnectionsChanged: vi.fn(() => () => {}),
      describe: vi.fn().mockResolvedValue({
        success: true,
        name: "Helper",
        actions: [{ id: "polish", label: "Polish", send: "Send to polish" }],
      }),
      lookup: vi.fn().mockResolvedValue({
        success: true,
        results: {
          7: {
            kind: "render",
            chip: { label: "Waiting #2", tone: "progress" },
            actions: { polish: { phase: "under-way", why: "Second in line" } },
          },
        },
      }),
    };
    window.electronAPI = { companion };
    const previousOrdered = masonryReturn.orderedVideos;
    const previousItems = masonryReturn.virtualItems;
    masonryReturn.orderedVideos = [clip];
    masonryReturn.virtualItems = [{ id: clip.id, item: clip, style: {} }];
    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      await waitFor(() => expect(companion.lookup).toHaveBeenCalledWith("c1", [7]), { timeout: 3000 });
      await waitFor(() =>
        expect(
          videoCardSpy.mock.calls.map(([props]) => props).filter((props) => props.video.id === clip.id).at(-1)
        ).toMatchObject({
          companionChips: [
            { key: "c1", label: "Waiting #2", tone: "progress", title: "Polish: Second in line" },
          ],
        })
      );
      const filterArgs = useFilterStateMock.mock.calls.at(-1)[0];
      expect(filterArgs.companions[0].entries.get(7).actions.polish.phase).toBe("under-way");
    } finally {
      masonryReturn.orderedVideos = previousOrdered;
      masonryReturn.virtualItems = previousItems;
    }
  });

  test("says in the status line how many clips wait on a companion's answer", async () => {
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      companionUnchecked: new Map([["c1", 214]]),
    }));
    window.electronAPI = {
      companion: {
        getConnections: vi.fn().mockResolvedValue([{ id: "c1", enabled: true, url: "http://127.0.0.1:9" }]),
        onConnectionsChanged: vi.fn(() => () => {}),
        describe: vi.fn().mockResolvedValue({
          success: true,
          name: "Helper",
          actions: [{ id: "polish", label: "Polish", send: "Send to polish" }],
        }),
        lookup: vi.fn().mockResolvedValue({ success: true, results: {} }),
      },
    };
    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    await waitFor(() =>
      expect(debugSummarySpy.mock.calls.at(-1)?.[0].companionNote).toBe(
        "214 clips not checked yet by Helper"
      )
    );
  });

  test("sends a right-clicked clip to a companion action in one click, and says why one is not sent", async () => {
    const clip = { id: "/library/a.mp4", name: "a.mp4", dirname: "", instanceId: 7, isElectronFile: true };
    useElectronLifecycleMock.mockImplementation(() => ({ ...electronLifecycleReturn, videos: [clip] }));
    useContextMenuMock.mockImplementation(() => ({
      ...contextMenuReturn,
      contextMenu: { visible: true, position: { x: 10, y: 10 }, contextId: clip.id },
    }));
    let plan = { result: "sent", why: "", estimate: 90 };
    const send = vi.fn(async () => ({ success: true, results: { 7: plan } }));
    window.electronAPI = {
      companion: {
        getConnections: vi.fn().mockResolvedValue([{ id: "c1", enabled: true, url: "http://127.0.0.1:9" }]),
        onConnectionsChanged: vi.fn(() => () => {}),
        describe: vi.fn().mockResolvedValue({
          success: true,
          name: "Helper",
          actions: [{ id: "polish", label: "Polish", send: "Send to polish" }],
        }),
        lookup: vi.fn().mockResolvedValue({ success: true, results: {} }),
        send,
      },
    };
    const previousOrdered = masonryReturn.orderedVideos;
    masonryReturn.orderedVideos = [clip];
    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      const menu = () => contextMenuSpy.mock.calls.at(-1)[0];
      await waitFor(() =>
        expect(menu().companionActions?.map((action) => [action.companionId, action.id])).toEqual([
          ["c1", "polish"],
        ])
      );
      // Every clip would be sent: the dry run, then the send, and no dialog.
      await act(async () => menu().onAction("companion:send:c1:polish"));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls.map(([call]) => call.dryRun)).toEqual([true, false]);
      expect(send.mock.calls[1][0]).toEqual({
        companionId: "c1",
        action: "polish",
        instanceIds: [7],
        dryRun: false,
        again: false,
      });
      expect(await screen.findByText(/Polish: sent 1 clip \(≈ 2 min\)/)).toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Send to polish" })).toBeNull();

      // One clip the app would skip: its reason, still no dialog.
      plan = { result: "skipped", why: "Already in line" };
      await act(async () => menu().onAction("companion:send:c1:polish"));
      expect(await screen.findByText(/Polish: skipped · Already in line/)).toBeInTheDocument();
      expect(send).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("dialog", { name: "Send to polish" })).toBeNull();
    } finally {
      masonryReturn.orderedVideos = previousOrdered;
      useContextMenuMock.mockImplementation(() => contextMenuReturn);
    }
  });

  test("Shift+1 accepts the selection and sends it to the first quick action, without advancing", async () => {
    const clip = { id: "/library/a.mp4", name: "a.mp4", dirname: "", instanceId: 7, fingerprint: "fp-a", isElectronFile: true };
    const after = { id: "/library/b.mp4", name: "b.mp4", dirname: "", instanceId: 8, fingerprint: "fp-b", isElectronFile: true };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [clip, after],
      activeRootPath: "/library",
      libraryRoot: { rootPath: "/library", name: "library", pinned: true },
      directorySummaries: [{ relativePath: "", name: "library" }],
    }));
    const send = vi.fn(async ({ instanceIds }) => ({
      success: true,
      results: Object.fromEntries(instanceIds.map((id) => [id, { result: "sent", why: "" }])),
    }));
    window.electronAPI = {
      saveSettingsPartial: vi.fn(),
      companion: {
        getConnections: vi.fn().mockResolvedValue([{ id: "c1", enabled: true, url: "http://127.0.0.1:9" }]),
        onConnectionsChanged: vi.fn(() => () => {}),
        describe: vi.fn().mockResolvedValue({
          success: true,
          name: "Helper",
          actions: [
            { id: "slow", label: "Slow", send: "Send slowly", quick: false },
            { id: "finish", label: "Finish", send: "Finish it", quick: true },
          ],
        }),
        lookup: vi.fn().mockResolvedValue({ success: true, results: {} }),
        send,
      },
    };
    const previousMasonry = { ...masonryReturn };
    const previousSelected = selectionMock.selected;
    const previousSize = selectionMock.size;
    const previousAnchor = selectionMock.anchorId;
    Object.assign(masonryReturn, {
      orderedVideos: [clip, after],
      displayVideos: [clip, after],
      orderedIds: [clip.id, after.id],
      orderForRange: [clip.id, after.id],
      virtualItems: [clip, after].map((item) => ({ id: item.id, item, style: {} })),
    });
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [clip, after],
      filteredVideoIds: new Set([clip.id, after.id]),
    }));
    selectionMock.selected = new Set([clip.id]);
    selectionMock.size = 1;
    selectionMock.anchorId = clip.id;
    metadataActionsReturn.handleSetReviewState.mockResolvedValue({
      success: true,
      updates: { "fp-a": { reviewState: "pick" } },
    });
    const hotkeys = () => useHotkeysMock.mock.calls.at(-1)?.[2];
    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      // Advance after marking is for review keys and buttons, not for these.
      act(() => useElectronLifecycleMock.mock.calls.at(-1)?.[0].setReviewAutoAdvance(true));
      selectionMock.selectExactly.mockClear();
      await waitFor(() => expect(window.electronAPI.companion.describe).toHaveBeenCalled());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => hotkeys().onQuickReview(0));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[1][0]).toMatchObject({ companionId: "c1", action: "finish", instanceIds: [7], dryRun: false });
      await waitFor(() =>
        expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith("pick", ["fp-a"])
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(selectionMock.selectExactly).not.toHaveBeenCalled();
      // No second quick action: it says so and sends nothing.
      await act(async () => hotkeys().onQuickReview(1));
      expect(await screen.findByText(/No connected app offers a second quick action/)).toBeInTheDocument();
      expect(send).toHaveBeenCalledTimes(2);

      // A card's button does what its key does, for that card's clip only.
      metadataActionsReturn.handleSetReviewState.mockClear();
      const cardProps = videoCardSpy.mock.calls
        .map(([props]) => props)
        .filter((props) => props.video.id === after.id)
        .at(-1);
      await act(async () => cardProps.onQuickAction(after.id, "c1", "finish"));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
      expect(send.mock.calls[3][0]).toMatchObject({ action: "finish", instanceIds: [8], dryRun: false });
      await waitFor(() =>
        expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith("pick", ["fp-b"])
      );
      expect(selectionMock.selectExactly).not.toHaveBeenCalled();
    } finally {
      Object.assign(masonryReturn, previousMasonry);
      selectionMock.selected = previousSelected;
      selectionMock.size = previousSize;
      selectionMock.anchorId = previousAnchor;
    }
  });

  test("in fullscreen, shows the clip's companion chip and buttons, and Shift+1 sends and accepts it without advancing", async () => {
    const clip = {
      id: "/library/a.mp4",
      name: "a.mp4",
      dirname: "",
      instanceId: 7,
      fingerprint: "fp-a",
      isElectronFile: true,
      reviewState: "unreviewed",
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [clip],
      activeRootPath: "/library",
      libraryRoot: { rootPath: "/library", name: "library", pinned: true },
    }));
    const send = vi.fn(async () => ({ success: true, results: { 7: { result: "sent", why: "" } } }));
    window.electronAPI = {
      saveSettingsPartial: vi.fn(),
      companion: {
        getConnections: vi.fn().mockResolvedValue([{ id: "c1", enabled: true, url: "http://127.0.0.1:9" }]),
        onConnectionsChanged: vi.fn(() => () => {}),
        describe: vi.fn().mockResolvedValue({
          success: true,
          name: "Helper",
          actions: [{ id: "finish", label: "Finish", send: "Finish it", quick: true }],
        }),
        lookup: vi.fn().mockResolvedValue({
          success: true,
          results: {
            7: {
              kind: "render",
              chip: { label: "New", tone: "info" },
              actions: { finish: { phase: "not-sent", why: "" } },
            },
          },
        }),
        send,
      },
    };
    const previousOrdered = masonryReturn.orderedVideos;
    masonryReturn.orderedVideos = [clip];
    const controller = {
      isOpen: true,
      currentVideo: clip,
      fullScreenVideo: clip,
      currentIndex: 0,
      fullScreenIndex: 0,
      currentViewIndex: 0,
      fullScreenCount: 1,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: false,
      hasNext: false,
      capturedNextId: null,
      collectionOwnerKey: "profile:/library",
      sessionToken: "fullscreen-session",
      open: vi.fn(),
      close: vi.fn(),
      navigateFullScreen: vi.fn(),
      peekNavigation: vi.fn(),
      sourceRemoved: vi.fn(),
      goToFullScreen: vi.fn(),
    };
    useFullScreenModalMock.mockReturnValue(controller);
    metadataActionsReturn.handleSetReviewState.mockResolvedValue({
      success: true,
      updates: { "fp-a": { reviewState: "pick" } },
    });
    const modal = () => fullScreenModalSpy.mock.calls.at(-1)?.[0];
    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      act(() => useElectronLifecycleMock.mock.calls.at(-1)?.[0].setReviewAutoAdvance(true));
      await waitFor(() =>
        expect(modal()?.reviewRail.props.quickActions).toEqual([
          expect.objectContaining({ key: "c1/finish", label: "Finish", shortcut: "Shift+1" }),
        ]),
        { timeout: 3000 }
      );
      expect(modal().reviewRail.props.companionChips).toEqual([
        expect.objectContaining({ key: "c1", label: "New", tone: "info" }),
      ]);

      // Shift+1 by physical key, whatever it prints: sent, then accepted.
      let handled;
      act(() => {
        handled = modal().onShortcut({ event: { shiftKey: true, code: "Digit1", key: "!" }, key: "!" });
      });
      expect(handled).toBe(true);
      await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[1][0]).toMatchObject({ companionId: "c1", action: "finish", instanceIds: [7], dryRun: false });
      await waitFor(() =>
        expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith("pick", ["fp-a"], {
          completionGuard: expect.any(Function),
        })
      );
      // Accepted, but the clip on screen stays: advancing is for review keys.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(controller.goToFullScreen).not.toHaveBeenCalled();
      expect(controller.peekNavigation).not.toHaveBeenCalled();

      // A button does what its key does: sent and accepted, staying put.
      metadataActionsReturn.handleSetReviewState.mockClear();
      await act(async () => modal().reviewRail.props.onQuickAction("c1", "finish"));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(4));
      await waitFor(() =>
        expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith("pick", ["fp-a"], {
          completionGuard: expect.any(Function),
        })
      );
      expect(controller.goToFullScreen).not.toHaveBeenCalled();
      expect(controller.peekNavigation).not.toHaveBeenCalled();

      // Shift+2 with no second quick action says so and sends nothing.
      act(() => {
        modal().onShortcut({ event: { shiftKey: true, code: "Digit2", key: "@" }, key: "@" });
      });
      expect(await screen.findByText(/No connected app offers a second quick action/)).toBeInTheDocument();
      expect(send).toHaveBeenCalledTimes(4);
    } finally {
      masonryReturn.orderedVideos = previousOrdered;
    }
  });

  test("opens a clip's workflow in ComfyUI from its context menu and says why not", async () => {
    const clip = {
      id: "/library/clip.mp4",
      name: "clip.mp4",
      fullPath: "/library/clip.mp4",
      dirname: "",
      instanceId: 42,
      promptKey: `pk2-${"a".repeat(32)}`,
      isElectronFile: true,
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [clip],
    }));
    useContextMenuMock.mockImplementation(() => ({
      ...contextMenuReturn,
      contextMenu: { visible: true, position: { x: 10, y: 10 }, contextId: clip.id },
    }));
    const openWorkflow = vi
      .fn()
      .mockResolvedValueOnce({ success: true, kind: "workflow" })
      .mockResolvedValueOnce({ success: false, code: "COMFY_UNAVAILABLE", error: "x" });
    window.electronAPI = { comfy: { openWorkflow } };
    const previousOrdered = masonryReturn.orderedVideos;
    masonryReturn.orderedVideos = [clip];
    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      const menu = () => contextMenuSpy.mock.calls.at(-1)[0];
      await act(async () => menu().onAction("comfy:open-workflow"));
      expect(openWorkflow).toHaveBeenCalledWith(42);
      await act(async () => menu().onAction("comfy:open-workflow"));
      expect(
        await screen.findByText(/ComfyUI is not answering\. Start it, or set its address/)
      ).toBeInTheDocument();
    } finally {
      masonryReturn.orderedVideos = previousOrdered;
      useContextMenuMock.mockImplementation(() => contextMenuReturn);
    }
  });

  test("Go to folder leaves a library view for the clip's folder and lands on it", async () => {
    const clip = {
      id: "/library/run-a/clip.mp4",
      name: "clip.mp4",
      basename: "clip.mp4",
      fullPath: "/library/run-a/clip.mp4",
      rootPath: "/library",
      dirname: "run-a",
      isElectronFile: true,
      tags: ["keeper"],
    };
    const handleElectronFolderSelection = vi.fn().mockResolvedValue(undefined);
    let lifecycle = {
      ...electronLifecycleReturn,
      videos: [clip],
      activeRootPath: null,
      tagCollection: { tags: ["keeper"], matchMode: "all", loadedAt: 1, truncated: false },
      handleElectronFolderSelection,
    };
    useElectronLifecycleMock.mockImplementation(() => lifecycle);
    useContextMenuMock.mockImplementation(() => ({
      ...contextMenuReturn,
      contextMenu: { visible: true, position: { x: 10, y: 10 }, contextId: clip.id },
    }));
    const authorizeRoot = vi.fn().mockResolvedValue({ success: true, rootPath: "/library" });
    const saveSettingsPartial = vi.fn();
    window.electronAPI = { library: { authorizeRoot }, saveSettingsPartial };
    const previousOrdered = masonryReturn.orderedVideos;
    // The right-clicked clip is on screen, so it is in the laid-out grid.
    masonryReturn.orderedVideos = [clip];
    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      const rendered = render(<App />);

      const menu = contextMenuSpy.mock.calls.at(-1)[0];
      expect(menu.canGoToFolder).toBe(true);
      await act(async () => {
        menu.onAction("library:go-to-folder");
      });
      await waitFor(() =>
        expect(handleElectronFolderSelection).toHaveBeenCalledWith("/library")
      );
      expect(authorizeRoot).toHaveBeenCalledWith("/library");
      expect(filterStateReturn.resetFilters).toHaveBeenCalled();
      // The clip sits in a subfolder, which only a recursive scan reaches.
      expect(saveSettingsPartial).toHaveBeenCalledWith(
        expect.objectContaining({ recursiveMode: true })
      );

      // The folder arrives: the clip is selected and scrolled into view.
      masonryReturn.scrollToId.mockReturnValue(true);
      lifecycle = { ...lifecycle, activeRootPath: "/library", tagCollection: null };
      rendered.rerender(<App />);
      await waitFor(() =>
        expect(selectionMock.setSelected).toHaveBeenCalledWith(new Set([clip.id]))
      );
      await waitFor(() =>
        expect(masonryReturn.scrollToId).toHaveBeenCalledWith(clip.id, {
          align: "center",
        })
      );
    } finally {
      masonryReturn.orderedVideos = previousOrdered;
      useContextMenuMock.mockImplementation(() => contextMenuReturn);
      masonryReturn.scrollToId.mockImplementation(() => false);
    }
  });

  test("re-opening a library root starts at the top of the grid", async () => {
    const videos = [
      { id: "video-a", name: "a.mp4", fingerprint: "fingerprint-a" },
      { id: "video-b", name: "b.mp4", fingerprint: "fingerprint-b" },
    ];
    const handleElectronFolderSelection = vi.fn().mockResolvedValue(undefined);
    let isLoadingFolder = false;
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", recursive: true },
      isLoadingFolder,
      handleElectronFolderSelection,
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    useLibraryCatalogMock.mockImplementation(() => ({
      pinnedRoots: [{ id: 1, rootPath: "/outputs", label: "outputs" }],
      currentRoot: null,
      directories: [],
      setPinned: setLibraryRootPinnedMock,
    }));
    const authorizeRoot = vi.fn().mockResolvedValue({
      success: true,
      rootPath: "/outputs",
    });
    window.electronAPI = { library: { authorizeRoot } };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    const rendered = render(<App />);

    // The initial restore writes scrollTop on a later animation frame; let it
    // land before scrolling so the reopen is what moves the viewport.
    const settleFrames = () =>
      act(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
      );
    await settleFrames();
    const viewport = document.querySelector(".content-region__viewport");
    viewport.scrollTop = 240;

    fireEvent.click(document.querySelector(".library-root-list__open"));
    await waitFor(() =>
      expect(handleElectronFolderSelection).toHaveBeenCalledWith("/outputs")
    );

    isLoadingFolder = true;
    act(() => rendered.rerender(<App />));
    isLoadingFolder = false;
    act(() => rendered.rerender(<App />));

    await waitFor(() => expect(viewport.scrollTop).toBe(0));
  });

  test("a sort the user picks starts at the top of the grid", async () => {
    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    await act(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    const viewport = document.querySelector(".content-region__viewport");
    const headerProps = () => topBarSpy.mock.calls.at(-1)?.[0];

    viewport.scrollTop = 240;
    act(() => headerProps().onSortChange("rating-desc"));
    expect(viewport.scrollTop).toBe(0);
    expect(headerProps().sortKey).toBe("rating");

    // Picking the sort already in use, or reshuffling and grouping, too.
    viewport.scrollTop = 240;
    act(() => headerProps().onSortChange("rating-desc"));
    expect(viewport.scrollTop).toBe(240);
    act(() => headerProps().onReshuffle());
    expect(viewport.scrollTop).toBe(0);
    viewport.scrollTop = 240;
    act(() => headerProps().onGroupByFoldersToggle());
    expect(viewport.scrollTop).toBe(0);
  });

  test("propagates minimized-window suspension through all expensive work", async () => {
    useWindowWorkSuspensionMock.mockReturnValue({
      isSuspended: true,
      reason: "window-minimized",
      activity: { active: false, minimized: true },
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    expect(usePlaybackTelemetryMock).toHaveBeenCalledWith({
      suspended: true,
      detailed: true,
      publishDiagnostics: false,
    });
    expect(useInitGateMock).toHaveBeenCalledWith({
      perFrame: 6,
      suspended: true,
    });
    expect(useAdaptivePlaybackPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ suspended: true })
    );

    const collectionArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(collectionArgs.workSuspended).toBe(true);

    const trashArgs = useTrashIntegrationMock.mock.calls.at(-1)?.[0];
    expect(trashArgs.workSuspended).toBe(true);

    const headerProps = topBarSpy.mock.calls.at(-1)?.[0];
    expect(headerProps.workSuspended).toBe(true);

    const overlayProps = loadingOverlaySpy.mock.calls.at(-1)?.[0];
    expect(overlayProps.workSuspensionReason).toBe("window-minimized");
    expect(setThumbSuspendedMock).toHaveBeenCalledWith(true);
  });

  test("freezes grid playback only while the covered pause is on and the window is covered", async () => {
    let reportCovered = () => {};
    const setPauseWhenCovered = vi.fn(() => Promise.resolve({ success: true }));
    window.electronAPI = {
      saveSettingsPartial: vi.fn(),
      playback: {
        setPauseWhenCovered,
        onWindowCovered: vi.fn((callback) => {
          reportCovered = callback;
          return () => {};
        }),
      },
    };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    const suspended = () =>
      useVideoCollectionMock.mock.calls.at(-1)?.[0].playbackSuspended;
    expect(setPauseWhenCovered).toHaveBeenLastCalledWith(false);

    act(() => reportCovered(true));
    expect(suspended()).toBe(false);

    // Loading a profile with the setting on tells main to start watching.
    act(() => useElectronLifecycleMock.mock.calls.at(-1)[0].setPauseWhenCovered(true));
    expect(setPauseWhenCovered).toHaveBeenLastCalledWith(true);
    act(() => reportCovered(true));
    expect(suspended()).toBe(true);

    act(() => reportCovered(false));
    expect(suspended()).toBe(false);
  });

  test("persists explicit playback and proxy controls", async () => {
    const saveSettingsPartial = vi.fn();
    window.electronAPI = { saveSettingsPartial };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    fireEvent.click(
      screen.getByRole("button", { name: "Use Static + Hover playback" })
    );

    let headerProps = topBarSpy.mock.calls.at(-1)?.[0];
    let collectionArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(headerProps.playbackMode).toBe("static-hover");
    expect(collectionArgs.playbackMode).toBe("static-hover");
    expect(saveSettingsPartial).toHaveBeenCalledWith({
      playbackMode: "static-hover",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Use All Motion playback" })
    );

    headerProps = topBarSpy.mock.calls.at(-1)?.[0];
    collectionArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(headerProps.playbackMode).toBe("all-motion");
    expect(collectionArgs.playbackMode).toBe("all-motion");
    expect(usePlaybackTelemetryMock).toHaveBeenLastCalledWith({
      suspended: false,
      detailed: false,
      publishDiagnostics: false,
    });

    // Per-sample diagnostics re-render the app, so they are published only
    // while the Playback details status line shows them.
    act(() => topBarSpy.mock.calls.at(-1)?.[0].onPlaybackDetailsToggle());
    expect(usePlaybackTelemetryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ publishDiagnostics: true })
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle proxy playback" })
    );

    // Proxies start on, so the first press turns them off.
    headerProps = topBarSpy.mock.calls.at(-1)?.[0];
    expect(headerProps.proxyPlaybackEnabled).toBe(false);
    expect(saveSettingsPartial).toHaveBeenCalledWith({
      proxyPlaybackEnabled: false,
    });
  });

  test("wires Hover audio header toggle into useVideoCollection state", async () => {
    window.electronAPI = { saveSettingsPartial: vi.fn() };
    vi.resetModules();
    const { default: App } = await import("./App.jsx");

    render(<App />);

    const hoverAudioToggle = screen.getByRole("button", { name: "Player audio on hover" });
    expect(hoverAudioToggle).toBeInTheDocument();
    expect(useVideoCollectionMock).toHaveBeenCalled();

    const initialArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(initialArgs.hoverAudioEnabled).toBe(false);

    fireEvent.click(hoverAudioToggle);

    const updatedArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(updatedArgs.hoverAudioEnabled).toBe(true);
    expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
      hoverAudioEnabled: true,
    });
    expect(topBarSpy).toHaveBeenCalled();
  });

  test("keeps navigation and rating while hiding review workflow when disabled", async () => {
    window.electronAPI = { saveSettingsPartial: vi.fn() };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      activeRootPath: "/outputs",
      libraryRoot: {
        rootPath: "/outputs",
        name: "outputs",
        recursive: true,
        refreshState: "idle",
      },
    }));
    vi.resetModules();
    const { default: App } = await import("./App.jsx");

    render(<App />);

    const toggle = screen.getByRole("button", { name: "Review" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("navigation", { name: "Location" })).toBeVisible();
    expect(screen.getByLabelText("Review workflow")).toBeVisible();
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
      reviewModeEnabled: false,
    });
    expect(useHotkeysMock.mock.calls.at(-1)?.[2]).toMatchObject({
      onSetReviewState: null,
      onUndoReview: null,
    });
    expect(useHotkeysMock.mock.calls.at(-1)?.[2].onSetRating).toEqual(
      expect.any(Function)
    );
    expect(screen.getByRole("navigation", { name: "Location" })).toBeVisible();
    expect(screen.queryByLabelText("Review workflow")).toBeNull();
  });

  test("keeps review in a library view and says why there is no resume point", async () => {
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      activeRootPath: null,
      tagCollection: { tags: ["keeper"], matchMode: "all", loadedAt: 1, truncated: false },
    }));
    vi.resetModules();
    const { default: App } = await import("./App.jsx");

    render(<App />);

    expect(screen.getByLabelText("Review workflow")).toBeVisible();
    expect(screen.getByText("No resume point in a library view", { selector: "strong" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Find next Unreviewed/ })).toBeNull();
    const processResults = screen.getByRole("button", { name: "Process results" });
    expect(processResults).toBeDisabled();
    expect(processResults).toHaveAttribute(
      "title",
      "Open a folder to process review results; a library view spans several."
    );
  });

  test("opens and closes keyboard shortcut help from the header", async () => {
    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" })
    ).toBeInTheDocument();
    expect(useHotkeysMock.mock.calls.at(-1)?.[2].enabled).toBe(false);

    fireEvent.click(
      screen.getByRole("button", { name: "Close keyboard shortcuts" })
    );
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" })
    ).not.toBeInTheDocument();
    expect(useHotkeysMock.mock.calls.at(-1)?.[2].enabled).toBe(true);
  });

  test("renders only the virtual window with stable collection-level callbacks", async () => {
    const videos = [
      { id: "video-1", name: "one.mp4" },
      { id: "video-2", name: "two.mp4" },
      { id: "video-3", name: "three.mp4" },
    ];
    const positions = videos.slice(0, 2).map((video, index) => ({
      id: video.id,
      item: video,
      style: {
        position: "absolute",
        width: "200px",
        height: "112px",
        transform: `translate3d(${index * 204}px, 16px, 0)`,
      },
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
      activationIds: positions.map((position) => position.id),
      centerPriorityIds: ["video-2", "video-1"],
      activationIdSet: new Set(positions.map((position) => position.id)),
      virtualItems: positions,
      totalHeight: 1600,
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    const rendered = render(<App />);

    expect(screen.getAllByTestId("video-card")).toHaveLength(2);
    expect(
      screen.getAllByTestId("video-card").map((node) => node.dataset.videoId)
    ).toEqual(["video-1", "video-2"]);

    const firstProps = videoCardSpy.mock.calls.find(
      ([props]) => props.video.id === "video-1"
    )?.[0];
    expect(firstProps).toBeTruthy();
    expect(firstProps).toMatchObject({
      workSuspended: false,
      proxyPlaybackEnabled: true,
      registerMediaElement: registerMediaElementMock,
    });

    const collectionArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(collectionArgs.centerPriorityIds).toBe(masonryReturn.centerPriorityIds);
    expect(collectionArgs.decoderTarget).toBe(playbackDecision.target);

    const renderCountBeforeUnrelatedParentRender = videoCardSpy.mock.calls.length;
    rendered.rerender(<App />);
    expect(videoCardSpy).toHaveBeenCalledTimes(
      renderCountBeforeUnrelatedParentRender
    );

    fireEvent.click(screen.getByRole("button", { name: "Player audio on hover" }));

    const lastProps = videoCardSpy.mock.calls
      .filter(([props]) => props.video.id === "video-1")
      .at(-1)?.[0];
    expect(lastProps.onSelect).toBe(firstProps.onSelect);
    expect(lastProps.canLoadVideo).toBe(firstProps.canLoadVideo);
    expect(lastProps.onVideoPlay).toBe(firstProps.onVideoPlay);
    expect(lastProps.onVideoPause).toBe(firstProps.onVideoPause);
    expect(lastProps.onPlayError).toBe(firstProps.onPlayError);
    expect(lastProps.onHover).toBe(firstProps.onHover);

    // Hovering is passed straight to the orchestrator and re-renders nothing.
    const markHover = useVideoCollectionMock.mock.results.at(-1)?.value.markHover;
    const rendersBeforeHover = useVideoCollectionMock.mock.calls.length;
    act(() => firstProps.onHover("video-1"));
    expect(markHover).toHaveBeenCalledWith("video-1");
    expect(useVideoCollectionMock.mock.calls).toHaveLength(rendersBeforeHover);

    act(() => firstProps.onUnmount("video-1"));
    expect(markHover).toHaveBeenCalledWith(null);

    act(() => firstProps.onVideoLoad("video-1", 16 / 9));
    const loadedProps = videoCardSpy.mock.calls
      .filter(([props]) => props.video.id === "video-1")
      .at(-1)?.[0];
    expect(loadedProps.isLoaded).toBe(true);

    const currentCollection = useVideoCollectionMock.mock.results.at(-1)?.value;
    currentCollection.reportPlayError.mockReturnValue(false);
    let staleErrorAccepted = true;
    act(() => {
      staleErrorAccepted = loadedProps.onPlayError(
        "video-1",
        new Error("old decoder"),
        { token: "stale" },
        null
      );
    });
    expect(staleErrorAccepted).toBe(false);
    const afterStaleErrorProps = videoCardSpy.mock.calls
      .filter(([props]) => props.video.id === "video-1")
      .at(-1)?.[0];
    expect(afterStaleErrorProps.isLoaded).toBe(true);

    act(() => loadedProps.onUnmount("video-1"));
    const unmountedProps = videoCardSpy.mock.calls
      .filter(([props]) => props.video.id === "video-1")
      .at(-1)?.[0];
    expect(unmountedProps.isLoaded).toBe(false);
    expect(unmountedProps.isVisible).toBe(false);
    expect(unmountedProps.isLoading).toBe(false);
  });

  test("selecting a card re-renders only the cards whose selection changed", async () => {
    const videos = [
      { id: "video-1", name: "one.mp4" },
      { id: "video-2", name: "two.mp4" },
      { id: "video-3", name: "three.mp4" },
    ];
    const positions = videos.map((video, index) => ({
      id: video.id,
      item: video,
      style: {
        position: "absolute",
        width: "200px",
        height: "112px",
        transform: `translate3d(${index * 204}px, 16px, 0)`,
      },
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
      activationIds: positions.map((position) => position.id),
      centerPriorityIds: videos.map((video) => video.id),
      activationIdSet: new Set(positions.map((position) => position.id)),
      virtualItems: positions,
      totalHeight: 1600,
    });

    const { default: realUseSelectionState } = await vi.importActual(
      "./hooks/selection/useSelectionState"
    );
    useSelectionStateMock.mockImplementation((...args) =>
      realUseSelectionState(...args)
    );
    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);

      const propsFor = (id) =>
        videoCardSpy.mock.calls.filter(([props]) => props.video.id === id);
      const firstProps = propsFor("video-1").at(-1)?.[0];
      const untouchedRenders = propsFor("video-3").length;

      act(() => firstProps.onSelect("video-1", false, false, false));
      expect(propsFor("video-1").at(-1)?.[0].selected).toBe(true);

      act(() => firstProps.onSelect("video-2", false, false, false));
      expect(propsFor("video-1").at(-1)?.[0].selected).toBe(false);
      expect(propsFor("video-2").at(-1)?.[0].selected).toBe(true);

      expect(propsFor("video-2").at(-1)?.[0].onSelect).toBe(firstProps.onSelect);
      expect(propsFor("video-3")).toHaveLength(untouchedRenders);
    } finally {
      useSelectionStateMock.mockImplementation(() => selectionMock);
    }
  });

  test("keeps an empty indexed root open and displays its path", async () => {
    const lifecycle = {
      ...electronLifecycleReturn,
      videos: [],
      activeRootPath: "/models/wan/empty-run",
      libraryRoot: {
        rootPath: "/models/wan/empty-run",
        name: "empty-run",
        pinned: false,
      },
      directorySummaries: [
        { relativePath: "", name: "empty-run", presentCount: 0 },
      ],
    };
    useElectronLifecycleMock.mockImplementation(() => lifecycle);
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [],
    }));

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    expect(screen.queryByText(/Welcome to Video Swarm/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Location" })
    ).toHaveTextContent("empty-run");
    const emptyStatus = screen
      .getByText("No videos in this collection")
      .closest('[role="status"]');
    expect(emptyStatus).toHaveTextContent("No videos in this collection");
    expect(emptyStatus).toHaveTextContent("/models/wan/empty-run");
  });

  test("keeps floating details selection-scoped without stealing passive focus", async () => {
    const videos = [
      { id: "video-a", name: "a.mp4", fingerprint: "fingerprint-a" },
      { id: "video-b", name: "b.mp4", fingerprint: "fingerprint-b" },
    ];
    selectionMock.selected = new Set(["video-a"]);
    selectionMock.size = 1;
    selectionMock.anchorId = "video-a";
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
      virtualItems: videos.map((video) => ({
        id: video.id,
        item: video,
        style: {},
      })),
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    const rendered = render(<App />);

    await waitFor(() => {
      expect(metadataPanelSpy.mock.calls.at(-1)?.[0].isOpen).toBe(true);
    });
    let panelProps = metadataPanelSpy.mock.calls.at(-1)?.[0];
    expect(panelProps).toMatchObject({
      selectionKey: '["video-a"]',
      anchorId: "video-a",
      focusToken: 0,
    });
    expect(panelProps.resolveAnchorRect("video-a")).toBeTruthy();
    const contentRegion = document.querySelector(".content-region");
    const viewport = document.querySelector(".content-region__viewport");
    viewport.scrollTop = 240;
    expect(contentRegion.className).toBe("content-region");
    expect(viewport.style.paddingBottom).toBe("");

    act(() => panelProps.onClose());
    expect(metadataPanelSpy.mock.calls.at(-1)?.[0].isOpen).toBe(false);
    expect(selectionMock.selected).toEqual(new Set(["video-a"]));
    expect(viewport.scrollTop).toBe(240);

    const hotkeyOptions = useHotkeysMock.mock.calls.at(-1)?.[2];
    act(() => hotkeyOptions.onOpenDetails());
    expect(metadataPanelSpy.mock.calls.at(-1)?.[0].isOpen).toBe(true);
    expect(metadataPanelSpy.mock.calls.at(-1)?.[0].focusToken).toBe(0);

    act(() => {
      selectionMock.selected = new Set(["video-b"]);
      selectionMock.size = 1;
      selectionMock.anchorId = "video-b";
      rendered.rerender(<App />);
    });
    await waitFor(() => {
      expect(metadataPanelSpy.mock.calls.at(-1)?.[0]).toMatchObject({
        isOpen: true,
        selectionKey: '["video-b"]',
        anchorId: "video-b",
        selectedVideos: [videos[1]],
      });
    });

    act(() => {
      selectionMock.selected = new Set();
      selectionMock.size = 0;
      selectionMock.anchorId = null;
      rendered.rerender(<App />);
    });
    await waitFor(() => {
      expect(metadataPanelSpy.mock.calls.at(-1)?.[0].isOpen).toBe(false);
    });
  });

  test("docked by default: Library at launch, Details follows new selections", async () => {
    const videos = ["follow-a", "follow-b"].map((id, index) => ({
      id,
      instanceId: 200 + index,
      name: `${id}.mp4`,
      fingerprint: `fingerprint-${id}`,
      reviewState: "unreviewed",
      tags: [],
    }));
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/follow-root",
      libraryRoot: { rootPath: "/follow-root", name: "follow-root", recursive: true },
      directorySummaries: [{ relativePath: "", name: "follow-root" }],
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
      virtualItems: videos.map((video) => ({ id: video.id, item: video, style: {} })),
    });
    window.electronAPI = { saveSettingsPartial: vi.fn() };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    const rendered = render(<App />);
    act(() => useElectronLifecycleMock.mock.calls.at(-1)?.[0].setMetadataInspectorMode("docked"));

    const libraryTab = () => screen.getByRole("tab", { name: "Library" });
    const detailsTab = () => screen.getByRole("tab", { name: /Details/ });
    const select = (id) =>
      act(() => {
        selectionMock.selected = new Set(id ? [id] : []);
        selectionMock.size = id ? 1 : 0;
        selectionMock.anchorId = id;
        rendered.rerender(<App />);
      });

    // Loading the saved mode does not hide the Library.
    expect(libraryTab()).toHaveAttribute("aria-selected", "true");
    expect(metadataPanelSpy.mock.calls.at(-1)?.[0].isOpen ?? false).toBe(false);

    select("follow-a");
    await waitFor(() => expect(detailsTab()).toHaveAttribute("aria-selected", "true"));

    // Going back to the Library dismisses Details for this selection only.
    fireEvent.click(libraryTab());
    select("follow-a");
    expect(libraryTab()).toHaveAttribute("aria-selected", "true");
    select("follow-b");
    await waitFor(() => expect(detailsTab()).toHaveAttribute("aria-selected", "true"));

    // A sidebar collapsed to the rail stays collapsed.
    fireEvent.click(libraryTab());
    select(null);
    fireEvent.click(libraryTab());
    expect(screen.queryByRole("tabpanel")).toBeNull();
    select("follow-a");
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(detailsTab()).toHaveAttribute("aria-selected", "false");

    // Its rail icon brings it back.
    fireEvent.click(detailsTab());
    expect(screen.getByRole("tabpanel", { name: /Details/ })).toBeVisible();

    // Reading Generation, the next clip keeps Generation in front.
    fireEvent.click(screen.getByRole("tab", { name: "Generation" }));
    select("follow-b");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Generation" })).toHaveAttribute("aria-selected", "true")
    );
    expect(detailsTab()).toHaveAttribute("aria-selected", "false");
  });

  test("docks selection details, keeps Library user-controlled, and suspends hidden generation work", async () => {
    const video = {
      id: "dock-video",
      instanceId: 91,
      name: "dock.mp4",
      fingerprint: "fingerprint-dock",
      reviewState: "unreviewed",
      tags: [],
    };
    selectionMock.selected = new Set([video.id]);
    selectionMock.size = 1;
    selectionMock.anchorId = video.id;
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [video],
      activeRootPath: "/dock-root",
      libraryRoot: { rootPath: "/dock-root", name: "dock-root", recursive: true },
      directorySummaries: [{ relativePath: "", name: "dock-root" }],
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [video],
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [video],
      displayVideos: [video],
      orderedIds: [video.id],
      orderForRange: [video.id],
      virtualItems: [{ id: video.id, item: video, style: {} }],
    });
    window.electronAPI = { saveSettingsPartial: vi.fn() };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    await waitFor(() => expect(metadataPanelSpy.mock.calls.at(-1)?.[0].isOpen).toBe(true));
    act(() => metadataPanelSpy.mock.calls.at(-1)?.[0].onDock());

    expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
      metadataInspectorMode: "docked",
    });
    expect(
      screen.getByRole("complementary", { name: "Sidebar" })
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: /Details/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    const generationCall = () => useGenerationMetadataMock.mock.calls
      .filter(([options]) => options.instanceId === 91)
      .at(-1)?.[0];
    // Docked Details keeps review and tags in view; the generation readout
    // has its own panel and is read only while that panel shows.
    const dockedDetails = screen.getByRole("region", { name: "Docked selection details" });
    expect(dockedDetails).toHaveTextContent("dock.mp4");
    expect(within(dockedDetails).queryByText("Generation")).toBeNull();
    expect(generationCall()).toMatchObject({ instanceId: 91, enabled: false });

    fireEvent.click(screen.getByRole("tab", { name: "Generation" }));
    expect(screen.getByRole("region", { name: "Docked generation details" }))
      .toHaveTextContent("dock.mp4");
    expect(screen.queryByRole("button", { name: /Collapse Generation details/ })).toBeNull();
    expect(generationCall()).toMatchObject({ instanceId: 91, enabled: true });

    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByRole("tab", { name: "Library" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(useGenerationMetadataMock.mock.calls
      .filter(([options]) => options.instanceId === 91)
      .at(-1)?.[0]).toMatchObject({
      instanceId: 91,
      enabled: false,
    });

    const hotkeyOptions = useHotkeysMock.mock.calls.at(-1)?.[2];
    act(() => hotkeyOptions.onOpenDetails());
    expect(screen.getByRole("tab", { name: /Details/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: "Undock selection details" }));
    expect(window.electronAPI.saveSettingsPartial).toHaveBeenLastCalledWith({
      metadataInspectorMode: "floating",
    });
    // Floating Details leaves the rail; the Library stays.
    expect(screen.queryByRole("tab", { name: /Details/ })).toBeNull();
    expect(screen.getByRole("tab", { name: "Library" })).toBeInTheDocument();
    expect(metadataPanelSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      isOpen: true,
      selectedVideos: [video],
    });
  });

  test("opens details opposite the fitted context menu and adopts its single target", async () => {
    const videos = [
      { id: "video-a", name: "a.mp4", fingerprint: "fingerprint-a" },
      { id: "video-b", name: "b.mp4", fingerprint: "fingerprint-b" },
    ];
    selectionMock.selected = new Set(["video-a"]);
    selectionMock.size = 1;
    selectionMock.anchorId = "video-a";
    Object.assign(contextMenuReturn.contextMenu, {
      visible: true,
      position: { x: 900, y: 160 },
      contextId: "video-b",
    });
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      virtualItems: videos.map((video) => ({ id: video.id, item: video, style: {} })),
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    await waitFor(() => expect(contextMenuSpy).toHaveBeenCalled());

    const menuRect = {
      x: 700,
      y: 160,
      left: 700,
      top: 160,
      right: 980,
      bottom: 520,
      width: 280,
      height: 360,
    };
    let menuProps = contextMenuSpy.mock.calls.at(-1)?.[0];
    act(() =>
      menuProps.onPlacementChange({
        contextId: "video-b",
        rect: menuRect,
        side: "left",
      })
    );
    menuProps = contextMenuSpy.mock.calls.at(-1)?.[0];
    act(() => menuProps.onAction("metadata:open"));

    expect(selectionMock.selectOnly).toHaveBeenCalledWith("video-b");
    expect(metadataPanelSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      isOpen: true,
      anchorId: "video-b",
      focusToken: 1,
      placementRequest: expect.objectContaining({
        anchorId: "video-b",
        avoidRect: menuRect,
        reason: "context-menu-open-details",
      }),
    });
  });

  test("routes panel and context review mutations through workflow undo", async () => {
    const videos = [
      {
        id: "video-a",
        name: "a.mp4",
        fingerprint: "fingerprint-a",
        reviewState: "unreviewed",
        rating: null,
      },
      {
        id: "video-b",
        name: "b.mp4",
        fingerprint: "fingerprint-b",
        reviewState: "unreviewed",
        rating: null,
      },
    ];
    selectionMock.selected = new Set(["video-a"]);
    selectionMock.size = 1;
    selectionMock.anchorId = "video-a";
    Object.assign(contextMenuReturn.contextMenu, {
      visible: true,
      position: { x: 900, y: 160 },
      contextId: "video-b",
    });
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
      virtualItems: videos.map((video) => ({ id: video.id, item: video, style: {} })),
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const panelProps = metadataPanelSpy.mock.calls.at(-1)?.[0];
    await act(async () => panelProps.onSetReviewState("pick"));
    const hotkeyOptions = useHotkeysMock.mock.calls.at(-1)?.[2];
    await act(async () => hotkeyOptions.onUndoReview());

    expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith(
      "pick",
      ["fingerprint-a"]
    );
    expect(metadataActionsReturn.handleRestoreReviewMetadata).toHaveBeenCalledWith([
      {
        fingerprint: "fingerprint-a",
        reviewState: "unreviewed",
        rating: null,
      },
    ]);

    metadataActionsReturn.handleSetReviewState.mockClear();
    metadataActionsReturn.handleRestoreReviewMetadata.mockClear();
    const menuProps = contextMenuSpy.mock.calls.at(-1)?.[0];
    await act(async () => menuProps.onAction("metadata:review:reject"));
    await act(async () => hotkeyOptions.onUndoReview());

    expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith(
      "reject",
      ["fingerprint-b"]
    );
    expect(metadataActionsReturn.handleRestoreReviewMetadata).toHaveBeenCalledWith([
      {
        fingerprint: "fingerprint-b",
        reviewState: "unreviewed",
        rating: null,
      },
    ]);
  });

  test("starts a persistent review session after the first positive review action", async () => {
    const activeVideo = {
      id: "video-session-a",
      instanceId: 41,
      name: "a.mp4",
      basename: "a.mp4",
      fingerprint: "fingerprint-session-a",
      reviewState: "unreviewed",
      rating: null,
    };
    selectionMock.selected = new Set([activeVideo.id]);
    selectionMock.size = 1;
    selectionMock.anchorId = activeVideo.id;
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [activeVideo],
      activeRootPath: "/session-root",
      libraryRoot: {
        rootPath: "/session-root",
        recursive: true,
        refreshState: "idle",
      },
      directorySummaries: [{ relativePath: "", presentCount: 1 }],
      loadingStatus: { phase: "complete" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [activeVideo],
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [activeVideo],
      displayVideos: [activeVideo],
      orderedIds: [activeVideo.id],
      orderForRange: [activeVideo.id],
    });
    const save = vi.fn(async (nextDraft) => ({
      checkpoint: { ...nextDraft, updatedAt: 1234 },
    }));
    window.electronAPI = {
      review: {
        sessions: {
          list: vi.fn().mockResolvedValue({ sessions: [] }),
          get: vi.fn().mockResolvedValue({ checkpoint: null }),
          save,
          clear: vi.fn().mockResolvedValue({ deleted: true }),
          onFlushRequested: vi.fn(() => vi.fn()),
          acknowledgeFlush: vi.fn(),
        },
      },
    };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const panelProps = metadataPanelSpy.mock.calls.at(-1)?.[0];
    await act(async () => panelProps.onSetReviewState("pick"));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/session-root",
        directory: "",
        scope: "all-descendants",
        anchorInstanceId: 41,
        anchorFingerprint: "fingerprint-session-a",
      })
    );
    expect(refreshLibraryRootsMock).toHaveBeenCalled();
    expect(refreshLibraryTreeMock).toHaveBeenCalledWith("/session-root");
  });

  test("keeps passive same-root navigation separate from an explicit session move", async () => {
    const videos = [
      {
        id: "root-video",
        instanceId: 1,
        name: "root.mp4",
        dirname: "",
        fingerprint: "fingerprint-root",
        reviewState: "reviewed",
      },
      {
        id: "run-b-video",
        instanceId: 2,
        name: "run-b.mp4",
        dirname: "run-b",
        fingerprint: "fingerprint-run-b",
        reviewState: "unreviewed",
      },
    ];
    selectionMock.selected = new Set(["run-b-video"]);
    selectionMock.size = 1;
    selectionMock.anchorId = "run-b-video";
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", recursive: true },
      directorySummaries: [
        { relativePath: "", name: "outputs" },
        { relativePath: "run-b", name: "run-b" },
      ],
      loadingStatus: { phase: "complete" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
    });
    const sessions = installReviewSessionsApi({
      checkpoint: reviewCheckpoint("/outputs"),
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    await waitFor(() =>
      expect(screen.getAllByText("Review position saved").length).toBeGreaterThan(0)
    );
    sessions.save.mockClear();
    fireEvent.click(screen.getByTitle("run-b"));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Folder scope" })).toHaveValue(
        "current-folder"
      )
    );
    expect(screen.getAllByText("Resume point saved elsewhere")[0]).toBeVisible();

    const panelProps = metadataPanelSpy.mock.calls.at(-1)?.[0];
    await act(async () => panelProps.onSetReviewState("pick"));
    expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith(
      "pick",
      ["fingerprint-run-b"]
    );
    expect(sessions.save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", {
      name: /Save current position instead/,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Save position" }));
    await waitFor(() => expect(sessions.save).toHaveBeenCalledOnce());
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/outputs",
        directory: "run-b",
        scope: "current-folder",
      })
    );
  });

  test("drains the child cursor before disabling recursive ownership", async () => {
    const childVideo = {
      id: "recursive-child-video",
      instanceId: 15,
      name: "child.mp4",
      dirname: "run-a",
      fingerprint: "fingerprint-recursive-child",
      reviewState: "unreviewed",
    };
    const reloadCurrentRoot = vi.fn().mockResolvedValue(true);
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [childVideo],
      activeRootPath: "/recursive-root",
      libraryRoot: { rootPath: "/recursive-root", recursive: true },
      directorySummaries: [
        { relativePath: "", name: "recursive-root" },
        { relativePath: "run-a", name: "run-a" },
      ],
      loadingStatus: { phase: "complete" },
      reloadCurrentRoot,
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [childVideo],
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [childVideo],
      displayVideos: [childVideo],
      orderedIds: [childVideo.id],
      orderForRange: [childVideo.id],
    });
    const pendingSave = createDeferredPromise();
    const save = vi.fn(() => pendingSave.promise);
    installReviewSessionsApi({ save });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    fireEvent.click(screen.getByTitle("run-a"));
    await waitFor(() => expect(reloadCurrentRoot).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Folder scope" })).toHaveValue(
        "current-folder"
      )
    );
    reloadCurrentRoot.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Find next Unreviewed/ }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("checkbox", { name: "Include subfolders" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(reloadCurrentRoot).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Folder scope" })).toHaveValue(
      "current-folder"
    );

    await act(async () => {
      const draft = save.mock.calls[0][0];
      pendingSave.resolve({ checkpoint: { ...draft, updatedAt: 3456 } });
      await pendingSave.promise;
      await flushPromiseTurns();
    });
    await waitFor(() => expect(reloadCurrentRoot).toHaveBeenCalledWith(false));
    expect(screen.getByRole("combobox", { name: "Folder scope" })).toHaveValue(
      "all-descendants"
    );
  });

  test("does not layout-save a null anchor while Continue is still resolving", async () => {
    const reviewedVideo = {
      id: "resume-anchor-video",
      instanceId: 91,
      name: "anchor.mp4",
      fingerprint: "fingerprint-anchor",
      reviewState: "reviewed",
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [reviewedVideo],
      activeRootPath: "/guarded-resume",
      activeScanId: "guarded-scan",
      cachedHydration: { scanId: "guarded-scan" },
      cachedHydrationComplete: true,
      isRefreshingFolder: true,
      libraryRoot: { rootPath: "/guarded-resume", recursive: true },
      directorySummaries: [{ relativePath: "", name: "guarded-resume" }],
      loadingStatus: { phase: "indexing" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [reviewedVideo],
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [],
      displayVideos: [],
      orderedIds: [],
      orderForRange: [],
    });
    const sessions = installReviewSessionsApi({
      checkpoint: reviewCheckpoint("/guarded-resume", {
        directory: "",
        scope: "current-folder",
        anchorInstanceId: reviewedVideo.instanceId,
        anchorFingerprint: reviewedVideo.fingerprint,
      }),
    });
    window.electronAPI.library = {
      authorizeRoot: vi.fn().mockResolvedValue({
        success: true,
        rootPath: "/guarded-resume",
      }),
    };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const continueButton = await screen.findByRole("button", {
      name: /Resume saved position/,
    });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(continueButton);
      await flushPromiseTurns();
    });
    expect(screen.getByRole("combobox", { name: "Folder scope" })).toHaveValue(
      "current-folder"
    );
    expect(window.electronAPI.library.authorizeRoot).toHaveBeenCalled();
    expect(sessions.save).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sessions.save).not.toHaveBeenCalled();
    expect(selectionMock.selectExactly).not.toHaveBeenCalled();
  });

  test("keeps Start unresolved when checkpoint persistence fails", async () => {
    const activeVideo = {
      id: "failed-start-video",
      instanceId: 101,
      name: "failed-start.mp4",
      fingerprint: "fingerprint-failed-start",
      reviewState: "unreviewed",
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [activeVideo],
      activeRootPath: "/failed-start",
      libraryRoot: { rootPath: "/failed-start", recursive: true },
      loadingStatus: { phase: "complete" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [activeVideo],
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [activeVideo],
      displayVideos: [activeVideo],
      orderedIds: [activeVideo.id],
      orderForRange: [activeVideo.id],
    });
    const save = vi.fn().mockResolvedValue({
      success: false,
      error: "Checkpoint disk is unavailable",
    });
    const sessions = installReviewSessionsApi({ save });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const startButton = await screen.findByRole("button", {
      name: /Find next Unreviewed/,
    });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(startButton);
      await flushPromiseTurns();
    });
    expect(save).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Checkpoint disk is unavailable"
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(save).toHaveBeenCalledOnce();
    expect(sessions.get).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Find next Unreviewed/ })).toBeVisible();
    expect(selectionMock.selectExactly).not.toHaveBeenCalled();
    expect(screen.queryByText("Restoring saved review…")).toBeNull();
  });

  test("keeps the old cursor when an explicit Move fails", async () => {
    const videos = [
      {
        id: "old-cursor-video",
        instanceId: 111,
        name: "old.mp4",
        dirname: "",
        fingerprint: "fingerprint-old",
        reviewState: "reviewed",
      },
      {
        id: "move-target-video",
        instanceId: 112,
        name: "target.mp4",
        dirname: "run-b",
        fingerprint: "fingerprint-target",
        reviewState: "unreviewed",
      },
    ];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/failed-move",
      libraryRoot: { rootPath: "/failed-move", recursive: true },
      directorySummaries: [
        { relativePath: "", name: "failed-move" },
        { relativePath: "run-b", name: "run-b" },
      ],
      loadingStatus: { phase: "complete" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
    });
    const save = vi.fn().mockResolvedValue({
      success: false,
      error: "Checkpoint disk is unavailable",
    });
    const sessions = installReviewSessionsApi({
      checkpoint: reviewCheckpoint("/failed-move", {
        anchorInstanceId: videos[0].instanceId,
        anchorFingerprint: videos[0].fingerprint,
      }),
      save,
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    await waitFor(() =>
      expect(screen.getAllByText("Review position saved").length).toBeGreaterThan(0)
    );
    fireEvent.click(screen.getByTitle("run-b"));
    await waitFor(() =>
      expect(screen.getAllByText("Resume point saved elsewhere").length).toBeGreaterThan(0)
    );
    const getCallCount = sessions.get.mock.calls.length;
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", {
      name: /Save current position instead/,
    }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save position" }));
      await flushPromiseTurns();
    });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(save).toHaveBeenCalledOnce();
    expect(sessions.get).toHaveBeenCalledTimes(getCallCount);
    expect(screen.getAllByText("Resume point saved elsewhere")[0]).toBeVisible();
    expect(selectionMock.selectExactly).not.toHaveBeenCalled();
    expect(screen.queryByText("Restoring saved review…")).toBeNull();
  });

  test("keeps a session intact when Forget reports that nothing was deleted", async () => {
    const activeVideo = {
      id: "reviewed-video",
      name: "reviewed.mp4",
      fingerprint: "fingerprint-reviewed",
      reviewState: "reviewed",
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [activeVideo],
      activeRootPath: "/forget-root",
      libraryRoot: { rootPath: "/forget-root", recursive: true },
      loadingStatus: { phase: "complete" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [activeVideo],
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [activeVideo],
      displayVideos: [activeVideo],
      orderedIds: [activeVideo.id],
      orderForRange: [activeVideo.id],
    });
    const clear = vi.fn().mockResolvedValue({ deleted: false });
    installReviewSessionsApi({
      checkpoint: reviewCheckpoint("/forget-root"),
      clear,
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    await waitFor(() =>
      expect(screen.getAllByText("Review position saved").length).toBeGreaterThan(0)
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear resume point…" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear resume point" }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith("/forget-root"));

    expect(screen.getAllByText("Review position saved")[0]).toBeVisible();
    expect(document.body).not.toHaveTextContent("Cleared the review resume point");
  });

  test("reactivates completed sessions without stealing focus on passive discovery", async () => {
    const reviewedVideo = {
      id: "reviewed-run-a",
      instanceId: 21,
      name: "reviewed.mp4",
      dirname: "",
      fingerprint: "fingerprint-reviewed-a",
      reviewState: "reviewed",
    };
    const excludedVideo = {
      id: "unreviewed-run-b",
      instanceId: 22,
      name: "excluded.mp4",
      dirname: "run-b",
      fingerprint: "fingerprint-excluded-b",
      reviewState: "unreviewed",
    };
    const visibleVideo = {
      id: "unreviewed-run-a",
      instanceId: 23,
      name: "visible.mp4",
      dirname: "",
      fingerprint: "fingerprint-visible-a",
      reviewState: "unreviewed",
    };
    let lifecycleVideos = [reviewedVideo];
    let catalogRoot = {
      rootPath: "/resume-root",
      label: "Resume root",
      pinned: true,
      presentCount: 1,
      reviewedCount: 1,
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: lifecycleVideos,
      activeRootPath: "/resume-root",
      activeScanId: "resume-scan",
      libraryRoot: { ...catalogRoot, recursive: true },
      directorySummaries: [
        { relativePath: "", name: "Resume root" },
        { relativePath: "run-a", name: "run-a" },
        { relativePath: "run-b", name: "run-b" },
      ],
      loadingStatus: { phase: "complete" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: lifecycleVideos,
    }));
    useLibraryCatalogMock.mockImplementation(() => ({
      roots: [catalogRoot],
      pinnedRoots: [catalogRoot],
      currentRoot: catalogRoot,
      directories: [
        { relativePath: "", name: "Resume root" },
        { relativePath: "run-a", name: "run-a" },
        { relativePath: "run-b", name: "run-b" },
      ],
      refreshRoots: refreshLibraryRootsMock,
      refreshTree: refreshLibraryTreeMock,
      setPinned: setLibraryRootPinnedMock,
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [reviewedVideo],
      displayVideos: [reviewedVideo],
      orderedIds: [reviewedVideo.id],
      orderForRange: [reviewedVideo.id],
    });
    installReviewSessionsApi({
      checkpoint: reviewCheckpoint("/resume-root", {
        directory: "",
        scope: "current-folder",
      }),
    });
    window.electronAPI.library = {
      authorizeRoot: vi.fn().mockResolvedValue({
        success: true,
        rootPath: "/resume-root",
      }),
    };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    const rendered = render(<App />);

    fireEvent.click(await screen.findByRole("button", {
      name: /Resume saved position/,
    }));
    await screen.findByText("Review complete");
    const stableFocusTarget = screen.getByRole("button", {
      name: "Keyboard shortcuts",
    });
    stableFocusTarget.focus();
    expect(stableFocusTarget).toHaveFocus();
    selectionMock.selectExactly.mockClear();
    masonryReturn.scrollToId.mockClear();

    lifecycleVideos = [reviewedVideo, excludedVideo];
    catalogRoot = { ...catalogRoot, presentCount: 2, reviewedCount: 1 };
    Object.assign(masonryReturn, {
      orderedVideos: [reviewedVideo],
      displayVideos: [reviewedVideo],
      orderedIds: [reviewedVideo.id],
      orderForRange: [reviewedVideo.id],
    });
    rendered.rerender(<App />);
    await screen.findByText("Review complete for this saved view");
    expect(screen.getByRole("button", {
      name: "Review all Unreviewed",
    })).toBeVisible();
    expect(selectionMock.selectExactly).not.toHaveBeenCalled();
    expect(masonryReturn.scrollToId).not.toHaveBeenCalled();
    expect(stableFocusTarget).toHaveFocus();

    lifecycleVideos = [reviewedVideo, excludedVideo, visibleVideo];
    catalogRoot = { ...catalogRoot, presentCount: 3, reviewedCount: 1 };
    Object.assign(masonryReturn, {
      orderedVideos: [reviewedVideo, visibleVideo],
      displayVideos: [reviewedVideo, visibleVideo],
      orderedIds: [reviewedVideo.id, visibleVideo.id],
      orderForRange: [reviewedVideo.id, visibleVideo.id],
    });
    rendered.rerender(<App />);
    await screen.findByText("New Unreviewed clips");
    expect(selectionMock.selectExactly).not.toHaveBeenCalled();
    expect(masonryReturn.scrollToId).not.toHaveBeenCalled();
    expect(stableFocusTarget).toHaveFocus();

    fireEvent.click(screen.getByRole("button", {
      name: /^Resume review —/,
    }));
    await waitFor(() =>
      expect(selectionMock.selectExactly).toHaveBeenCalledWith(visibleVideo.id)
    );
  });

  test("invalidates review undo when the active profile changes", async () => {
    const activeVideo = {
      id: "video-a",
      name: "a.mp4",
      fingerprint: "fingerprint-a",
      reviewState: "unreviewed",
      rating: null,
    };
    selectionMock.selected = new Set([activeVideo.id]);
    selectionMock.size = 1;
    selectionMock.anchorId = activeVideo.id;
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [activeVideo],
      activeRootPath: "/same-root",
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [activeVideo],
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [activeVideo],
      displayVideos: [activeVideo],
      orderedIds: [activeVideo.id],
      orderForRange: [activeVideo.id],
    });
    const profileChanged = [];
    window.electronAPI = {
      profiles: {
        onChanged: vi.fn((callback) => {
          profileChanged.push(callback);
          return vi.fn();
        }),
      },
    };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const panelProps = metadataPanelSpy.mock.calls.at(-1)?.[0];
    await act(async () => panelProps.onSetReviewState("pick"));
    metadataActionsReturn.handleSetReviewState.mockClear();
    metadataActionsReturn.handleRestoreReviewMetadata.mockClear();

    act(() => {
      profileChanged.forEach((callback) =>
        callback({ profileName: "other-profile" })
      );
    });
    const hotkeyOptions = useHotkeysMock.mock.calls.at(-1)?.[2];
    await act(async () => hotkeyOptions.onUndoReview());

    expect(metadataActionsReturn.handleSetReviewState).not.toHaveBeenCalled();
    expect(metadataActionsReturn.handleRestoreReviewMetadata).not.toHaveBeenCalled();
  });

  test("keeps metadata targets for selected videos hidden by filters", async () => {
    const hiddenVideo = {
      id: "hidden-video",
      name: "hidden.mp4",
      fingerprint: "fingerprint-hidden",
      reviewState: "pick",
    };
    selectionMock.selected = new Set([hiddenVideo.id]);
    selectionMock.size = 1;
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [hiddenVideo],
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [],
    }));

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    expect(metadataPanelSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      selectionCount: 1,
      selectedVideos: [hiddenVideo],
    });
    expect(useMetadataActionsMock.mock.calls.at(-1)?.[0].selectedFingerprints).toEqual([
      "fingerprint-hidden",
    ]);
    expect(selectionMock.pruneTo).toHaveBeenCalledWith(new Set([hiddenVideo.id]));
  });

  test("requires an authoritative direct-folder scope before processing a nonrecursive root", async () => {
    const rootVideo = {
      id: "root-video",
      name: "root.mp4",
      dirname: "",
      fingerprint: "fingerprint-root",
      reviewState: "reject",
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [rootVideo],
      activeRootPath: "/outputs",
      libraryRoot: {
        rootPath: "/outputs",
        name: "outputs",
        recursive: false,
        refreshState: "idle",
      },
      loadingStatus: { phase: "complete" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [rootVideo],
    }));

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const processResults = screen.getByRole("button", { name: "Process results" });
    expect(processResults).toBeDisabled();
    expect(processResults).toHaveAttribute(
      "title",
      expect.stringContaining("Choose Current folder")
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Folder scope" }), {
      target: { value: "current-folder" },
    });
    await waitFor(() => expect(processResults).toBeEnabled());
  });

  test("plans Copy Accepted from the authoritative native scope without renderer records", async () => {
    const acceptedVideo = {
      id: "accepted-video",
      name: "accepted.mp4",
      dirname: "",
      fingerprint: "fingerprint-accepted",
      reviewState: "pick",
      isElectronFile: true,
      fullPath: "/outputs/accepted.mp4",
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [acceptedVideo],
      activeRootPath: "/outputs",
      libraryRoot: {
        rootPath: "/outputs",
        name: "outputs",
        recursive: true,
        refreshState: "idle",
      },
      loadingStatus: { phase: "complete" },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [acceptedVideo],
    }));
    const prepare = vi.fn().mockResolvedValue({
      success: true,
      planId: "copy-plan-app-1",
      destinationLabel: "Accepted",
      mediaCount: 1,
      totalBytes: 16,
      collisionCount: 0,
      collisionSamples: [],
      missingCount: 0,
      failureCount: 0,
      failureSamples: [],
      totalFiles: 1,
      copyableCount: 1,
      canStart: true,
    });
    const start = vi.fn().mockResolvedValue({
      success: true,
      copiedCount: 1,
      copiedMedia: 1,
      failedCount: 0,
    });
    const cancel = vi.fn().mockResolvedValue({ cancelled: true });
    const unsubscribe = vi.fn();
    const onProgress = vi.fn(() => unsubscribe);
    window.electronAPI = {
      review: {
        copyAccepted: { prepare, start, cancel, onProgress },
      },
    };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    const { unmount } = render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Process results" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));

    await waitFor(() => expect(prepare).toHaveBeenCalledWith({
      rootPath: "/outputs",
      directory: "",
      scope: "all-descendants",
      // Scope stays authoritative; these only say "no reuse, keep folders".
      destinationPath: null,
      layout: "structured",
      reusePlanId: null,
    }));
    expect(prepare.mock.calls[0][0]).not.toHaveProperty("videos");
    expect(prepare.mock.calls[0][0]).not.toHaveProperty("records");

    fireEvent.click(await screen.findByRole("button", { name: /Copy 1 file/ }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("copy-plan-app-1", "copy")
    );
    expect(await screen.findByText("Copy complete")).toBeInTheDocument();

    unmount();
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("closes and cancels a prepared Copy Accepted plan when root ownership changes", async () => {
    const acceptedVideo = {
      id: "accepted-video",
      name: "accepted.mp4",
      dirname: "",
      fingerprint: "fingerprint-accepted",
      reviewState: "pick",
    };
    let lifecycle = {
      ...electronLifecycleReturn,
      videos: [acceptedVideo],
      activeRootPath: "/outputs",
      libraryRoot: {
        rootPath: "/outputs",
        name: "outputs",
        recursive: true,
        refreshState: "idle",
      },
      loadingStatus: { phase: "complete" },
    };
    useElectronLifecycleMock.mockImplementation(() => lifecycle);
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [acceptedVideo],
    }));
    const cancel = vi.fn().mockResolvedValue({ success: true, cancelled: true });
    window.electronAPI = {
      review: {
        copyAccepted: {
          prepare: vi.fn().mockResolvedValue({
            success: true,
            planId: "copy-plan-root-change",
            destinationLabel: "Accepted",
            mediaCount: 1,
            totalBytes: 16,
            collisionCount: 0,
            collisionSamples: [],
            missingCount: 0,
            failureCount: 0,
            failureSamples: [],
            totalFiles: 1,
            copyableCount: 1,
            canStart: true,
          }),
          start: vi.fn(),
          cancel,
          onProgress: vi.fn(() => vi.fn()),
        },
      },
    };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    const rendered = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Process results" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose destination…" }));
    await screen.findByRole("button", { name: /Copy 1 file/ });

    lifecycle = {
      ...lifecycle,
      activeRootPath: "/other",
      libraryRoot: {
        ...lifecycle.libraryRoot,
        rootPath: "/other",
        name: "other",
      },
    };
    rendered.rerender(<App />);

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(
      "copy-plan-root-change"
    ));
    expect(screen.queryByRole("dialog", { name: "Process review results" }))
      .not.toBeInTheDocument();
  });

  test("stacks runs of one prompt, opens, steps through and closes stacks", async () => {
    const PK_A = `pk1-${"a".repeat(32)}`;
    const PK_B = `pk1-${"b".repeat(32)}`;
    const clip = (id, promptKey, createdMs) => ({
      id,
      name: `${id}.mp4`,
      dirname: "",
      fingerprint: `fp-${id}`,
      promptKey,
      reviewState: "unreviewed",
      createdMs,
    });
    const videos = [
      clip("a1", PK_A, 1),
      clip("a2", PK_A, 2),
      clip("solo", null, 3),
      clip("b1", PK_B, 4),
      clip("b2", PK_B, 6),
      clip("b3", PK_B, 5),
    ];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [{ relativePath: "", name: "outputs" }],
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    // The grid lays out whatever it is given, in that order.
    useMasonryLayoutMock.mockImplementation((args) => ({
      ...masonryReturn,
      orderedVideos: args.filteredVideos,
      orderForRange: args.filteredVideos.map((video) => video.id),
      virtualItems: args.filteredVideos.map((video) => ({
        id: video.id,
        item: video,
        style: {},
      })),
    }));
    const saveSettingsPartial = vi.fn();
    window.electronAPI = { saveSettingsPartial };
    const gridIds = () =>
      useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos.map((video) => video.id);
    const hotkeys = () => useHotkeysMock.mock.calls.at(-1)?.[2];
    const cardProps = (id) =>
      videoCardSpy.mock.calls.map(([props]) => props).filter((props) => props.video.id === id).at(-1);

    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      expect(gridIds()).toEqual(["a1", "a2", "solo", "b1", "b2", "b3"]);

      await act(async () => hotkeys().onToggleStacks());
      expect(saveSettingsPartial).toHaveBeenCalledWith({ stackByPrompt: true });
      // Each stack shows its newest run where that run sorts.
      await waitFor(() => expect(gridIds()).toEqual(["a2", "solo", "b2"]));
      expect(cardProps("a2")).toMatchObject({ stackCount: 2, stackTotal: 2 });
      expect(cardProps("b2")).toMatchObject({ stackCount: 3, stackTotal: 3 });
      expect(cardProps("solo").stackCount).toBe(0);
      // Collapsed runs select together.
      const { unitsRef } = useSelectionStateMock.mock.calls[0][0];
      expect(unitsRef.current.membersOf(unitsRef.current.unitOf("a1"))).toEqual(["a1", "a2"]);

      // Ctrl+A selects every card the grid shows; the stacks' units widen
      // each to all of its runs.
      await act(async () => hotkeys().onSelectAll());
      expect(selectionMock.setSelectedIds).toHaveBeenLastCalledWith(["a2", "solo", "b2"]);
      expect(hotkeys().onClearSelection).toBe(selectionMock.clear);

      await act(async () => cardProps("a2").onOpenStack("a2"));
      await waitFor(() => expect(gridIds()).toEqual(["a1", "a2"]));
      expect(screen.getByText("Stack 1 of 2 · 2 runs")).toBeInTheDocument();
      expect(selectionMock.selectExactly).toHaveBeenLastCalledWith("a2");
      // Inside a stack each run selects on its own.
      expect(unitsRef.current).toBeNull();

      await act(async () => hotkeys().onNextFolder());
      await waitFor(() => expect(gridIds()).toEqual(["b1", "b2", "b3"]));
      expect(screen.getByText("Stack 2 of 2 · 3 runs")).toBeInTheDocument();

      await act(async () => hotkeys().onRejectUnreviewedInStack());
      await waitFor(() =>
        expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith(
          "reject",
          ["fp-b1", "fp-b2", "fp-b3"]
        )
      );

      await act(async () => hotkeys().onCloseStack());
      await waitFor(() => expect(gridIds()).toEqual(["a2", "solo", "b2"]));
      expect(selectionMock.selectExactly).toHaveBeenLastCalledWith("b2");
      expect(screen.queryByRole("toolbar", { name: "Open prompt stack" })).toBeNull();

      await act(async () => hotkeys().onToggleStacks());
      await waitFor(() => expect(gridIds()).toEqual(["a1", "a2", "solo", "b1", "b2", "b3"]));
      expect(saveSettingsPartial).toHaveBeenLastCalledWith({ stackByPrompt: false });
    } finally {
      useMasonryLayoutMock.mockImplementation(() => masonryReturn);
    }
  });

  test("shows a clip's versions side by side, from other folders too, and leads back", async () => {
    const GK = `gk3-${"a".repeat(32)}`;
    const draft = {
      id: "/outputs/draft.mp4",
      name: "draft.mp4",
      dirname: "",
      instanceId: 7,
      fingerprint: "fp-draft",
      generationKey: GK,
      dimensions: { width: 640, height: 360 },
      reviewState: "unreviewed",
    };
    const other = { id: "/outputs/other.mp4", name: "other.mp4", dirname: "", fingerprint: "fp-other" };
    const videos = [draft, other];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [{ relativePath: "", name: "outputs" }],
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    useMasonryLayoutMock.mockImplementation((args) => ({
      ...masonryReturn,
      orderedVideos: args.filteredVideos,
      orderForRange: args.filteredVideos.map((video) => video.id),
      virtualItems: args.filteredVideos.map((video) => ({ id: video.id, item: video, style: {} })),
    }));
    const open = vi.fn(async () => ({
      success: true,
      generationKey: GK,
      truncated: false,
      records: [
        {
          id: "/finals/final.mp4",
          instanceId: 9,
          name: "final.mp4",
          fingerprint: "fp-final",
          rootPath: "/finals",
          relativePath: "final.mp4",
          generationKey: GK,
          dimensions: { width: 1920, height: 1080 },
          isElectronFile: true,
        },
        { ...draft, rootPath: "/outputs", relativePath: "draft.mp4" },
      ],
    }));
    window.electronAPI = { saveSettingsPartial: vi.fn(), generationVersions: { open } };
    const gridIds = () =>
      useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos.map((video) => video.id);
    const hotkeys = () => useHotkeysMock.mock.calls.at(-1)?.[2];
    const cardProps = (id) =>
      videoCardSpy.mock.calls.map(([props]) => props).filter((props) => props.video.id === id).at(-1);

    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      expect(gridIds()).toEqual([draft.id, other.id]);

      await act(async () => cardProps(draft.id).onOpenVersions(draft.id));
      expect(open).toHaveBeenCalledWith(7);
      await waitFor(() => expect(gridIds()).toEqual(["/finals/final.mp4", draft.id]));
      // Side by side in version order, whatever the sort.
      expect(useMasonryLayoutMock.mock.calls.at(-1)[0].comparison).toBe(true);
      expect(screen.getByRole("toolbar", { name: "Versions side by side" })).toHaveTextContent(
        "2 versions of this generation, best first · 1 from folders that aren't open"
      );
      expect(cardProps("/finals/final.mp4")).toMatchObject({
        versionLabel: "Best · 1920×1080",
        versionLocation: "finals/final.mp4",
        onOpenVersions: null,
      });
      expect(cardProps(draft.id).versionLabel).toBe("640×360");
      expect(selectionMock.selectExactly).toHaveBeenLastCalledWith(draft.id);

      await act(async () => hotkeys().onCloseStack());
      await waitFor(() => expect(gridIds()).toEqual([draft.id, other.id]));
      expect(selectionMock.selectExactly).toHaveBeenLastCalledWith(draft.id);
      expect(screen.queryByRole("toolbar", { name: "Versions side by side" })).toBeNull();
      expect(useMasonryLayoutMock.mock.calls.at(-1)[0].comparison).toBe(false);
    } finally {
      useMasonryLayoutMock.mockImplementation(() => masonryReturn);
    }
  });

  test("deals arena rounds side by side, moves on once New is rated, and sums up on leaving", async () => {
    // The collection holds New under another id; the references are guests.
    const own = { id: "/outputs/new.mp4", name: "new.mp4", dirname: "", instanceId: 30, fingerprint: "fp-new" };
    const videos = [own, { id: "/outputs/other.mp4", name: "other.mp4", dirname: "", instanceId: 31, fingerprint: "fp-other" }];
    let held = videos;
    const setHeld = (update) => {
      held = typeof update === "function" ? update(held) : update;
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: held,
      setVideos: setHeld,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [{ relativePath: "", name: "outputs" }],
    }));
    useFilterStateMock.mockImplementation(() => ({ ...filterStateReturn, filteredVideos: videos }));
    useMasonryLayoutMock.mockImplementation((args) => ({
      ...masonryReturn,
      orderedVideos: args.filteredVideos,
      orderForRange: args.filteredVideos.map((video) => video.id),
      virtualItems: args.filteredVideos.map((video) => ({ id: video.id, item: video, style: {} })),
    }));
    const record = (instanceId, fingerprint, rating = null) => ({
      id: `/a1/${fingerprint}.mp4`,
      instanceId,
      name: `${fingerprint}.mp4`,
      fingerprint,
      rootPath: "/a1",
      relativePath: `${fingerprint}.mp4`,
      rating,
      isElectronFile: true,
    });
    const rounds = [
      {
        success: true,
        round: {
          id: 1,
          kind: "place",
          // Dealt out of order: the view puts New first, then low to high.
          clips: [
            { instanceId: 15, role: "reference", rating: 5 },
            { instanceId: 7, role: "new", rating: null },
            { instanceId: 11, role: "reference", rating: 1 },
          ],
        },
        records: [record(15, "fp-five", 5), record(7, "fp-new"), record(11, "fp-one", 1)],
        counts: { unrated: 5, rated: 2, byRating: { 1: 1, 5: 1 }, total: 7 },
      },
      {
        success: true,
        round: { id: 2, kind: "tier", clips: [{ instanceId: 11, role: "check", rating: 1 }, { instanceId: 12, role: "check", rating: 1 }] },
        records: [record(11, "fp-one", 1), record(12, "fp-one-b", 1)],
        counts: { unrated: 4, rated: 3, byRating: { 1: 1, 3: 1, 5: 1 }, total: 7 },
      },
      { success: true, round: null, reason: "mixed", counts: { unrated: 4, rated: 3, byRating: {}, total: 7 } },
    ];
    const arenaApi = {
      start: vi.fn(async () => ({ success: true, session: "s1", counts: rounds[0].counts })),
      round: vi.fn(async () => rounds.shift()),
      finish: vi.fn(async ({ round }) => ({
        success: true,
        outcomes: round === 1 ? { placed: 1 } : { held: 2 },
      })),
      end: vi.fn(async () => ({ success: true })),
    };
    window.electronAPI = { saveSettingsPartial: vi.fn(), arena: arenaApi };
    const gridIds = () =>
      useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos.map((video) => video.id);
    const cardProps = (id) =>
      videoCardSpy.mock.calls.map(([props]) => props).filter((props) => props.video.id === id).at(-1);
    const setVideos = () => useMetadataActionsMock.mock.calls.at(-1)[0].setVideos;

    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      await act(async () => topBarSpy.mock.calls.at(-1)[0].onArenaToggle());
      expect(arenaApi.start).toHaveBeenCalledWith({ scope: "library" });
      expect(arenaApi.round).toHaveBeenCalledWith({ session: "s1", kind: "mixed", border: null, match: "similar" });
      await waitFor(() => expect(gridIds()).toEqual([own.id, "/a1/fp-one.mp4", "/a1/fp-five.mp4"]));
      const layout = useMasonryLayoutMock.mock.calls.at(-1)[0];
      expect(layout).toMatchObject({ comparison: true, keepOrder: true });
      expect(cardProps(own.id).versionLabel).toBe("New");
      expect(cardProps("/a1/fp-five.mp4").versionLabel).toBe("5★");
      expect(selectionMock.selectExactly).toHaveBeenLastCalledWith(own.id);
      const bar = screen.getByRole("toolbar", { name: "Rating arena" });
      expect(bar).toHaveTextContent("Round 1 · 5 unrated left");
      expect(bar).toHaveTextContent("Where does New go?");
      expect(within(bar).getByRole("button", { name: /Skip/ })).toBeEnabled();

      // Backspace never trashes in the arena.
      const backspace = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
      document.body.dispatchEvent(backspace);
      expect(backspace.defaultPrevented).toBe(true);

      // Rating New (as a metadata update does) ends the round after a beat.
      act(() =>
        setVideos()((list) =>
          list.map((video) => (video.fingerprint === "fp-new" ? { ...video, rating: 3 } : video))
        )
      );
      expect(cardProps(own.id).versionLabel).toBe("New → 3★");
      await waitFor(() => expect(arenaApi.finish).toHaveBeenCalledWith({ session: "s1", round: 1 }));
      await waitFor(() => expect(gridIds()).toEqual(["/a1/fp-one.mp4", "/a1/fp-one-b.mp4"]));
      expect(screen.getByRole("toolbar", { name: "Rating arena" })).toHaveTextContent("Tier check");
      expect(screen.getByRole("toolbar", { name: "Rating arena" })).toHaveTextContent("1 placed");

      // Enter finishes a tier check as it stands.
      fireEvent.keyDown(document.body, { key: "Enter" });
      await waitFor(() => expect(arenaApi.finish).toHaveBeenCalledWith({ session: "s1", round: 2 }));
      await waitFor(() =>
        expect(screen.getByRole("toolbar", { name: "Rating arena" })).toHaveTextContent("Nothing to rate here")
      );

      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(arenaApi.end).toHaveBeenCalledWith("s1"));
      expect(screen.queryByRole("toolbar", { name: "Rating arena" })).toBeNull();
      // Leaving shows what the session did, with a way straight back in.
      const summary = await screen.findByRole("dialog", { name: "Arena session done" });
      expect(summary).toHaveTextContent("Rounds2");
      expect(summary).toHaveTextContent("Placed1");
      expect(summary).toHaveTextContent("Held2");
      expect(within(summary).getByRole("button", { name: /More rounds/ })).toHaveFocus();
      expect(gridIds()).toEqual(videos.map((video) => video.id));
      rounds.push({ success: true, round: null, reason: "mixed", counts: rounds[0]?.counts || null });
      await act(async () => {
        fireEvent.click(within(summary).getByRole("button", { name: /More rounds/ }));
      });
      expect(screen.queryByRole("dialog", { name: "Arena session done" })).toBeNull();
      expect(arenaApi.start).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.getByRole("toolbar", { name: "Rating arena" })).toBeInTheDocument());
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Rating arena" })).toBeNull());
      // A session that did nothing ends without the dialog.
      expect(screen.queryByRole("dialog", { name: "Arena session done" })).toBeNull();
    } finally {
      useMasonryLayoutMock.mockImplementation(() => masonryReturn);
    }
  });

  test("tags given in the arena over a library view re-read it only on leaving", async () => {
    const own = { id: "/a1/new.mp4", name: "new.mp4", dirname: "", instanceId: 7, fingerprint: "fp-new" };
    const videos = [own];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: null,
      tagCollection: { tags: ["keeper"], matchMode: "all", loadedAt: 1, truncated: false },
    }));
    useFilterStateMock.mockImplementation(() => ({ ...filterStateReturn, filteredVideos: videos }));
    const taggedSnapshot = vi.fn(async () => ({ success: true, records: [], truncated: false }));
    const arenaApi = {
      start: vi.fn(async () => ({ success: true, session: "s1", counts: null })),
      round: vi.fn(async () => ({
        success: true,
        round: { id: 1, kind: "place", clips: [{ instanceId: 7, role: "new", rating: null }] },
        records: [{ ...own, rootPath: "/a1", relativePath: "new.mp4", isElectronFile: true }],
        counts: { unrated: 1 },
      })),
      finish: vi.fn(async () => ({ success: true, outcomes: {} })),
      end: vi.fn(async () => ({ success: true })),
    };
    window.electronAPI = { saveSettingsPartial: vi.fn(), arena: arenaApi, library: { taggedSnapshot } };
    const addTags = vi.fn(async () => ({ success: true }));
    useMetadataActionsMock.mockImplementation(() => ({ ...metadataActionsReturn, handleAddTags: addTags }));

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    await act(async () => topBarSpy.mock.calls.at(-1)[0].onArenaToggle());
    const bar = await screen.findByRole("toolbar", { name: "Rating arena" });
    await waitFor(() => expect(bar).toHaveTextContent("Where does New go?"));

    fireEvent.click(within(bar).getByRole("button", { name: /Tag…/ }));
    const input = await screen.findByLabelText("Tag for the selected clip");
    fireEvent.change(input, { target: { value: "dance" } });
    await act(async () => {
      fireEvent.submit(input.closest("form"));
    });
    await waitFor(() => expect(addTags).toHaveBeenCalled());
    // Re-reading now would replace the collection and close the arena.
    expect(taggedSnapshot).not.toHaveBeenCalled();
    expect(screen.getByRole("toolbar", { name: "Rating arena" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(taggedSnapshot).toHaveBeenCalledWith(["keeper"], "all", expect.any(Object)));
  });

  test("heads a stack with its most typical clip and shows the most different as stills", async () => {
    const PK_A = `pk2-${"a".repeat(32)}`;
    const bits = (count) => (count === 0 ? 0n : (1n << BigInt(count)) - 1n).toString(16).padStart(16, "0");
    const clip = (n) => ({
      id: `a${n}`,
      name: `a${n}.mp4`,
      dirname: "",
      fingerprint: `fp-a${n}`,
      instanceId: n,
      promptKey: PK_A,
      reviewState: "unreviewed",
      createdMs: n,
    });
    const videos = [1, 2, 3, 4, 5].map(clip);
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [{ relativePath: "", name: "outputs" }],
    }));
    useFilterStateMock.mockImplementation(() => ({ ...filterStateReturn, filteredVideos: videos }));
    useMasonryLayoutMock.mockImplementation((args) => ({
      ...masonryReturn,
      orderedVideos: args.filteredVideos,
      orderForRange: args.filteredVideos.map((video) => video.id),
      virtualItems: args.filteredVideos.map((video) => ({ id: video.id, item: video, style: {} })),
    }));
    // First frames 0, 10, 20, 30 and 40 bits apart: a3 is the most typical.
    const hashes = { 1: bits(0), 2: bits(10), 3: bits(20), 4: bits(30), 5: bits(40) };
    window.electronAPI = {
      saveSettingsPartial: vi.fn(),
      stacks: {
        frameFingerprints: vi.fn(async (ids) => ({
          success: true,
          hashes: Object.fromEntries(ids.map((id) => [id, hashes[id]])),
          pending: 0,
        })),
        frameStills: vi.fn(async (ids) => ({
          success: true,
          stills: Object.fromEntries(ids.map((id) => [id, `data:image/jpeg;base64,${id}`])),
        })),
        onFrameFingerprints: vi.fn(() => () => {}),
      },
    };
    const gridIds = () =>
      useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos.map((video) => video.id);
    const hotkeys = () => useHotkeysMock.mock.calls.at(-1)?.[2];
    const cardProps = (id) =>
      videoCardSpy.mock.calls.map(([props]) => props).filter((props) => props.video.id === id).at(-1);

    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      await act(async () => hotkeys().onToggleStacks());
      await waitFor(() => expect(gridIds()).toEqual(["a3"]), { timeout: 3000 });
      await waitFor(
        () =>
          expect(cardProps("a3").stackStrip).toEqual([
            // These clips are not local files, so nothing plays on hover.
            { id: "a1", src: "data:image/jpeg;base64,1", instanceId: null, sourceUrl: null },
            { id: "a2", src: "data:image/jpeg;base64,2", instanceId: null, sourceUrl: null },
            { id: "a5", src: "data:image/jpeg;base64,5", instanceId: null, sourceUrl: null },
          ]),
        { timeout: 3000 }
      );

      // Strip clips play on hover through the grid's scheduler.
      expect(typeof cardProps("a3").stackPeekScheduler?.reserveAuxiliaryDecoder).toBe("function");
      await act(async () => cardProps("a3").onOpenStack("a3", "a5"));
      await waitFor(() => expect(gridIds()).toEqual(["a1", "a2", "a3", "a4", "a5"]));
      expect(selectionMock.selectExactly).toHaveBeenLastCalledWith("a5");
    } finally {
      useMasonryLayoutMock.mockImplementation(() => masonryReturn);
    }
  });

  test("lays the grid out in rows when chosen, and remembers it", async () => {
    const saveSettingsPartial = vi.fn();
    window.electronAPI = { saveSettingsPartial };
    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    expect(useMasonryLayoutMock.mock.calls.at(-1)[0].gridLayout).toBe("masonry");
    await act(async () => topBarSpy.mock.calls.at(-1)[0].onGridLayoutChange("rows"));
    expect(useMasonryLayoutMock.mock.calls.at(-1)[0].gridLayout).toBe("rows");
    expect(saveSettingsPartial).toHaveBeenCalledWith({ gridLayout: "rows" });
  });

  test("stacks only neighbours in the grid's sort order", async () => {
    const PK_A = `pk2-${"a".repeat(32)}`;
    const PK_B = `pk2-${"b".repeat(32)}`;
    const clip = (name, promptKey, createdMs) => ({
      id: name,
      name: `${name}.mp4`,
      dirname: "",
      fingerprint: `fp-${name}`,
      promptKey,
      reviewState: "unreviewed",
      createdMs,
    });
    // By name the two prompts alternate; by creation time each is a batch.
    const videos = [clip("001", PK_A, 1), clip("002", PK_B, 3), clip("003", PK_A, 2), clip("004", PK_B, 4)];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [{ relativePath: "", name: "outputs" }],
    }));
    useFilterStateMock.mockImplementation(() => ({ ...filterStateReturn, filteredVideos: videos }));
    useMasonryLayoutMock.mockImplementation((args) => ({
      ...masonryReturn,
      orderedVideos: args.filteredVideos,
      orderForRange: args.filteredVideos.map((video) => video.id),
      virtualItems: args.filteredVideos.map((video) => ({ id: video.id, item: video, style: {} })),
    }));
    window.electronAPI = { saveSettingsPartial: vi.fn() };
    const gridIds = () =>
      useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos.map((video) => video.id);
    const hotkeys = () => useHotkeysMock.mock.calls.at(-1)?.[2];
    const headerProps = () => topBarSpy.mock.calls.at(-1)?.[0];

    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      await act(async () => hotkeys().onToggleStacks());
      // Far apart in the sort: no stacks.
      await waitFor(() => expect(gridIds()).toEqual(["001", "002", "003", "004"]));

      await act(async () => headerProps().onSortChange("created-asc"));
      // Each batch's newest clip stands for it.
      await waitFor(() => expect(gridIds()).toEqual(["003", "004"]));
    } finally {
      useMasonryLayoutMock.mockImplementation(() => masonryReturn);
    }
  });

  test("the mouse's back button closes an open stack and forward reopens it", async () => {
    const PK_A = `pk2-${"a".repeat(32)}`;
    const clip = (id, createdMs) => ({
      id,
      name: `${id}.mp4`,
      dirname: "",
      fingerprint: `fp-${id}`,
      promptKey: PK_A,
      reviewState: "unreviewed",
      createdMs,
    });
    const videos = [clip("a1", 1), clip("a2", 2)];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [{ relativePath: "", name: "outputs" }],
    }));
    useFilterStateMock.mockImplementation(() => ({ ...filterStateReturn, filteredVideos: videos }));
    useMasonryLayoutMock.mockImplementation((args) => ({
      ...masonryReturn,
      orderedVideos: args.filteredVideos,
      orderForRange: args.filteredVideos.map((video) => video.id),
      virtualItems: args.filteredVideos.map((video) => ({ id: video.id, item: video, style: {} })),
    }));
    window.electronAPI = { saveSettingsPartial: vi.fn() };
    const gridIds = () =>
      useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos.map((video) => video.id);
    const hotkeys = () => useHotkeysMock.mock.calls.at(-1)?.[2];
    const cardProps = (id) =>
      videoCardSpy.mock.calls.map(([props]) => props).filter((props) => props.video.id === id).at(-1);
    const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 450)));
    const mouse = (button) =>
      act(() => {
        window.dispatchEvent(new MouseEvent("mouseup", { button, bubbles: true }));
      });

    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      await act(async () => hotkeys().onToggleStacks());
      await waitFor(() => expect(gridIds()).toEqual(["a2"]));
      await settle();

      await act(async () => cardProps("a2").onOpenStack("a2"));
      await waitFor(() => expect(gridIds()).toEqual(["a1", "a2"]));
      await settle();

      mouse(3);
      await waitFor(() => expect(gridIds()).toEqual(["a2"]));
      await settle();
      mouse(4);
      await waitFor(() => expect(gridIds()).toEqual(["a1", "a2"]));
    } finally {
      useMasonryLayoutMock.mockImplementation(() => masonryReturn);
    }
  });

  test("stacks neighbouring clips of alike prompts once main says they are alike", async () => {
    const PK_A = `pk2-${"a".repeat(32)}`;
    const PK_B = `pk2-${"b".repeat(32)}`;
    const clip = (id, promptKey, createdMs) => ({
      id,
      name: `${id}.mp4`,
      dirname: "",
      fingerprint: `fp-${id}`,
      promptKey,
      reviewState: "unreviewed",
      createdMs,
    });
    const videos = [clip("a1", PK_A, 1), clip("a2", PK_A, 2), clip("b1", PK_B, 3)];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [{ relativePath: "", name: "outputs" }],
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    useMasonryLayoutMock.mockImplementation((args) => ({
      ...masonryReturn,
      orderedVideos: args.filteredVideos,
      orderForRange: args.filteredVideos.map((video) => video.id),
      virtualItems: args.filteredVideos.map((video) => ({ id: video.id, item: video, style: {} })),
    }));
    const saveSettingsPartial = vi.fn();
    const similarPrompts = vi.fn(async ({ threshold }) => ({
      success: true,
      alike: threshold <= 0.8 ? { [PK_A]: [PK_B], [PK_B]: [PK_A] } : {},
    }));
    window.electronAPI = { saveSettingsPartial, stacks: { similarPrompts } };
    const gridIds = () =>
      useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos.map((video) => video.id);
    const headerProps = () => topBarSpy.mock.calls.at(-1)?.[0];
    const cardProps = (id) =>
      videoCardSpy.mock.calls.map(([props]) => props).filter((props) => props.video.id === id).at(-1);

    try {
      vi.resetModules();
      const { default: App } = await import("./App.jsx");
      render(<App />);
      expect(headerProps().stackSimilarity).toBe(0.8);

      await act(async () => headerProps().onStackSimilarityChange(0.9));
      expect(saveSettingsPartial).toHaveBeenLastCalledWith({
        stackSimilarity: 0.9,
        stackByPrompt: true,
      });
      await waitFor(() =>
        expect(similarPrompts).toHaveBeenLastCalledWith({
          promptKeys: [PK_A, PK_B],
          threshold: 0.9,
        })
      );
      await waitFor(() => expect(gridIds()).toEqual(["a2", "b1"]));

      await act(async () => headerProps().onStackSimilarityChange(0.8));
      await waitFor(() => expect(gridIds()).toEqual(["b1"]));
      expect(cardProps("b1")).toMatchObject({ stackCount: 3, stackTotal: 3 });
    } finally {
      useMasonryLayoutMock.mockImplementation(() => masonryReturn);
    }
  });

  test("restores recursive scope when navigating from a child folder to the root", async () => {
    const videos = [
      { id: "root", name: "root.mp4", dirname: "", reviewState: "reviewed" },
      { id: "a", name: "a.mp4", dirname: "run-a", reviewState: "pick" },
      { id: "b", name: "b.mp4", dirname: "run-b", reviewState: "unreviewed" },
    ];
    const reloadCurrentRoot = vi.fn().mockResolvedValue(true);
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [
        { relativePath: "", name: "outputs" },
        { relativePath: "run-a", name: "run-a" },
        { relativePath: "run-b", name: "run-b" },
      ],
      reloadCurrentRoot,
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    const smartView = {
      id: 1,
      name: "Needs review",
      definition: {
        version: 1,
        filters: { reviewFilter: "unreviewed" },
        sort: { key: "created", dir: "desc", groupByFolders: true },
        scope: { mode: "current-subtree" },
      },
    };
    useSavedViewsMock.mockImplementation(() => ({
      ...savedViewsReturn,
      savedViews: [smartView],
    }));
    window.electronAPI = { saveSettingsPartial: vi.fn() };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    fireEvent.click(screen.getByTitle("run-a"));
    await waitFor(() => expect(reloadCurrentRoot).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos).toEqual([
        videos[1],
      ])
    );

    const hotkeyOptions = useHotkeysMock.mock.calls.at(-1)?.[2];
    expect(hotkeyOptions.onPreviousFolder).toEqual(expect.any(Function));
    expect(hotkeyOptions.onNextFolder).toEqual(expect.any(Function));
    await act(async () => hotkeyOptions.onNextFolder());
    await waitFor(() =>
      expect(useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos).toEqual([
        videos[2],
      ])
    );

    fireEvent.click(screen.getByTitle("outputs"));
    await waitFor(() =>
      expect(useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos).toEqual(
        videos
      )
    );
    expect(screen.getByRole("combobox", { name: "Folder scope" })).toHaveValue(
      "all-descendants"
    );

    fireEvent.click(screen.getByRole("button", { name: "Needs review" }));
    // The view's filters, and every other filter back to its default.
    expect(filterStateReturn.updateFilters).toHaveBeenCalledWith(
      expect.objectContaining({ reviewFilter: "unreviewed", includeTags: [], promptQuery: "" })
    );
    expect(selectionMock.clear).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Include subfolders" }));
    await waitFor(() => expect(reloadCurrentRoot).toHaveBeenLastCalledWith(false));
    await waitFor(() =>
      expect(useMasonryLayoutMock.mock.calls.at(-1)?.[0].filteredVideos).toEqual(videos)
    );
  });

  test("forwards live scan status and whole-app memory to the loading dialog", async () => {
    const loadingStatus = {
      scanId: "scan-large",
      phase: "indexing",
      completed: 250,
      total: 1000,
    };
    const memoryStatus = {
      source: "app",
      currentMemoryMB: 640,
      totalMemoryMB: 32768,
      memoryPressure: 2,
    };
    const lifecycleDefaults = useElectronLifecycleMock.getMockImplementation()();
    const collectionDefaults = useVideoCollectionMock.getMockImplementation()();
    useElectronLifecycleMock.mockReturnValueOnce({
      ...lifecycleDefaults,
      isLoadingFolder: true,
      loadingStatus,
    });
    useVideoCollectionMock.mockReturnValueOnce({
      ...collectionDefaults,
      memoryStatus,
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const overlayProps = loadingOverlaySpy.mock.calls
      .map(([props]) => props)
      .find((props) => props.status === loadingStatus);
    expect(overlayProps).toMatchObject({
      show: true,
      status: loadingStatus,
      memoryStatus,
    });
  });

  test("wires fullscreen review to the full order with explicit clip targets", async () => {
    const videos = [
      {
        id: "clip-1",
        instanceId: 11,
        fingerprint: "fp-1",
        name: "one.mp4",
        relativePath: "run/one.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
      {
        id: "clip-2",
        instanceId: 12,
        fingerprint: "fp-2",
        name: "two.mp4",
        relativePath: "run/two.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
    ];
    selectionMock.selected = new Set(["clip-2"]);
    selectionMock.size = 1;
    selectionMock.anchorId = "clip-2";
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/collection",
      libraryRoot: { rootPath: "/collection", recursive: true },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
      filteredVideoIds: new Set(videos.map((video) => video.id)),
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: [videos[0]],
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
    });
    const controller = {
      isOpen: true,
      currentVideo: videos[1],
      fullScreenVideo: videos[1],
      currentIndex: 1,
      fullScreenIndex: 1,
      currentViewIndex: 1,
      fullScreenCount: 2,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: true,
      hasNext: false,
      capturedNextId: null,
      collectionOwnerKey: "profile:/collection",
      sessionToken: "fullscreen-session",
      open: vi.fn(),
      close: vi.fn(),
      navigateFullScreen: vi.fn(),
      peekNavigation: vi.fn(),
      sourceRemoved: vi.fn(),
    };
    useFullScreenModalMock.mockReturnValue(controller);
    metadataActionsReturn.handleSetReviewState.mockResolvedValue({
      success: true,
      updates: { "fp-2": { reviewState: "pick" } },
    });
    metadataActionsReturn.handleAddTags.mockResolvedValue({ success: true });
    runActionForVideosMock.mockResolvedValue(true);

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    expect(useFullScreenModalMock.mock.calls.at(-1)?.[0]).toMatchObject({
      orderedVideos: videos,
    });
    const modalProps = fullScreenModalSpy.mock.calls.at(-1)?.[0];
    expect(modalProps).toMatchObject({
      video: videos[1],
      positionLabel: "2 of 2",
      detailsOpen: true,
      canNavigatePrevious: true,
      canNavigateNext: false,
    });

    await act(async () => {
      await modalProps.reviewRail.props.onSetReviewState("pick");
    });
    expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith(
      "pick",
      ["fp-2"],
      { completionGuard: expect.any(Function) }
    );

    await act(async () => {
      await modalProps.detailsDock.props.onAddTags(["favorite"]);
    });
    expect(metadataActionsReturn.handleAddTags).toHaveBeenCalledWith(
      ["favorite"],
      ["fp-2"],
      { completionGuard: expect.any(Function) }
    );

    const actions = modalProps.actionsContent({ retryPlayback: vi.fn() });
    await act(async () => {
      await actions.props.onSafeAction(ActionIds.COPY_PATH);
    });
    expect(runActionForVideosMock).toHaveBeenCalledWith(
      ActionIds.COPY_PATH,
      [videos[1]]
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runActionForVideosMock.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    let failedAction;
    await act(async () => {
      failedAction = await actions.props.onSafeAction(ActionIds.COPY_PATH);
    });
    expect(failedAction).toBe(false);
    const actionAlert = screen.getByText(/Clipboard unavailable/).closest("[role=alert]");
    expect(actionAlert).toHaveTextContent("Clipboard unavailable");
    actionAlert.remove();
    consoleSpy.mockRestore();
  });

  test("copies a fullscreen frame natively and falls back to the canvas", async () => {
    const video = {
      id: "clip-1",
      instanceId: 11,
      fingerprint: "fp-1",
      name: "one.mp4",
      isElectronFile: true,
      fullPath: "/collection/one.mp4",
      reviewState: "unreviewed",
      tags: [],
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [video],
      activeRootPath: "/collection",
      libraryRoot: { rootPath: "/collection", recursive: true },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [video],
      filteredVideoIds: new Set([video.id]),
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [video],
      displayVideos: [video],
      orderedIds: [video.id],
      orderForRange: [video.id],
    });
    useFullScreenModalMock.mockReturnValue({
      isOpen: true,
      currentVideo: video,
      fullScreenVideo: video,
      currentIndex: 0,
      currentViewIndex: 0,
      fullScreenCount: 1,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: false,
      hasNext: false,
      collectionOwnerKey: "profile:/collection",
      sessionToken: "fullscreen-session",
      close: vi.fn(),
    });
    const copyFrameAtTime = vi.fn().mockResolvedValue({ success: true });
    const copyImageToClipboard = vi.fn().mockResolvedValue({ success: true });
    window.electronAPI = { copyFrameAtTime, copyImageToClipboard };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const onCopyFrame = fullScreenModalSpy.mock.calls.at(-1)?.[0]?.onCopyFrame;
    const captureCanvasFrame = vi.fn().mockResolvedValue({
      blob: new Blob(),
      dataUrl: "data:image/png;base64,AAAA",
    });

    let copied;
    await act(async () => {
      copied = await onCopyFrame({ video, atSeconds: 1.24, captureCanvasFrame });
    });
    expect(copied).toBe(true);
    expect(copyFrameAtTime).toHaveBeenCalledWith("/collection/one.mp4", 1.24);
    // The native extractor read the source file, so no canvas work was needed.
    expect(captureCanvasFrame).not.toHaveBeenCalled();

    // Without a usable ffmpeg the displayed frame is still copyable.
    copyFrameAtTime.mockResolvedValueOnce({ success: false, error: "ENOENT" });
    await act(async () => {
      copied = await onCopyFrame({ video, atSeconds: 1.24, captureCanvasFrame });
    });
    expect(copied).toBe(true);
    expect(captureCanvasFrame).toHaveBeenCalledTimes(1);
    expect(copyImageToClipboard).toHaveBeenCalledWith("data:image/png;base64,AAAA");
  });

  test("persists the fullscreen dock preference and releases before ownership work", async () => {
    const video = {
      id: "clip-1",
      instanceId: 11,
      fingerprint: "fp-1",
      name: "one.mp4",
      reviewState: "unreviewed",
      tags: [],
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [video],
      activeRootPath: "/collection",
      libraryRoot: { rootPath: "/collection", recursive: true },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: [video],
      filteredVideoIds: new Set([video.id]),
    }));
    Object.assign(masonryReturn, {
      orderedVideos: [video],
      displayVideos: [video],
      orderedIds: [video.id],
      orderForRange: [video.id],
    });
    const close = vi.fn();
    useFullScreenModalMock.mockReturnValue({
      isOpen: true,
      currentVideo: video,
      fullScreenVideo: video,
      currentIndex: 0,
      currentViewIndex: 0,
      fullScreenCount: 1,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: false,
      hasNext: false,
      collectionOwnerKey: "profile:/collection",
      sessionToken: "fullscreen-session",
      close,
    });
    window.electronAPI = { saveSettingsPartial: vi.fn() };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const lifecycleArgs = useElectronLifecycleMock.mock.calls.at(-1)?.[0];
    act(() => lifecycleArgs.setFullscreenDetailsOpen(false));
    const modalProps = fullScreenModalSpy.mock.calls.at(-1)?.[0];
    expect(modalProps.detailsOpen).toBe(false);
    expect(
      useGenerationMetadataMock.mock.calls.some(
        ([options]) => options.instanceId === 11 && options.enabled === false
      )
    ).toBe(true);

    act(() => modalProps.onToggleDetails());
    expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
      fullscreenDetailsOpen: true,
    });
    const openModalProps = fullScreenModalSpy.mock.calls.at(-1)?.[0];
    expect(openModalProps.detailsDock.props.generationExpanded).toBe(true);
    expect(useGenerationMetadataMock.mock.calls
      .filter(([options]) => options.instanceId === 11)
      .at(-1)?.[0]).toMatchObject({ enabled: true });
    act(() => openModalProps.detailsDock.props.onGenerationExpandedChange(false));
    expect(useGenerationMetadataMock.mock.calls
      .filter(([options]) => options.instanceId === 11)
      .at(-1)?.[0]).toMatchObject({ enabled: false });

    act(() => lifecycleArgs.setFullscreenAudioEnabled(true));
    expect(fullScreenModalSpy.mock.calls.at(-1)?.[0].audioEnabled).toBe(true);
    act(() =>
      fullScreenModalSpy.mock.calls.at(-1)?.[0].onAudioEnabledChange(false)
    );
    expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
      fullscreenAudioEnabled: false,
    });
    expect(fullScreenModalSpy.mock.calls.at(-1)?.[0].audioEnabled).toBe(false);

    act(() => lifecycleArgs.setFullscreenAutoContinue(true));
    expect(fullScreenModalSpy.mock.calls.at(-1)?.[0].autoContinue).toBe(true);
    act(() =>
      fullScreenModalSpy.mock.calls.at(-1)?.[0].onAutoContinueChange(false)
    );
    expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
      fullscreenAutoContinue: false,
    });
    expect(fullScreenModalSpy.mock.calls.at(-1)?.[0].autoContinue).toBe(false);

    await act(async () => {
      await lifecycleArgs.beforeExternalFolderSelection("/next");
    });
    expect(fullScreenReleaseNowSpy).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(fullScreenReleaseNowSpy.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0]
    );
  });

  test("drops stale fullscreen mutation side effects after manual navigation", async () => {
    const videos = [
      {
        id: "clip-stale-a",
        instanceId: 31,
        fingerprint: "fp-stale-a",
        name: "a.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
      {
        id: "clip-stale-b",
        instanceId: 32,
        fingerprint: "fp-stale-b",
        name: "b.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
    ];
    selectionMock.selected = new Set([videos[0].id]);
    selectionMock.size = 1;
    selectionMock.anchorId = videos[0].id;
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/stale-root",
      libraryRoot: { rootPath: "/stale-root", recursive: true },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
      filteredVideoIds: new Set(videos.map((video) => video.id)),
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
    });
    const controller = {
      currentVideo: videos[0],
      fullScreenVideo: videos[0],
      currentIndex: 0,
      currentViewIndex: 0,
      fullScreenCount: 2,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: false,
      hasNext: true,
      collectionOwnerKey: "profile:/stale-root",
      sessionToken: "stale-session",
      close: vi.fn(),
      navigateFullScreen: vi.fn(),
      goToFullScreen: vi.fn(),
      peekNavigation: vi.fn(),
      sourceRemoved: vi.fn(),
    };
    useFullScreenModalMock.mockReturnValue(controller);
    const pendingWrite = createDeferredPromise();
    metadataActionsReturn.handleSetReviewState.mockImplementationOnce(
      () => pendingWrite.promise
    );
    const sessions = installReviewSessionsApi();

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    const initialModal = fullScreenModalSpy.mock.calls.at(-1)?.[0];
    let mutation;
    act(() => {
      mutation = initialModal.reviewRail.props.onSetReviewState("pick");
    });
    await waitFor(() =>
      expect(metadataActionsReturn.handleSetReviewState).toHaveBeenCalledWith(
        "pick",
        ["fp-stale-a"],
        { completionGuard: expect.any(Function) }
      )
    );

    controller.currentVideo = videos[1];
    controller.fullScreenVideo = videos[1];
    await act(async () => {
      pendingWrite.resolve({
        success: true,
        updates: { "fp-stale-a": { reviewState: "pick" } },
      });
      await mutation;
    });

    expect(controller.goToFullScreen).not.toHaveBeenCalled();
    expect(controller.navigateFullScreen).not.toHaveBeenCalled();
    expect(fullScreenModalSpy.mock.calls.at(-1)?.[0].reviewRail.props.canUndo).toBe(
      false
    );
    await waitFor(() => expect(sessions.save).toHaveBeenCalledOnce());
    expect(sessions.save).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/stale-root",
        anchorFingerprint: "fp-stale-a",
      })
    );
  });

  test("auto-advances past duplicate content and Undo returns to the affected clip", async () => {
    const videos = [
      {
        id: "clip-original",
        instanceId: 41,
        fingerprint: "fp-shared",
        name: "original.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
      {
        id: "clip-duplicate",
        instanceId: 42,
        fingerprint: "fp-shared",
        name: "duplicate.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
      {
        id: "clip-successor",
        instanceId: 43,
        fingerprint: "fp-next",
        name: "successor.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
    ];
    selectionMock.selected = new Set([videos[0].id]);
    selectionMock.size = 1;
    selectionMock.anchorId = videos[0].id;
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/duplicate-root",
      libraryRoot: { rootPath: "/duplicate-root", recursive: true },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
      filteredVideoIds: new Set(videos.map((video) => video.id)),
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
    });
    const controller = {
      currentVideo: videos[0],
      fullScreenVideo: videos[0],
      currentIndex: 0,
      currentViewIndex: 0,
      fullScreenCount: 3,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: false,
      hasNext: true,
      collectionOwnerKey: "profile:/duplicate-root",
      sessionToken: "duplicate-session",
      close: vi.fn(),
      navigateFullScreen: vi.fn(),
      peekNavigation: vi.fn(),
      sourceRemoved: vi.fn(),
      goToFullScreen: vi.fn((id) => {
        const next = videos.find((video) => video.id === id) || null;
        if (next) {
          controller.currentVideo = next;
          controller.fullScreenVideo = next;
        }
        return next;
      }),
    };
    useFullScreenModalMock.mockReturnValue(controller);
    metadataActionsReturn.handleSetReviewState.mockResolvedValue({
      success: true,
      updates: { "fp-shared": { reviewState: "pick" } },
    });
    metadataActionsReturn.handleRestoreReviewMetadata.mockResolvedValue({
      success: true,
      updates: { "fp-shared": { reviewState: "unreviewed", rating: null } },
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    const lifecycleArgs = useElectronLifecycleMock.mock.calls.at(-1)?.[0];
    act(() => lifecycleArgs.setReviewAutoAdvance(true));

    await act(async () => {
      await fullScreenModalSpy.mock.calls
        .at(-1)?.[0]
        .reviewRail.props.onSetReviewState("pick");
    });
    expect(controller.goToFullScreen).toHaveBeenCalledWith("clip-successor");
    expect(controller.goToFullScreen).not.toHaveBeenCalledWith("clip-duplicate");
    expect(selectionMock.selectExactly).toHaveBeenCalledWith("clip-successor");
    expect(fullScreenReleaseNowSpy).toHaveBeenCalledWith({ resetAudio: false });

    const advancedModal = fullScreenModalSpy.mock.calls.at(-1)?.[0];
    expect(advancedModal.reviewRail.props.canUndo).toBe(true);
    await act(async () => {
      await advancedModal.reviewRail.props.onUndo();
    });
    await waitFor(() =>
      expect(controller.goToFullScreen).toHaveBeenCalledWith("clip-original")
    );
    expect(selectionMock.selectExactly).toHaveBeenCalledWith("clip-original");
  });

  test("rates without advancing so a clip can be rated and marked together", async () => {
    const videos = [
      {
        id: "clip-rated",
        instanceId: 51,
        fingerprint: "fp-rated",
        name: "rated.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
      {
        id: "clip-after",
        instanceId: 52,
        fingerprint: "fp-after",
        name: "after.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
    ];
    selectionMock.selected = new Set([videos[0].id]);
    selectionMock.size = 1;
    selectionMock.anchorId = videos[0].id;
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/rating-root",
      libraryRoot: { rootPath: "/rating-root", recursive: true },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
      filteredVideoIds: new Set(videos.map((video) => video.id)),
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
    });
    const controller = {
      currentVideo: videos[0],
      fullScreenVideo: videos[0],
      currentIndex: 0,
      currentViewIndex: 0,
      fullScreenCount: 2,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: false,
      hasNext: true,
      collectionOwnerKey: "profile:/rating-root",
      sessionToken: "rating-session",
      close: vi.fn(),
      navigateFullScreen: vi.fn(),
      peekNavigation: vi.fn(),
      sourceRemoved: vi.fn(),
      goToFullScreen: vi.fn(),
    };
    useFullScreenModalMock.mockReturnValue(controller);
    metadataActionsReturn.handleSetRating.mockResolvedValue({
      success: true,
      updates: { "fp-rated": { rating: 4, reviewState: "reviewed" } },
    });
    metadataActionsReturn.handleSetReviewState.mockResolvedValue({
      success: true,
      updates: { "fp-rated": { reviewState: "pick" } },
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    const lifecycleArgs = useElectronLifecycleMock.mock.calls.at(-1)?.[0];
    act(() => lifecycleArgs.setReviewAutoAdvance(true));

    await act(async () => {
      await fullScreenModalSpy.mock.calls.at(-1)?.[0].reviewRail.props.onSetRating(4);
    });
    // The rating marks the clip reviewed on its own, but marking it is not what
    // "advance after marking" means: the clip has to stay put long enough to
    // also be accepted or rejected.
    expect(metadataActionsReturn.handleSetRating).toHaveBeenCalled();
    expect(controller.goToFullScreen).not.toHaveBeenCalled();
    expect(controller.navigateFullScreen).not.toHaveBeenCalled();

    await act(async () => {
      await fullScreenModalSpy.mock.calls
        .at(-1)?.[0]
        .reviewRail.props.onSetReviewState("pick");
    });
    expect(controller.goToFullScreen).toHaveBeenCalledWith("clip-after");
  });

  test("releases the active player before a watched fullscreen source is removed", async () => {
    const videos = [
      {
        id: "/watch/current.mp4",
        fingerprint: "fp-watch-current",
        name: "current.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
      {
        id: "/watch/next.mp4",
        fingerprint: "fp-watch-next",
        name: "next.mp4",
        reviewState: "unreviewed",
        tags: [],
      },
    ];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/watch",
      libraryRoot: { rootPath: "/watch", recursive: true },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
    });
    const sourceRemoved = vi.fn(() => videos[1]);
    useFullScreenModalMock.mockReturnValue({
      currentVideo: videos[0],
      fullScreenVideo: videos[0],
      currentIndex: 0,
      currentViewIndex: 0,
      fullScreenCount: 2,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: false,
      hasNext: true,
      collectionOwnerKey: "profile:/watch",
      sessionToken: "watch-session",
      close: vi.fn(),
      sourceRemoved,
    });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);
    const lifecycleArgs = useElectronLifecycleMock.mock.calls.at(-1)?.[0];

    act(() => lifecycleArgs.beforeFileRemoved(videos[0].id));

    expect(fullScreenReleaseNowSpy).toHaveBeenCalledWith({ resetAudio: false });
    expect(sourceRemoved).toHaveBeenCalledWith(videos[0].id);
    expect(fullScreenReleaseNowSpy.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sourceRemoved.mock.invocationCallOrder[0]
    );
    expect(selectionMock.selectExactly).toHaveBeenCalledWith(videos[1].id);
  });

  test("returns directly to a visited virtualized clip without changing settings", async () => {
    const videos = Array.from({ length: 6_000 }, (_, index) => ({
      id: `virtual-return-${index}`,
      instanceId: index + 1,
      fingerprint: `virtual-return-fp-${index}`,
      name: `clip-${index}.mp4`,
      reviewState: "unreviewed",
      tags: [],
    }));
    const current = videos[100];
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos,
      activeRootPath: "/virtual-return",
      libraryRoot: { rootPath: "/virtual-return", recursive: true },
    }));
    useFilterStateMock.mockImplementation(() => ({
      ...filterStateReturn,
      filteredVideos: videos,
      filteredVideoIds: new Set(videos.map((video) => video.id)),
    }));
    Object.assign(masonryReturn, {
      orderedVideos: videos,
      displayVideos: videos,
      orderedIds: videos.map((video) => video.id),
      orderForRange: videos.map((video) => video.id),
    });
    const close = vi.fn();
    useFullScreenModalMock.mockReturnValue({
      currentVideo: current,
      fullScreenVideo: current,
      currentIndex: 100,
      currentViewIndex: 100,
      fullScreenCount: videos.length,
      isInCurrentView: true,
      isCurrentInView: true,
      hasPrevious: true,
      hasNext: true,
      collectionOwnerKey: "profile:/virtual-return",
      sessionToken: "virtual-return-session",
      close,
    });
    window.electronAPI = { saveSettingsPartial: vi.fn() };

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    act(() => fullScreenModalSpy.mock.calls.at(-1)?.[0].onClose());

    expect(close).toHaveBeenCalledOnce();
    expect(window.electronAPI.saveSettingsPartial).not.toHaveBeenCalled();
    expect(selectionMock.selectExactly).toHaveBeenCalledWith(current.id);
    expect(masonryReturn.scrollToId).toHaveBeenCalledWith(current.id, {
      align: "center",
    });
  });
});

// The scope control gates this in the UI, but the guard behind it is what stops
// a library-wide read with no tag to constrain it - including the case the
// control cannot cover, where the last tag is removed mid-search.
describe("library search scope", () => {
  const openFiltersWith = (includeTags, extra = {}) => ({
    ...filterStateReturn,
    isFiltersOpen: true,
    filters: {
      ...filterStateReturn.filters,
      includeTags,
      includeTagsMode: "all",
      ...extra,
    },
  });

  const renderWithTags = async (includeTags, extra) => {
    useFilterStateMock.mockImplementation(() => openFiltersWith(includeTags, extra));
    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    const view = render(<App />);
    return { view, props: () => filtersPopoverSpy.mock.calls.at(-1)?.[0] };
  };

  test("loads the whole library when nothing narrows the search", async () => {
    const records = [{ id: "a" }, { id: "b" }];
    const taggedSnapshot = vi.fn(async () => ({ success: true, records, truncated: false }));
    window.electronAPI = { library: { taggedSnapshot } };

    const { props } = await renderWithTags([]);
    await act(async () => {
      await props()?.onSearchScopeChange?.("library");
    });

    expect(taggedSnapshot).toHaveBeenCalledWith([], "all", {
      minRating: null,
      exactRating: null,
      promptQuery: "",
      mightBe: "",
    });
    expect(openTagCollectionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: [], records, truncated: false })
    );
  });

  // The smart views sidebar shows beside an open root.
  const withOpenRoot = () =>
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      activeRootPath: "/outputs",
      libraryRoot: { rootPath: "/outputs", name: "outputs", pinned: true },
      directorySummaries: [{ relativePath: "", name: "outputs" }],
    }));

  test("saves a view made during a library search as a library view", async () => {
    const taggedSnapshot = vi.fn(async () => ({ success: true, records: [], truncated: false }));
    window.electronAPI = { library: { taggedSnapshot } };
    const createSavedView = vi.fn(async (name) => ({ id: 3, name }));
    useSavedViewsMock.mockImplementation(() => ({ ...savedViewsReturn, createSavedView }));
    withOpenRoot();

    const { props } = await renderWithTags(["keeper"]);
    await act(async () => {
      await props()?.onSearchScopeChange?.("library");
    });
    fireEvent.click(screen.getByRole("button", { name: "Save current smart view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Smart view name" }), {
      target: { value: "Every keeper" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(createSavedView).toHaveBeenCalledWith(
      "Every keeper",
      expect.objectContaining({ searchScope: "library" })
    );
  });

  // A library search closes the folder; the panel with the + stays, or a
  // library view could never be saved.
  test("keeps the smart views panel while searching the library with no folder open", async () => {
    const taggedSnapshot = vi.fn(async () => ({ success: true, records: [], truncated: false }));
    window.electronAPI = { library: { taggedSnapshot } };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      activeRootPath: null,
      tagCollection: { tags: [], matchMode: "all", loadedAt: 1, truncated: false },
    }));

    const { props } = await renderWithTags([]);
    expect(screen.queryByRole("button", { name: "Save current smart view" })).toBeNull();
    await act(async () => {
      await props()?.onSearchScopeChange?.("library");
    });
    expect(screen.getByRole("button", { name: "Save current smart view" })).toBeInTheDocument();
  });

  test("saves the frame rate, steps and workflow filters with a view", async () => {
    const createSavedView = vi.fn(async (name) => ({ id: 6, name }));
    useSavedViewsMock.mockImplementation(() => ({ ...savedViewsReturn, createSavedView }));
    withOpenRoot();

    await renderWithTags(["keeper"], {
      minFrameRate: 30,
      minSteps: 20,
      workflowInclude: " upscale ",
      workflowExclude: "turbo",
      companionFilters: { "c1/requeue": "done" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save current smart view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Smart view name" }), {
      target: { value: "Full runs" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(createSavedView).toHaveBeenCalledWith(
      "Full runs",
      expect.objectContaining({
        filters: expect.objectContaining({
          minFrameRate: 30,
          minSteps: 20,
          maxSteps: null,
          workflowInclude: "upscale",
          workflowExclude: "turbo",
          companionFilters: { "c1/requeue": "done" },
        }),
      })
    );
  });

  test("saves a view made in a folder as a folder view", async () => {
    const createSavedView = vi.fn(async (name) => ({ id: 5, name }));
    useSavedViewsMock.mockImplementation(() => ({ ...savedViewsReturn, createSavedView }));
    withOpenRoot();

    await renderWithTags(["keeper"]);
    fireEvent.click(screen.getByRole("button", { name: "Save current smart view" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Smart view name" }), {
      target: { value: "Folder keepers" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(createSavedView).toHaveBeenCalledWith(
      "Folder keepers",
      expect.objectContaining({ searchScope: "folder" })
    );
  });

  test("applying a library view searches the library with its tags", async () => {
    const taggedSnapshot = vi.fn(async () => ({ success: true, records: [], truncated: false }));
    window.electronAPI = { library: { taggedSnapshot } };
    const libraryView = {
      id: 4,
      name: "Every keeper",
      definition: {
        version: 1,
        filters: { includeTags: ["keeper"], includeTagsMode: "all" },
        sort: { key: "name", dir: "asc", groupByFolders: true },
        scope: { mode: "all-descendants" },
        searchScope: "library",
      },
    };
    useSavedViewsMock.mockImplementation(() => ({ ...savedViewsReturn, savedViews: [libraryView] }));
    withOpenRoot();

    await renderWithTags(["keeper"]);
    expect(taggedSnapshot).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Every keeper Library" }));
    });
    await waitFor(() => expect(taggedSnapshot).toHaveBeenCalledWith(["keeper"], "all", { minRating: null, exactRating: null, promptQuery: "", mightBe: "" }));
    expect(taggedSnapshot).toHaveBeenCalledTimes(1);
    // The view stands for all of the filters: those it does not mention are cleared.
    expect(filterStateReturn.updateFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        ...libraryView.definition.filters,
        promptQuery: "",
        workflowExclude: "",
        companionFilters: {},
        minSteps: null,
      })
    );
  });

  test("runs the search once a tag constrains it", async () => {
    const taggedSnapshot = vi.fn(async () => ({
      success: true,
      records: [],
      truncated: false,
    }));
    window.electronAPI = { library: { taggedSnapshot } };

    const { props } = await renderWithTags(["keeper"]);
    await act(async () => {
      await props()?.onSearchScopeChange?.("library");
    });

    expect(taggedSnapshot).toHaveBeenCalledWith(["keeper"], "all", { minRating: null, exactRating: null, promptQuery: "", mightBe: "" });
  });

  test("searches the whole library by prompt words alone", async () => {
    const taggedSnapshot = vi.fn(async () => ({ success: true, records: [], truncated: false }));
    window.electronAPI = { library: { taggedSnapshot } };
    const { props } = await renderWithTags([], { promptQuery: " lighthouse " });
    await act(async () => {
      await props()?.onSearchScopeChange?.("library");
    });
    expect(taggedSnapshot).toHaveBeenCalledWith([], "all", {
      minRating: null,
      exactRating: null,
      promptQuery: "lighthouse",
      mightBe: "",
    });
    expect(openTagCollectionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: [], promptQuery: "lighthouse" })
    );
  });

  test("searches the whole library by rating alone", async () => {
    const taggedSnapshot = vi.fn(async () => ({
      success: true,
      records: [],
      truncated: false,
    }));
    window.electronAPI = { library: { taggedSnapshot } };

    const { props } = await renderWithTags([], { minRating: 4 });
    expect(props()?.filters.minRating).toBe(4);
    await act(async () => {
      await props()?.onSearchScopeChange?.("library");
    });

    expect(taggedSnapshot).toHaveBeenCalledWith([], "all", { minRating: 4, exactRating: null, promptQuery: "", mightBe: "" });
    expect(openTagCollectionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: [], minRating: 4, exactRating: null })
    );
  });

  test("searches the whole library for clips that might be a tag", async () => {
    const taggedSnapshot = vi.fn(async () => ({ success: true, records: [], truncated: false }));
    window.electronAPI = { library: { taggedSnapshot } };
    const { props } = await renderWithTags([], { mightBe: " dance " });
    await act(async () => {
      await props()?.onSearchScopeChange?.("library");
    });
    expect(taggedSnapshot).toHaveBeenCalledWith([], "all", {
      minRating: null,
      exactRating: null,
      promptQuery: "",
      mightBe: "dance",
    });
    expect(openTagCollectionMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ tags: [], mightBe: "dance" })
    );
  });
});
