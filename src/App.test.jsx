import React from "react";
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, act, waitFor } from "@testing-library/react";

const selectionMock = {
  selected: new Set(),
  size: 0,
  anchorId: null,
  setSelected: vi.fn(),
  pruneTo: vi.fn(),
  clear: vi.fn(),
  toggle: vi.fn(),
  selectOnly: vi.fn(),
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
const useActionDispatchMock = vi.fn(() => ({ runAction: vi.fn() }));
const useFullScreenModalMock = vi.fn(() => ({
  fullScreenVideo: null,
  openFullScreen: vi.fn(),
  closeFullScreen: vi.fn(),
  navigateFullScreen: vi.fn(),
}));
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
  loadingStatus: null,
  loadingStage: "",
  loadingProgress: 0,
  settingsLoaded: true,
  cancelFolderLoad: vi.fn(),
  handleElectronFolderSelection: vi.fn(),
  reloadCurrentRoot: vi.fn(),
  handleFolderSelect: vi.fn(),
  handleWebFileSelection: vi.fn(),
};
const useElectronLifecycleMock = vi.fn(() => electronLifecycleReturn);

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
const setLibraryRootPinnedMock = vi.fn();
const useLibraryCatalogMock = vi.fn((args = {}) => ({
  pinnedRoots: [],
  currentRoot: args.scannedRoot ?? null,
  directories: args.scannedDirectories ?? [],
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
vi.mock("./components/FullScreenModal", () => ({
  __esModule: true,
  default: () => null,
}));
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
          aria-label="Play audio on hover"
          aria-pressed={Boolean(props.hoverAudioEnabled)}
          onClick={() => props.onHoverAudioToggle?.()}
        >
          Hover audio
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
  vi.clearAllMocks();
  useElectronLifecycleMock.mockImplementation(() => electronLifecycleReturn);
  useFilterStateMock.mockImplementation(() => filterStateReturn);
  useLibraryCatalogMock.mockImplementation((args = {}) => ({
    pinnedRoots: [],
    currentRoot: args.scannedRoot ?? null,
    directories: args.scannedDirectories ?? [],
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
    expect(electronArgs.resetMediaScheduler).toBe(
      collectionArgs.mediaScheduler.reset
    );

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
    vi.resetModules();
    const { default: App } = await import("./App.jsx");

    render(<App />);

    const hoverAudioToggle = screen.getByRole("button", { name: "Play audio on hover" });
    expect(hoverAudioToggle).toBeInTheDocument();
    expect(useVideoCollectionMock).toHaveBeenCalled();

    const initialArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(initialArgs.hoverAudioEnabled).toBe(false);

    fireEvent.click(hoverAudioToggle);

    const updatedArgs = useVideoCollectionMock.mock.calls.at(-1)?.[0];
    expect(updatedArgs.hoverAudioEnabled).toBe(true);
    expect(headerBarSpy).toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole("button", { name: "Play audio on hover" }));

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
    expect(screen.getByRole("status")).toHaveTextContent(
      "No videos in this collection"
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "/models/wan/empty-run"
    );
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
});
