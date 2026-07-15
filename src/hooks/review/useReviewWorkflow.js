import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  REVIEW_STATES,
  normalizeReviewState,
} from "../../review/reviewState";

export const REVIEW_WORKFLOW_MAX_PENDING = 32;

const asIdSet = (value) =>
  value instanceof Set ? new Set(value) : new Set(value || []);

const setsEqual = (left, right) => {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
};

const hasRating = (video) =>
  typeof video?.rating === "number" && Number.isFinite(video.rating);

const snapshotVideoMetadata = (video) => ({
  reviewState: normalizeReviewState(video?.reviewState),
  rating: hasRating(video) ? video.rating : null,
});

export const getEffectiveReviewState = (video) => {
  const state = normalizeReviewState(video?.reviewState);
  if (state === REVIEW_STATES.UNREVIEWED && hasRating(video)) {
    return REVIEW_STATES.REVIEWED;
  }
  return state;
};

export const buildReviewProgress = (videos) => {
  const progress = {
    total: 0,
    reviewedTotal: 0,
    reviewed: 0,
    accept: 0,
    reject: 0,
    unreviewed: 0,
  };

  for (const video of Array.isArray(videos) ? videos : []) {
    const state = getEffectiveReviewState(video);
    progress.total += 1;
    if (state === REVIEW_STATES.UNREVIEWED) {
      progress.unreviewed += 1;
      continue;
    }

    progress.reviewedTotal += 1;
    if (state === REVIEW_STATES.PICK) progress.accept += 1;
    else if (state === REVIEW_STATES.REJECT) progress.reject += 1;
    else progress.reviewed += 1;
  }

  return progress;
};

const mutationSucceeded = (result) =>
  result !== false && result?.success !== false && !result?.error;

const makeVideoMap = (videos) =>
  new Map(
    (Array.isArray(videos) ? videos : [])
      .filter((video) => video?.id != null)
      .map((video) => [video.id, video])
  );

const makeFingerprintMap = (videos) => {
  const byFingerprint = new Map();
  for (const video of Array.isArray(videos) ? videos : []) {
    if (video?.fingerprint && !byFingerprint.has(video.fingerprint)) {
      byFingerprint.set(video.fingerprint, video);
    }
  }
  return byFingerprint;
};

const asPositiveSafeInteger = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const plainMutationAnchor = (video, fallbackFingerprint = null) => ({
  id: video?.id ?? null,
  instanceId: asPositiveSafeInteger(video?.instanceId),
  fingerprint: typeof video?.fingerprint === "string" && video.fingerprint
    ? video.fingerprint
    : fallbackFingerprint,
});

const resolveMutationAnchor = ({
  anchorId,
  fingerprints,
  orderedVideoIds,
  videosById,
}) => {
  const targetSet = new Set(fingerprints);
  if (anchorId != null) {
    const explicit = videosById.get(anchorId);
    if (explicit?.fingerprint && targetSet.has(explicit.fingerprint)) {
      return plainMutationAnchor(explicit);
    }
  }

  const order = Array.isArray(orderedVideoIds) ? orderedVideoIds : [];
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const candidate = videosById.get(order[index]);
    if (candidate?.fingerprint && targetSet.has(candidate.fingerprint)) {
      return plainMutationAnchor(candidate);
    }
  }

  const fallbackFingerprint = fingerprints.at(-1) || null;
  return fallbackFingerprint
    ? plainMutationAnchor(null, fallbackFingerprint)
    : null;
};

const hasOwn = (value, key) =>
  Object.prototype.hasOwnProperty.call(value || {}, key);

const metadataMatches = (video, metadata) => {
  const current = snapshotVideoMetadata(video);
  return (
    current.reviewState === metadata.reviewState &&
    current.rating === metadata.rating
  );
};

export default function useReviewWorkflow({
  scopeVideos = [],
  orderedVideoIds = [],
  selectedIds = new Set(),
  selectExactly,
  setSelectedIds,
  scrollToId,
  ownershipKey,
  setReviewState,
  setRating,
  restoreReviewMetadata,
  autoAdvance = false,
  notify,
  onMutationCommitted,
} = {}) {
  const [isBusy, setIsBusy] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [endCheckVersion, setEndCheckVersion] = useState(0);
  const mountedRef = useRef(true);
  const queueRef = useRef(Promise.resolve());
  const pendingCountRef = useRef(0);
  const queueSaturatedRef = useRef(false);
  const historyRef = useRef(null);
  const metadataOverlayRef = useRef(new Map());
  const pendingEndRef = useRef(null);
  const previousOwnershipRef = useRef(ownershipKey);

  const inputRef = useRef({});
  inputRef.current = {
    scopeVideos,
    orderedVideoIds,
    selectedIds,
    selectExactly,
    setSelectedIds,
    scrollToId,
    ownershipKey,
    setReviewState,
    setRating,
    restoreReviewMetadata,
    autoAdvance,
    notify,
    onMutationCommitted,
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (Object.is(previousOwnershipRef.current, ownershipKey)) return;
    previousOwnershipRef.current = ownershipKey;
    historyRef.current = null;
    metadataOverlayRef.current.clear();
    pendingEndRef.current = null;
    setCanUndo(false);
  }, [ownershipKey]);

  useEffect(() => {
    const overlay = metadataOverlayRef.current;
    if (overlay.size === 0) return;
    const videosByFingerprint = makeFingerprintMap(scopeVideos);
    for (const [fingerprint, metadata] of overlay) {
      const video = videosByFingerprint.get(fingerprint);
      if (!video || metadataMatches(video, metadata)) {
        overlay.delete(fingerprint);
      }
    }
  }, [scopeVideos]);

  useEffect(() => {
    const pending = pendingEndRef.current;
    if (!pending) return;
    const current = inputRef.current;
    if (!Object.is(current.ownershipKey, pending.ownershipKey)) {
      pendingEndRef.current = null;
      return;
    }

    const currentSelection = asIdSet(current.selectedIds);
    if (!setsEqual(currentSelection, pending.selection)) {
      pendingEndRef.current = null;
      return;
    }

    if (current.orderedVideoIds === pending.originalOrder) return;
    pendingEndRef.current = null;
    if ((current.orderedVideoIds || []).includes(pending.selectedId)) return;

    const empty = new Set();
    inputRef.current.selectedIds = empty;
    current.setSelectedIds?.(empty);
  }, [endCheckVersion, orderedVideoIds, ownershipKey, selectedIds]);

  const progress = useMemo(
    () => buildReviewProgress(scopeVideos),
    [scopeVideos]
  );

  const enqueue = useCallback((task) => {
    if (pendingCountRef.current >= REVIEW_WORKFLOW_MAX_PENDING) {
      if (!queueSaturatedRef.current) {
        queueSaturatedRef.current = true;
        inputRef.current.notify?.(
          "Review input queue is full; wait for pending changes",
          "warning"
        );
      }
      return Promise.resolve(false);
    }
    pendingCountRef.current += 1;
    if (mountedRef.current) setIsBusy(true);

    const execution = queueRef.current.then(task, task);
    queueRef.current = execution.then(
      () => undefined,
      () => undefined
    );

    return execution.finally(() => {
      pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
      if (mountedRef.current && pendingCountRef.current === 0) {
        setIsBusy(false);
      }
      if (pendingCountRef.current === 0) queueSaturatedRef.current = false;
    });
  }, []);

  const recordMetadataOverlay = useCallback(({
    kind,
    value,
    fingerprints,
    result,
    videosByFingerprint,
  }) => {
    const updates = result?.updates || {};
    for (const fingerprint of fingerprints) {
      const previous = metadataOverlayRef.current.get(fingerprint) ||
        snapshotVideoMetadata(videosByFingerprint.get(fingerprint));
      const next = { ...previous };

      if (kind === "review") {
        next.reviewState = normalizeReviewState(value);
        if (next.reviewState === REVIEW_STATES.UNREVIEWED) next.rating = null;
      } else {
        next.rating = value == null ? null : value;
        if (
          next.rating !== null &&
          next.reviewState === REVIEW_STATES.UNREVIEWED
        ) {
          next.reviewState = REVIEW_STATES.REVIEWED;
        }
      }

      const update = updates[fingerprint];
      if (hasOwn(update, "reviewState")) {
        next.reviewState = normalizeReviewState(update.reviewState);
      }
      if (hasOwn(update, "rating")) {
        next.rating = hasRating(update) ? update.rating : null;
      }
      metadataOverlayRef.current.set(fingerprint, next);
    }
  }, []);

  const recordRestoredMetadataOverlay = useCallback(({
    snapshots,
    result,
  }) => {
    const updates = result?.updates || {};
    for (const snapshot of snapshots) {
      const next = {
        reviewState: normalizeReviewState(snapshot.reviewState),
        rating: hasRating(snapshot) ? snapshot.rating : null,
      };
      const update = updates[snapshot.fingerprint];
      if (hasOwn(update, "reviewState")) {
        next.reviewState = normalizeReviewState(update.reviewState);
      }
      if (hasOwn(update, "rating")) {
        next.rating = hasRating(update) ? update.rating : null;
      }
      metadataOverlayRef.current.set(snapshot.fingerprint, next);
    }
  }, []);

  const emitMutationCommitted = useCallback((payload) => {
    const callback = inputRef.current.onMutationCommitted;
    if (typeof callback !== "function") return;
    try {
      const response = callback(payload);
      response?.catch?.((error) => {
        console.error("Failed to persist committed review navigation:", error);
      });
    } catch (error) {
      console.error("Failed to persist committed review navigation:", error);
    }
  }, []);

  const runMutation = useCallback(async ({
    kind,
    value,
    mayAdvance,
    targetFingerprints = null,
    allowAdvance = true,
    anchorId = null,
    completionGuard = null,
  }) => {
    const current = inputRef.current;
    const videosById = makeVideoMap(current.scopeVideos);
    const videosByFingerprint = makeFingerprintMap(current.scopeVideos);
    const selection = asIdSet(current.selectedIds);
    const selectedVideos = Array.from(selection)
      .map((id) => videosById.get(id))
      .filter(Boolean);
    const uniqueTargets = new Map();

    if (targetFingerprints) {
      for (const fingerprint of targetFingerprints) {
        const video = videosByFingerprint.get(fingerprint);
        if (fingerprint && video && !uniqueTargets.has(fingerprint)) {
          uniqueTargets.set(fingerprint, video);
        }
      }
    } else {
      for (const video of selectedVideos) {
        if (video?.fingerprint && !uniqueTargets.has(video.fingerprint)) {
          uniqueTargets.set(video.fingerprint, video);
        }
      }
    }
    if (uniqueTargets.size === 0) return false;

    const fingerprints = Array.from(uniqueTargets.keys());
    const snapshots = Array.from(uniqueTargets, ([fingerprint, video]) => ({
      fingerprint,
      ...(metadataOverlayRef.current.get(fingerprint) ||
        snapshotVideoMetadata(video)),
    }));
    const operationOwnership = current.ownershipKey;
    const originalOrder = current.orderedVideoIds;
    const originalSelection = new Set(selection);
    const mutationAnchor = resolveMutationAnchor({
      anchorId,
      fingerprints,
      orderedVideoIds: originalOrder,
      videosById,
    });
    let advance = null;

    if (
      allowAdvance &&
      !targetFingerprints &&
      current.autoAdvance &&
      mayAdvance &&
      selection.size === 1
    ) {
      const selectedId = selection.values().next().value;
      const selectedVideo = videosById.get(selectedId);
      const selectedIndex = (current.orderedVideoIds || []).indexOf(selectedId);
      if (selectedIndex >= 0) {
        let successorId = null;
        for (
          let index = selectedIndex + 1;
          index < current.orderedVideoIds.length;
          index += 1
        ) {
          const candidateId = current.orderedVideoIds[index];
          const candidate = videosById.get(candidateId);
          if (
            selectedVideo?.fingerprint &&
            candidate?.fingerprint === selectedVideo.fingerprint
          ) {
            continue;
          }
          successorId = candidateId;
          break;
        }
        advance = { selectedId, successorId };
      }
    }

    const mutate = kind === "rating" ? current.setRating : current.setReviewState;
    if (typeof mutate !== "function") return false;

    let result;
    try {
      result = typeof completionGuard === "function"
        ? await mutate(value, fingerprints, { completionGuard })
        : await mutate(value, fingerprints);
    } catch (error) {
      console.error(`Failed to apply ${kind} workflow mutation:`, error);
      return false;
    }
    if (!mutationSucceeded(result)) return false;

    const latest = inputRef.current;
    if (!Object.is(latest.ownershipKey, operationOwnership)) return true;

    // The native mutation is authoritative once it succeeds. Persist its
    // checkpoint even if the initiating fullscreen session has since moved;
    // the session guard below still suppresses history, overlays, selection,
    // and auto-advance side effects for that stale surface.
    emitMutationCommitted({
      kind,
      value,
      allowCreateSession:
        kind === "rating"
          ? value !== null
          : value !== REVIEW_STATES.UNREVIEWED,
      ownershipKey: operationOwnership,
      anchor: mutationAnchor,
      fingerprints: [...fingerprints],
    });

    if (
      typeof completionGuard === "function" &&
      completionGuard() !== true
    ) {
      return true;
    }

    recordMetadataOverlay({
      kind,
      value,
      fingerprints,
      result,
      videosByFingerprint,
    });

    historyRef.current = {
      ownershipKey: operationOwnership,
      selectionIds: Array.from(originalSelection),
      snapshots,
      anchor: mutationAnchor,
    };
    if (mountedRef.current) setCanUndo(true);

    if (!advance || !setsEqual(asIdSet(latest.selectedIds), originalSelection)) {
      return true;
    }

    if (advance.successorId != null) {
      const nextSelection = new Set([advance.successorId]);
      inputRef.current.selectedIds = nextSelection;
      latest.selectExactly?.(advance.successorId);
      latest.scrollToId?.(advance.successorId, { align: "center" });
      return true;
    }

    pendingEndRef.current = {
      ownershipKey: operationOwnership,
      selectedId: advance.selectedId,
      selection: originalSelection,
      originalOrder,
    };
    if (mountedRef.current) setEndCheckVersion((version) => version + 1);
    latest.notify?.("Reached the end of the review queue", "info");
    return true;
  }, [emitMutationCommitted, recordMetadataOverlay]);

  const applyReviewState = useCallback((value, options = {}) => {
    const requestedOwnership = inputRef.current.ownershipKey;
    const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!Object.values(REVIEW_STATES).includes(normalizedValue)) {
      return Promise.resolve(false);
    }
    const state = normalizeReviewState(normalizedValue);
    return enqueue(() => {
      if (!Object.is(inputRef.current.ownershipKey, requestedOwnership)) return false;
      return runMutation({
        kind: "review",
        value: state,
        mayAdvance: state !== REVIEW_STATES.UNREVIEWED,
        targetFingerprints: Array.isArray(options.fingerprints)
          ? options.fingerprints
          : null,
        allowAdvance: options.allowAdvance !== false,
        anchorId: options.anchorId ?? null,
        completionGuard:
          typeof options.completionGuard === "function"
            ? options.completionGuard
            : null,
      });
    });
  }, [enqueue, runMutation]);

  const applyRating = useCallback((value, options = {}) => {
    const requestedOwnership = inputRef.current.ownershipKey;
    const numeric = Number(value);
    const rating = value == null || value === 0
      ? null
      : Math.max(1, Math.min(5, Math.round(numeric)));
    if (rating !== null && !Number.isFinite(numeric)) {
      return Promise.resolve(false);
    }

    return enqueue(() => {
      if (!Object.is(inputRef.current.ownershipKey, requestedOwnership)) return false;
      return runMutation({
        kind: "rating",
        value: rating,
        mayAdvance: rating !== null,
        targetFingerprints: Array.isArray(options.fingerprints)
          ? options.fingerprints
          : null,
        allowAdvance: options.allowAdvance !== false,
        anchorId: options.anchorId ?? null,
        completionGuard:
          typeof options.completionGuard === "function"
            ? options.completionGuard
            : null,
      });
    });
  }, [enqueue, runMutation]);

  const undo = useCallback(() => {
    const requestedOwnership = inputRef.current.ownershipKey;
    return enqueue(async () => {
      const current = inputRef.current;
      const history = historyRef.current;
      if (
        !history ||
        !Object.is(current.ownershipKey, requestedOwnership) ||
        !Object.is(history.ownershipKey, current.ownershipKey)
      ) {
        if (history && !Object.is(history.ownershipKey, current.ownershipKey)) {
          historyRef.current = null;
          if (mountedRef.current) setCanUndo(false);
        }
        return false;
      }
      if (typeof current.restoreReviewMetadata !== "function") {
        return false;
      }

      let result;
      try {
        result = await current.restoreReviewMetadata(history.snapshots);
      } catch (error) {
        console.error("Failed to undo review workflow mutation:", error);
        return false;
      }
      if (!mutationSucceeded(result)) return false;
      if (!Object.is(inputRef.current.ownershipKey, history.ownershipKey)) {
        return true;
      }

      recordRestoredMetadataOverlay({ snapshots: history.snapshots, result });

      const latestVideos = makeVideoMap(inputRef.current.scopeVideos);
      const restorableIds = history.selectionIds.filter((id) => latestVideos.has(id));
      const restoredSelection = new Set(restorableIds);
      inputRef.current.selectedIds = restoredSelection;
      inputRef.current.setSelectedIds?.(restoredSelection);
      emitMutationCommitted({
        kind: "undo",
        value: null,
        allowCreateSession: false,
        ownershipKey: history.ownershipKey,
        anchor: history.anchor,
        fingerprints: history.snapshots.map((snapshot) => snapshot.fingerprint),
      });
      historyRef.current = null;
      pendingEndRef.current = null;
      if (mountedRef.current) setCanUndo(false);
      inputRef.current.notify?.("Undid last review change", "success");
      return true;
    });
  }, [emitMutationCommitted, enqueue, recordRestoredMetadataOverlay]);

  return {
    progress,
    applyReviewState,
    applyRating,
    undo,
    canUndo,
    isBusy,
  };
}
