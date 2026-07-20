import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildReviewCheckpointDraft,
  checkpointLocationMatches,
  createReviewCheckpointSignature,
  normalizeReviewCheckpoint,
} from "../../review/continueReview";

export const REVIEW_SESSION_SAVE_DEBOUNCE_MS = 400;
export const REVIEW_SESSION_SUMMARY_LIMIT = 128;

const EXPECTED_INVALIDATION_CODES = new Set([
  "APPLICATION_SHUTDOWN_REQUESTED",
  "DIRECTORY_SCAN_CANCELLED",
  "PROFILE_RECONFIGURATION_IN_PROGRESS",
]);

const sessionsApi = () => window.electronAPI?.review?.sessions;

const makeResultError = (result, fallback) => {
  const error = new Error(result?.error || fallback);
  if (result?.code) error.code = result.code;
  return error;
};

const assertSuccess = (result, fallback) => {
  if (result?.success === false) throw makeResultError(result, fallback);
  return result;
};

const isExpectedInvalidation = (error) =>
  EXPECTED_INVALIDATION_CODES.has(error?.code);

const normalizeRootPath = (value) =>
  typeof value === "string" && value.trim() ? value : "";

const normalizeSummary = (value) => {
  const rootPath = normalizeRootPath(value?.rootPath);
  if (!rootPath) return null;
  const normalized = normalizeReviewCheckpoint(value);
  return {
    rootPath,
    directory: normalized.directory,
    scope: normalized.scope,
    updatedAt: normalized.updatedAt,
  };
};

const normalizeSummaries = (values) => {
  const byRoot = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const summary = normalizeSummary(value);
    if (!summary || byRoot.has(summary.rootPath)) continue;
    byRoot.set(summary.rootPath, summary);
    if (byRoot.size >= REVIEW_SESSION_SUMMARY_LIMIT) break;
  }
  return Array.from(byRoot.values()).sort(
    (left, right) => right.updatedAt - left.updatedAt ||
      left.rootPath.localeCompare(right.rootPath)
  );
};

const createQueue = (epoch) => ({
  epoch,
  running: false,
  inFlight: null,
  trailing: null,
  drainPromise: Promise.resolve(null),
});

const queueHasPendingCreateForRoot = (queue, rootPath) =>
  Boolean(
    queue &&
      [queue.inFlight, queue.trailing].some(
        (item) =>
          item?.allowCreate === true && item?.draft?.rootPath === rootPath
      )
  );

export default function useReviewSessions({
  activeRootPath = null,
  activeDirectory = "",
  activeScope = "all-descendants",
  notify,
  debounceMs = REVIEW_SESSION_SAVE_DEBOUNCE_MS,
} = {}) {
  const [summaries, setSummaries] = useState([]);
  const [checkpoint, setCheckpoint] = useState(null);
  const [checkpointRootPath, setCheckpointRootPath] = useState(null);
  const [engagedRootPath, setEngagedRootPath] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const mountedRef = useRef(true);
  const inputRef = useRef({
    activeRootPath,
    activeDirectory,
    activeScope,
    notify,
  });
  inputRef.current = {
    activeRootPath,
    activeDirectory,
    activeScope,
    notify,
  };
  const summariesRef = useRef([]);
  const knownRootsRef = useRef(new Set());
  const listLoadedRef = useRef(false);
  const checkpointRef = useRef(null);
  const checkpointRootPathRef = useRef(null);
  const engagementRef = useRef({
    rootPath: null,
    directory: "",
    scope: "all-descendants",
    baselineSignature: null,
    lastAttemptedSignature: null,
  });
  const profileEpochRef = useRef(0);
  const listRequestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const queueRef = useRef(createQueue(0));
  const scheduledRef = useRef(null);
  const scheduleTimerRef = useRef(null);
  const flushingRef = useRef(0);
  const clearingRootsRef = useRef(new Set());

  const applySummaries = useCallback((nextSummaries) => {
    summariesRef.current = nextSummaries;
    knownRootsRef.current = new Set(
      nextSummaries.map((summary) => summary.rootPath)
    );
    if (mountedRef.current) setSummaries(nextSummaries);
  }, []);

  const applyCheckpoint = useCallback((nextCheckpoint) => {
    checkpointRef.current = nextCheckpoint;
    checkpointRootPathRef.current = nextCheckpoint?.rootPath || null;
    if (mountedRef.current) {
      setCheckpoint(nextCheckpoint);
      setCheckpointRootPath(nextCheckpoint?.rootPath || null);
    }
  }, []);

  const reportError = useCallback((nextError, fallback) => {
    if (isExpectedInvalidation(nextError)) return;
    const message = nextError?.message || fallback;
    if (mountedRef.current) setError(message);
    inputRef.current.notify?.(message, "error");
  }, []);

  const upsertCheckpoint = useCallback((nextCheckpoint) => {
    const normalized = normalizeReviewCheckpoint(nextCheckpoint);
    const summary = normalizeSummary(normalized);
    if (!summary) return null;
    const nextSummaries = normalizeSummaries([
      summary,
      ...summariesRef.current.filter((item) => item.rootPath !== summary.rootPath),
    ]);
    applySummaries(nextSummaries);
    if (
      checkpointRootPathRef.current === normalized.rootPath ||
      inputRef.current.activeRootPath === normalized.rootPath ||
      !checkpointRootPathRef.current
    ) {
      applyCheckpoint(normalized);
    }
    return normalized;
  }, [applyCheckpoint, applySummaries]);

  const persistItem = useCallback(async (item, queue) => {
    const api = sessionsApi();
    if (!api?.save) return null;
    try {
      const result = assertSuccess(
        await api.save(item.draft),
        "Could not save the review position"
      );
      if (
        queueRef.current !== queue ||
        queue.epoch !== profileEpochRef.current
      ) {
        return null;
      }
      const nextCheckpoint = result?.checkpoint
        ? upsertCheckpoint(result.checkpoint)
        : null;
      if (nextCheckpoint) {
        const engagement = engagementRef.current;
        if (engagement.rootPath === item.draft.rootPath) {
          engagementRef.current = {
            ...engagement,
            baselineSignature: item.signature,
            lastAttemptedSignature: item.signature,
          };
        }
        if (mountedRef.current) setError(null);
      }
      return nextCheckpoint;
    } catch (nextError) {
      if (
        queueRef.current === queue &&
        queue.epoch === profileEpochRef.current
      ) {
        const engagement = engagementRef.current;
        if (
          engagement.rootPath === item.draft.rootPath &&
          engagement.lastAttemptedSignature === item.signature
        ) {
          engagementRef.current = {
            ...engagement,
            lastAttemptedSignature: engagement.baselineSignature,
          };
        }
        reportError(nextError, "Could not save the review position");
      }
      return null;
    }
  }, [reportError, upsertCheckpoint]);

  const startQueue = useCallback((queue, firstItem) => {
    queue.running = true;
    queue.inFlight = firstItem;
    if (queueRef.current === queue && mountedRef.current) setSaving(true);

    const drain = (async () => {
      let lastResult = null;
      while (queue.inFlight) {
        lastResult = await persistItem(queue.inFlight, queue);
        queue.inFlight = queue.trailing;
        queue.trailing = null;
      }
      return lastResult;
    })();

    queue.drainPromise = drain.finally(() => {
      queue.running = false;
      queue.inFlight = null;
      if (queueRef.current === queue && mountedRef.current) setSaving(false);
    });
    return queue.drainPromise;
  }, [persistItem]);

  const enqueueDraft = useCallback((draftInput, {
    allowCreate = false,
    engage = false,
    signature,
  } = {}) => {
    const draft = buildReviewCheckpointDraft(draftInput);
    const rootPath = draft.rootPath;
    const queue = queueRef.current;
    if (!rootPath || clearingRootsRef.current.has(rootPath)) {
      return Promise.resolve(null);
    }
    if (
      !allowCreate &&
      !knownRootsRef.current.has(rootPath) &&
      !queueHasPendingCreateForRoot(queue, rootPath)
    ) {
      return Promise.resolve(null);
    }

    const itemSignature = typeof signature === "string"
      ? signature
      : createReviewCheckpointSignature(draft);
    if (engage) {
      engagementRef.current = {
        rootPath,
        directory: draft.directory,
        scope: draft.scope,
        baselineSignature: knownRootsRef.current.has(rootPath)
          ? engagementRef.current.baselineSignature
          : null,
        lastAttemptedSignature: itemSignature,
      };
      if (mountedRef.current) setEngagedRootPath(rootPath);
    } else if (engagementRef.current.rootPath === rootPath) {
      engagementRef.current = {
        ...engagementRef.current,
        lastAttemptedSignature: itemSignature,
      };
    }

    const item = {
      draft,
      signature: itemSignature,
      allowCreate,
    };
    if (queue.running) {
      queue.trailing = item;
      return queue.drainPromise;
    }
    return startQueue(queue, item);
  }, [startQueue]);

  const cancelScheduled = useCallback((rootPath = null) => {
    const scheduled = scheduledRef.current;
    if (!scheduled || (rootPath && scheduled.draft.rootPath !== rootPath)) {
      return null;
    }
    if (scheduleTimerRef.current !== null) {
      clearTimeout(scheduleTimerRef.current);
      scheduleTimerRef.current = null;
    }
    scheduledRef.current = null;
    return scheduled;
  }, []);

  const refresh = useCallback(async () => {
    const api = sessionsApi();
    if (!api?.list) return [];
    const requestId = ++listRequestRef.current;
    const epoch = profileEpochRef.current;
    try {
      const result = assertSuccess(
        await api.list(),
        "Could not load saved review positions"
      );
      if (
        requestId !== listRequestRef.current ||
        epoch !== profileEpochRef.current
      ) {
        return [];
      }
      const nextSummaries = normalizeSummaries(result?.sessions);
      listLoadedRef.current = true;
      applySummaries(nextSummaries);
      if (mountedRef.current) setError(null);
      return nextSummaries;
    } catch (nextError) {
      if (
        requestId === listRequestRef.current &&
        epoch === profileEpochRef.current
      ) {
        reportError(nextError, "Could not load saved review positions");
      }
      return [];
    }
  }, [applySummaries, reportError]);

  const load = useCallback(async (rootPathInput) => {
    const rootPath = normalizeRootPath(rootPathInput);
    const api = sessionsApi();
    if (!rootPath || !api?.get) return null;
    const requestId = ++loadRequestRef.current;
    const epoch = profileEpochRef.current;
    try {
      const result = assertSuccess(
        await api.get(rootPath),
        "Could not load the saved review position"
      );
      if (
        requestId !== loadRequestRef.current ||
        epoch !== profileEpochRef.current
      ) {
        return null;
      }
      const nextCheckpoint = result?.checkpoint
        ? upsertCheckpoint(result.checkpoint)
        : null;
      if (!nextCheckpoint && checkpointRootPathRef.current === rootPath) {
        applyCheckpoint(null);
      }
      if (mountedRef.current) setError(null);
      return nextCheckpoint;
    } catch (nextError) {
      if (
        requestId === loadRequestRef.current &&
        epoch === profileEpochRef.current
      ) {
        reportError(nextError, "Could not load the saved review position");
      }
      return null;
    }
  }, [applyCheckpoint, reportError, upsertCheckpoint]);

  const engage = useCallback((rootPathInput, baselineSignatureOrDraft) => {
    const rootPath = normalizeRootPath(rootPathInput);
    if (!rootPath) return false;
    let baselineSignature = null;
    let location = null;
    if (typeof baselineSignatureOrDraft === "string") {
      baselineSignature = baselineSignatureOrDraft;
    } else if (baselineSignatureOrDraft) {
      location = buildReviewCheckpointDraft({
        ...baselineSignatureOrDraft,
        rootPath,
      });
      baselineSignature = createReviewCheckpointSignature(location);
    } else if (checkpointRootPathRef.current === rootPath) {
      location = buildReviewCheckpointDraft(checkpointRef.current);
      baselineSignature = createReviewCheckpointSignature(location);
    }
    if (!location) {
      const active = inputRef.current;
      location = buildReviewCheckpointDraft({
        rootPath,
        directory:
          active.activeRootPath === rootPath ? active.activeDirectory : "",
        scope:
          active.activeRootPath === rootPath
            ? active.activeScope
            : "all-descendants",
      });
    }
    engagementRef.current = {
      rootPath,
      directory: location.directory,
      scope: location.scope,
      baselineSignature,
      lastAttemptedSignature: baselineSignature,
    };
    if (mountedRef.current) setEngagedRootPath(rootPath);
    return true;
  }, []);

  const disengage = useCallback((rootPathInput = null) => {
    const rootPath = rootPathInput == null
      ? null
      : normalizeRootPath(rootPathInput);
    if (rootPath && engagementRef.current.rootPath !== rootPath) return false;
    cancelScheduled(engagementRef.current.rootPath);
    engagementRef.current = {
      rootPath: null,
      directory: "",
      scope: "all-descendants",
      baselineSignature: null,
      lastAttemptedSignature: null,
    };
    if (mountedRef.current) setEngagedRootPath(null);
    return true;
  }, [cancelScheduled]);

  const saveNow = useCallback((draft, options = {}) => {
    const normalizedDraft = buildReviewCheckpointDraft(draft);
    cancelScheduled(normalizedDraft.rootPath);
    return enqueueDraft(normalizedDraft, options);
  }, [cancelScheduled, enqueueDraft]);

  const schedule = useCallback((draftInput, {
    allowCreate = false,
    signature,
  } = {}) => {
    const draft = buildReviewCheckpointDraft(draftInput);
    const rootPath = draft.rootPath;
    if (
      !rootPath ||
      !checkpointLocationMatches(engagementRef.current, draft) ||
      (!allowCreate &&
        !knownRootsRef.current.has(rootPath) &&
        !queueHasPendingCreateForRoot(queueRef.current, rootPath)) ||
      clearingRootsRef.current.has(rootPath)
    ) {
      return false;
    }
    const itemSignature = typeof signature === "string"
      ? signature
      : createReviewCheckpointSignature(draft);
    if (scheduledRef.current?.signature === itemSignature) return false;
    if (
      !queueRef.current.running &&
      engagementRef.current.baselineSignature === itemSignature
    ) {
      cancelScheduled(rootPath);
      return false;
    }

    cancelScheduled(rootPath);
    scheduledRef.current = { draft, allowCreate, signature: itemSignature };
    const enqueueScheduled = () => {
      const scheduled = scheduledRef.current;
      scheduledRef.current = null;
      scheduleTimerRef.current = null;
      if (scheduled) enqueueDraft(scheduled.draft, scheduled);
    };
    if (flushingRef.current > 0) {
      enqueueScheduled();
    } else {
      const delay = Number.isFinite(debounceMs)
        ? Math.max(0, debounceMs)
        : REVIEW_SESSION_SAVE_DEBOUNCE_MS;
      scheduleTimerRef.current = setTimeout(enqueueScheduled, delay);
    }
    return true;
  }, [cancelScheduled, debounceMs, enqueueDraft]);

  const flush = useCallback(async () => {
    flushingRef.current += 1;
    try {
      while (true) {
        const scheduled = cancelScheduled();
        if (scheduled) enqueueDraft(scheduled.draft, scheduled);
        const queue = queueRef.current;
        if (queue.running) await queue.drainPromise;
        if (
          queue === queueRef.current &&
          !scheduledRef.current &&
          !queue.running
        ) {
          return;
        }
      }
    } finally {
      flushingRef.current = Math.max(0, flushingRef.current - 1);
    }
  }, [cancelScheduled, enqueueDraft]);

  const clear = useCallback(async (rootPathInput) => {
    const rootPath = normalizeRootPath(rootPathInput);
    const api = sessionsApi();
    if (!rootPath || !api?.clear || clearingRootsRef.current.has(rootPath)) {
      return false;
    }
    clearingRootsRef.current.add(rootPath);
    cancelScheduled(rootPath);
    if (queueRef.current.trailing?.draft.rootPath === rootPath) {
      queueRef.current.trailing = null;
    }
    try {
      const queue = queueRef.current;
      if (queue.running) await queue.drainPromise;
      if (queue !== queueRef.current) return false;
      const epoch = profileEpochRef.current;
      const result = assertSuccess(
        await api.clear(rootPath),
        "Could not forget the saved review position"
      );
      if (epoch !== profileEpochRef.current) return false;
      const deleted = Boolean(result?.deleted);
      if (deleted) {
        applySummaries(
          summariesRef.current.filter((summary) => summary.rootPath !== rootPath)
        );
        if (checkpointRootPathRef.current === rootPath) applyCheckpoint(null);
        if (engagementRef.current.rootPath === rootPath) disengage(rootPath);
      }
      if (mountedRef.current) setError(null);
      return deleted;
    } catch (nextError) {
      reportError(nextError, "Could not forget the saved review position");
      return false;
    } finally {
      clearingRootsRef.current.delete(rootPath);
    }
  }, [
    applyCheckpoint,
    applySummaries,
    cancelScheduled,
    disengage,
    reportError,
  ]);

  const hasCheckpoint = useCallback((rootPathInput) => {
    const rootPath = normalizeRootPath(rootPathInput);
    return Boolean(
      rootPath && (
        knownRootsRef.current.has(rootPath) ||
        checkpointRootPathRef.current === rootPath
      )
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
      listRequestRef.current += 1;
      loadRequestRef.current += 1;
      cancelScheduled();
      queueRef.current.trailing = null;
    };
  }, [cancelScheduled, refresh]);

  useEffect(() => {
    const subscribe = window.electronAPI?.profiles?.onChanged;
    if (!subscribe) return undefined;
    return subscribe(() => {
      profileEpochRef.current += 1;
      listRequestRef.current += 1;
      loadRequestRef.current += 1;
      listLoadedRef.current = false;
      cancelScheduled();
      queueRef.current.trailing = null;
      queueRef.current = createQueue(profileEpochRef.current);
      clearingRootsRef.current.clear();
      engagementRef.current = {
        rootPath: null,
        directory: "",
        scope: "all-descendants",
        baselineSignature: null,
        lastAttemptedSignature: null,
      };
      applySummaries([]);
      applyCheckpoint(null);
      if (mountedRef.current) {
        setEngagedRootPath(null);
        setSaving(false);
        setError(null);
      }
      refresh();
    });
  }, [applyCheckpoint, applySummaries, cancelScheduled, refresh]);

  useEffect(() => {
    const api = sessionsApi();
    if (!api?.onFlushRequested) return undefined;
    return api.onFlushRequested((payload) => {
      const requestId = payload?.requestId;
      Promise.resolve()
        .then(() => flush())
        .catch(() => {})
        .finally(() => {
          try {
            const acknowledgement = api.acknowledgeFlush?.(requestId);
            acknowledgement?.catch?.(() => {});
          } catch {}
        });
    });
  }, [flush]);

  useEffect(() => {
    const rootPath = normalizeRootPath(activeRootPath);
    if (!listLoadedRef.current) return;
    if (!rootPath || !knownRootsRef.current.has(rootPath)) return;
    if (checkpointRootPathRef.current !== rootPath) load(rootPath);
  }, [activeRootPath, load, summaries]);

  const summaryByRoot = useMemo(
    () => new Map(summaries.map((summary) => [summary.rootPath, summary])),
    [summaries]
  );

  return {
    summaries,
    summaryByRoot,
    checkpoint,
    checkpointRootPath,
    engagedRootPath,
    isEngaged: Boolean(
      activeRootPath &&
      checkpointLocationMatches(engagementRef.current, {
        rootPath: activeRootPath,
        directory: activeDirectory,
        scope: activeScope,
      })
    ),
    saving,
    error,
    hasCheckpoint,
    refresh,
    load,
    engage,
    disengage,
    saveNow,
    schedule,
    flush,
    clear,
  };
}
