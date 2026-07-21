import React from "react";
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, act, waitFor } from "@testing-library/react";
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
const electronLifecycleReturn = {
  videos: electronVideos,
  setVideos: vi.fn(),
  activeRootPath: null,
  libraryRoot: null,
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
const headerBarSpy = vi.fn();
const videoCardSpy = vi.fn();
const loadingOverlaySpy = vi.fn();
const metadataPanelSpy = vi.fn();
const contextMenuSpy = vi.fn();
const fullScreenModalSpy = vi.fn();
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
vi.mock("./components/HeaderBar", () => ({
  __esModule: true,
  default: (props) => {
    headerBarSpy(props);
    return (
      <>
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
          aria-label="Review mode"
          aria-pressed={Boolean(props.reviewModeEnabled)}
          onClick={() => props.onReviewModeToggle?.()}
        >
          Review mode
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
}));
vi.mock("./components/FiltersPopover", async () => {
  const ReactModule = await vi.importActual("react");
  return {
    __esModule: true,
    default: ReactModule.default.forwardRef(() => null),
  };
});
vi.mock("./components/DebugSummary", () => ({
  __esModule: true,
  default: () => null,
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
      hoveredId: null,
    });
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

    const headerProps = headerBarSpy.mock.calls.at(-1)?.[0];
    expect(headerProps).toMatchObject({
      playbackMode: "balanced",
      playbackDecision,
      playbackCapabilityStatus,
      proxyPlaybackEnabled: false,
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

    const headerProps = headerBarSpy.mock.calls.at(-1)?.[0];
    expect(headerProps.workSuspended).toBe(true);

    const overlayProps = loadingOverlaySpy.mock.calls.at(-1)?.[0];
    expect(overlayProps.workSuspensionReason).toBe("window-minimized");
    expect(setThumbSuspendedMock).toHaveBeenCalledWith(true);
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

    let headerProps = headerBarSpy.mock.calls.at(-1)?.[0];
    let collectionArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(headerProps.playbackMode).toBe("static-hover");
    expect(collectionArgs.playbackMode).toBe("static-hover");
    expect(saveSettingsPartial).toHaveBeenCalledWith({
      playbackMode: "static-hover",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Use All Motion playback" })
    );

    headerProps = headerBarSpy.mock.calls.at(-1)?.[0];
    collectionArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(headerProps.playbackMode).toBe("all-motion");
    expect(collectionArgs.playbackMode).toBe("all-motion");
    expect(usePlaybackTelemetryMock).toHaveBeenLastCalledWith({
      suspended: false,
      detailed: false,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Toggle proxy playback" })
    );

    headerProps = headerBarSpy.mock.calls.at(-1)?.[0];
    expect(headerProps.proxyPlaybackEnabled).toBe(true);
    expect(saveSettingsPartial).toHaveBeenCalledWith({
      proxyPlaybackEnabled: true,
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
    expect(headerBarSpy).toHaveBeenCalled();
  });

  test("persists review mode and removes its hotkey handlers while disabled", async () => {
    window.electronAPI = { saveSettingsPartial: vi.fn() };
    vi.resetModules();
    const { default: App } = await import("./App.jsx");

    render(<App />);

    const toggle = screen.getByRole("button", { name: "Review mode" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(window.electronAPI.saveSettingsPartial).toHaveBeenCalledWith({
      reviewModeEnabled: false,
    });
    expect(useHotkeysMock.mock.calls.at(-1)?.[2]).toMatchObject({
      onSetReviewState: null,
      onSetRating: null,
      onUndoReview: null,
    });
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
      proxyPlaybackEnabled: false,
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

    const markHover = useVideoCollectionMock.mock.results.at(-1)?.value.markHover;
    act(() => firstProps.onHover("video-1"));
    expect(useVideoCollectionMock.mock.calls.at(-1)?.[0].hoveredId).toBe(
      "video-1"
    );
    expect(markHover).toHaveBeenCalledWith("video-1");

    const hoverRenderMarkHover =
      useVideoCollectionMock.mock.results.at(-1)?.value.markHover;
    act(() => firstProps.onUnmount("video-1"));
    expect(useVideoCollectionMock.mock.calls.at(-1)?.[0].hoveredId).toBeNull();
    expect(hoverRenderMarkHover).toHaveBeenCalledWith(null);

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
      screen.getByRole("navigation", { name: "Current folder path" })
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
      screen.getByRole("complementary", { name: "Library and clip details" })
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: /Details/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("region", { name: "Docked selection details" }))
      .toHaveTextContent("dock.mp4");
    expect(useGenerationMetadataMock.mock.calls
      .filter(([options]) => options.instanceId === 91)
      .at(-1)?.[0]).toMatchObject({
      instanceId: 91,
      enabled: true,
    });

    fireEvent.click(screen.getByRole("button", {
      name: "Collapse Generation details",
    }));
    expect(useGenerationMetadataMock.mock.calls
      .filter(([options]) => options.instanceId === 91)
      .at(-1)?.[0]).toMatchObject({ enabled: false });
    fireEvent.click(screen.getByRole("button", {
      name: "Expand Generation details",
    }));

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
    expect(
      screen.queryByRole("complementary", { name: "Library and clip details" })
    ).toBeNull();
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

  test("drains an in-flight checkpoint before a web directory switch", async () => {
    const activeVideo = {
      id: "web-switch-video",
      instanceId: 11,
      name: "web.mp4",
      fingerprint: "fingerprint-web",
      reviewState: "unreviewed",
    };
    useElectronLifecycleMock.mockImplementation(() => ({
      ...electronLifecycleReturn,
      videos: [activeVideo],
      activeRootPath: "/before-web-switch",
      libraryRoot: { rootPath: "/before-web-switch", recursive: true },
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
    const pendingSave = createDeferredPromise();
    const save = vi.fn(() => pendingSave.promise);
    installReviewSessionsApi({ save });

    vi.resetModules();
    const { default: App } = await import("./App.jsx");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", {
      name: /Find next Unreviewed/,
    }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    electronLifecycleReturn.handleWebFileSelection.mockClear();

    let switchPromise;
    act(() => {
      switchPromise = headerBarSpy.mock.calls.at(-1)?.[0]
        .handleWebFileSelection({ target: { files: ["next-root"] } });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(electronLifecycleReturn.handleWebFileSelection).not.toHaveBeenCalled();

    await act(async () => {
      const draft = save.mock.calls[0][0];
      pendingSave.resolve({ checkpoint: { ...draft, updatedAt: 2345 } });
      await switchPromise;
    });
    expect(electronLifecycleReturn.handleWebFileSelection).toHaveBeenCalledWith({
      target: { files: ["next-root"] },
    });
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
    fireEvent.click(screen.getByRole("checkbox", { name: "Index subfolders" }));
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
      sidecarCount: 0,
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
      includeSidecars: false,
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
            sidecarCount: 0,
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
    expect(filterStateReturn.updateFilters).toHaveBeenCalledWith({
      reviewFilter: "unreviewed",
    });
    expect(selectionMock.clear).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Index subfolders" }));
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
