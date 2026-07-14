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
import {
  FOLDER_OPEN_MILESTONES,
  beginFolderOpenMeasurement,
  recordFolderOpenMilestone,
} from "../performance/folderOpenMetrics";

const __DEV__ = import.meta.env.MODE !== "production";
let directoryScanSequence = 0;

const preserveEnumeratedMetadata = (existing, incoming) => {
  if (!existing) return normalizeVideoFromMain(incoming);
  const normalized = normalizeVideoFromMain(incoming);
  return {
    ...existing,
    ...normalized,
    instanceId: existing.instanceId ?? normalized.instanceId ?? null,
    fingerprint: existing.fingerprint ?? null,
    tags: Array.isArray(existing.tags) ? existing.tags : [],
    rating: existing.rating ?? null,
    reviewState: existing.reviewState || "unreviewed",
    dimensions: existing.dimensions ?? null,
    aspectRatio: existing.aspectRatio ?? null,
    enrichmentState:
      existing.enrichmentState === "ready" ? "ready" : "enumerated",
  };
};

const mergeReadyRecord = (existing, incoming) =>
  normalizeVideoFromMain({ ...(existing || {}), ...(incoming || {}) });

const snapshotRecordMap = (scan) => [...scan.recordsById.values()];

const settleRecordSequenceWaiters = (scan, completed = false) => {
  if (!scan?.recordSequenceWaiters?.length) return;
  const remaining = [];
  for (const waiter of scan.recordSequenceWaiters) {
    if (completed || scan.lastRecordSequence >= waiter.target) {
      clearTimeout(waiter.timeout);
      waiter.resolve(!completed);
    } else {
      remaining.push(waiter);
    }
  }
  scan.recordSequenceWaiters = remaining;
};

const waitForRecordSequence = (scan, target) => {
  if (!Number.isFinite(target) || target <= scan.lastRecordSequence) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const waiter = { target, resolve, timeout: null };
    waiter.timeout = setTimeout(() => {
      scan.recordSequenceWaiters = scan.recordSequenceWaiters.filter(
        (candidate) => candidate !== waiter
      );
      resolve(false);
    }, 5000);
    scan.recordSequenceWaiters.push(waiter);
  });
};

export function useElectronFolderLifecycle({
  selection,
  recursiveMode,
  setRecursiveMode,
  setShowFilenames,
  renderLimitStep: _renderLimitStep,
  setRenderLimitStep,
  setSortKey,
  setSortDir,
  groupByFolders: _groupByFolders,
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
  const [activeScanId, setActiveScanId] = useState(null);
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
    settleRecordSequenceWaiters(scan, true);
    activeFolderScanRef.current = null;
    recordFolderOpenMilestone(
      scan.id,
      FOLDER_OPEN_MILESTONES.CANCELLED,
      { recordCount: scan.recordsById?.size || 0 }
    );

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
        if (payload.phase === "finalizing") {
          recordFolderOpenMilestone(
            scan.id,
            FOLDER_OPEN_MILESTONES.ENRICHMENT_COMPLETE,
            {
              recordCount:
                Number(payload.enrichedFiles) || scan.recordsById?.size || 0,
            }
          );
        }
      }
    );

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onDirectoryScanRecords?.(
      (payload) => {
        const scan = activeFolderScanRef.current;
        if (
          !mountedRef.current ||
          !scan ||
          scan.cancelled ||
          !payload ||
          payload.scanId !== scan.id ||
          !Array.isArray(payload.records)
        ) {
          return;
        }

        const sequence = Number(payload.sequence);
        if (Number.isFinite(sequence)) {
          if (sequence <= scan.lastRecordSequence) return;
          scan.lastRecordSequence = sequence;
        }

        const isEnumeration = payload.kind === "enumeration";
        let changed = false;
        for (const incoming of payload.records) {
          if (!incoming?.id) continue;
          const existing = scan.recordsById.get(incoming.id);
          const next = isEnumeration
            ? preserveEnumeratedMetadata(existing, incoming)
            : mergeReadyRecord(existing, incoming);
          scan.recordsById.set(next.id, next);
          scan.authoritativeIds.add(next.id);
          changed = true;
        }
        if (!changed || activeFolderScanRef.current !== scan) return;

        if (!scan.incrementalPreviewApplied) {
          recordFolderOpenMilestone(
            scan.id,
            FOLDER_OPEN_MILESTONES.FIRST_BATCH,
            {
              batchSize: payload.records.length,
              recordCount: scan.recordsById.size,
              batchKind: payload.kind || "unknown",
            }
          );
        }
        scan.incrementalPreviewApplied = true;
        settleRecordSequenceWaiters(scan);
        setVideos(snapshotRecordMap(scan));
        setIsLoadingFolder(false);
        setIsRefreshingFolder(true);
      }
    );

    return () => unsubscribe?.();
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
        lastRecordSequence: -1,
        recordsById: new Map(),
        authoritativeIds: new Set(),
        incrementalPreviewApplied: false,
        lastPrioritySignature: "",
        recordSequenceWaiters: [],
      };
      activeFolderScanRef.current = scan;
      setActiveScanId(scan.id);
      beginFolderOpenMeasurement({
        scanId: scan.id,
        rootPath: folderPath,
        recursive: scanRecursive,
      });
      const isCurrentScan = () =>
        mountedRef.current &&
        !scan.cancelled &&
        activeFolderScanRef.current === scan;
      let cachedPreviewApplied = false;
      let watchStarted = false;

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
        setLibraryRoot({
          rootPath: folderPath,
          refreshState: "scanning",
        });
        setDirectorySummaries([]);
        setVideos([]);
        resetDerivedVideoState();

        if (typeof api.startFolderWatch === "function") {
          try {
            const watchResult = await api.startFolderWatch(
              folderPath,
              scanRecursive,
              {
                scanId: scan.id,
                bufferInitialEvents: true,
              }
            );
            if (!isCurrentScan()) return;
            watchStarted = Boolean(watchResult?.success);
            if (!watchStarted && watchResult?.error) {
              console.warn(
                "Failed to start folder watcher:",
                new Error(watchResult.error)
              );
            }
          } catch (watchError) {
            console.warn("Failed to start folder watcher:", watchError);
          }
        }
        if (!isCurrentScan()) return;

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
              scan.recordsById = new Map(
                cachedFiles.map((file) => [file.id, file])
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
              recordFolderOpenMilestone(
                scan.id,
                FOLDER_OPEN_MILESTONES.CACHED_PREVIEW,
                {
                  recordCount: cachedFiles.length,
                  previewSource: "sqlite",
                }
              );
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
          scan.id,
          { streamRecords: true }
        );
        if (!isCurrentScan()) return;

        if (result?.cancelled) {
          settleRecordSequenceWaiters(scan, true);
          activeFolderScanRef.current = null;
          recordFolderOpenMilestone(
            scan.id,
            FOLDER_OPEN_MILESTONES.CANCELLED,
            { recordCount: scan.recordsById.size }
          );
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

        const streamed = Boolean(result?.streamed);
        if (streamed) {
          const receivedCompleteStream = await waitForRecordSequence(
            scan,
            Number(result?.recordSequence) || 0
          );
          if (!isCurrentScan()) return;
          if (!receivedCompleteStream) {
            throw new Error("The folder record stream did not complete");
          }
        }
        const files = Array.isArray(result)
          ? result
          : Array.isArray(result?.files)
            ? result.files
            : [];
        let normalizedFiles;
        if (streamed) {
          for (const id of scan.recordsById.keys()) {
            if (!scan.authoritativeIds.has(id)) {
              scan.recordsById.delete(id);
            }
          }
          normalizedFiles = snapshotRecordMap(scan);
        } else {
          normalizedFiles = files.map((file) => normalizeVideoFromMain(file));
          scan.recordsById = new Map(
            normalizedFiles.map((file) => [file.id, file])
          );
          scan.authoritativeIds = new Set(scan.recordsById.keys());
        }
        const completedFileCount = streamed
          ? Number(result?.fileCount) || normalizedFiles.length
          : normalizedFiles.length;
        recordFolderOpenMilestone(
          scan.id,
          FOLDER_OPEN_MILESTONES.ENRICHMENT_COMPLETE,
          { recordCount: completedFileCount }
        );
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
            completedFileCount
          ),
          prepared: completedFileCount,
          completed: completedFileCount,
          total: completedFileCount,
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
        recordFolderOpenMilestone(
          scan.id,
          FOLDER_OPEN_MILESTONES.SCAN_COMPLETE,
          {
            recordCount: completedFileCount,
            streamed,
            cachedPreview: cachedPreviewApplied,
          }
        );

        refreshTagList();

        let watchResult = watchStarted ? { success: true } : null;
        if (!watchStarted) {
          try {
            watchResult = await api.startFolderWatch?.(
              folderPath,
              scanRecursive,
              { scanId: scan.id, bufferInitialEvents: false }
            );
          } catch (watchError) {
            console.warn("Failed to start folder watcher:", watchError);
          }
        }
        if (!isCurrentScan()) return;
        if (watchResult?.success && __DEV__) {
          console.log("👁️ watching folder");
        }

        addRecentFolder(folderPath);
        if (activeFolderScanRef.current === scan) {
          settleRecordSequenceWaiters(scan, true);
          activeFolderScanRef.current = null;
        }
      } catch (error) {
        if (!isCurrentScan()) return;
        console.error("Error reading directory:", error);
        settleRecordSequenceWaiters(scan, true);
        activeFolderScanRef.current = null;
        recordFolderOpenMilestone(
          scan.id,
          FOLDER_OPEN_MILESTONES.ERROR,
          {
            recordCount: scan.recordsById.size,
            error: error?.message || "The folder could not be read.",
          }
        );
        setLoadingStatus((previous) => ({
          ...previous,
          phase: "error",
          message: "Couldn’t open this collection",
          error: error?.message || "The folder could not be read.",
          updatedAt: Date.now(),
        }));
        setLibraryRoot((previous) =>
          (cachedPreviewApplied || scan.incrementalPreviewApplied) && previous
            ? { ...previous, refreshState: "error" }
            : previous
        );
        setIsLoadingFolder(
          !(cachedPreviewApplied || scan.incrementalPreviewApplied)
        );
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
      setActiveScanId(null);
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
      setActiveScanId(null);
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

    const resolveWatcherScan = (watch) => {
      const scan = activeFolderScanRef.current;
      if (!scan || scan.cancelled) return null;
      if (watch?.scanId && watch.scanId !== scan.id) return false;
      return scan;
    };

    const handleFileAdded = (videoFile, watch) => {
      const normalized = normalizeVideoFromMain(videoFile);
      const scan = resolveWatcherScan(watch);
      if (scan === false) return;
      if (scan) {
        scan.recordsById.set(
          normalized.id,
          mergeReadyRecord(scan.recordsById.get(normalized.id), normalized)
        );
        scan.authoritativeIds.add(normalized.id);
        setVideos(snapshotRecordMap(scan));
      } else {
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
      }
      if (normalized.tags.length) {
        refreshTagList();
      }
    };

    const handleFileRemoved = (filePath, watch) => {
      const scan = resolveWatcherScan(watch);
      if (scan === false) return;
      if (scan) {
        scan.recordsById.delete(filePath);
        scan.authoritativeIds.delete(filePath);
        setVideos(snapshotRecordMap(scan));
      } else {
        setVideos((prev) => prev.filter((v) => v.id !== filePath));
      }
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

    const handleFileChanged = (videoFile, watch) => {
      const normalized = normalizeVideoFromMain(videoFile);
      const scan = resolveWatcherScan(watch);
      if (scan === false) return;
      if (scan) {
        scan.recordsById.set(
          normalized.id,
          mergeReadyRecord(scan.recordsById.get(normalized.id), normalized)
        );
        scan.authoritativeIds.add(normalized.id);
        setVideos(snapshotRecordMap(scan));
      } else {
        setVideos((prev) =>
          prev.map((v) => (v.id === normalized.id ? normalized : v))
        );
      }
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

  const prioritizeActiveDirectoryScan = useCallback((ids) => {
    const scan = activeFolderScanRef.current;
    const prioritize = window.electronAPI?.prioritizeDirectoryScan;
    if (!scan || scan.cancelled || typeof prioritize !== "function") {
      return false;
    }
    const normalizedIds = Array.from(
      new Set(
        (Array.isArray(ids) ? ids : [])
          .filter((id) => typeof id === "string" && id)
          .slice(0, 256)
      )
    );
    const signature = normalizedIds.join("\n");
    if (signature === scan.lastPrioritySignature) return false;
    scan.lastPrioritySignature = signature;
    prioritize(scan.id, normalizedIds);
    return true;
  }, []);

  return {
    videos,
    setVideos,
    activeRootPath,
    libraryRoot,
    directorySummaries,
    setDirectorySummaries,
    isLoadingFolder,
    isRefreshingFolder,
    activeScanId,
    loadingStatus,
    loadingStage: loadingStatus.message,
    loadingProgress: getLoadingProgressPercent(loadingStatus),
    settingsLoaded,
    cancelFolderLoad,
    prioritizeActiveDirectoryScan,
    handleElectronFolderSelection,
    reloadCurrentRoot,
    handleFolderSelect,
    handleWebFileSelection,
  };
}
