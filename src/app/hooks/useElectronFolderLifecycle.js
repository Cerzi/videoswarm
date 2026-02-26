import { useState, useCallback, useEffect, useRef } from "react";
import { normalizeVideoFromMain } from "../videoNormalization";
import {
  clampRenderLimitStep,
  inferRenderLimitStepFromLegacy,
} from "../../utils/renderLimit";

const __DEV__ = import.meta.env.MODE !== "production";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useElectronFolderLifecycle({
  selection,
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
  delayFn = delay,
}) {
  const [videos, setVideos] = useState([]);
  const [librarySources, setLibrarySources] = useState([]);
  const [activeSourceId, setActiveSourceId] = useState(null);
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const { clear: clearSelection, setSelected: setSelection } = selection;
  const setterRefs = useRef({
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
        setShowFilenames,
      setRenderLimitStep,
      setSortKey,
      setSortDir,
      setGroupByFolders,
      setRandomSeed,
      setZoomLevelFromSettings,
    };
  }, [
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

  const mergeSourceVideos = useCallback((sourceId, sourcePath, files) => {
    const normalizedFiles = files.map((file) => ({
      ...normalizeVideoFromMain(file),
      sourceId,
      sourcePath,
    }));

    setVideos((prev) => {
      const retained = prev.filter((video) => video.sourceId !== sourceId);
      return [...retained, ...normalizedFiles].sort((a, b) =>
        (a.basename ?? "").localeCompare(b.basename ?? "", undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );
    });
  }, []);

  const registerSource = useCallback((sourceId, folderPath) => {
    const now = new Date();
    setLibrarySources((prev) => {
      const existing = prev.find((entry) => entry.id === sourceId);
      if (existing) {
        return prev.map((entry) =>
          entry.id === sourceId
            ? {
                ...entry,
                path: folderPath,
                isIndexed: true,
                isIncluded: true,
                lastOpenedAt: now,
              }
            : entry
        );
      }

      return [
        ...prev,
        {
          id: sourceId,
          path: folderPath,
          isIndexed: true,
          isIncluded: true,
          addedAt: now,
          lastOpenedAt: now,
        },
      ];
    });
  }, []);

  const handleElectronFolderSelection = useCallback(
    async (folderPath) => {
      const api = window.electronAPI;
      if (!api?.readDirectory) return;
      const sourceId = folderPath;

      try {
        setIsLoadingFolder(true);
        setLoadingStage("Reading directory...");
        setLoadingProgress(10);
        await delayFn(100);

        await api.stopFolderWatch?.();

        resetDerivedVideoState();

        setLoadingStage("Scanning for video files...");
        setLoadingProgress(30);
        await delayFn(200);

        const files = await api.readDirectory(folderPath, true);

        setLoadingStage(`Found ${files.length} videos — initializing masonry...`);
        setLoadingProgress(70);
        await delayFn(200);

        mergeSourceVideos(sourceId, folderPath, files);
        registerSource(sourceId, folderPath);
        setActiveSourceId(sourceId);
        await delayFn(300);

        setLoadingStage("Complete!");
        setLoadingProgress(100);
        await delayFn(250);
        setIsLoadingFolder(false);

        refreshTagList();

        const watchResult = await api.startFolderWatch?.(
          folderPath,
          true
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
      mergeSourceVideos,
      registerSource,
      refreshTagList,
      resetDerivedVideoState,
    ]
  );

  const removeLibrarySource = useCallback(
    (sourceId) => {
      if (!sourceId) return;
      setLibrarySources((prev) => prev.filter((source) => source.id !== sourceId));
      setVideos((prev) => {
        const removedIds = new Set(
          prev
            .filter((video) => video.sourceId === sourceId)
            .map((video) => video.id)
        );
        if (removedIds.size) {
          setSelection((selectedPrev) => {
            const next = new Set(selectedPrev);
            removedIds.forEach((id) => next.delete(id));
            return next;
          });
        }
        return prev.filter((video) => video.sourceId !== sourceId);
      });
      setActiveSourceId((current) => (current === sourceId ? null : current));
      refreshTagList();
    },
    [refreshTagList, setSelection]
  );

  const reindexLibrarySource = useCallback(
    async (sourceId) => {
      const source = librarySources.find((entry) => entry.id === sourceId);
      if (!source?.path || !window.electronAPI?.readDirectory) return;
      const files = await window.electronAPI.readDirectory(source.path, true);
      mergeSourceVideos(sourceId, source.path, files);
      registerSource(sourceId, source.path);
      refreshTagList();
    },
    [librarySources, mergeSourceVideos, refreshTagList, registerSource]
  );

  const setSourceIncluded = useCallback(
    async (sourceId, included) => {
      setLibrarySources((prev) =>
        prev.map((source) =>
          source.id === sourceId ? { ...source, isIncluded: Boolean(included) } : source
        )
      );

      if (included) {
        await reindexLibrarySource(sourceId);
        return;
      }

      setVideos((prev) => prev.filter((video) => video.sourceId !== sourceId));
      if (activeSourceId === sourceId) {
        setActiveSourceId(null);
      }
      refreshTagList();
    },
    [activeSourceId, refreshTagList, reindexLibrarySource]
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

  const applySettingsFromMain = useCallback((settings) => {
    if (!settings) return;
    const {
      setShowFilenames: applyShowFilenames,
      setRenderLimitStep: applyRenderLimitStep,
      setSortKey: applySortKey,
      setSortDir: applySortDir,
      setGroupByFolders: applyGroupByFolders,
      setRandomSeed: applyRandomSeed,
      setZoomLevelFromSettings: applyZoomLevelFromSettings,
    } = setterRefs.current;

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
  }, [loadSettingsFromMain, refreshTagList, resetDerivedVideoState, setVideos]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return undefined;

    const handleFileAdded = (videoFile) => {
      const normalized = {
        ...normalizeVideoFromMain(videoFile),
        sourceId: activeSourceId,
      };
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
      setSelection((prev) => {
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
      const normalized = {
        ...normalizeVideoFromMain(videoFile),
        sourceId: activeSourceId,
      };
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
    activeSourceId,
    refreshTagList,
    setActualPlaying,
    setLoadedVideos,
    setLoadingVideos,
    setSelection,
    setVisibleVideos,
  ]);

  return {
    videos,
    setVideos,
    librarySources,
    activeSourceId,
    setActiveSourceId,
    removeLibrarySource,
    reindexLibrarySource,
    setSourceIncluded,
    isLoadingFolder,
    loadingStage,
    loadingProgress,
    settingsLoaded,
    handleElectronFolderSelection,
    handleFolderSelect,
    handleWebFileSelection,
  };
}
