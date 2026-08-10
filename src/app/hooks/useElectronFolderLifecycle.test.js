import { renderHook, act, waitFor } from "@testing-library/react";
import {
  CACHED_FIRST_GRID_LIMIT,
  useElectronFolderLifecycle,
} from "./useElectronFolderLifecycle";
import { SortKey, buildComparator, groupAndSort } from "../../sorting/sorting";

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
  let directoryScanRecordsHandler;
  let disposeDirectoryScanRecords;

  const renderDefaultLifecycle = (overrides = {}) =>
    renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        setHoverAudioEnabled: vi.fn(),
        setSortKey: vi.fn(),
        setSortDir: vi.fn(),
        groupByFolders: true,
        setGroupByFolders: vi.fn(),
        setRandomSeed: vi.fn(),
        setPlaybackMode: vi.fn(),
        setProxyPlaybackEnabled: vi.fn(),
        setReviewAutoAdvance: vi.fn(),
        setReviewModeEnabled: vi.fn(),
        setFullscreenDetailsOpen: vi.fn(),
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
    directoryScanRecordsHandler = undefined;
    disposeDirectoryScanRecords = vi.fn();

    window.electronAPI = {
      getSettings: vi.fn().mockResolvedValue({
        recursiveMode: true,
        showFilenames: false,
        hoverAudioEnabled: true,
        zoomLevel: 3,
        sortKey: "name",
        sortDir: "desc",
        groupByFolders: false,
        randomSeed: 42,
        playbackMode: "static-hover",
        proxyPlaybackEnabled: true,
        reviewAutoAdvance: true,
        reviewModeEnabled: false,
        fullscreenDetailsOpen: false,
        fullscreenAudioEnabled: true,
        metadataInspectorMode: "docked",
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
      readDirectoryCache: vi.fn().mockResolvedValue(null),
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
      onDirectoryScanRecords: vi.fn((callback) => {
        directoryScanRecordsHandler = callback;
        return disposeDirectoryScanRecords;
      }),
      prioritizeDirectoryScan: vi.fn(),
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
          setHoverAudioEnabled: vi.fn(),
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

  it("flushes and captures the outgoing view before a native menu folder selection", async () => {
    let nativeFolderSelected;
    let releasePreOpen;
    const beforeExternalFolderSelection = vi.fn(
      () => new Promise((resolve) => {
        releasePreOpen = resolve;
      })
    );
    window.electronAPI.onFolderSelected.mockImplementation((callback) => {
      nativeFolderSelected = callback;
      return vi.fn();
    });
    renderDefaultLifecycle({ beforeExternalFolderSelection });
    await waitFor(() => expect(typeof nativeFolderSelected).toBe("function"));

    let selectionPromise;
    act(() => {
      selectionPromise = nativeFolderSelected("/opened-from-menu");
    });

    expect(beforeExternalFolderSelection).toHaveBeenCalledWith(
      "/opened-from-menu"
    );
    expect(window.electronAPI.readDirectory).not.toHaveBeenCalled();

    await act(async () => {
      releasePreOpen();
      await selectionPromise;
    });
    expect(beforeExternalFolderSelection.mock.invocationCallOrder[0]).toBeLessThan(
      window.electronAPI.readDirectory.mock.invocationCallOrder[0]
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete window.electronAPI;
    onFileAddedHandler = undefined;
    onFileRemovedHandler = undefined;
    onFileChangedHandler = undefined;
    directoryScanProgressHandler = undefined;
    directoryScanRecordsHandler = undefined;
  });

  it("loads persisted settings on mount", async () => {
    const setRecursiveMode = vi.fn();
    const setShowFilenames = vi.fn();
    const setHoverAudioEnabled = vi.fn();
    const setSortKey = vi.fn();
    const setSortDir = vi.fn();
    const setGroupByFolders = vi.fn();
    const setRandomSeed = vi.fn();
    const setPlaybackMode = vi.fn();
    const setProxyPlaybackEnabled = vi.fn();
    const setReviewAutoAdvance = vi.fn();
    const setReviewModeEnabled = vi.fn();
    const setFullscreenDetailsOpen = vi.fn();
    const setFullscreenAudioEnabled = vi.fn();
    const setMetadataInspectorMode = vi.fn();
    const setZoomLevelFromSettings = vi.fn();

    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode,
        setShowFilenames,
        setHoverAudioEnabled,
        setSortKey,
        setSortDir,
        groupByFolders: true,
        setGroupByFolders,
        setRandomSeed,
        setPlaybackMode,
        setProxyPlaybackEnabled,
        setReviewAutoAdvance,
        setReviewModeEnabled,
        setFullscreenDetailsOpen,
        setFullscreenAudioEnabled,
        setMetadataInspectorMode,
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
    expect(setHoverAudioEnabled).toHaveBeenCalledWith(true);
    expect(setSortKey).toHaveBeenCalledWith("name");
    expect(setSortDir).toHaveBeenCalledWith("desc");
    expect(setGroupByFolders).toHaveBeenCalledWith(false);
    expect(setRandomSeed).toHaveBeenCalledWith(42);
    expect(setPlaybackMode).toHaveBeenCalledWith("static-hover");
    expect(setProxyPlaybackEnabled).toHaveBeenCalledWith(true);
    expect(setReviewAutoAdvance).toHaveBeenCalledWith(true);
    expect(setReviewModeEnabled).toHaveBeenCalledWith(false);
    expect(setFullscreenDetailsOpen).toHaveBeenCalledWith(false);
    expect(setFullscreenAudioEnabled).toHaveBeenCalledWith(true);
    expect(setMetadataInspectorMode).toHaveBeenCalledWith("docked");
    expect(setZoomLevelFromSettings).toHaveBeenCalledWith(3);
  });

  it("normalizes invalid playback settings and coerces the proxy toggle", async () => {
    window.electronAPI.getSettings.mockResolvedValueOnce({
      playbackMode: "turbo-everything",
      proxyPlaybackEnabled: 1,
    });
    const setPlaybackMode = vi.fn();
    const setProxyPlaybackEnabled = vi.fn();

    const { result } = renderDefaultLifecycle({
      setPlaybackMode,
      setProxyPlaybackEnabled,
    });

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(setPlaybackMode).toHaveBeenCalledWith("balanced");
    expect(setProxyPlaybackEnabled).toHaveBeenCalledWith(true);
  });

  it("treats only a literal true auto-advance setting as enabled", async () => {
    window.electronAPI.getSettings.mockResolvedValueOnce({
      reviewAutoAdvance: "true",
    });
    const setReviewAutoAdvance = vi.fn();

    const { result } = renderDefaultLifecycle({ setReviewAutoAdvance });

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(setReviewAutoAdvance).toHaveBeenCalledWith(false);
  });

  it("defaults fullscreen details open unless a literal false is loaded", async () => {
    window.electronAPI.getSettings.mockResolvedValueOnce({
      fullscreenDetailsOpen: "false",
    });
    const setFullscreenDetailsOpen = vi.fn();

    const { result } = renderDefaultLifecycle({ setFullscreenDetailsOpen });

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(setFullscreenDetailsOpen).toHaveBeenCalledWith(false);
  });

  it("treats only a literal true fullscreen audio setting as enabled", async () => {
    window.electronAPI.getSettings.mockResolvedValueOnce({
      fullscreenAudioEnabled: "true",
    });
    const setFullscreenAudioEnabled = vi.fn();

    const { result } = renderDefaultLifecycle({ setFullscreenAudioEnabled });

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(setFullscreenAudioEnabled).toHaveBeenCalledWith(false);
  });

  it("allows only the docked metadata inspector mode", async () => {
    window.electronAPI.getSettings.mockResolvedValueOnce({
      metadataInspectorMode: "detached-window",
    });
    const setMetadataInspectorMode = vi.fn();

    const { result } = renderDefaultLifecycle({ setMetadataInspectorMode });

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(setMetadataInspectorMode).toHaveBeenCalledWith("floating");
  });

  it("handles folder selection lifecycle", async () => {
    const resetMediaScheduler = vi.fn();
    const resetThumbnailGeneration = vi.fn();
    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        setHoverAudioEnabled: vi.fn(),
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
        resetMediaScheduler,
        resetThumbnailGeneration,
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
    expect(resetMediaScheduler).toHaveBeenCalledOnce();
    expect(resetThumbnailGeneration).toHaveBeenCalledOnce();
    expect(resetMediaScheduler.mock.invocationCallOrder[0]).toBeLessThan(
      selection.clear.mock.invocationCallOrder[0]
    );
    expect(resetThumbnailGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      selection.clear.mock.invocationCallOrder[0]
    );
    expect(window.electronAPI.readDirectory).toHaveBeenCalledWith(
      "/videos",
      false,
      expect.stringMatching(/^directory-scan-/),
      { streamRecords: true }
    );
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/videos",
      false,
      expect.objectContaining({
        scanId: expect.stringMatching(/^directory-scan-/),
        bufferInitialEvents: true,
      })
    );
    expect(refreshTagList).toHaveBeenCalled();
    expect(addRecentFolder).toHaveBeenCalledWith("/videos");
    expect(result.current.isLoadingFolder).toBe(false);
  });

  it("shows an indexed folder immediately while its filesystem refresh continues", async () => {
    let resolveRefresh;
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      async (folderPath, recursive, scanId) => ({
        cached: true,
        refreshing: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [
          { relativePath: "", present: true, presentCount: 1 },
        ],
        files: [
          {
            id: "/large/cached.mp4",
            name: "cached.mp4",
            basename: "cached.mp4",
            fullPath: "/large/cached.mp4",
            tags: ["cached"],
          },
        ],
      })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/large");
    });

    await waitFor(() =>
      expect(result.current.videos.map((video) => video.name)).toEqual([
        "cached.mp4",
      ])
    );
    const scanId = window.electronAPI.readDirectory.mock.calls[0][2];
    expect(window.electronAPI.readDirectoryCache).toHaveBeenCalledWith(
      "/large",
      true,
      scanId,
      { limit: CACHED_FIRST_GRID_LIMIT }
    );
    expect(result.current.isLoadingFolder).toBe(false);
    expect(result.current.isRefreshingFolder).toBe(true);
    expect(result.current.libraryRoot).toMatchObject({
      rootPath: "/large",
      refreshState: "refreshing",
    });
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/large",
      true,
      expect.objectContaining({ bufferInitialEvents: true })
    );

    await act(async () => {
      resolveRefresh({
        scanId,
        root: { rootPath: "/large", refreshState: "idle" },
        directories: [
          { relativePath: "", present: true, presentCount: 1 },
        ],
        files: [
          {
            id: "/large/current.mp4",
            name: "current.mp4",
            basename: "current.mp4",
            fullPath: "/large/current.mp4",
            tags: [],
          },
        ],
      });
      await loadPromise;
    });

    expect(result.current.videos.map((video) => video.name)).toEqual([
      "current.mp4",
    ]);
    expect(result.current.isRefreshingFolder).toBe(false);
    expect(result.current.libraryRoot.refreshState).toBe("idle");
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/large",
      true,
      expect.objectContaining({ bufferInitialEvents: true })
    );
  });

  it("marks a small cached collection complete only after its first grid commits", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 13));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let resolveRefresh;
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      async (folderPath, _recursive, scanId) => ({
        cached: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [],
        totalRecordCount: 1,
        files: [
          {
            id: "/small/cached.mp4",
            name: "cached.mp4",
            basename: "cached.mp4",
            fullPath: "/small/cached.mp4",
            tags: [],
          },
        ],
      })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/small");
    });
    await waitFor(() => expect(result.current.videos).toHaveLength(1));

    const scanId = result.current.activeScanId;
    expect(result.current.cachedHydration).toMatchObject({
      scanId,
      phase: "preview",
      recordCount: 1,
      totalRecordCount: 1,
    });
    expect(result.current.cachedHydrationComplete).toBe(false);
    expect(window.electronAPI.readDirectoryCache).toHaveBeenCalledTimes(1);

    act(() => {
      expect(result.current.promoteCachedPreview(scanId)).toBe(true);
    });
    expect(result.current.cachedHydration).toMatchObject({
      scanId,
      phase: "complete",
      recordCount: 1,
      totalRecordCount: 1,
    });
    expect(result.current.cachedHydrationComplete).toBe(true);
    expect(result.current.promoteCachedPreview(scanId)).toBe(false);
    expect(window.electronAPI.readDirectoryCache).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(13);

    await act(async () => {
      resolveRefresh({
        scanId,
        root: { rootPath: "/small", refreshState: "idle" },
        directories: [],
        files: [
          {
            id: "/small/cached.mp4",
            name: "cached.mp4",
            basename: "cached.mp4",
            fullPath: "/small/cached.mp4",
            tags: [],
          },
        ],
      });
      await loadPromise;
    });
  });

  it("promotes a bounded cached first grid to the complete active collection", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 11));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let resolveWatcher;
    let resolveRefresh;
    const cachedFiles = Array.from(
      { length: CACHED_FIRST_GRID_LIMIT + 2 },
      (_, index) => ({
        id: `/large/clip-${index}.mp4`,
        fullPath: `/large/clip-${index}.mp4`,
        name: `clip-${index}.mp4`,
        basename: `clip-${index}.mp4`,
        tags: [],
      })
    );
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      async (folderPath, _recursive, scanId) => ({
        cached: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [],
        files: cachedFiles,
      })
    );
    window.electronAPI.startFolderWatch.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveWatcher = resolve;
      })
    );
    window.electronAPI.readDirectory.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/large");
    });
    await waitFor(() =>
      expect(result.current.videos).toHaveLength(CACHED_FIRST_GRID_LIMIT)
    );
    const scanId = result.current.activeScanId;

    act(() => {
      directoryScanRecordsHandler?.({
        scanId,
        sequence: 1,
        kind: "enumeration",
        records: [
          {
            ...cachedFiles[0],
            name: "updated-before-promotion.mp4",
            basename: "updated-before-promotion.mp4",
          },
          {
            id: "/large/discovered-before-promotion.mp4",
            fullPath: "/large/discovered-before-promotion.mp4",
            name: "discovered-before-promotion.mp4",
            basename: "discovered-before-promotion.mp4",
            tags: [],
          },
        ],
      });
    });
    expect(result.current.videos).toHaveLength(CACHED_FIRST_GRID_LIMIT);

    act(() => {
      expect(result.current.promoteCachedPreview(scanId)).toBe(true);
    });
    expect(result.current.videos).toHaveLength(cachedFiles.length + 1);
    expect(
      result.current.videos.find((video) => video.id === cachedFiles[0].id)?.name
    ).toBe("updated-before-promotion.mp4");
    expect(
      result.current.videos.some(
        (video) => video.id === "/large/discovered-before-promotion.mp4"
      )
    ).toBe(true);
    expect(result.current.promoteCachedPreview(scanId)).toBe(false);

    await act(async () => {
      resolveWatcher({ success: true });
    });
    await waitFor(() =>
      expect(window.electronAPI.readDirectory).toHaveBeenCalledOnce()
    );
    await act(async () => {
      resolveRefresh({
        scanId,
        files: cachedFiles,
        root: { rootPath: "/large", refreshState: "idle" },
        directories: [],
      });
      await loadPromise;
    });
    expect(result.current.videos).toHaveLength(cachedFiles.length);
  });

  it("promotes the complete indexed collection when the user cancels refresh", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 17));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let resolveRefresh;
    const cachedFiles = Array.from(
      { length: CACHED_FIRST_GRID_LIMIT + 2 },
      (_, index) => ({
        id: `/large/clip-${index}.mp4`,
        fullPath: `/large/clip-${index}.mp4`,
        name: `clip-${index}.mp4`,
        basename: `clip-${index}.mp4`,
        tags: [],
      })
    );
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      async (folderPath, _recursive, scanId) => ({
        cached: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [],
        files: cachedFiles,
      })
    );
    window.electronAPI.readDirectory.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/large");
    });
    await waitFor(() =>
      expect(result.current.videos).toHaveLength(CACHED_FIRST_GRID_LIMIT)
    );

    act(() => {
      result.current.cancelFolderLoad();
    });
    expect(result.current.videos).toHaveLength(cachedFiles.length);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(17);

    await act(async () => {
      resolveRefresh({ cancelled: true });
      await loadPromise;
    });
    expect(result.current.videos).toHaveLength(cachedFiles.length);
  });

  it("hydrates the full cache after first paint without overwriting scan changes", async () => {
    let resolveFullCache;
    let resolveRefresh;
    const cachedFiles = Array.from(
      { length: CACHED_FIRST_GRID_LIMIT + 2 },
      (_, index) => ({
        id: `/bounded/clip-${index}.mp4`,
        fullPath: `/bounded/clip-${index}.mp4`,
        name: `clip-${index}.mp4`,
        basename: `clip-${index}.mp4`,
        tags: [],
      })
    );
    window.electronAPI.readDirectoryCache.mockImplementation(
      async (folderPath, _recursive, scanId, options) => {
        if (options?.limit) {
          return {
            cached: true,
            scanId,
            root: { rootPath: folderPath, refreshState: "refreshing" },
            directories: [],
            totalRecordCount: cachedFiles.length,
            files: cachedFiles.slice(0, CACHED_FIRST_GRID_LIMIT),
          };
        }
        return new Promise((resolve) => {
          resolveFullCache = () =>
            resolve({
              cached: true,
              scanId,
              root: { rootPath: folderPath, refreshState: "refreshing" },
              directories: [],
              totalRecordCount: cachedFiles.length,
              files: cachedFiles,
            });
        });
      }
    );
    window.electronAPI.readDirectory.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/bounded");
    });
    await waitFor(() =>
      expect(result.current.videos).toHaveLength(CACHED_FIRST_GRID_LIMIT)
    );
    expect(result.current.cachedHydration).toMatchObject({
      phase: "preview",
      recordCount: CACHED_FIRST_GRID_LIMIT,
      totalRecordCount: cachedFiles.length,
    });
    const scanId = result.current.activeScanId;

    act(() => {
      expect(result.current.promoteCachedPreview(scanId)).toBe(true);
    });
    await waitFor(() => expect(resolveFullCache).toEqual(expect.any(Function)));
    expect(result.current.cachedHydration.phase).toBe("hydrating");

    act(() => {
      directoryScanRecordsHandler?.({
        scanId,
        sequence: 1,
        kind: "enumeration",
        records: [
          {
            ...cachedFiles[0],
            name: "authoritative-name.mp4",
            basename: "authoritative-name.mp4",
          },
          {
            id: "/bounded/new.mp4",
            fullPath: "/bounded/new.mp4",
            name: "new.mp4",
            basename: "new.mp4",
            tags: [],
          },
        ],
      });
      onFileRemovedHandler?.(cachedFiles[1].id, { scanId });
    });

    await act(async () => {
      resolveFullCache();
    });
    await waitFor(() => expect(result.current.cachedHydrationComplete).toBe(true));
    expect(result.current.cachedHydration.phase).toBe("complete");
    expect(result.current.videos).toHaveLength(cachedFiles.length);
    expect(result.current.videos.some((video) => video.id === cachedFiles[1].id))
      .toBe(false);
    expect(
      result.current.videos.find((video) => video.id === cachedFiles[0].id)?.name
    ).toBe("authoritative-name.mp4");
    expect(result.current.videos.some((video) => video.id === "/bounded/new.mp4"))
      .toBe(true);
    expect(window.electronAPI.readDirectoryCache.mock.calls[1]).toEqual([
      "/bounded",
      true,
      scanId,
    ]);

    act(() => result.current.cancelFolderLoad());
    await act(async () => {
      resolveRefresh({ cancelled: true });
      await loadPromise;
    });
  });

  it("restores the complete cache when authoritative refresh fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cachedFiles = Array.from(
      { length: CACHED_FIRST_GRID_LIMIT + 1 },
      (_, index) => ({
        id: `/failed/clip-${index}.mp4`,
        fullPath: `/failed/clip-${index}.mp4`,
        name: `clip-${index}.mp4`,
        basename: `clip-${index}.mp4`,
        tags: [],
      })
    );
    window.electronAPI.readDirectoryCache.mockImplementation(
      async (folderPath, _recursive, scanId, options) => ({
        cached: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [],
        totalRecordCount: cachedFiles.length,
        files: options?.limit
          ? cachedFiles.slice(0, CACHED_FIRST_GRID_LIMIT)
          : cachedFiles,
      })
    );
    window.electronAPI.readDirectory.mockRejectedValueOnce(
      new Error("temporary filesystem error")
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    await act(async () => {
      await result.current.handleElectronFolderSelection("/failed");
    });

    expect(result.current.videos).toHaveLength(cachedFiles.length);
    expect(result.current.cachedHydrationComplete).toBe(true);
    expect(result.current.cachedHydration.phase).toBe("complete");
    expect(result.current.libraryRoot.refreshState).toBe("error");
    expect(result.current.loadingStatus).toMatchObject({
      phase: "error",
      partialPreview: false,
      error: "temporary filesystem error",
    });
    expect(result.current.loadingStatus.message).toContain("indexed snapshot");
    consoleError.mockRestore();
  });

  it("finishes full cache hydration after explicit cancellation", async () => {
    let resolveFullCache;
    let resolveRefresh;
    const cachedFiles = Array.from(
      { length: CACHED_FIRST_GRID_LIMIT + 1 },
      (_, index) => ({
        id: `/cancelled/clip-${index}.mp4`,
        fullPath: `/cancelled/clip-${index}.mp4`,
        name: `clip-${index}.mp4`,
        basename: `clip-${index}.mp4`,
        tags: [],
      })
    );
    window.electronAPI.readDirectoryCache.mockImplementation(
      async (folderPath, _recursive, scanId, options) => {
        if (options?.limit) {
          return {
            cached: true,
            scanId,
            root: { rootPath: folderPath, refreshState: "refreshing" },
            directories: [],
            totalRecordCount: cachedFiles.length,
            files: cachedFiles.slice(0, CACHED_FIRST_GRID_LIMIT),
          };
        }
        return new Promise((resolve) => {
          resolveFullCache = () =>
            resolve({
              cached: true,
              scanId,
              totalRecordCount: cachedFiles.length,
              files: cachedFiles,
            });
        });
      }
    );
    window.electronAPI.readDirectory.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/cancelled");
    });
    await waitFor(() =>
      expect(result.current.videos).toHaveLength(CACHED_FIRST_GRID_LIMIT)
    );
    const scanId = result.current.activeScanId;

    act(() => result.current.cancelFolderLoad());
    await waitFor(() => expect(resolveFullCache).toEqual(expect.any(Function)));
    expect(result.current.loadingStatus).toMatchObject({
      phase: "cancelled",
      partialPreview: true,
    });
    act(() => {
      onFileRemovedHandler?.(cachedFiles[0].id, { scanId });
    });

    await act(async () => {
      resolveFullCache();
    });
    await waitFor(() => expect(result.current.cachedHydrationComplete).toBe(true));
    expect(result.current.videos).toHaveLength(cachedFiles.length - 1);
    expect(result.current.videos.some((video) => video.id === cachedFiles[0].id))
      .toBe(false);
    expect(result.current.loadingStatus).toMatchObject({
      phase: "cancelled",
      partialPreview: false,
    });
    expect(result.current.loadingStatus.message).toContain("complete indexed");

    await act(async () => {
      resolveRefresh({ cancelled: true });
      await loadPromise;
    });
  });

  it("ignores a full cache response after the root is superseded", async () => {
    let resolveOlderFullCache;
    let resolveOlderRefresh;
    const cachedFiles = Array.from(
      { length: CACHED_FIRST_GRID_LIMIT + 1 },
      (_, index) => ({
        id: `/older/clip-${index}.mp4`,
        fullPath: `/older/clip-${index}.mp4`,
        name: `clip-${index}.mp4`,
        basename: `clip-${index}.mp4`,
        tags: [],
      })
    );
    window.electronAPI.readDirectoryCache.mockImplementation(
      async (folderPath, _recursive, scanId, options) => {
        if (folderPath !== "/older") return null;
        if (options?.limit) {
          return {
            cached: true,
            scanId,
            root: { rootPath: folderPath, refreshState: "refreshing" },
            directories: [],
            totalRecordCount: cachedFiles.length,
            files: cachedFiles.slice(0, CACHED_FIRST_GRID_LIMIT),
          };
        }
        return new Promise((resolve) => {
          resolveOlderFullCache = () =>
            resolve({
              cached: true,
              scanId,
              totalRecordCount: cachedFiles.length,
              files: cachedFiles,
            });
        });
      }
    );
    window.electronAPI.readDirectory.mockImplementation((folderPath) => {
      if (folderPath === "/older") {
        return new Promise((resolve) => {
          resolveOlderRefresh = resolve;
        });
      }
      return Promise.resolve([
        {
          id: "/newer/current.mp4",
          fullPath: "/newer/current.mp4",
          name: "current.mp4",
          basename: "current.mp4",
          tags: [],
        },
      ]);
    });
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let olderLoad;
    act(() => {
      olderLoad = result.current.handleElectronFolderSelection("/older");
    });
    await waitFor(() =>
      expect(result.current.videos).toHaveLength(CACHED_FIRST_GRID_LIMIT)
    );
    const olderScanId = result.current.activeScanId;
    act(() => result.current.promoteCachedPreview(olderScanId));
    await waitFor(() =>
      expect(resolveOlderFullCache).toEqual(expect.any(Function))
    );

    await act(async () => {
      await result.current.handleElectronFolderSelection("/newer");
    });
    expect(result.current.videos.map((video) => video.id)).toEqual([
      "/newer/current.mp4",
    ]);
    expect(result.current.cachedHydration).toMatchObject({
      phase: "authoritative",
      recordCount: 1,
    });

    await act(async () => {
      resolveOlderFullCache();
      await Promise.resolve();
    });
    expect(result.current.videos.map((video) => video.id)).toEqual([
      "/newer/current.mp4",
    ]);

    await act(async () => {
      resolveOlderRefresh({ cancelled: true });
      await olderLoad;
    });
  });

  it("falls back to promoting the cache when no grid milestone can fire", async () => {
    const scheduledFrames = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback) => {
        scheduledFrames.push(callback);
        return scheduledFrames.length;
      })
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let resolveRefresh;
    const cachedFiles = Array.from(
      { length: CACHED_FIRST_GRID_LIMIT + 1 },
      (_, index) => ({
        id: `/filtered/clip-${index}.mp4`,
        fullPath: `/filtered/clip-${index}.mp4`,
        name: `clip-${index}.mp4`,
        basename: `clip-${index}.mp4`,
        tags: [],
      })
    );
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      async (folderPath, _recursive, scanId) => ({
        cached: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [],
        files: cachedFiles,
      })
    );
    window.electronAPI.readDirectory.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/filtered");
    });
    await waitFor(() =>
      expect(result.current.videos).toHaveLength(CACHED_FIRST_GRID_LIMIT)
    );

    act(() => scheduledFrames.shift()?.());
    expect(scheduledFrames).toHaveLength(1);
    act(() => scheduledFrames.shift()?.());
    await waitFor(() =>
      expect(result.current.videos).toHaveLength(cachedFiles.length)
    );

    act(() => result.current.cancelFolderLoad());
    await act(async () => {
      resolveRefresh({ cancelled: true });
      await loadPromise;
    });
  });

  it("cancels an outgoing cached promotion without resurrecting its root", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 23));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let resolveOlderRefresh;
    const cachedFiles = Array.from(
      { length: CACHED_FIRST_GRID_LIMIT + 2 },
      (_, index) => ({
        id: `/older/clip-${index}.mp4`,
        fullPath: `/older/clip-${index}.mp4`,
        name: `clip-${index}.mp4`,
        basename: `clip-${index}.mp4`,
        tags: [],
      })
    );
    window.electronAPI.readDirectoryCache.mockImplementation(
      async (folderPath, _recursive, scanId) =>
        folderPath === "/older"
          ? {
              cached: true,
              scanId,
              root: { rootPath: folderPath, refreshState: "refreshing" },
              directories: [],
              files: cachedFiles,
            }
          : null
    );
    window.electronAPI.readDirectory.mockImplementation((folderPath) => {
      if (folderPath === "/older") {
        return new Promise((resolve) => {
          resolveOlderRefresh = resolve;
        });
      }
      return Promise.resolve([
        {
          id: "/newer/current.mp4",
          fullPath: "/newer/current.mp4",
          name: "current.mp4",
          basename: "current.mp4",
          tags: [],
        },
      ]);
    });
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let olderLoad;
    act(() => {
      olderLoad = result.current.handleElectronFolderSelection("/older");
    });
    await waitFor(() =>
      expect(result.current.videos).toHaveLength(CACHED_FIRST_GRID_LIMIT)
    );
    const olderScanId = result.current.activeScanId;

    await act(async () => {
      await result.current.handleElectronFolderSelection("/newer");
    });
    expect(result.current.videos.map((video) => video.id)).toEqual([
      "/newer/current.mp4",
    ]);
    expect(result.current.promoteCachedPreview(olderScanId)).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(23);

    await act(async () => {
      resolveOlderRefresh({ cancelled: true });
      await olderLoad;
    });
    expect(result.current.videos.map((video) => video.id)).toEqual([
      "/newer/current.mp4",
    ]);
  });

  it("hydrates cache before watcher startup but attaches the watcher before scanning", async () => {
    let resolveCache;
    let resolveWatcher;
    let resolveRefresh;
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      (folderPath, _recursive, scanId) =>
        new Promise((resolve) => {
          resolveCache = () =>
            resolve({
              cached: true,
              scanId,
              root: { rootPath: folderPath, refreshState: "refreshing" },
              directories: [],
              files: [
                {
                  id: `${folderPath}/cached.mp4`,
                  fullPath: `${folderPath}/cached.mp4`,
                  name: "cached.mp4",
                  basename: "cached.mp4",
                  tags: [],
                },
              ],
            });
        })
    );
    window.electronAPI.startFolderWatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWatcher = resolve;
        })
    );
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/large");
    });
    await waitFor(() =>
      expect(window.electronAPI.readDirectoryCache).toHaveBeenCalledOnce()
    );
    expect(window.electronAPI.startFolderWatch).not.toHaveBeenCalled();
    expect(window.electronAPI.readDirectory).not.toHaveBeenCalled();

    await act(async () => {
      resolveCache();
    });
    await waitFor(() =>
      expect(result.current.videos.map((video) => video.name)).toEqual([
        "cached.mp4",
      ])
    );
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledOnce();
    expect(window.electronAPI.readDirectory).not.toHaveBeenCalled();

    await act(async () => {
      resolveWatcher({ success: true });
    });
    await waitFor(() =>
      expect(window.electronAPI.readDirectory).toHaveBeenCalledOnce()
    );
    expect(
      window.electronAPI.readDirectoryCache.mock.invocationCallOrder[0]
    ).toBeLessThan(
      window.electronAPI.startFolderWatch.mock.invocationCallOrder[0]
    );
    expect(
      window.electronAPI.startFolderWatch.mock.invocationCallOrder[0]
    ).toBeLessThan(window.electronAPI.readDirectory.mock.invocationCallOrder[0]);

    const scanId = window.electronAPI.readDirectory.mock.calls[0][2];
    await act(async () => {
      resolveRefresh({
        scanId,
        files: [
          {
            id: "/large/current.mp4",
            fullPath: "/large/current.mp4",
            name: "current.mp4",
            basename: "current.mp4",
            tags: [],
          },
        ],
        root: { rootPath: "/large", refreshState: "idle" },
        directories: [],
      });
      await loadPromise;
    });
    expect(result.current.videos.map((video) => video.name)).toEqual([
      "current.mp4",
    ]);
  });

  it("preserves an indexed media source when enumeration has not enriched it yet", async () => {
    let resolveScan;
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      async (folderPath, _recursive, scanId) => ({
        cached: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [],
        files: [
          {
            id: "/library/cached.mp4",
            instanceId: 17,
            fullPath: "/library/cached.mp4",
            name: "cached.mp4",
            basename: "cached.mp4",
            sourceUrl: "videoswarm-media://instance/17?v=cached&g=1",
            enrichmentState: "ready",
          },
        ],
      })
    );
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        })
    );
    const { result } = renderDefaultLifecycle({ recursiveMode: true });

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/library");
    });
    await waitFor(() =>
      expect(result.current.videos[0]?.sourceUrl).toContain("v=cached")
    );
    const scanId = window.electronAPI.readDirectory.mock.calls[0][2];

    act(() => {
      directoryScanRecordsHandler?.({
        scanId,
        sequence: 1,
        kind: "enumeration",
        records: [
          {
            id: "/library/cached.mp4",
            instanceId: null,
            fullPath: "/library/cached.mp4",
            name: "cached.mp4",
            basename: "cached.mp4",
            sourceUrl: null,
            enrichmentState: "enumerated",
          },
        ],
      });
    });

    expect(result.current.videos[0]).toMatchObject({
      instanceId: 17,
      sourceUrl: "videoswarm-media://instance/17?v=cached&g=1",
      enrichmentState: "ready",
    });

    await act(async () => {
      resolveScan({
        streamed: true,
        scanId,
        recordSequence: 1,
        fileCount: 1,
        root: { rootPath: "/library", refreshState: "idle" },
        directories: [],
      });
      await loadPromise;
    });
  });

  it("renders streamed enumeration records before enrichment and final completion", async () => {
    let resolveScan;
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        })
    );
    const { result } = renderDefaultLifecycle();

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/streamed");
    });
    await waitFor(() =>
      expect(window.electronAPI.readDirectory).toHaveBeenCalledOnce()
    );
    const scanId = window.electronAPI.readDirectory.mock.calls[0][2];

    act(() => {
      directoryScanRecordsHandler?.({
        scanId,
        sequence: 1,
        kind: "enumeration",
        records: [
          {
            id: "/streamed/first.mp4",
            fullPath: "/streamed/first.mp4",
            name: "first.mp4",
            basename: "first.mp4",
            tags: [],
            enrichmentState: "enumerated",
          },
        ],
      });
    });

    expect(result.current.videos).toHaveLength(1);
    expect(result.current.videos[0]).toMatchObject({
      id: "/streamed/first.mp4",
      enrichmentState: "enumerated",
    });
    expect(result.current.isLoadingFolder).toBe(false);
    expect(result.current.isRefreshingFolder).toBe(true);
    expect(result.current.activeScanId).toBe(scanId);

    act(() => {
      result.current.prioritizeActiveDirectoryScan([
        "/streamed/first.mp4",
      ]);
      directoryScanRecordsHandler?.({
        scanId,
        sequence: 2,
        kind: "patch",
        records: [
          {
            id: "/streamed/first.mp4",
            fullPath: "/streamed/first.mp4",
            name: "first.mp4",
            basename: "first.mp4",
            fingerprint: "fp-first",
            tags: ["ready"],
            enrichmentState: "ready",
          },
        ],
      });
    });
    expect(window.electronAPI.prioritizeDirectoryScan).toHaveBeenCalledWith(
      scanId,
      ["/streamed/first.mp4"]
    );
    expect(result.current.videos[0]).toMatchObject({
      fingerprint: "fp-first",
      tags: ["ready"],
      enrichmentState: "ready",
    });
    act(() => {
      directoryScanRecordsHandler?.({
        scanId,
        sequence: 1,
        kind: "patch",
        records: [
          {
            id: "/streamed/first.mp4",
            fingerprint: "stale-fp",
            tags: ["stale"],
          },
        ],
      });
    });
    expect(result.current.videos[0].fingerprint).toBe("fp-first");

    await act(async () => {
      resolveScan({
        streamed: true,
        scanId,
        recordSequence: 2,
        fileCount: 1,
        root: { rootPath: "/streamed", refreshState: "idle" },
        directories: [],
      });
      await loadPromise;
    });
    expect(result.current.videos).toHaveLength(1);
    expect(result.current.isRefreshingFolder).toBe(false);
    expect(result.current.activeScanId).toBe(scanId);
  });

  it("waits for streamed records that arrive after the invoke response", async () => {
    let resolveScan;
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        })
    );
    const { result } = renderDefaultLifecycle();

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/ordered");
    });
    await waitFor(() =>
      expect(window.electronAPI.readDirectory).toHaveBeenCalledOnce()
    );
    const scanId = window.electronAPI.readDirectory.mock.calls[0][2];

    await act(async () => {
      resolveScan({
        streamed: true,
        scanId,
        recordSequence: 1,
        fileCount: 1,
        root: { rootPath: "/ordered", refreshState: "idle" },
        directories: [],
      });
      await Promise.resolve();
    });

    expect(result.current.isLoadingFolder).toBe(true);
    expect(addRecentFolder).not.toHaveBeenCalled();

    await act(async () => {
      directoryScanRecordsHandler?.({
        scanId,
        sequence: 1,
        kind: "enumeration",
        records: [
          {
            id: "/ordered/late.mp4",
            fullPath: "/ordered/late.mp4",
            name: "late.mp4",
            basename: "late.mp4",
            tags: [],
            enrichmentState: "enumerated",
          },
        ],
      });
      await loadPromise;
    });

    expect(result.current.videos.map((video) => video.id)).toEqual([
      "/ordered/late.mp4",
    ]);
    expect(result.current.isLoadingFolder).toBe(false);
    expect(result.current.isRefreshingFolder).toBe(false);
    expect(addRecentFolder).toHaveBeenCalledWith("/ordered");
  });

  it("prunes stale cached records while preserving matching watcher deltas", async () => {
    let resolveScan;
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      async (folderPath, _recursive, scanId) => ({
        cached: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [],
        files: [
          {
            id: "/library/keep.mp4",
            fullPath: "/library/keep.mp4",
            name: "keep.mp4",
            basename: "keep.mp4",
            fingerprint: "cached-fp",
            tags: ["cached"],
          },
          {
            id: "/library/stale.mp4",
            fullPath: "/library/stale.mp4",
            name: "stale.mp4",
            basename: "stale.mp4",
            tags: [],
          },
        ],
      })
    );
    window.electronAPI.readDirectory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        })
    );
    const { result } = renderDefaultLifecycle();

    let loadPromise;
    act(() => {
      loadPromise = result.current.handleElectronFolderSelection("/library");
    });
    await waitFor(() =>
      expect(window.electronAPI.readDirectory).toHaveBeenCalledOnce()
    );
    const scanId = window.electronAPI.readDirectory.mock.calls[0][2];

    act(() => {
      directoryScanRecordsHandler?.({
        scanId,
        sequence: 1,
        kind: "enumeration",
        records: [
          {
            id: "/library/keep.mp4",
            fullPath: "/library/keep.mp4",
            name: "keep.mp4",
            basename: "keep.mp4",
            tags: [],
          },
          {
            id: "/library/removed-during-scan.mp4",
            fullPath: "/library/removed-during-scan.mp4",
            name: "removed-during-scan.mp4",
            basename: "removed-during-scan.mp4",
            tags: [],
          },
        ],
      });
      onFileAddedHandler?.(
        {
          id: "/library/added-during-scan.mp4",
          fullPath: "/library/added-during-scan.mp4",
          name: "added-during-scan.mp4",
          basename: "added-during-scan.mp4",
          tags: [],
        },
        { scanId }
      );
      onFileRemovedHandler?.("/library/removed-during-scan.mp4", { scanId });
    });

    await act(async () => {
      resolveScan({
        streamed: true,
        scanId,
        recordSequence: 1,
        fileCount: 2,
        root: { rootPath: "/library", refreshState: "idle" },
        directories: [],
      });
      await loadPromise;
    });

    expect(result.current.videos.map((video) => video.id).sort()).toEqual([
      "/library/added-during-scan.mp4",
      "/library/keep.mp4",
    ]);
    expect(result.current.videos.find((video) => video.id.endsWith("keep.mp4")))
      .toMatchObject({ fingerprint: "cached-fp", tags: ["cached"] });
  });

  it("ignores a stale cache generation and keeps the normal loading flow", async () => {
    window.electronAPI.readDirectoryCache.mockResolvedValueOnce({
      cached: true,
      scanId: "older-scan",
      files: [{ id: "stale", name: "stale", basename: "stale", tags: [] }],
    });
    const { result } = renderDefaultLifecycle();

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });

    expect(result.current.videos.map((video) => video.name)).toEqual(["file1"]);
    expect(result.current.isRefreshingFolder).toBe(false);
  });

  it("does not start an authoritative scan after a superseded cache read rejects", async () => {
    let rejectFirstCache;
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.electronAPI.readDirectoryCache
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirstCache = reject;
          })
      )
      .mockResolvedValueOnce(null);
    const { result } = renderDefaultLifecycle();

    let firstLoad;
    act(() => {
      firstLoad = result.current.handleElectronFolderSelection("/older");
    });
    await waitFor(() => expect(rejectFirstCache).toEqual(expect.any(Function)));

    await act(async () => {
      await result.current.handleElectronFolderSelection("/newer");
    });
    await act(async () => {
      rejectFirstCache(new Error("older cache failed"));
      await firstLoad;
    });

    expect(window.electronAPI.readDirectory).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.readDirectory.mock.calls[0][0]).toBe("/newer");
    expect(
      window.electronAPI.startFolderWatch.mock.calls.map(([folderPath]) => folderPath)
    ).toEqual(["/newer"]);
    consoleWarn.mockRestore();
  });

  it("does not scan a superseded folder when its watcher startup resolves late", async () => {
    let resolveOlderWatcher;
    window.electronAPI.startFolderWatch.mockImplementation((folderPath) => {
      if (folderPath === "/older") {
        return new Promise((resolve) => {
          resolveOlderWatcher = resolve;
        });
      }
      return Promise.resolve({ success: true });
    });
    const { result } = renderDefaultLifecycle();

    let olderLoad;
    act(() => {
      olderLoad = result.current.handleElectronFolderSelection("/older");
    });
    await waitFor(() =>
      expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
        "/older",
        false,
        expect.objectContaining({ bufferInitialEvents: true })
      )
    );

    await act(async () => {
      await result.current.handleElectronFolderSelection("/newer");
    });
    await act(async () => {
      resolveOlderWatcher({ success: true });
      await olderLoad;
    });

    expect(
      window.electronAPI.readDirectory.mock.calls.map(([folderPath]) => folderPath)
    ).toEqual(["/newer"]);
    expect(result.current.videos.map((video) => video.name)).toEqual(["file1"]);
    expect(addRecentFolder).toHaveBeenCalledTimes(1);
    expect(addRecentFolder).toHaveBeenCalledWith("/newer");
  });

  it("keeps an indexed preview usable when background validation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    window.electronAPI.readDirectoryCache.mockImplementationOnce(
      async (folderPath, _recursive, scanId) => ({
        cached: true,
        scanId,
        root: { rootPath: folderPath, refreshState: "refreshing" },
        directories: [],
        files: [
          {
            id: "/large/cached.mp4",
            name: "cached.mp4",
            basename: "cached.mp4",
            tags: [],
          },
        ],
      })
    );
    window.electronAPI.readDirectory.mockRejectedValueOnce(
      new Error("temporary filesystem error")
    );
    const { result } = renderDefaultLifecycle();

    await act(async () => {
      await result.current.handleElectronFolderSelection("/large");
    });

    expect(result.current.videos.map((video) => video.name)).toEqual([
      "cached.mp4",
    ]);
    expect(result.current.libraryRoot.refreshState).toBe("error");
    expect(result.current.isLoadingFolder).toBe(false);
    expect(result.current.isRefreshingFolder).toBe(false);
    expect(result.current.loadingStatus).toMatchObject({
      phase: "error",
      error: "temporary filesystem error",
    });
    consoleError.mockRestore();
  });

  it("keeps an empty indexed folder open with its directory tree", async () => {
    window.electronAPI.readDirectory.mockResolvedValueOnce({
      files: [],
      root: { rootPath: "/empty", presentCount: 0, pinned: false },
      directories: [
        { relativePath: "", name: "empty", present: true, presentCount: 0 },
        { relativePath: "batch", name: "batch", present: true, presentCount: 0 },
      ],
      scanId: "native-scan",
    });
    const { result } = renderDefaultLifecycle();

    await act(async () => {
      await result.current.handleElectronFolderSelection("/empty");
    });

    expect(result.current.videos).toEqual([]);
    expect(result.current.activeRootPath).toBe("/empty");
    expect(result.current.libraryRoot).toMatchObject({
      rootPath: "/empty",
      presentCount: 0,
    });
    expect(result.current.directorySummaries).toHaveLength(2);
    expect(result.current.isLoadingFolder).toBe(false);
    expect(addRecentFolder).toHaveBeenCalledWith("/empty");
  });

  it("reloads the active root with an explicit recursive override", async () => {
    const { result } = renderDefaultLifecycle({ recursiveMode: false });

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });
    window.electronAPI.readDirectory.mockClear();
    window.electronAPI.startFolderWatch.mockClear();

    await act(async () => {
      await result.current.reloadCurrentRoot(true);
    });

    expect(window.electronAPI.readDirectory).toHaveBeenCalledWith(
      "/videos",
      true,
      expect.stringMatching(/^directory-scan-/),
      { streamRecords: true }
    );
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/videos",
      true,
      expect.objectContaining({ bufferInitialEvents: true })
    );
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
        setHoverAudioEnabled: vi.fn(),
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
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/slow",
      false,
      expect.objectContaining({ bufferInitialEvents: true })
    );
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
    expect(window.electronAPI.onDirectoryScanRecords).toHaveBeenCalledOnce();

    unmount();
    expect(disposeDirectoryScanProgress).toHaveBeenCalledOnce();
    expect(disposeDirectoryScanRecords).toHaveBeenCalledOnce();
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
        setHoverAudioEnabled: vi.fn(),
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
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledTimes(2);
    expect(window.electronAPI.startFolderWatch).toHaveBeenCalledWith(
      "/second",
      false,
      expect.objectContaining({ bufferInitialEvents: true })
    );
    expect(addRecentFolder).toHaveBeenCalledTimes(1);
    expect(addRecentFolder).toHaveBeenCalledWith("/second");
  });

  it("propagates watcher events into local state", async () => {
    const beforeFileRemoved = vi.fn();
    const { result, unmount } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        setHoverAudioEnabled: vi.fn(),
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
        beforeFileRemoved,
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
    expect(beforeFileRemoved).toHaveBeenCalledWith("file1");
    expect(beforeFileRemoved.mock.invocationCallOrder[0]).toBeLessThan(
      selection.setSelected.mock.invocationCallOrder.at(-1)
    );
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
          setHoverAudioEnabled: vi.fn(),
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
        setHoverAudioEnabled: vi.fn(),
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

  // A tag view is the only collection that belongs to no root, so the chrome
  // that describes a root has to be cleared rather than left pointing at a
  // folder the visible clips may not live in.
  it("adopts a rootless tag collection and clears the folder it came from", async () => {
    const { result } = renderHook(() =>
      useElectronFolderLifecycle({
        selection,
        recursiveMode: false,
        setRecursiveMode: vi.fn(),
        setShowFilenames: vi.fn(),
        setHoverAudioEnabled: vi.fn(),
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

    const records = [
      {
        id: "/roots/a/2026-08-09/clip.mp4",
        instanceId: 11,
        rootPath: "/roots/a",
        sourceUrl: "videoswarm-media://instance/11?v=2048-2000&g=1",
        name: "clip.mp4",
        relativePath: "2026-08-09/clip.mp4",
        dirname: "2026-08-09",
        size: 2048,
        dateModified: new Date(2_000),
        isElectronFile: true,
        tags: ["keeper"],
      },
      {
        id: "/roots/b/2026-08-09/clip.mp4",
        instanceId: 12,
        rootPath: "/roots/b",
        sourceUrl: "videoswarm-media://instance/12?v=4096-3000&g=1",
        name: "clip.mp4",
        relativePath: "2026-08-09/clip.mp4",
        dirname: "2026-08-09",
        size: 4096,
        dateModified: new Date(3_000),
        isElectronFile: true,
        tags: ["keeper"],
      },
    ];

    act(() => {
      result.current.openTagCollection({
        tags: ["keeper"],
        matchMode: "all",
        records,
      });
    });

    expect(result.current.videos).toHaveLength(2);
    // Clips from two roots coexist, which is the whole point of the view.
    expect(result.current.videos.map((video) => video.rootPath)).toEqual([
      "/roots/a",
      "/roots/b",
    ]);
    expect(result.current.activeRootPath).toBeNull();
    expect(result.current.libraryRoot).toBeNull();
    expect(result.current.directorySummaries).toEqual([]);
    expect(result.current.tagCollection).toMatchObject({
      tags: ["keeper"],
      matchMode: "all",
      truncated: false,
    });

    // The name comparator dereferences `basename`, which only normalization
    // derives from `name`. Adopting records raw threw here and took the whole
    // renderer down with it.
    expect(result.current.videos.map((video) => video.basename)).toEqual([
      "clip.mp4",
      "clip.mp4",
    ]);
    expect(() =>
      groupAndSort(result.current.videos, {
        groupByFolders: true,
        comparator: buildComparator({ sortKey: SortKey.NAME, sortDir: "asc" }),
      })
    ).not.toThrow();
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
          setHoverAudioEnabled: vi.fn(),
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
      false,
      expect.objectContaining({ bufferInitialEvents: true })
    );

    window.electronAPI.startFolderWatch.mockClear();

    rerender({ recursiveMode: true });

    await act(async () => {
      await result.current.handleElectronFolderSelection("/videos");
    });

    expect(window.electronAPI.startFolderWatch).toHaveBeenLastCalledWith(
      "/videos",
      true,
      expect.objectContaining({ bufferInitialEvents: true })
    );
  });
});
