import { useState, useCallback, useEffect, useRef } from "react";
import { normalizeVideoFromMain } from "../videoNormalization";
import {
  clampRenderLimitStep,
  inferRenderLimitStepFromLegacy,
} from "../../utils/renderLimit";

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
  setZoomLevelFromSettings,
  setVisibleVideos,
  setLoadedVideos,
  setLoadingVideos,
  setActualPlaying,
  refreshTagList,
  addRecentFolder,
}) {
  const [videos, setVideos] = useState([]);
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [loadingProgress, setLoadingProgress] = useState(0);
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
    setZoomLevelFromSettings,
  ]);

  const resetDerivedVideoState = useCallback(() => {
    clearSelection();
    setVisibleVideos(new Set());
    setLoadedVideos(new Set());
    setLoadingVideos(new Set());
    setActualPlaying(new Set());
  }, [
    clearSelection,
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
      setLoadingStage("Cancelled");
      setLoadingProgress(0);
      setIsLoadingFolder(false);
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

  const handleElectronFolderSelection = useCallback(
    async (folderPath) => {
      const api = window.electronAPI;
      if (!api?.readDirectory) return;

      cancelActiveFolderScan(false);
      const scan = {
        id: `directory-scan-${Date.now()}-${++directoryScanSequence}`,
        cancelled: false,
      };
      activeFolderScanRef.current = scan;
      const isCurrentScan = () =>
        mountedRef.current &&
        !scan.cancelled &&
        activeFolderScanRef.current === scan;

      try {
        setIsLoadingFolder(true);
        setLoadingStage("Reading directory...");
        setLoadingProgress(10);

        await api.stopFolderWatch?.();
        if (!isCurrentScan()) return;

        setVideos([]);
        resetDerivedVideoState();

        setLoadingStage("Scanning for video files...");
        setLoadingProgress(30);

        const result = await api.readDirectory(
          folderPath,
          recursiveMode,
          scan.id
        );
        if (!isCurrentScan()) return;

        if (result?.cancelled) {
          activeFolderScanRef.current = null;
          setLoadingStage("Cancelled");
          setLoadingProgress(0);
          setIsLoadingFolder(false);
          return;
        }

        const files = Array.isArray(result)
          ? result
          : Array.isArray(result?.files)
            ? result.files
            : [];
        const normalizedFiles = files.map((file) => normalizeVideoFromMain(file));

        setLoadingStage(`Found ${files.length} videos — initializing masonry...`);
        setLoadingProgress(70);

        setVideos(normalizedFiles);

        setLoadingStage("Complete!");
        setLoadingProgress(100);
        setIsLoadingFolder(false);

        refreshTagList();

        const watchResult = await api.startFolderWatch?.(
          folderPath,
          recursiveMode
        );
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
        setIsLoadingFolder(false);
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
    const cleanup = window.electronAPI?.onFolderSelected?.((folderPath) => {
      handleElectronFolderSelection(folderPath);
    });

    return () => {
      if (typeof cleanup === "function") {
        cleanup();
      }
    };
  }, [handleElectronFolderSelection]);

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
    isLoadingFolder,
    loadingStage,
    loadingProgress,
    settingsLoaded,
    cancelFolderLoad,
    handleElectronFolderSelection,
    handleFolderSelect,
    handleWebFileSelection,
  };
}
