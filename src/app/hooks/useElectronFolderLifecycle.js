import { useState, useCallback, useEffect, useRef } from "react";
import { normalizeVideoFromMain } from "../videoNormalization";
import {
  clampRenderLimitStep,
  inferRenderLimitStepFromLegacy,
} from "../../utils/renderLimit";
import {
  EMPTY_SCAN_LOADING_STATUS,
  createScanLoadingStatus,
  getLoadingProgressPercent,
  mergeScanLoadingProgress,
} from "../loading/scanLoadingStatus";
import { normalizePlaybackMode } from "../../playback/playbackPolicy";

const __DEV__ = import.meta.env.MODE !== "production";
let directoryScanSequence = 0;

export function useElectronFolderLifecycle({
  selection,
  recursiveMode,
  setRecursiveMode,
  setShowFilenames,
  renderLimitStep,
  setRenderLimitStep,
  setSortKey,
  setSortDir,
  groupByFolders,
  setGroupByFolders,
  setRandomSeed,
  setPlaybackMode,
  setProxyPlaybackEnabled,
  setZoomLevelFromSettings,
  setVisibleVideos,
  setLoadedVideos,
  setLoadingVideos,
  setActualPlaying,
  resetMediaScheduler,
  resetThumbnailGeneration,
  refreshTagList,
  addRecentFolder,
  beforeExternalFolderSelection,
}) {
  const [videos, setVideos] = useState([]);
  const [activeRootPath, setActiveRootPath] = useState(null);
  const [libraryRoot, setLibraryRoot] = useState(null);
  const [directorySummaries, setDirectorySummaries] = useState([]);
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [isRefreshingFolder, setIsRefreshingFolder] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(
    EMPTY_SCAN_LOADING_STATUS
  );
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const activeFolderScanRef = useRef(null);
  const mountedRef = useRef(true);
  const {
    clear: clearSelection,
    setSelected: setSelection,
    remove: removeSelection,
  } = selection;
  const setterRefs = useRef({
    setRecursiveMode,
    setShowFilenames,
    setRenderLimitStep,
    setSortKey,
    setSortDir,
    setGroupByFolders,
    setRandomSeed,
    setPlaybackMode,
    setProxyPlaybackEnabled,
    setZoomLevelFromSettings,
  });

  useEffect(() => {
    setterRefs.current = {
      setRecursiveMode,
      setShowFilenames,
      setRenderLimitStep,
      setSortKey,
      setSortDir,
      setGroupByFolders,
      setRandomSeed,
      setPlaybackMode,
      setProxyPlaybackEnabled,
      setZoomLevelFromSettings,
    };
  }, [
    setRecursiveMode,
    setShowFilenames,
    setRenderLimitStep,
    setSortKey,
    setSortDir,
    setGroupByFolders,
    setRandomSeed,
    setPlaybackMode,
    setProxyPlaybackEnabled,
    setZoomLevelFromSettings,
  ]);

  const resetDerivedVideoState = useCallback(() => {
    resetMediaScheduler?.();
    resetThumbnailGeneration?.();
    clearSelection();
    setVisibleVideos(new Set());
    setLoadedVideos(new Set());
    setLoadingVideos(new Set());
    setActualPlaying(new Set());
  }, [
    clearSelection,
    resetMediaScheduler,
    resetThumbnailGeneration,
    setActualPlaying,
    setLoadedVideos,
    setLoadingVideos,
    setVisibleVideos,
  ]);

  const cancelActiveFolderScan = useCallback((updateLoadingState = true) => {
    const scan = activeFolderScanRef.current;
    if (!scan) {
      if (updateLoadingState && mountedRef.current) {
        setIsLoadingFolder(false);
        setIsRefreshingFolder(false);
        setLoadingStatus(EMPTY_SCAN_LOADING_STATUS);
      }
      return false;
    }

    scan.cancelled = true;
    activeFolderScanRef.current = null;

    try {
      const cancellation = window.electronAPI?.cancelDirectoryScan?.(scan.id);
      cancellation?.catch?.(() => {});
    } catch {}

    if (updateLoadingState && mountedRef.current) {
      setLoadingStatus((previous) => ({
        ...previous,
        phase: "cancelled",
        message: "Scan cancelled",
        updatedAt: Date.now(),
      }));
      setIsLoadingFolder(false);
      setIsRefreshingFolder(false);
    }
    return true;
  }, []);

  const cancelFolderLoad = useCallback(() => {
    cancelActiveFolderScan(true);
  }, [cancelActiveFolderScan]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelActiveFolderScan(false);
    };
  }, [cancelActiveFolderScan]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onDirectoryScanProgress?.(
      (payload) => {
        const scan = activeFolderScanRef.current;
        if (
          !mountedRef.current ||
          !scan ||
          scan.cancelled ||
          !payload ||
          payload.scanId !== scan.id
        ) {
          return;
        }

        const sequence = Number(payload.sequence);
        if (Number.isFinite(sequence)) {
          if (sequence <= scan.lastProgressSequence) return;
          scan.lastProgressSequence = sequence;
        }

        setLoadingStatus((previous) =>
          mergeScanLoadingProgress(previous, payload)
        );
      }
    );

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  const handleElectronFolderSelection = useCallback(
    async (folderPath, options = {}) => {
      const api = window.electronAPI;
      if (!api?.readDirectory) return;
      const scanRecursive =
        typeof options?.recursive === "boolean"
          ? options.recursive
          : recursiveMode;

      cancelActiveFolderScan(false);
      const scan = {
        id: `directory-scan-${Date.now()}-${++directoryScanSequence}`,
        cancelled: false,
        lastProgressSequence: -1,
      };
      activeFolderScanRef.current = scan;
      const isCurrentScan = () =>
        mountedRef.current &&
        !scan.cancelled &&
        activeFolderScanRef.current === scan;
      let cachedPreviewApplied = false;

      try {
        const startedAt = Date.now();
        setIsLoadingFolder(true);
        setIsRefreshingFolder(false);
        setLoadingStatus(
          createScanLoadingStatus({
            scanId: scan.id,
            rootPath: folderPath,
            recursive: scanRecursive,
            startedAt,
          })
        );

        await api.stopFolderWatch?.();
        if (!isCurrentScan()) return;

        setActiveRootPath(folderPath);
        setVideos([]);
        resetDerivedVideoState();

        if (typeof api.readDirectoryCache === "function") {
          try {
            const cachedResult = await api.readDirectoryCache(
              folderPath,
              scanRecursive,
              scan.id
            );
            if (!isCurrentScan()) return;
            if (
              cachedResult?.cached === true &&
              cachedResult.scanId === scan.id &&
              Array.isArray(cachedResult.files)
            ) {
              const cachedFiles = cachedResult.files.map((file) =>
                normalizeVideoFromMain(file)
              );
              setVideos(cachedFiles);
              setActiveRootPath(cachedResult.root?.rootPath || folderPath);
              setLibraryRoot(
                cachedResult.root || {
                  rootPath: folderPath,
                  refreshState: "refreshing",
                }
              );
              setDirectorySummaries(
                Array.isArray(cachedResult.directories)
                  ? cachedResult.directories
                  : []
              );
              setLoadingStatus((previous) => ({
                ...previous,
                phase: "refreshing",
                message: "Showing indexed videos while checking the folder",
                videosDiscovered: cachedFiles.length,
                prepared: cachedFiles.length,
                updatedAt: Date.now(),
              }));
              cachedPreviewApplied = true;
              setIsLoadingFolder(false);
              setIsRefreshingFolder(true);
            }
          } catch (cacheError) {
            // The filesystem scan remains authoritative. A missing, old, or
            // temporarily unreadable cache must never prevent a normal open.
            console.warn("Failed to hydrate indexed folder preview:", cacheError);
          }
        }
        if (!isCurrentScan()) return;

        setLoadingStatus((previous) => ({
          ...previous,
          phase: "enumerating",
          message: cachedPreviewApplied
            ? "Refreshing indexed videos"
            : "Discovering video files",
          updatedAt: Date.now(),
        }));

        const result = await api.readDirectory(
          folderPath,
          scanRecursive,
          scan.id
        );
        if (!isCurrentScan()) return;

        if (result?.cancelled) {
          activeFolderScanRef.current = null;
          setLoadingStatus((previous) => ({
            ...previous,
            phase: "cancelled",
            message: "Scan cancelled",
            updatedAt: Date.now(),
          }));
          setIsLoadingFolder(false);
          setIsRefreshingFolder(false);
          return;
        }

        const files = Array.isArray(result)
          ? result
          : Array.isArray(result?.files)
            ? result.files
            : [];
        const normalizedFiles = files.map((file) => normalizeVideoFromMain(file));
        const nextRoot =
          result && !Array.isArray(result) && result.root
            ? result.root
            : { rootPath: folderPath };
        const nextDirectories =
          result && !Array.isArray(result) && Array.isArray(result.directories)
            ? result.directories
            : [];

        setLoadingStatus((previous) => ({
          ...previous,
          phase: "finalizing",
          message: "Preparing the video grid",
          videosDiscovered: Math.max(
            previous.videosDiscovered || 0,
            files.length
          ),
          prepared: files.length,
          completed: files.length,
          total: files.length,
          updatedAt: Date.now(),
        }));

        setVideos(normalizedFiles);
        setActiveRootPath(nextRoot.rootPath || folderPath);
        setLibraryRoot(nextRoot);
        setDirectorySummaries(nextDirectories);

        setLoadingStatus((previous) => ({
          ...previous,
          phase: "complete",
          message: "Collection ready",
          updatedAt: Date.now(),
        }));
        setIsLoadingFolder(false);
        setIsRefreshingFolder(false);

        refreshTagList();

        let watchResult = null;
        try {
          watchResult = await api.startFolderWatch?.(
            folderPath,
            scanRecursive
          );
        } catch (watchError) {
          console.warn("Failed to start folder watcher:", watchError);
        }
        if (!isCurrentScan()) return;
        if (watchResult?.success && __DEV__) {
          console.log("👁️ watching folder");
        }

        addRecentFolder(folderPath);
        if (activeFolderScanRef.current === scan) {
          activeFolderScanRef.current = null;
        }
      } catch (error) {
        if (!isCurrentScan()) return;
        console.error("Error reading directory:", error);
        activeFolderScanRef.current = null;
        setLoadingStatus((previous) => ({
          ...previous,
          phase: "error",
          message: "Couldn’t open this collection",
          error: error?.message || "The folder could not be read.",
          updatedAt: Date.now(),
        }));
        setLibraryRoot((previous) =>
          cachedPreviewApplied && previous
            ? { ...previous, refreshState: "error" }
            : previous
        );
        setIsLoadingFolder(!cachedPreviewApplied);
        setIsRefreshingFolder(false);
      }
    },
    [
      addRecentFolder,
      cancelActiveFolderScan,
      recursiveMode,
      refreshTagList,
      resetDerivedVideoState,
    ]
  );

  const reloadCurrentRoot = useCallback(
    async (recursiveOverride = recursiveMode) => {
      if (!activeRootPath) return false;
      await handleElectronFolderSelection(activeRootPath, {
        recursive: Boolean(recursiveOverride),
      });
      return true;
    }, [activeRootPath, handleElectronFolderSelection, recursiveMode]
  );

  const handleFolderSelect = useCallback(async () => {
    const res = await window.electronAPI?.selectFolder?.();
    if (res?.folderPath) {
      await handleElectronFolderSelection(res.folderPath);
    }
  }, [handleElectronFolderSelection]);

  const handleWebFileSelection = useCallback(
    (event) => {
      cancelActiveFolderScan(true);
      const files = Array.from(event.target.files || []).filter((f) => {
        const isVideoType = f.type.startsWith("video/");
        const hasExt = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ogv)$/i.test(
          f.name
        );
        return isVideoType || hasExt;
      });

      const list = files.map((f) => ({
        id: f.name + f.size,
        name: f.name,
        file: f,
        loaded: false,
        isElectronFile: false,
        basename: f.name,
        dirname: "",
        createdMs: f.lastModified || 0,
        fingerprint: null,
        tags: [],
        rating: null,
      }));

      setVideos(list);
      setActiveRootPath(null);
      setLibraryRoot(null);
      setDirectorySummaries([]);
      resetDerivedVideoState();
    },
    [cancelActiveFolderScan, resetDerivedVideoState]
  );

  const applySettingsFromMain = useCallback((settings) => {
    if (!settings) return;
    const {
      setRecursiveMode: applyRecursiveMode,
      setShowFilenames: applyShowFilenames,
      setRenderLimitStep: applyRenderLimitStep,
      setSortKey: applySortKey,
      setSortDir: applySortDir,
      setGroupByFolders: applyGroupByFolders,
      setRandomSeed: applyRandomSeed,
      setPlaybackMode: applyPlaybackMode,
      setProxyPlaybackEnabled: applyProxyPlaybackEnabled,
      setZoomLevelFromSettings: applyZoomLevelFromSettings,
    } = setterRefs.current;

    if (settings.recursiveMode !== undefined)
      applyRecursiveMode(settings.recursiveMode);
    if (settings.showFilenames !== undefined)
      applyShowFilenames(settings.showFilenames);
    if (settings.renderLimitStep !== undefined) {
      applyRenderLimitStep(clampRenderLimitStep(settings.renderLimitStep));
    } else if (settings.maxConcurrentPlaying !== undefined) {
      applyRenderLimitStep(
        clampRenderLimitStep(
          inferRenderLimitStepFromLegacy(settings.maxConcurrentPlaying)
        )
      );
    }
    if (settings.zoomLevel !== undefined)
      applyZoomLevelFromSettings(settings.zoomLevel);
    if (settings.sortKey) applySortKey(settings.sortKey);
    if (settings.sortDir) applySortDir(settings.sortDir);
    if (settings.groupByFolders !== undefined)
      applyGroupByFolders(settings.groupByFolders);
    if (settings.randomSeed !== undefined)
      applyRandomSeed(settings.randomSeed);
    if (settings.playbackMode !== undefined) {
      applyPlaybackMode?.(normalizePlaybackMode(settings.playbackMode));
    }
    if (settings.proxyPlaybackEnabled !== undefined) {
      applyProxyPlaybackEnabled?.(Boolean(settings.proxyPlaybackEnabled));
    }
  }, []);

  const loadSettingsFromMain = useCallback(
    async (settingsOverride = null) => {
      const api = window.electronAPI;
      if (!api?.getSettings) {
        setSettingsLoaded(true);
        return;
      }

      try {
        const settings =
          settingsOverride !== null && settingsOverride !== undefined
            ? settingsOverride
            : await api.getSettings();
        applySettingsFromMain(settings);
      } catch (error) {
        console.error("Failed to load settings", error);
      }

      setSettingsLoaded(true);
    },
    [applySettingsFromMain]
  );

  useEffect(() => {
    loadSettingsFromMain();
  }, [loadSettingsFromMain]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onFolderSelected?.(async (folderPath) => {
      beforeExternalFolderSelection?.(folderPath);
      await handleElectronFolderSelection(folderPath);
    });

    return () => {
      if (typeof cleanup === "function") {
        cleanup();
      }
    };
  }, [beforeExternalFolderSelection, handleElectronFolderSelection]);

  useEffect(() => {
    const profilesApi = window.electronAPI?.profiles;
    if (!profilesApi?.onChanged) return undefined;

    const unsubscribe = profilesApi.onChanged?.((payload) => {
      cancelActiveFolderScan(true);
      try {
        const stopPromise = window.electronAPI?.stopFolderWatch?.();
        if (stopPromise?.catch) {
          stopPromise.catch(() => {});
        }
      } catch {}
      setVideos([]);
      setActiveRootPath(null);
      setLibraryRoot(null);
      setDirectorySummaries([]);
      resetDerivedVideoState();
      setSettingsLoaded(false);
      loadSettingsFromMain(payload?.settings);
      refreshTagList();
    });

    return () => unsubscribe?.();
  }, [
    cancelActiveFolderScan,
    loadSettingsFromMain,
    refreshTagList,
    resetDerivedVideoState,
    setVideos,
  ]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return undefined;

    const handleFileAdded = (videoFile) => {
      const normalized = normalizeVideoFromMain(videoFile);
      setVideos((prev) => {
        const existingIndex = prev.findIndex((v) => v.id === normalized.id);
        if (existingIndex !== -1) {
          const next = prev.slice();
          next[existingIndex] = normalized;
          return next;
        }
        return [...prev, normalized].sort((a, b) =>
          a.basename.localeCompare(b.basename, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        );
      });
      if (normalized.tags.length) {
        refreshTagList();
      }
    };

    const handleFileRemoved = (filePath) => {
      setVideos((prev) => prev.filter((v) => v.id !== filePath));
      if (typeof removeSelection === "function") {
        removeSelection(filePath);
      } else {
        setSelection((prev) => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
      }
      setActualPlaying((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      setLoadedVideos((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      setLoadingVideos((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      setVisibleVideos((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      refreshTagList();
    };

    const handleFileChanged = (videoFile) => {
      const normalized = normalizeVideoFromMain(videoFile);
      setVideos((prev) =>
        prev.map((v) => (v.id === normalized.id ? normalized : v))
      );
      if (normalized.tags.length) {
        refreshTagList();
      }
    };

    const disposeAdded = api.onFileAdded?.(handleFileAdded);
    const disposeRemoved = api.onFileRemoved?.(handleFileRemoved);
    const disposeChanged = api.onFileChanged?.(handleFileChanged);
    const disposeError = api.onFileWatchError?.((error) => {
      console.error("File watch error:", error);
    });

    return () => {
      disposeAdded?.();
      disposeRemoved?.();
      disposeChanged?.();
      disposeError?.();
      api?.stopFolderWatch?.().catch(() => {});
    };
  }, [
    refreshTagList,
    removeSelection,
    setActualPlaying,
    setLoadedVideos,
    setLoadingVideos,
    setSelection,
    setVisibleVideos,
  ]);

  return {
    videos,
    setVideos,
    activeRootPath,
    libraryRoot,
    directorySummaries,
    setDirectorySummaries,
    isLoadingFolder,
    isRefreshingFolder,
    loadingStatus,
    loadingStage: loadingStatus.message,
    loadingProgress: getLoadingProgressPercent(loadingStatus),
    settingsLoaded,
    cancelFolderLoad,
    handleElectronFolderSelection,
    reloadCurrentRoot,
    handleFolderSelect,
    handleWebFileSelection,
  };
}
