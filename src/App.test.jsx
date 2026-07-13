import React from "react";
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";

const selectionMock = {
  selected: new Set(),
  size: 0,
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
const useLongTaskFlagMock = vi.fn(() => ({ hadLongTaskRecently: false }));
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
const useElectronLifecycleMock = vi.fn(() => ({
  videos: electronVideos,
  setVideos: vi.fn(),
  isLoadingFolder: false,
  loadingStatus: null,
  loadingStage: "",
  loadingProgress: 0,
  settingsLoaded: true,
  cancelFolderLoad: vi.fn(),
  handleElectronFolderSelection: vi.fn(),
  handleFolderSelect: vi.fn(),
  handleWebFileSelection: vi.fn(),
}));

const filterStateReturn = {
  filters: { includeTags: [], excludeTags: [] },
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

vi.mock("./components/VideoCard/VideoCard", async () => {
  const ReactModule = await vi.importActual("react");
  return {
    __esModule: true,
    default: ReactModule.default.memo((props) => {
      videoCardSpy(props);
      return <div data-testid="video-card" data-video-id={props.video.id} />;
    }),
  };
});
vi.mock("./components/FullScreenModal", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("./components/ContextMenu", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("./components/RecentFolders", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("./components/MetadataPanel", () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock("./components/HeaderBar", () => ({
  __esModule: true,
  default: (props) => {
    headerBarSpy(props);
    return (
      <button
        type="button"
        aria-label="Play audio on hover"
        aria-pressed={Boolean(props.hoverAudioEnabled)}
        onClick={() => props.onHoverAudioToggle?.()}
      >
        Hover audio
      </button>
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
vi.mock("./hooks/ui-perf/useLongTaskFlag", () => ({
  __esModule: true,
  default: (...args) => useLongTaskFlagMock(...args),
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
vi.mock("./config/featureFlags", () => ({
  __esModule: true,
  default: { stableViewFixes: false, stableViewAnchoring: false },
}));
vi.mock("./App.css", () => ({}), { virtual: true });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Object.assign(masonryReturn, {
    orderedVideos: [],
    displayVideos: [],
    orderedIds: [],
    orderForRange: [],
    activationIds: [],
    activationIdSet: new Set(),
    virtualItems: [],
    totalHeight: 0,
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

    const electronArgs = useElectronLifecycleMock.mock.calls[0][0];
    expect(typeof electronArgs.setZoomLevelFromSettings).toBe("function");

    const filterArgs = useFilterStateMock.mock.calls[0][0];
    expect(filterArgs.videos).toBe(electronVideos);

    expect(useElectronLifecycleMock.mock.invocationCallOrder[0]).toBeLessThan(
      useFilterStateMock.mock.invocationCallOrder[0]
    );

    const zoomArgs = useZoomControlsMock.mock.calls[0][0];
    expect(typeof zoomArgs.runWithStableAnchor).toBe("function");

    result.unmount();
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
