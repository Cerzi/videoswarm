import { useState, useCallback, useEffect } from "react";
import { normalizeVideoFromMain } from "../videoNormalization";

const __DEV__ = import.meta.env.MODE !== "production";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useElectronFolderLifecycle({
  selection,
  recursiveMode,
  setRecursiveMode,
  setShowFilenames,
  maxConcurrentPlaying,
  setMaxConcurrentPlaying,
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
  delayFn = delay,
}) {
  const [videos, setVideos] = useState([]);
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const resetDerivedVideoState = useCallback(() => {
    selection.clear();
    setVisibleVideos(new Set());
    setLoadedVideos(new Set());
    setLoadingVideos(new Set());
    setActualPlaying(new Set());
  }, [
    selection,
    setActualPlaying,
    setLoadedVideos,
    setLoadingVideos,
    setVisibleVideos,
  ]);

  const handleElectronFolderSelection = useCallback(
    async (folderPath) => {
      const api = window.electronAPI;
      if (!api?.readDirectory) return;

      try {
        setIsLoadingFolder(true);
        setLoadingStage("Reading directory...");
        setLoadingProgress(10);
        await delayFn(100);

        await api.stopFolderWatch?.();

        setVideos([]);
        resetDerivedVideoState();

        setLoadingStage("Scanning for video files...");
        setLoadingProgress(30);
        await delayFn(200);

        const files = await api.readDirectory(folderPath, recursiveMode);
        const normalizedFiles = files.map((file) => normalizeVideoFromMain(file));

        setLoadingStage(`Found ${files.length} videos — initializing masonry...`);
        setLoadingProgress(70);
        await delayFn(200);

        setVideos(normalizedFiles);
        await delayFn(300);

        setLoadingStage("Complete!");
        setLoadingProgress(100);
        await delayFn(250);
        setIsLoadingFolder(false);

        refreshTagList();

        const watchResult = await api.startFolderWatch?.(
          folderPath,
          recursiveMode
        );
        if (watchResult?.success && __DEV__) {
          console.log("👁️ watching folder");
        }

        addRecentFolder(folderPath);
      } catch (error) {
        console.error("Error reading directory:", error);
        setIsLoadingFolder(false);
      }
    },
    [
      addRecentFolder,
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
    [resetDerivedVideoState]
  );

  useEffect(() => {
    const loadSettings = async () => {
      const api = window.electronAPI;
      if (!api?.getSettings) {
        setSettingsLoaded(true);
        return;
      }

      try {
        const settings = await api.getSettings();
        if (settings.recursiveMode !== undefined)
          setRecursiveMode(settings.recursiveMode);
        if (settings.showFilenames !== undefined)
          setShowFilenames(settings.showFilenames);
        if (settings.maxConcurrentPlaying !== undefined)
          setMaxConcurrentPlaying(settings.maxConcurrentPlaying);
        if (settings.zoomLevel !== undefined)
          setZoomLevelFromSettings(settings.zoomLevel);
        if (settings.sortKey) setSortKey(settings.sortKey);
        if (settings.sortDir) setSortDir(settings.sortDir);
        if (settings.groupByFolders !== undefined)
          setGroupByFolders(settings.groupByFolders);
        if (settings.randomSeed !== undefined)
          setRandomSeed(settings.randomSeed);
      } catch (error) {
        console.error("Failed to load settings", error);
      }

      setSettingsLoaded(true);
    };

    loadSettings();

    const cleanup = window.electronAPI?.onFolderSelected?.(
      (folderPath) => {
        handleElectronFolderSelection(folderPath);
      },
      [handleElectronFolderSelection]
    );

    return () => {
      if (typeof cleanup === "function") {
        cleanup();
      }
    };
  }, [
    setZoomLevelFromSettings,
    handleElectronFolderSelection,
    setGroupByFolders,
    setMaxConcurrentPlaying,
    setRandomSeed,
    setRecursiveMode,
    setShowFilenames,
    setSortDir,
    setSortKey,
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
      selection.setSelected((prev) => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
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

    api.onFileAdded?.(handleFileAdded);
    api.onFileRemoved?.(handleFileRemoved);
    api.onFileChanged?.(handleFileChanged);

    return () => {
      api?.stopFolderWatch?.().catch(() => {});
    };
  }, [
    refreshTagList,
    selection,
    setActualPlaying,
    setLoadedVideos,
    setLoadingVideos,
    setVisibleVideos,
  ]);

  return {
    videos,
    setVideos,
    isLoadingFolder,
    loadingStage,
    loadingProgress,
    settingsLoaded,
    handleElectronFolderSelection,
    handleFolderSelect,
    handleWebFileSelection,
  };
}
