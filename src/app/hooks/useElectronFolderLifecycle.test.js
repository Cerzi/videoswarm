import { renderHook, act, waitFor } from "@testing-library/react";
import { useElectronFolderLifecycle } from "./useElectronFolderLifecycle";

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

    window.electronAPI = {
      getSettings: vi.fn().mockResolvedValue({
        recursiveMode: true,
        showFilenames: false,
        maxConcurrentPlaying: 10,
        zoomLevel: 3,
        sortKey: "name",
        sortDir: "desc",
        groupByFolders: false,
        randomSeed: 42,
      }),
      onFolderSelected: vi.fn().mockReturnValue(() => {}),
      readDirectory: vi.fn().mockResolvedValue([
        { id: "file1", name: "file1", path: "file1" },
      ]),
      stopFolderWatch: vi.fn().mockResolvedValue(),
      startFolderWatch: vi.fn().mockResolvedValue({ success: true }),
      onFileAdded: vi.fn(),
      onFileRemoved: vi.fn(),
      onFileChanged: vi.fn(),
      selectFolder: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.electronAPI;
  });

  it("loads persisted settings on mount", async () => {
    const setRecursiveMode = vi.fn();
    const setShowFilenames = vi.fn();
    const setMaxConcurrentPlaying = vi.fn();
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
        maxConcurrentPlaying: 5,
        setMaxConcurrentPlaying,
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
    expect(setMaxConcurrentPlaying).toHaveBeenCalledWith(10);
    expect(setSortKey).toHaveBeenCalledWith("name");
    expect(setSortDir).toHaveBeenCalledWith("desc");
    expect(setGroupByFolders).toHaveBeenCalledWith(false);
    expect(setRandomSeed).toHaveBeenCalledWith(42);
    expect(setZoomLevelFromSettings).toHaveBeenCalledWith(3);
  });

  it("handles folder selection lifecycle", async () => {
    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        maxConcurrentPlaying: 5,
        setMaxConcurrentPlaying: vi.fn(),
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
    expect(refreshTagList).toHaveBeenCalled();
    expect(addRecentFolder).toHaveBeenCalledWith("/videos");
    expect(result.current.isLoadingFolder).toBe(false);
  });

  it("loads web files when selected", async () => {
    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        maxConcurrentPlaying: 5,
        setMaxConcurrentPlaying: vi.fn(),
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
});
