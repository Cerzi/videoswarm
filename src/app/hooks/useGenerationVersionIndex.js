import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Background generation-key indexing for the open collection. Keys that are
// already stored arrive with records; this hook asks the main process to
// evaluate the rest once the collection has settled, and applies the results
// by fingerprint. See docs/architecture/generation-versions.md, Section 4.

export const GENERATION_INDEX_REQUEST_LIMIT = 20_000;
export const GENERATION_INDEX_SETTLE_MS = 750;
const MAX_EARLY_EVENTS = 16;

const getApi = () =>
  typeof window === "undefined" ? null : window.electronAPI?.generationVersions || null;

// Content still to be evaluated: one instance per fingerprint, skipping
// fingerprints already requested for this collection so a transient failure
// cannot turn into a request loop.
export function collectPendingGenerationKeys(videos, attempted, limit = GENERATION_INDEX_REQUEST_LIMIT) {
  const seen = new Set();
  const instanceIds = [];
  const fingerprints = [];
  let pendingCount = 0;
  for (const video of videos || []) {
    const fingerprint = video?.fingerprint;
    if (!fingerprint || !video.instanceId || video.generationKeyChecked === true) continue;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    pendingCount += 1;
    if (attempted?.has(fingerprint) || instanceIds.length >= limit) continue;
    instanceIds.push(video.instanceId);
    fingerprints.push(fingerprint);
  }
  return { instanceIds, fingerprints, pendingCount };
}

// Returns the same array when nothing changes, so an irrelevant batch (for
// example a library-wide job's) does not re-render the grid.
export function applyGenerationKeyUpdates(videos, updates) {
  if (!Array.isArray(videos) || !Array.isArray(updates) || updates.length === 0) {
    return videos;
  }
  const byFingerprint = new Map();
  for (const update of updates) {
    if (update?.checked === true && typeof update.fingerprint === "string") {
      byFingerprint.set(update.fingerprint, update.generationKey || null);
    }
  }
  if (byFingerprint.size === 0) return videos;
  let changed = false;
  const next = videos.map((video) => {
    if (!video?.fingerprint || !byFingerprint.has(video.fingerprint)) return video;
    const generationKey = byFingerprint.get(video.fingerprint);
    if (video.generationKeyChecked === true && (video.generationKey || null) === generationKey) {
      return video;
    }
    changed = true;
    return { ...video, generationKey, generationKeyChecked: true };
  });
  return changed ? next : videos;
}

export default function useGenerationVersionIndex({
  videos,
  setVideos,
  collectionKey,
  busy,
  onBatch,
}) {
  const [status, setStatus] = useState(null);
  // Bumped whenever the attempted set changes, so the pending list is
  // recomputed even when no record changed (every read was transient).
  const [attemptVersion, setAttemptVersion] = useState(0);
  const jobIdRef = useRef(null);
  const requestingRef = useRef(false);
  const earlyEventsRef = useRef([]);
  const attemptedRef = useRef(new Set());
  const collectionKeyRef = useRef(collectionKey);
  const onBatchRef = useRef(onBatch);
  onBatchRef.current = onBatch;

  const handleProgress = useCallback(
    (payload) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.jobId !== jobIdRef.current) {
        // The reply naming a job can trail its first event; keep a few.
        if (requestingRef.current && earlyEventsRef.current.length < MAX_EARLY_EVENTS) {
          earlyEventsRef.current.push(payload);
        }
        return;
      }
      if (Array.isArray(payload.updates) && payload.updates.length > 0) {
        setVideos((previous) => applyGenerationKeyUpdates(previous, payload.updates));
        onBatchRef.current?.(payload);
      }
      setStatus({
        scope: payload.scope === "library" ? "library" : "collection",
        running: payload.done !== true,
        processed: Number(payload.processed) || 0,
        total: Number(payload.total) || 0,
        failed: payload.failed === true,
      });
      if (payload.done === true) {
        jobIdRef.current = null;
        if (!payload.failed) onBatchRef.current?.({ ...payload, updates: [] });
      }
    },
    [setVideos]
  );

  useEffect(() => {
    const api = getApi();
    if (typeof api?.onProgress !== "function") return undefined;
    return api.onProgress(handleProgress);
  }, [handleProgress]);

  const cancel = useCallback(() => {
    const hadJob = jobIdRef.current !== null || requestingRef.current;
    jobIdRef.current = null;
    requestingRef.current = false;
    earlyEventsRef.current = [];
    if (hadJob) getApi()?.cancel?.().catch?.(() => {});
    setStatus(null);
  }, []);

  const startJob = useCallback(
    async (scope) => {
      const api = getApi();
      if (typeof api?.index !== "function") return null;
      const requestedFor = collectionKeyRef.current;
      requestingRef.current = true;
      earlyEventsRef.current = [];
      let result = null;
      try {
        result = await api.index(scope);
      } catch {
        result = null;
      }
      requestingRef.current = false;
      if (collectionKeyRef.current !== requestedFor) {
        earlyEventsRef.current = [];
        return null;
      }
      if (!result || result.success === false || !result.jobId) {
        earlyEventsRef.current = [];
        setStatus({ scope: scope?.library ? "library" : "collection", running: false, processed: 0, total: 0, failed: true });
        return null;
      }
      jobIdRef.current = result.jobId;
      setStatus({
        scope: result.scope === "library" ? "library" : "collection",
        running: true,
        processed: 0,
        total: Number(result.pending) || 0,
        failed: false,
      });
      const early = earlyEventsRef.current;
      earlyEventsRef.current = [];
      early.filter((event) => event.jobId === result.jobId).forEach(handleProgress);
      return result;
    },
    [handleProgress]
  );

  // A new collection, a scan or a refresh supersedes the running job; the
  // scan re-delivers records with whatever keys were stored meanwhile.
  useEffect(() => {
    collectionKeyRef.current = collectionKey;
    attemptedRef.current = new Set();
    setAttemptVersion((version) => version + 1);
    cancel();
  }, [collectionKey, cancel]);

  useEffect(() => {
    if (!busy) return;
    attemptedRef.current = new Set();
    setAttemptVersion((version) => version + 1);
    if (jobIdRef.current !== null || requestingRef.current) cancel();
  }, [busy, cancel]);

  const pending = useMemo(
    () => collectPendingGenerationKeys(videos, attemptedRef.current),
    // attemptedRef is versioned by attemptVersion.
    [videos, attemptVersion]
  );

  useEffect(() => {
    if (busy || !collectionKey || pending.instanceIds.length === 0) return undefined;
    if (jobIdRef.current !== null || requestingRef.current) return undefined;
    if (typeof getApi()?.index !== "function") return undefined;
    const timer = setTimeout(() => {
      if (jobIdRef.current !== null || requestingRef.current) return;
      pending.fingerprints.forEach((fingerprint) => attemptedRef.current.add(fingerprint));
      setAttemptVersion((version) => version + 1);
      void startJob({ instanceIds: pending.instanceIds });
    }, GENERATION_INDEX_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [busy, collectionKey, pending, startJob, status]);

  useEffect(() => () => cancel(), [cancel]);

  const indexLibrary = useCallback(() => startJob({ library: true }), [startJob]);

  return {
    status,
    pendingCount: pending.pendingCount,
    indexLibrary,
    cancel,
  };
}
