import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

const selectionRef = { current: null };
const runActionRef = { current: null };

vi.mock("./hooks/selection/useSelectionState", async () => {
  const actual = await vi.importActual("./hooks/selection/useSelectionState");
  return {
    __esModule: true,
    default: (...args) => {
      const result = actual.default(...args);
      selectionRef.current = result;
      return result;
    },
  };
});

vi.mock("./hooks/actions/useTrashIntegration", async () => {
  const actual = await vi.importActual("./hooks/actions/useTrashIntegration.js");
  return {
    __esModule: true,
    default: (args) => {
      const result = actual.default(args);
      return result;
    },
  };
});

vi.mock("./hooks/actions/useActionDispatch", async () => {
  const actual = await vi.importActual("./hooks/actions/useActionDispatch.js");
  return {
    __esModule: true,
    default: (deps, getById) => {
      const result = actual.default(deps, getById);
      runActionRef.current = result.runAction;
      return result;
    },
  };
});

vi.mock("./utils/releaseVideoHandles", () => ({
  __esModule: true,
  releaseVideoHandlesForAsync: vi.fn(async () => {}),
}));

vi.mock("./components/VideoCard/VideoCard", () => ({
  __esModule: true,
  default: ({ video, onSelect }) => (
    <button
      data-testid={`video-${video.id}`}
      onClick={() => onSelect?.(video.id, false, false, false)}
    >
      {video.name || video.id}
    </button>
  ),
}));

vi.mock("./components/HeaderBar", () => ({ __esModule: true, default: () => null }));
vi.mock("./components/DebugSummary", () => ({ __esModule: true, default: () => null }));
vi.mock("./components/RecentFolders", () => ({ __esModule: true, default: () => null }));
vi.mock("./components/FullScreenModal", () => ({ __esModule: true, default: () => null }));

vi.mock("./hooks/useFullScreenModal", () => ({
  __esModule: true,
  useFullScreenModal: () => ({
    fullScreenVideo: null,
    openFullScreen: vi.fn(),
    closeFullScreen: vi.fn(),
    navigateFullScreen: vi.fn(),
  }),
}));

let memoryStatusMock = null;

vi.mock("./hooks/video-collection", () => ({
  __esModule: true,
  useVideoCollection: ({ videos = [] }) => ({
    memoryStatus: memoryStatusMock,
    playingVideos: [],
    limits: { maxLoaded: videos.length },
    performCleanup: vi.fn(() => []),
    stats: {
      total: videos.length,
      rendered: videos.length,
      playing: 0,
      progressiveVisible: videos.length,
      activationTarget: videos.length,
      activeWindow: videos.length,
    },
    videosToRender: videos,
    canLoadVideo: () => true,
    isVideoPlaying: () => false,
    reportStarted: vi.fn(),
    reportPlayError: vi.fn(),
    markHover: vi.fn(),
  }),
}));

vi.mock("./hooks/useRecentFolders", () => ({
  __esModule: true,
  default: () => ({ items: [], add: vi.fn(), remove: vi.fn(), clear: vi.fn() }),
}));

vi.mock("./hooks/ui-perf/useLongTaskFlag", () => ({
  __esModule: true,
  default: () => ({ hadLongTaskRecently: false }),
}));

vi.mock("./hooks/ui-perf/useInitGate", () => ({
  __esModule: true,
  default: () => ({ scheduleInit: vi.fn() }),
}));

vi.mock("./hooks/useContextMenu", () => ({
  __esModule: true,
  default: () => ({
    contextMenu: { visible: false, position: null, contextId: null },
    showOnItem: vi.fn(),
    showOnEmpty: vi.fn(),
    hide: vi.fn(),
  }),
}));

vi.mock("./hooks/useHotkeys", () => ({
  __esModule: true,
  default: () => {},
}));

vi.mock("./hooks/selection/useStableViewAnchoring", () => ({
  __esModule: true,
  default: () => ({
    runWithStableAnchor: (_type, fn) => (typeof fn === "function" ? fn() : undefined),
    focusCurrentAnchor: () => false,
  }),
}));

vi.mock("./hooks/useZoomControls", () => ({
  __esModule: true,
  default: () => ({
    handleZoomChangeSafe: vi.fn(),
    getMinimumZoomLevel: vi.fn(() => 0),
    applyZoomFromSettings: vi.fn(),
  }),
}));

vi.mock("./app/hooks/useMasonryLayout", () => ({
  __esModule: true,
  useMasonryLayout: ({ videos }) => ({
    orderedVideos: videos,
    orderedIds: videos.map((v) => v.id),
    orderForRange: videos.map((v) => v.id),
    ioRegistry: { observe: vi.fn(), unobserve: vi.fn(), isNear: () => true },
    layoutEpoch: 0,
    scheduleLayout: vi.fn(),
    updateAspectRatio: vi.fn(),
    onItemsChanged: vi.fn(),
    setZoomClass: vi.fn(),
    progressiveMaxVisibleNumber: videos.length,
    activationTarget: videos.length,
    viewportMetrics: {
      columnCount: 1,
      viewportRows: videos.length,
      approxTileHeight: 200,
      viewportHeight: 800,
      scrollTop: 0,
    },
    withLayoutHold: (fn) => (typeof fn === "function" ? fn() : undefined),
    isLayoutTransitioning: false,
  }),
}));

const initialVideos = [
  {
    id: "keep",
    name: "Keep",
    tags: [],
    rating: null,
    isElectronFile: true,
    fullPath: "keep",
    fingerprint: "keep",
  },
  {
    id: "trash",
    name: "Trash",
    tags: [],
    rating: null,
    isElectronFile: true,
    fullPath: "trash",
    fingerprint: "trash",
  },
];

vi.mock("./app/hooks/useElectronFolderLifecycle", async () => {
  const React = await vi.importActual("react");
  return {
    __esModule: true,
    useElectronFolderLifecycle: () => {
      const [videos, setVideos] = React.useState(initialVideos);
      return {
        videos,
        setVideos,
        isLoadingFolder: false,
        loadingStage: "",
        loadingProgress: 0,
        settingsLoaded: true,
        handleElectronFolderSelection: vi.fn(),
        handleFolderSelect: vi.fn(),
        handleWebFileSelection: vi.fn(),
      };
    },
  };
});

vi.mock("./app/hooks/useFilterState", async () => {
  const React = await vi.importActual("react");
  return {
    __esModule: true,
    useFilterState: ({ videos }) => {
      const [filters, setFilters] = React.useState({
        includeTags: [],
        excludeTags: [],
        minRating: null,
        exactRating: null,
      });
      const [isFiltersOpen, setFiltersOpen] = React.useState(true);
      const updateFilters = (updater) => {
        setFilters((prev) =>
          typeof updater === "function" ? updater(prev) ?? prev : { ...prev, ...updater }
        );
      };
      const resetFilters = () =>
        setFilters({ includeTags: [], excludeTags: [], minRating: null, exactRating: null });
      return {
        filters,
        setFiltersOpen,
        isFiltersOpen,
        updateFilters,
        resetFilters,
        filteredVideos: videos,
        filteredVideoIds: new Set(videos.map((video) => video.id)),
        filtersActiveCount: 0,
        ratingSummary: null,
        handleRemoveIncludeFilter: vi.fn(),
        handleRemoveExcludeFilter: vi.fn(),
        clearMinRatingFilter: vi.fn(),
        clearExactRatingFilter: vi.fn(),
      };
    },
  };
});

vi.mock("./app/hooks/useMetadataActions", () => ({
  __esModule: true,
  useMetadataActions: () => ({
    applyMetadataPatch: vi.fn(),
    handleAddTags: vi.fn(),
    handleRemoveTag: vi.fn(),
    handleSetRating: vi.fn(),
    handleClearRating: vi.fn(),
    handleApplyExistingTag: vi.fn(),
    refreshTagList: vi.fn(),
  }),
}));

describe("App trash regression", () => {
  beforeEach(() => {
    selectionRef.current = null;
    runActionRef.current = null;
    memoryStatusMock = null;
    window.electronAPI = {
      bulkMoveToTrash: vi.fn(async (paths) => {
        const result = { moved: paths.filter((p) => p !== "keep"), failed: [] };
        return result;
      }),
      metadata: {},
    };
    window.confirm = vi.fn(() => true);
  });

  afterEach(() => {
    cleanup();
    delete window.electronAPI;
    delete window.confirm;
  });

  it("keeps metadata and filter inputs interactive when some selected items survive", async () => {
    const { default: App } = await import("./App.jsx");
    render(<App />);

    await act(async () => {
      expect(selectionRef.current).not.toBeNull();
      selectionRef.current.setSelected(() => new Set(initialVideos.map((v) => v.id)));
    });

    expect(Array.from(selectionRef.current.selected)).toEqual([
      "keep",
      "trash",
    ]);

    const metadataInput = await screen.findByPlaceholderText("Add tag and press Enter");
    expect(metadataInput).not.toBeDisabled();

    const filterInput = screen.getByPlaceholderText("Search available tags");
    fireEvent.change(filterInput, { target: { value: "foo" } });
    expect(filterInput).toHaveValue("foo");

    await act(async () => {
      expect(runActionRef.current).toBeInstanceOf(Function);
      await runActionRef.current("move-to-trash", selectionRef.current.selected, null);
    });

    expect(window.electronAPI.bulkMoveToTrash).toHaveBeenCalled();
    expect(Array.from(selectionRef.current.selected)).toEqual(["keep"]);
    expect(metadataInput).not.toBeDisabled();

    fireEvent.change(filterInput, { target: { value: "foobar" } });
    expect(filterInput).toHaveValue("foobar");

    const toast = await screen.findByText(/Moved 1 item\(s\) to Recycle Bin/);
    expect(toast).toHaveStyle({ pointerEvents: "none" });
  });

  it("keeps filter input editable when all selected items are trashed", async () => {
    const { default: App } = await import("./App.jsx");
    render(<App />);

    await act(async () => {
      selectionRef.current.setSelected(() => new Set(initialVideos.map((v) => v.id)));
    });

    const filterInput = screen.getByPlaceholderText("Search available tags");
    fireEvent.change(filterInput, { target: { value: "first" } });
    expect(filterInput).toHaveValue("first");

    // Force bulkMoveToTrash to report all items as moved for this run.
    window.electronAPI.bulkMoveToTrash.mockImplementationOnce(async (paths) => {
      const result = { moved: paths.slice(), failed: [] };
      return result;
    });

    await act(async () => {
      await runActionRef.current("move-to-trash", selectionRef.current.selected, null);
    });

    expect(Array.from(selectionRef.current.selected)).toEqual([]);
    fireEvent.change(filterInput, { target: { value: "second" } });
    expect(filterInput).toHaveValue("second");

    const toast = await screen.findByText(/Moved 2 item\(s\) to Recycle Bin/);
    expect(toast).toHaveStyle({ pointerEvents: "none" });
  });

  it("renders memory alert without blocking interactions", async () => {
    memoryStatusMock = {
      currentMemoryMB: 5120,
      totalMemoryMB: 8192,
      memoryPressure: 90,
      isNearLimit: true,
      source: "test",
    };

    const { default: App } = await import("./App.jsx");
    render(<App />);

    const warningLabel = await screen.findByText(/Memory Warning/);
    expect(warningLabel.parentElement).toHaveStyle({ pointerEvents: "none" });
  });
});
