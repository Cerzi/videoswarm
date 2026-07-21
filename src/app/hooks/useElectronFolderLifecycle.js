import { useState, useCallback, useEffect, useRef } from "react";
import { normalizeVideoFromMain } from "../videoNormalization";
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
import { createWebVideoRecord } from "../webFileIdentity";

const __DEV__ = import.meta.env.MODE !== "production";
let directoryScanSequence = 0;
export const CACHED_FIRST_GRID_LIMIT = 128;

const emptyCachedHydration = () => ({
  scanId: null,
  phase: "idle",
  recordCount: 0,
  totalRecordCount: 0,
});

const clearCachedPreviewPromotion = (scan) => {
  if (!scan) return;
  scan.cancelCachedPreviewFallback?.();
  scan.cancelCachedPreviewFallback = null;
  scan.promoteCachedPreview = null;
  scan.cachedPreviewPending = false;
};

const scheduleCachedPreviewFallback = (promote) => {
  let firstFrameId = null;
  let secondFrameId = null;
  let timeoutId = null;
  let cancelled = false;

  const run = () => {
    timeoutId = null;
    if (!cancelled) promote();
  };
  const afterSecondFrame = () => {
    secondFrameId = null;
    if (cancelled) return;
    // This is recovery for filtered/failed observability, not the normal
    // promotion path. Leave ample time for App's committed-grid frame to own
    // the first-paint measurement deterministically.
    timeoutId = setTimeout(run, 250);
  };

  if (typeof requestAnimationFrame === "function") {
    firstFrameId = requestAnimationFrame(() => {
      firstFrameId = null;
      if (cancelled) return;
      secondFrameId = requestAnimationFrame(afterSecondFrame);
    });
  } else {
    // Tests and non-visual runtimes may not expose animation frames. The
    // authoritative scan still owns completion, but do not leave a cached
    // collection permanently provisional if that scan stalls.
    timeoutId = setTimeout(run, 300);
  }

  return () => {
    cancelled = true;
    if (firstFrameId !== null) cancelAnimationFrame(firstFrameId);
    if (secondFrameId !== null) cancelAnimationFrame(secondFrameId);
    if (timeoutId !== null) clearTimeout(timeoutId);
  };
};

const preserveEnumeratedMetadata = (existing, incoming) => {
  if (!existing) return normalizeVideoFromMain(incoming);
  const normalized = normalizeVideoFromMain(incoming);
  const instanceId = existing.instanceId ?? normalized.instanceId ?? null;
  const sourceUrl = normalized.sourceUrl ?? existing.sourceUrl ?? null;
  return {
    ...existing,
    ...normalized,
    instanceId,
    sourceUrl,
    fingerprint: existing.fingerprint ?? null,
    tags: Array.isArray(existing.tags) ? existing.tags : [],
    rating: existing.rating ?? null,
    reviewState: existing.reviewState || "unreviewed",
    dimensions: existing.dimensions ?? null,
    aspectRatio: existing.aspectRatio ?? null,
    enrichmentState:
      existing.enrichmentState === "ready" || (instanceId && sourceUrl)
        ? "ready"
        : "enumerated",
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
  setHoverAudioEnabled,
  setSortKey,
  setSortDir,
  groupByFolders: _groupByFolders,
  setGroupByFolders,
  setRandomSeed,
  setPlaybackMode,
  setProxyPlaybackEnabled,
  setReviewAutoAdvance,
  setFullscreenDetailsOpen,
  setMetadataInspectorMode,
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
  beforeFileRemoved,
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
  const [cachedHydration, setCachedHydration] = useState(
    emptyCachedHydration
  );
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const activeFolderScanRef = useRef(null);
  const retainedFolderScanRef = useRef(null);
  const collectionOwnerScanIdRef = useRef(null);
  const mountedRef = useRef(true);
  const {
    clear: clearSelection,
    setSelected: setSelection,
    remove: removeSelection,
  } = selection;
  const setterRefs = useRef({
    setRecursiveMode,
    setShowFilenames,
    setHoverAudioEnabled,
    setSortKey,
    setSortDir,
    setGroupByFolders,
    setRandomSeed,
    setPlaybackMode,
    setProxyPlaybackEnabled,
    setReviewAutoAdvance,
    setFullscreenDetailsOpen,
    setMetadataInspectorMode,
    setZoomLevelFromSettings,
  });

  useEffect(() => {
    setterRefs.current = {
      setRecursiveMode,
      setShowFilenames,
      setHoverAudioEnabled,
      setSortKey,
      setSortDir,
      setGroupByFolders,
      setRandomSeed,
      setPlaybackMode,
      setProxyPlaybackEnabled,
      setReviewAutoAdvance,
      setFullscreenDetailsOpen,
      setMetadataInspectorMode,
      setZoomLevelFromSettings,
    };
  }, [
    setRecursiveMode,
    setShowFilenames,
    setHoverAudioEnabled,
    setSortKey,
    setSortDir,
    setGroupByFolders,
    setRandomSeed,
    setPlaybackMode,
    setProxyPlaybackEnabled,
    setReviewAutoAdvance,
    setFullscreenDetailsOpen,
    setMetadataInspectorMode,
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

    // User cancellation leaves the already indexed folder usable and permits
    // an in-flight full cache hydration to finish. Superseding roots and
    // unmount/profile teardown pass false and must never resurrect the
    // outgoing collection.
    if (updateLoadingState) {
      scan.retainCacheAfterStop = true;
      retainedFolderScanRef.current = scan;
      scan.promoteCachedPreview?.();
      scan.ensureFullCacheHydration?.();
    } else if (collectionOwnerScanIdRef.current === scan.id) {
      collectionOwnerScanIdRef.current = null;
      if (retainedFolderScanRef.current === scan) {
        retainedFolderScanRef.current = null;
      }
    }
    scan.cancelled = true;
    clearCachedPreviewPromotion(scan);
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
      const restoringFullCache =
        scan.boundedCachedPreview && !scan.fullCacheHydrationComplete;
      setLoadingStatus((previous) => ({
        ...previous,
        phase: "cancelled",
        message: restoringFullCache
          ? "Scan cancelled — restoring the complete indexed snapshot"
          : "Scan cancelled",
        partialPreview: restoringFullCache,
        updatedAt: Date.now(),
      }));
      if (restoringFullCache) {
        setLibraryRoot((previous) =>
          previous ? { ...previous, refreshState: "cancelled" } : previous
        );
      }
      setIsLoadingFolder(false);
      setIsRefreshingFolder(false);
    }
    return true;
  }, []);

  const promoteCachedPreview = useCallback((scanId) => {
    const scan = activeFolderScanRef.current;
    if (!scan || scan.cancelled || scan.id !== scanId) {
      return false;
    }
    return scan.promoteCachedPreview?.() === true;
  }, []);

  const cancelFolderLoad = useCallback(() => {
    cancelActiveFolderScan(true);
  }, [cancelActiveFolderScan]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelActiveFolderScan(false);
      retainedFolderScanRef.current = null;
      collectionOwnerScanIdRef.current = null;
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
          if (scan.authoritativeRemovedIds.has(incoming.id)) continue;
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
        if (!scan.cachedPreviewPending) {
          setVideos(snapshotRecordMap(scan));
        }
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

      const retainedScan = retainedFolderScanRef.current;
      if (retainedScan) {
        retainedScan.retainCacheAfterStop = false;
        retainedFolderScanRef.current = null;
        if (collectionOwnerScanIdRef.current === retainedScan.id) {
          collectionOwnerScanIdRef.current = null;
        }
      }
      cancelActiveFolderScan(false);
      const scan = {
        id: `directory-scan-${Date.now()}-${++directoryScanSequence}`,
        cancelled: false,
        lastProgressSequence: -1,
        lastRecordSequence: -1,
        recordsById: new Map(),
        authoritativeIds: new Set(),
        authoritativeRemovedIds: new Set(),
        incrementalPreviewApplied: false,
        lastPrioritySignature: "",
        recordSequenceWaiters: [],
        cachedPreviewPending: false,
        cachedFirstGridCommitted: false,
        promoteCachedPreview: null,
        cancelCachedPreviewFallback: null,
        boundedCachedPreview: false,
        cachedTotalRecordCount: 0,
        fullCacheHydrationPromise: null,
        fullCacheHydrationComplete: false,
        ensureFullCacheHydration: null,
        retainCacheAfterStop: false,
        authoritativeComplete: false,
      };
      activeFolderScanRef.current = scan;
      collectionOwnerScanIdRef.current = scan.id;
      setActiveScanId(scan.id);
      setCachedHydration({
        scanId: scan.id,
        phase: "idle",
        recordCount: 0,
        totalRecordCount: 0,
      });
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

        // Read only a bounded SQLite preview before watcher startup. It is
        // explicitly stale-while-revalidate: the watcher attaches before the
        // authoritative scan, and that stream expands the scan-owned map. Once
        // App confirms the first grid has painted, a second generation-owned
        // read may hydrate the complete cached order for review-session resume
        // without delaying first paint.
        if (typeof api.readDirectoryCache === "function") {
          try {
            const cachedResult = await api.readDirectoryCache(
              folderPath,
              scanRecursive,
              scan.id,
              { limit: CACHED_FIRST_GRID_LIMIT }
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
              const firstGridFiles = cachedFiles.slice(
                0,
                CACHED_FIRST_GRID_LIMIT
              );
              const totalCachedRecordCount = Math.max(
                cachedFiles.length,
                Number(cachedResult.totalRecordCount || 0)
              );
              scan.cachedTotalRecordCount = totalCachedRecordCount;
              scan.boundedCachedPreview =
                totalCachedRecordCount > cachedFiles.length;
              if (scan.boundedCachedPreview) {
                const ownsCollection = () =>
                  mountedRef.current &&
                  collectionOwnerScanIdRef.current === scan.id &&
                  !scan.authoritativeComplete &&
                  (
                    (!scan.cancelled && activeFolderScanRef.current === scan) ||
                    (scan.cancelled && scan.retainCacheAfterStop)
                  );
                scan.ensureFullCacheHydration = () => {
                  if (scan.fullCacheHydrationPromise) {
                    return scan.fullCacheHydrationPromise;
                  }
                  if (!ownsCollection()) return Promise.resolve(false);
                  scan.cancelCachedPreviewFallback?.();
                  scan.cancelCachedPreviewFallback = null;

                  setCachedHydration({
                    scanId: scan.id,
                    phase: "hydrating",
                    recordCount: scan.recordsById.size,
                    totalRecordCount: scan.cachedTotalRecordCount,
                  });
                  scan.fullCacheHydrationPromise = (async () => {
                    try {
                      const fullResult = await api.readDirectoryCache(
                        folderPath,
                        scanRecursive,
                        scan.id
                      );
                      if (
                        !ownsCollection() ||
                        fullResult?.cached !== true ||
                        fullResult.scanId !== scan.id ||
                        !Array.isArray(fullResult.files)
                      ) {
                        return false;
                      }

                      const fullCachedFiles = fullResult.files.map((file) =>
                        normalizeVideoFromMain(file)
                      );
                      for (const file of fullCachedFiles) {
                        if (
                          scan.authoritativeRemovedIds.has(file.id) ||
                          scan.authoritativeIds.has(file.id)
                        ) {
                          continue;
                        }
                        scan.recordsById.set(file.id, file);
                      }
                      if (!ownsCollection()) return false;

                      scan.fullCacheHydrationComplete = true;
                      scan.cachedTotalRecordCount = Math.max(
                        fullCachedFiles.length,
                        Number(fullResult.totalRecordCount || 0)
                      );
                      setVideos(snapshotRecordMap(scan));
                      setCachedHydration({
                        scanId: scan.id,
                        phase: "complete",
                        recordCount: scan.recordsById.size,
                        totalRecordCount: scan.cachedTotalRecordCount,
                      });
                      if (scan.cancelled && scan.retainCacheAfterStop) {
                        setLoadingStatus((previous) =>
                          previous.scanId === scan.id
                            ? {
                                ...previous,
                                message:
                                  "Scan cancelled — showing the complete indexed snapshot",
                                partialPreview: false,
                                updatedAt: Date.now(),
                              }
                            : previous
                        );
                      }
                      return true;
                    } catch (fullCacheError) {
                      if (ownsCollection()) {
                        console.warn(
                          "Failed to hydrate complete indexed snapshot:",
                          fullCacheError
                        );
                        setCachedHydration({
                          scanId: scan.id,
                          phase: "partial",
                          recordCount: scan.recordsById.size,
                          totalRecordCount: scan.cachedTotalRecordCount,
                        });
                        if (scan.cancelled && scan.retainCacheAfterStop) {
                          setLoadingStatus((previous) =>
                            previous.scanId === scan.id
                              ? {
                                  ...previous,
                                  message:
                                    "Scan cancelled — showing a partial indexed preview",
                                  partialPreview: true,
                                  updatedAt: Date.now(),
                                }
                              : previous
                          );
                        }
                      }
                      return false;
                    } finally {
                      if (
                        retainedFolderScanRef.current === scan &&
                        (scan.cancelled ||
                          scan.fullCacheHydrationComplete ||
                          collectionOwnerScanIdRef.current !== scan.id)
                      ) {
                        retainedFolderScanRef.current = null;
                      }
                    }
                  })();
                  return scan.fullCacheHydrationPromise;
                };
              }
              scan.cachedPreviewPending =
                cachedFiles.length > firstGridFiles.length;
              scan.promoteCachedPreview = () => {
                if (!isCurrentScan() || scan.cachedFirstGridCommitted) {
                  return false;
                }
                scan.cachedFirstGridCommitted = true;
                scan.cancelCachedPreviewFallback?.();
                scan.cancelCachedPreviewFallback = null;
                if (scan.cachedPreviewPending) {
                  scan.cachedPreviewPending = false;
                  setVideos(snapshotRecordMap(scan));
                }
                if (scan.boundedCachedPreview) {
                  scan.ensureFullCacheHydration?.();
                  return true;
                }
                setCachedHydration({
                  scanId: scan.id,
                  phase: "complete",
                  recordCount: scan.recordsById.size,
                  totalRecordCount: scan.cachedTotalRecordCount,
                });
                return true;
              };
              if (cachedFiles.length > 0) {
                scan.cancelCachedPreviewFallback =
                  scheduleCachedPreviewFallback(scan.promoteCachedPreview);
              }
              setVideos(firstGridFiles);
              setCachedHydration({
                scanId: scan.id,
                phase: "preview",
                recordCount: cachedFiles.length,
                totalRecordCount: totalCachedRecordCount,
              });
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
                videosDiscovered: totalCachedRecordCount,
                prepared: cachedFiles.length,
                updatedAt: Date.now(),
              }));
              cachedPreviewApplied = true;
              recordFolderOpenMilestone(
                scan.id,
                FOLDER_OPEN_MILESTONES.CACHED_PREVIEW,
                {
                  recordCount: totalCachedRecordCount,
                  firstGridRecordCount: firstGridFiles.length,
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
          scan.retainCacheAfterStop = true;
          await scan.ensureFullCacheHydration?.();
          if (!isCurrentScan()) return;
          scan.promoteCachedPreview?.();
          scan.cancelled = true;
          clearCachedPreviewPromotion(scan);
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
            message: scan.fullCacheHydrationComplete
              ? "Scan cancelled — showing the complete indexed snapshot"
              : "Scan cancelled — showing a partial indexed preview",
            partialPreview:
              scan.boundedCachedPreview && !scan.fullCacheHydrationComplete,
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
          normalizedFiles = files
            .map((file) => normalizeVideoFromMain(file))
            .filter(
              (file) => !scan.authoritativeRemovedIds.has(file?.id)
            );
          scan.recordsById = new Map(
            normalizedFiles.map((file) => [file.id, file])
          );
          scan.authoritativeIds = new Set(scan.recordsById.keys());
        }
        const completedFileCount = streamed
          ? Number(result?.fileCount) || normalizedFiles.length
            : normalizedFiles.length;
        scan.authoritativeComplete = true;
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

        clearCachedPreviewPromotion(scan);
        setVideos(normalizedFiles);
        setCachedHydration({
          scanId: scan.id,
          phase: "authoritative",
          recordCount: normalizedFiles.length,
          totalRecordCount: completedFileCount,
        });
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
        // A failed authoritative refresh should leave the complete indexed
        // snapshot usable when SQLite still owns one. This read happens only
        // after the bounded first grid has already painted (or on failure).
        scan.retainCacheAfterStop = true;
        await scan.ensureFullCacheHydration?.();
        if (!isCurrentScan()) return;
        scan.promoteCachedPreview?.();
        clearCachedPreviewPromotion(scan);
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
          message: scan.fullCacheHydrationComplete
            ? "Couldn’t refresh this collection — showing its indexed snapshot"
            : "Couldn’t open this collection",
          partialPreview:
            scan.boundedCachedPreview && !scan.fullCacheHydrationComplete,
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
      cancelActiveFolderScan(false);
      retainedFolderScanRef.current = null;
      collectionOwnerScanIdRef.current = null;
      const files = Array.from(event.target.files || [])
        .map((file, selectionOrdinal) => ({ file, selectionOrdinal }))
        .filter(({ file }) => {
          const isVideoType = file.type.startsWith("video/");
          const hasExt =
            /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ogv)$/i.test(file.name);
          return isVideoType || hasExt;
        });

      const list = files.map(({ file, selectionOrdinal }) =>
        createWebVideoRecord(file, selectionOrdinal)
      );

      setVideos(list);
      setActiveScanId(null);
      setActiveRootPath(null);
      setLibraryRoot(null);
      setDirectorySummaries([]);
      setCachedHydration(emptyCachedHydration());
      resetDerivedVideoState();
    },
    [cancelActiveFolderScan, resetDerivedVideoState]
  );

  const applySettingsFromMain = useCallback((settings) => {
    if (!settings) return;
    const {
      setRecursiveMode: applyRecursiveMode,
      setShowFilenames: applyShowFilenames,
      setHoverAudioEnabled: applyHoverAudioEnabled,
      setSortKey: applySortKey,
      setSortDir: applySortDir,
      setGroupByFolders: applyGroupByFolders,
      setRandomSeed: applyRandomSeed,
      setPlaybackMode: applyPlaybackMode,
      setProxyPlaybackEnabled: applyProxyPlaybackEnabled,
      setReviewAutoAdvance: applyReviewAutoAdvance,
      setFullscreenDetailsOpen: applyFullscreenDetailsOpen,
      setMetadataInspectorMode: applyMetadataInspectorMode,
      setZoomLevelFromSettings: applyZoomLevelFromSettings,
    } = setterRefs.current;

    if (settings.recursiveMode !== undefined)
      applyRecursiveMode(settings.recursiveMode);
    if (settings.showFilenames !== undefined)
      applyShowFilenames(settings.showFilenames);
    if (settings.hoverAudioEnabled !== undefined)
      applyHoverAudioEnabled?.(settings.hoverAudioEnabled === true);
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
    if (settings.reviewAutoAdvance !== undefined) {
      applyReviewAutoAdvance?.(settings.reviewAutoAdvance === true);
    }
    if (settings.fullscreenDetailsOpen !== undefined) {
      applyFullscreenDetailsOpen?.(settings.fullscreenDetailsOpen === true);
    }
    if (settings.metadataInspectorMode !== undefined) {
      applyMetadataInspectorMode?.(
        settings.metadataInspectorMode === "docked" ? "docked" : "floating"
      );
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
      await beforeExternalFolderSelection?.(folderPath);
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
      cancelActiveFolderScan(false);
      retainedFolderScanRef.current = null;
      collectionOwnerScanIdRef.current = null;
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
      setCachedHydration(emptyCachedHydration());
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
      let scan = activeFolderScanRef.current;
      if (!scan) {
        const retained = retainedFolderScanRef.current;
        if (
          retained?.retainCacheAfterStop &&
          collectionOwnerScanIdRef.current === retained.id
        ) {
          scan = retained;
        }
      }
      if (!scan || (scan.cancelled && !scan.retainCacheAfterStop)) return null;
      if (watch?.scanId && watch.scanId !== scan.id) return false;
      return scan;
    };

    const handleFileAdded = (videoFile, watch) => {
      const normalized = normalizeVideoFromMain(videoFile);
      const scan = resolveWatcherScan(watch);
      if (scan === false) return;
      if (scan) {
        scan.authoritativeRemovedIds.delete(normalized.id);
        scan.recordsById.set(
          normalized.id,
          mergeReadyRecord(scan.recordsById.get(normalized.id), normalized)
        );
        scan.authoritativeIds.add(normalized.id);
        if (!scan.cachedPreviewPending) {
          setVideos(snapshotRecordMap(scan));
        }
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
      beforeFileRemoved?.(filePath);
      if (scan) {
        scan.recordsById.delete(filePath);
        scan.authoritativeIds.delete(filePath);
        scan.authoritativeRemovedIds.add(filePath);
        if (!scan.cachedPreviewPending) {
          setVideos(snapshotRecordMap(scan));
        }
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
        scan.authoritativeRemovedIds.delete(normalized.id);
        scan.recordsById.set(
          normalized.id,
          mergeReadyRecord(scan.recordsById.get(normalized.id), normalized)
        );
        scan.authoritativeIds.add(normalized.id);
        if (!scan.cachedPreviewPending) {
          setVideos(snapshotRecordMap(scan));
        }
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
    beforeFileRemoved,
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
    cachedHydration,
    cachedHydrationComplete:
      cachedHydration.phase === "complete" ||
      cachedHydration.phase === "authoritative",
    loadingStage: loadingStatus.message,
    loadingProgress: getLoadingProgressPercent(loadingStatus),
    settingsLoaded,
    cancelFolderLoad,
    prioritizeActiveDirectoryScan,
    promoteCachedPreview,
    handleElectronFolderSelection,
    reloadCurrentRoot,
    handleFolderSelect,
    handleWebFileSelection,
  };
}
