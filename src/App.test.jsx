import React from "react";
import { describe, test, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

const selectionMock = {
  selected: new Set(),
  size: 0,
  setSelected: vi.fn(),
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

const useInitGateMock = vi.fn(() => ({ scheduleInit: vi.fn() }));
const useLongTaskFlagMock = vi.fn(() => ({ hadLongTaskRecently: false }));
const useContextMenuMock = vi.fn(() => ({
  contextMenu: { visible: false, position: { x: 0, y: 0 }, contextId: null },
  showOnItem: vi.fn(),
  showOnEmpty: vi.fn(),
  hide: vi.fn(),
}));
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
  loadingStage: "",
  loadingProgress: 0,
  settingsLoaded: true,
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
  orderedIds: [],
  orderForRange: () => [],
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
  isVideoPlaying: vi.fn(() => false),
  reportStarted: vi.fn(),
  reportPlayError: vi.fn(),
  markHover: vi.fn(),
}));

vi.mock("./components/VideoCard/VideoCard", () => ({
  __esModule: true,
  default: () => null,
}));
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
  default: () => null,
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
  default: () => null,
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
});

describe("App hook composition", () => {
  test("provides stable dependencies to extracted hooks", async () => {
    vi.resetModules();
    const { default: App } = await import("./App.jsx");

    const result = render(<App />);

    expect(useElectronLifecycleMock).toHaveBeenCalledTimes(1);
    expect(useFilterStateMock).toHaveBeenCalledTimes(1);
    expect(useMasonryLayoutMock).toHaveBeenCalledTimes(1);
    expect(useZoomControlsMock).toHaveBeenCalledTimes(1);

    const electronArgs = useElectronLifecycleMock.mock.calls[0][0];
    expect(typeof electronArgs.setZoomLevelFromSettings).toBe("function");

    const filterArgs = useFilterStateMock.mock.calls[0][0];
    expect(filterArgs.videos).toBe(electronVideos);

    expect(useElectronLifecycleMock.mock.invocationCallOrder[0]).toBeLessThan(
      useFilterStateMock.mock.invocationCallOrder[0]
    );

    const zoomArgs = useZoomControlsMock.mock.calls[0][0];
    expect(zoomArgs.runWithStableAnchor).toBe(runWithStableAnchorMock);

    result.unmount();
  });
});
