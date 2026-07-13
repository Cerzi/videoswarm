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
  let directoryScanProgressHandler;
  let disposeDirectoryScanProgress;

  const renderDefaultLifecycle = (overrides = {}) =>
    renderHook(() =>
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
        ...overrides,
      })
    );

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
    directoryScanProgressHandler = undefined;
    disposeDirectoryScanProgress = vi.fn();

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
      cancelDirectoryScan: vi.fn().mockResolvedValue({
        success: true,
        cancelled: true,
      }),
      onDirectoryScanProgress: vi.fn((callback) => {
        directoryScanProgressHandler = callback;
        return disposeDirectoryScanProgress;
      }),
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
    directoryScanProgressHandler = undefined;
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
      })
    );

    await waitFor(() => expect(window.electronAPI.getSettings).toHaveBeenCalled());

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });

    await waitFor(() => expect(result.current.videos).toHaveLength(1));

    expect(selection.clear).toHaveBeenCalled();
    expect(window.electronAPI.readDirectory).toHaveBeenCalledWith(
      "/videos",
      false,
      expect.stringMatching(/^directory-scan-/)
    );
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/videos",
      false
    );
    expect(refreshTagList).toHaveBeenCalled();
    expect(addRecentFolder).toHaveBeenCalledWith("/videos");
    expect(result.current.isLoadingFolder).toBe(false);
  });

  it("cancels an in-flight directory scan without applying stale results", async () => {
    let resolveRead;
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );

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
      })
    );

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/slow");
    });

    await waitFor(() =>
      expect(window.electronAPI.readDirectory).toHaveBeenCalledTimes(1)
    );
    const scanId = window.electronAPI.readDirectory.mock.calls[0][2];

    act(() => {
      result.current.cancelFolderLoad();
    });

    expect(window.electronAPI.cancelDirectoryScan).toHaveBeenCalledWith(scanId);
    expect(result.current.isLoadingFolder).toBe(false);

    await act(async () => {
      resolveRead([
        { id: "stale", name: "stale", basename: "stale", tags: [] },
      ]);
      await loadPromise;
    });

    expect(result.current.videos).toEqual([]);
    expect(window.electronAPI.startFolderWatch).not.toHaveBeenCalled();
    expect(addRecentFolder).not.toHaveBeenCalled();
  });

  it("accepts only monotonic progress for the active directory scan", async () => {
    let resolveRead;
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );
    const { result } = renderDefaultLifecycle();

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/large");
    });
    await waitFor(() =>
      expect(window.electronAPI.readDirectory).toHaveBeenCalledTimes(1)
    );
    const scanId = window.electronAPI.readDirectory.mock.calls[0][2];

    act(() => {
      directoryScanProgressHandler?.({
        scanId: "stale-scan",
        sequence: 9,
        phase: "indexing",
        phaseCurrent: 90,
        phaseTotal: 100,
      });
    });
    expect(result.current.loadingStatus.phase).toBe("enumerating");

    act(() => {
      directoryScanProgressHandler?.({
        scanId,
        sequence: 2,
        phase: "indexing",
        phaseCurrent: 40,
        phaseTotal: 200,
        directoriesScanned: 18,
        entriesChecked: 900,
        videosFound: 200,
        indexedFiles: 40,
        currentPath: "run-18",
        updatedAt: 500,
      });
    });
    expect(result.current.loadingStatus).toMatchObject({
      phase: "indexing",
      completed: 40,
      total: 200,
      directoriesScanned: 18,
      entriesInspected: 900,
      videosDiscovered: 200,
      indexed: 40,
      currentPath: "run-18",
    });
    expect(result.current.loadingProgress).toBe(20);

    act(() => {
      directoryScanProgressHandler?.({
        scanId,
        sequence: 1,
        phase: "indexing",
        phaseCurrent: 5,
        phaseTotal: 200,
      });
    });
    expect(result.current.loadingStatus.completed).toBe(40);

    act(() => result.current.cancelFolderLoad());
    act(() => {
      directoryScanProgressHandler?.({
        scanId,
        sequence: 3,
        phase: "enriching",
        phaseCurrent: 100,
        phaseTotal: 200,
      });
    });
    expect(result.current.loadingStatus.phase).toBe("cancelled");

    await act(async () => {
      resolveRead({ cancelled: true, files: [] });
      await loadPromise;
    });
  });

  it("keeps scan failures visible until the user closes the dialog", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    window.electronAPI.readDirectory.mockRejectedValueOnce(
      new Error("Permission denied")
    );
    const { result } = renderDefaultLifecycle();

    await act(async () => {
      await result.current.handleElectronFolderSelection("/unreadable");
    });

    expect(result.current.isLoadingFolder).toBe(true);
    expect(result.current.loadingStatus).toMatchObject({
      phase: "error",
      message: "Couldn’t open this collection",
      error: "Permission denied",
    });

    act(() => result.current.cancelFolderLoad());
    expect(result.current.isLoadingFolder).toBe(false);
    expect(errorLog).toHaveBeenCalledWith(
      "Error reading directory:",
      expect.any(Error)
    );
    errorLog.mockRestore();
  });

  it("keeps a loaded collection open when watcher startup fails", async () => {
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.electronAPI.startFolderWatch.mockRejectedValueOnce(
      new Error("watch limit reached")
    );
    const { result } = renderDefaultLifecycle();

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });

    expect(result.current.videos).toHaveLength(1);
    expect(result.current.loadingStatus.phase).toBe("complete");
    expect(result.current.isLoadingFolder).toBe(false);
    expect(addRecentFolder).toHaveBeenCalledWith("/videos");
    expect(warningLog).toHaveBeenCalledWith(
      "Failed to start folder watcher:",
      expect.any(Error)
    );
    warningLog.mockRestore();
  });

  it("disposes the directory progress subscription on unmount", async () => {
    const { unmount } = renderDefaultLifecycle();
    await waitFor(() =>
      expect(window.electronAPI.onDirectoryScanProgress).toHaveBeenCalledOnce()
    );

    unmount();
    expect(disposeDirectoryScanProgress).toHaveBeenCalledOnce();
  });

  it("keeps the newest folder when scans resolve out of order", async () => {
    const pending = new Map();
    window.electronAPI.readDirectory.mockImplementation(
      (folderPath) =>
        new Promise((resolve) => {
          pending.set(folderPath, resolve);
        })
    );

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
      })
    );

    let firstLoad;
    act(() => {
      firstLoad = result.current.handleElectronFolderSelection("/first");
    });
    await waitFor(() => expect(pending.has("/first")).toBe(true));

    let secondLoad;
    act(() => {
      secondLoad = result.current.handleElectronFolderSelection("/second");
    });
    await waitFor(() => expect(pending.has("/second")).toBe(true));

    await act(async () => {
      pending.get("/second")([
        { id: "second", name: "second", basename: "second", tags: [] },
      ]);
      await secondLoad;
    });

    await act(async () => {
      pending.get("/first")([
        { id: "first", name: "first", basename: "first", tags: [] },
      ]);
      await firstLoad;
    });

    expect(result.current.videos.map((video) => video.id)).toEqual(["second"]);
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/second",
      false
    );
    expect(addRecentFolder).toHaveBeenCalledTimes(1);
    expect(addRecentFolder).toHaveBeenCalledWith("/second");
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
