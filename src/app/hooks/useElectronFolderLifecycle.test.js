import { renderHook, act, waitFor } from "@testing-library/react";
import { useElectronFolderLifecycle } from "./useElectronFolderLifecycle";
import { inferRenderLimitStepFromLegacy } from "../../utils/renderLimit";

function createSetStateMock() {
  let current = new Set();
  const setter = vi.fn((update) => {
    current = typeof update === "function" ? update(current) : update;
  });
  return { get: () => current, setter };
}

describe("useElectronFolderLifecycle", () => {
  let selection;
  let setVisibleVideosMock;
  let setLoadedVideosMock;
  let setLoadingVideosMock;
  let setActualPlayingMock;
  let addRecentFolder;
  let refreshTagList;
  let onFileAddedHandler;
  let onFileRemovedHandler;
  let onFileChangedHandler;
  let disposeAdded;
  let disposeRemoved;
  let disposeChanged;
  let disposeError;

  beforeEach(() => {
    selection = {
      clear: vi.fn(),
      setSelected: vi.fn((updater) => {
        const base = new Set(["a", "b"]);
        return typeof updater === "function" ? updater(base) : base;
      }),
    };

    setVisibleVideosMock = createSetStateMock();
    setLoadedVideosMock = createSetStateMock();
    setLoadingVideosMock = createSetStateMock();
    setActualPlayingMock = createSetStateMock();
    addRecentFolder = vi.fn();
    refreshTagList = vi.fn();
    onFileAddedHandler = undefined;
    onFileRemovedHandler = undefined;
    onFileChangedHandler = undefined;
    disposeAdded = vi.fn();
    disposeRemoved = vi.fn();
    disposeChanged = vi.fn();
    disposeError = vi.fn();

    window.electronAPI = {
      getSettings: vi.fn().mockResolvedValue({
        recursiveMode: true,
        showFilenames: false,
        renderLimitStep: 7,
        zoomLevel: 3,
        sortKey: "name",
        sortDir: "desc",
        groupByFolders: false,
        randomSeed: 42,
      }),
      onFolderSelected: vi.fn().mockReturnValue(() => {}),
      readDirectory: vi.fn().mockResolvedValue([
        {
          id: "file1",
          name: "file1",
          path: "file1",
          basename: "file1",
          tags: [],
        },
      ]),
      stopFolderWatch: vi.fn().mockResolvedValue(),
      startFolderWatch: vi.fn().mockResolvedValue({ success: true }),
      onFileAdded: vi.fn((cb) => {
        onFileAddedHandler = cb;
        return disposeAdded;
      }),
      onFileRemoved: vi.fn((cb) => {
        onFileRemovedHandler = cb;
        return disposeRemoved;
      }),
      onFileChanged: vi.fn((cb) => {
        onFileChangedHandler = cb;
        return disposeChanged;
      }),
      onFileWatchError: vi.fn(() => disposeError),
      selectFolder: vi.fn(),
    };
  });

  it("does not refetch settings when setter identities change", async () => {
    const setRecursiveMode = vi.fn();
    const { rerender } = renderHook(
      ({ setZoomLevelFromSettings }) =>
        useElectronFolderLifecycle({
          selection,
          recursiveMode: false,
          setRecursiveMode,
          setShowFilenames: vi.fn(),
          renderLimitStep: 5,
          setRenderLimitStep: vi.fn(),
          setSortKey: vi.fn(),
          setSortDir: vi.fn(),
          groupByFolders: true,
          setGroupByFolders: vi.fn(),
          setRandomSeed: vi.fn(),
          setZoomLevelFromSettings,
          setVisibleVideos: setVisibleVideosMock.setter,
          setLoadedVideos: setLoadedVideosMock.setter,
          setLoadingVideos: setLoadingVideosMock.setter,
          setActualPlaying: setActualPlayingMock.setter,
          refreshTagList,
          addRecentFolder,
          delayFn: () => Promise.resolve(),
        }),
      { initialProps: { setZoomLevelFromSettings: vi.fn() } }
    );

    await waitFor(() =>
      expect(window.electronAPI.getSettings).toHaveBeenCalledTimes(1)
    );

    rerender({ setZoomLevelFromSettings: vi.fn() });

    await waitFor(() =>
      expect(window.electronAPI.getSettings).toHaveBeenCalledTimes(1)
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
    onFileAddedHandler = undefined;
    onFileRemovedHandler = undefined;
    onFileChangedHandler = undefined;
  });

  it("loads persisted settings on mount", async () => {
    const setRecursiveMode = vi.fn();
    const setShowFilenames = vi.fn();
    const setRenderLimitStep = vi.fn();
    const setSortKey = vi.fn();
    const setSortDir = vi.fn();
    const setGroupByFolders = vi.fn();
    const setRandomSeed = vi.fn();
    const setZoomLevelFromSettings = vi.fn();

    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode,
        setShowFilenames,
        renderLimitStep: 5,
        setRenderLimitStep,
        setSortKey,
        setSortDir,
        groupByFolders: true,
        setGroupByFolders,
        setRandomSeed,
        setZoomLevelFromSettings,
        setVisibleVideos: setVisibleVideosMock.setter,
        setLoadedVideos: setLoadedVideosMock.setter,
        setLoadingVideos: setLoadingVideosMock.setter,
        setActualPlaying: setActualPlayingMock.setter,
        refreshTagList,
        addRecentFolder,
        delayFn: () => Promise.resolve(),
      })
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(setRecursiveMode).toHaveBeenCalledWith(true);
    expect(setShowFilenames).toHaveBeenCalledWith(false);
    expect(setRenderLimitStep).toHaveBeenCalledWith(7);
    expect(setSortKey).toHaveBeenCalledWith("name");
    expect(setSortDir).toHaveBeenCalledWith("desc");
    expect(setGroupByFolders).toHaveBeenCalledWith(false);
    expect(setRandomSeed).toHaveBeenCalledWith(42);
    expect(setZoomLevelFromSettings).toHaveBeenCalledWith(3);
  });

  it("converts legacy maxConcurrentPlaying setting to render limit step", async () => {
    const legacyValue = 250;
    window.electronAPI.getSettings.mockResolvedValueOnce({
      recursiveMode: false,
      showFilenames: true,
      maxConcurrentPlaying: legacyValue,
    });

    const setRenderLimitStep = vi.fn();

    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        renderLimitStep: 5,
        setRenderLimitStep,
        setSortKey: vi.fn(),
        setSortDir: vi.fn(),
        groupByFolders: true,
        setGroupByFolders: vi.fn(),
        setRandomSeed: vi.fn(),
        setZoomLevelFromSettings: vi.fn(),
        setVisibleVideos: setVisibleVideosMock.setter,
        setLoadedVideos: setLoadedVideosMock.setter,
        setLoadingVideos: setLoadingVideosMock.setter,
        setActualPlaying: setActualPlayingMock.setter,
        refreshTagList,
        addRecentFolder,
        delayFn: () => Promise.resolve(),
      })
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(setRenderLimitStep).toHaveBeenCalledWith(
      inferRenderLimitStepFromLegacy(legacyValue)
    );
  });

  it("handles folder selection lifecycle", async () => {
    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        renderLimitStep: 5,
        setRenderLimitStep: vi.fn(),
        setSortKey: vi.fn(),
        setSortDir: vi.fn(),
        groupByFolders: true,
        setGroupByFolders: vi.fn(),
        setRandomSeed: vi.fn(),
        setZoomLevelFromSettings: vi.fn(),
        setVisibleVideos: setVisibleVideosMock.setter,
        setLoadedVideos: setLoadedVideosMock.setter,
        setLoadingVideos: setLoadingVideosMock.setter,
        setActualPlaying: setActualPlayingMock.setter,
        refreshTagList,
        addRecentFolder,
        delayFn: () => Promise.resolve(),
      })
    );

    await waitFor(() => expect(window.electronAPI.getSettings).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });

    await waitFor(() => expect(result.current.videos).toHaveLength(1));

    expect(selection.clear).toHaveBeenCalled();
    expect(window.electronAPI.readDirectory).toHaveBeenCalledWith("/videos", false);
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/videos",
      false
    );
    expect(refreshTagList).toHaveBeenCalled();
    expect(addRecentFolder).toHaveBeenCalledWith("/videos");
    expect(result.current.isLoadingFolder).toBe(false);
  });

  it("propagates watcher events into local state", async () => {
    const { result, unmount } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        renderLimitStep: 5,
        setRenderLimitStep: vi.fn(),
        setSortKey: vi.fn(),
        setSortDir: vi.fn(),
        groupByFolders: true,
        setGroupByFolders: vi.fn(),
        setRandomSeed: vi.fn(),
        setZoomLevelFromSettings: vi.fn(),
        setVisibleVideos: setVisibleVideosMock.setter,
        setLoadedVideos: setLoadedVideosMock.setter,
        setLoadingVideos: setLoadingVideosMock.setter,
        setActualPlaying: setActualPlayingMock.setter,
        refreshTagList,
        addRecentFolder,
        delayFn: () => Promise.resolve(),
      })
    );

    await waitFor(() => expect(window.electronAPI.getSettings).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });

    expect(typeof onFileAddedHandler).toBe("function");
    expect(typeof onFileRemovedHandler).toBe("function");
    expect(typeof onFileChangedHandler).toBe("function");

    act(() => {
      onFileAddedHandler?.({
        id: "file2",
        basename: "file2",
        tags: [],
      });
    });

    expect(result.current.videos.map((v) => v.id)).toEqual([
      "file1",
      "file2",
    ]);

    act(() => {
      onFileChangedHandler?.({
        id: "file2",
        basename: "file2",
        tags: ["new"],
      });
    });

    expect(result.current.videos.find((v) => v.id === "file2")?.tags).toEqual([
      "new",
    ]);

    act(() => {
      onFileRemovedHandler?.("file1");
    });

    expect(result.current.videos.map((v) => v.id)).toEqual(["file2"]);
    expect(selection.setSelected).toHaveBeenCalled();
    expect(refreshTagList).toHaveBeenCalledTimes(3);

    unmount();
    expect(disposeAdded).toHaveBeenCalled();
    expect(disposeRemoved).toHaveBeenCalled();
    expect(disposeChanged).toHaveBeenCalled();
    expect(disposeError).toHaveBeenCalled();
    expect(window.electronAPI.stopFolderWatch).toHaveBeenCalled();
  });

  it("keeps watcher subscriptions active when selection identity changes", async () => {
    const clear = vi.fn();
    const setSelected = vi.fn((updater) => {
      const base = new Set(["persist"]);
      return typeof updater === "function" ? updater(base) : base;
    });

    const baseSelection = { clear, setSelected };

    const { rerender, unmount } = renderHook(
      ({ selectionProp }) =>
        useElectronFolderLifecycle({
          selection: selectionProp,
          recursiveMode: false,
          setRecursiveMode: vi.fn(),
          setShowFilenames: vi.fn(),
          renderLimitStep: 5,
          setRenderLimitStep: vi.fn(),
          setSortKey: vi.fn(),
          setSortDir: vi.fn(),
          groupByFolders: true,
          setGroupByFolders: vi.fn(),
          setRandomSeed: vi.fn(),
          setZoomLevelFromSettings: vi.fn(),
          setVisibleVideos: setVisibleVideosMock.setter,
          setLoadedVideos: setLoadedVideosMock.setter,
          setLoadingVideos: setLoadingVideosMock.setter,
          setActualPlaying: setActualPlayingMock.setter,
          refreshTagList,
          addRecentFolder,
          delayFn: () => Promise.resolve(),
        }),
      { initialProps: { selectionProp: baseSelection } }
    );

    await waitFor(() =>
      expect(window.electronAPI.onFileAdded).toHaveBeenCalledTimes(1)
    );

    rerender({ selectionProp: { clear, setSelected } });

    expect(disposeAdded).not.toHaveBeenCalled();
    expect(disposeRemoved).not.toHaveBeenCalled();
    expect(disposeChanged).not.toHaveBeenCalled();
    expect(window.electronAPI.stopFolderWatch).not.toHaveBeenCalled();

    unmount();

    expect(disposeAdded).toHaveBeenCalledTimes(1);
    expect(disposeRemoved).toHaveBeenCalledTimes(1);
    expect(disposeChanged).toHaveBeenCalledTimes(1);
    expect(disposeError).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.stopFolderWatch).toHaveBeenCalledTimes(1);
  });

  it("loads web files when selected", async () => {
    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        renderLimitStep: 5,
        setRenderLimitStep: vi.fn(),
        setSortKey: vi.fn(),
        setSortDir: vi.fn(),
        groupByFolders: true,
        setGroupByFolders: vi.fn(),
        setRandomSeed: vi.fn(),
        setZoomLevelFromSettings: vi.fn(),
        setVisibleVideos: setVisibleVideosMock.setter,
        setLoadedVideos: setLoadedVideosMock.setter,
        setLoadingVideos: setLoadingVideosMock.setter,
        setActualPlaying: setActualPlayingMock.setter,
        refreshTagList,
        addRecentFolder,
        delayFn: () => Promise.resolve(),
      })
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    const file = {
      name: "video.mp4",
      size: 123,
      type: "video/mp4",
      lastModified: Date.now(),
    };
    const event = { target: { files: [file] } };

    act(() => {
      result.current.handleWebFileSelection(event);
    });

    expect(result.current.videos).toHaveLength(1);
    expect(selection.clear).toHaveBeenCalled();
    expect(setVisibleVideosMock.setter).toHaveBeenCalled();
    expect(setLoadedVideosMock.setter).toHaveBeenCalled();
    expect(setLoadingVideosMock.setter).toHaveBeenCalled();
    expect(setActualPlayingMock.setter).toHaveBeenCalled();
  });

  it("passes the recursive flag when starting folder watch", async () => {
    const setRecursiveMode = vi.fn();
    const { result, rerender } = renderHook(
      ({ recursiveMode }) =>
        useElectronFolderLifecycle({
          selection,
          recursiveMode,
          setRecursiveMode,
          setShowFilenames: vi.fn(),
          renderLimitStep: 5,
          setRenderLimitStep: vi.fn(),
          setSortKey: vi.fn(),
          setSortDir: vi.fn(),
          groupByFolders: true,
          setGroupByFolders: vi.fn(),
          setRandomSeed: vi.fn(),
          setZoomLevelFromSettings: vi.fn(),
          setVisibleVideos: setVisibleVideosMock.setter,
          setLoadedVideos: setLoadedVideosMock.setter,
          setLoadingVideos: setLoadingVideosMock.setter,
          setActualPlaying: setActualPlayingMock.setter,
          refreshTagList,
          addRecentFolder,
          delayFn: () => Promise.resolve(),
        }),
      { initialProps: { recursiveMode: false } }
    );

    await waitFor(() => expect(window.electronAPI.getSettings).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });

    expect(window.electronAPI.startFolderWatch).toHaveBeenLastCalledWith(
      "/videos",
      false
    );

    window.electronAPI.startFolderWatch.mockClear();

    rerender({ recursiveMode: true });

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });

    expect(window.electronAPI.startFolderWatch).toHaveBeenLastCalledWith(
      "/videos",
      true
    );
  });
});
