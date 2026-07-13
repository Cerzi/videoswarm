// main/watcher.js
// Single-instance folder watcher with graceful polling fallback.
// Emits: 'mode', 'ready', 'added', 'removed', 'changed', 'error'

const chokidar = require("chokidar");
const { EventEmitter } = require("events");

const EMPTY_CONTEXT = Object.freeze({});
const DEFAULT_WATCHER_LIMITS = Object.freeze({
  maxChangeDebouncers: 2048,
  enrichmentConcurrency: 2,
  maxPendingEnrichments: 2048,
  maxOutstandingEnrichments: 8,
  reconciliationRetryBaseMs: 250,
  maxReconciliationRetries: 3,
});

function finiteInteger(value, fallback, minimum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.floor(numeric));
}

class StaleWatcherSessionError extends Error {
  constructor() {
    super("Watcher session is no longer active");
    this.name = "StaleWatcherSessionError";
    this.code = "WATCHER_SESSION_STALE";
  }
}

function createFolderWatcher({
  isVideoFile,
  createVideoFileObject,
  scanFolderForChanges,   // used for polling fallback
  logger = console,
  depth = 10,             // keep your previous recursion limit; set to undefined for unlimited
  maxChangeDebouncers = DEFAULT_WATCHER_LIMITS.maxChangeDebouncers,
  enrichmentConcurrency = DEFAULT_WATCHER_LIMITS.enrichmentConcurrency,
  maxPendingEnrichments = DEFAULT_WATCHER_LIMITS.maxPendingEnrichments,
  maxOutstandingEnrichments = DEFAULT_WATCHER_LIMITS.maxOutstandingEnrichments,
  reconciliationRetryBaseMs = DEFAULT_WATCHER_LIMITS.reconciliationRetryBaseMs,
  maxReconciliationRetries = DEFAULT_WATCHER_LIMITS.maxReconciliationRetries,
}) {
  if (typeof isVideoFile !== "function") {
    throw new Error("createFolderWatcher: isVideoFile(fn) is required");
  }
  if (typeof createVideoFileObject !== "function") {
    throw new Error("createFolderWatcher: createVideoFileObject(fn) is required");
  }
  if (typeof scanFolderForChanges !== "function") {
    throw new Error("createFolderWatcher: scanFolderForChanges(fn) is required");
  }

  const events = new EventEmitter();
  const changeDebouncerLimit = finiteInteger(
    maxChangeDebouncers,
    DEFAULT_WATCHER_LIMITS.maxChangeDebouncers,
    1
  );
  const enrichmentConcurrencyLimit = finiteInteger(
    enrichmentConcurrency,
    DEFAULT_WATCHER_LIMITS.enrichmentConcurrency,
    1
  );
  const pendingEnrichmentLimit = finiteInteger(
    maxPendingEnrichments,
    DEFAULT_WATCHER_LIMITS.maxPendingEnrichments,
    0
  );
  const outstandingEnrichmentLimit = finiteInteger(
    maxOutstandingEnrichments,
    DEFAULT_WATCHER_LIMITS.maxOutstandingEnrichments,
    1
  );
  const reconciliationRetryBase = finiteInteger(
    reconciliationRetryBaseMs,
    DEFAULT_WATCHER_LIMITS.reconciliationRetryBaseMs,
    1
  );
  const reconciliationRetryLimit = finiteInteger(
    maxReconciliationRetries,
    DEFAULT_WATCHER_LIMITS.maxReconciliationRetries,
    0
  );

  let fileWatcher = null; // active chokidar watcher (native events)
  let pollingInterval = null; // setInterval id (polling fallback)
  let currentFolder = null; // current root
  let currentOptions = { recursive: true, context: EMPTY_CONTEXT };
  let activeSession = null;
  let sessionSequence = 0;
  let lifecycleGeneration = 0;
  const changeTimeouts = new Map(); // debounce timers per file
  const pendingEnrichments = new Map(); // one coalesced job per path
  const activeEnrichments = new Map(); // at most one current-session job per path
  const rawEnrichments = new Map(); // retained until createVideoFileObject settles
  let enrichmentSequence = 0;
  let disposed = false;
  const enrichmentTotals = {
    queued: 0,
    coalesced: 0,
    completed: 0,
    overflowed: 0,
    cancelled: 0,
    reconciliations: 0,
    reconciliationFailures: 0,
    reconciliationRetries: 0,
    rawStarted: 0,
    rawSettled: 0,
  };

  // ---- helpers ----
  function isPolling() {
    return !!pollingInterval;
  }

  function getCurrentFolder() {
    return currentFolder;
  }

  function getSnapshot() {
    let retiredEnrichments = 0;
    for (const record of rawEnrichments.values()) {
      if (
        record.item.cancelled ||
        record.item.released ||
        !isSessionActive(record.item.session)
      ) {
        retiredEnrichments += 1;
      }
    }
    return {
      disposed,
      currentFolder,
      mode: isPolling() ? "polling" : fileWatcher ? "watch" : "stopped",
      pendingChangeDebouncers: changeTimeouts.size,
      activeEnrichments: activeEnrichments.size,
      outstandingEnrichments: rawEnrichments.size,
      retiredEnrichments,
      pendingEnrichments: pendingEnrichments.size,
      reconciliationNeeded: Boolean(activeSession?.reconciliationNeeded),
      reconciliationInFlight: Boolean(activeSession?.reconciliationInFlight),
      reconciliationRetryScheduled: Boolean(
        activeSession?.reconciliationRetryTimer
      ),
      reconciliationAttempts: activeSession?.reconciliationAttempts || 0,
      reconciliationRetryExhausted: Boolean(
        activeSession?.reconciliationRetryExhausted
      ),
      limits: {
        maxChangeDebouncers: changeDebouncerLimit,
        enrichmentConcurrency: enrichmentConcurrencyLimit,
        maxPendingEnrichments: pendingEnrichmentLimit,
        maxOutstandingEnrichments: outstandingEnrichmentLimit,
        reconciliationRetryBaseMs: reconciliationRetryBase,
        maxReconciliationRetries: reconciliationRetryLimit,
      },
      totals: { ...enrichmentTotals },
    };
  }

  function clearChangeDebouncers() {
    for (const entry of changeTimeouts.values()) {
      clearTimeout(entry.timer);
    }
    changeTimeouts.clear();
  }

  function clearPendingEnrichments() {
    pendingEnrichments.clear();
  }

  function isSessionActive(session) {
    return !!session &&
      session.active &&
      activeSession === session &&
      session.context?.cancelled !== true;
  }

  function assertSessionActive(session) {
    if (!isSessionActive(session)) {
      throw new StaleWatcherSessionError();
    }
  }

  function isStaleSessionError(error) {
    return error?.code === "WATCHER_SESSION_STALE";
  }

  function eventMetadata(session) {
    return {
      folderPath: session.folderPath,
      sessionId: session.sessionId,
      context: session.context,
    };
  }

  function helperContext(session, item = null) {
    return {
      ...session.context,
      ...(item?.abortController
        ? { signal: item.abortController.signal }
        : {}),
      assertActive: () => {
        assertSessionActive(session);
        if (item?.cancelled) throw new StaleWatcherSessionError();
      },
    };
  }

  function pollingOptions(session) {
    return {
      recursive: session.recursive,
      ...session.context,
      assertActive: () => assertSessionActive(session),
      pollingState: session.pollingState,
    };
  }

  function createSession(folderPath, options) {
    const context =
      options.context && typeof options.context === "object"
        ? options.context
        : EMPTY_CONTEXT;
    const session = {
      sessionId: `watch-${++sessionSequence}`,
      folderPath,
      recursive: options.recursive,
      context,
      active: true,
      fellBack: false,
      pollInFlight: null,
      reconciliationNeeded: false,
      reconciliationInFlight: null,
      reconciliationVersion: 0,
      reconciliationAttempts: 0,
      reconciliationRetryExhausted: false,
      reconciliationRetryTimer: null,
      pollingState: {
        lastFiles: new Map(),
        initialized: false,
      },
    };

    activeSession = session;
    currentFolder = folderPath;
    currentOptions = {
      recursive: options.recursive,
      context,
    };
    return session;
  }

  function invalidateActiveSession() {
    const session = activeSession;
    if (session) {
      session.active = false;
    }
    activeSession = null;
    return session;
  }

  // Detach synchronously. In particular, stop() must invalidate assertActive
  // before it waits for chokidar.close(), and an old close must never clear a
  // newer watcher's state when starts overlap.
  function detachActiveResources() {
    const watcherToClose = fileWatcher;
    fileWatcher = null;

    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    clearChangeDebouncers();
    clearPendingEnrichments();
    const invalidatedSession = invalidateActiveSession();
    if (invalidatedSession?.reconciliationRetryTimer) {
      clearTimeout(invalidatedSession.reconciliationRetryTimer);
      invalidatedSession.reconciliationRetryTimer = null;
    }
    cancelActiveEnrichmentsForSession(invalidatedSession);
    currentFolder = null;
    currentOptions = { recursive: true, context: EMPTY_CONTEXT };
    return watcherToClose;
  }

  async function closeNativeWatcher(watcherToClose) {
    if (!watcherToClose) return;
    try {
      watcherToClose.removeAllListeners?.();
      await watcherToClose.close();
    } catch (error) {
      logger.warn("[watch] Error closing watcher:", error);
    }
  }

  async function stop() {
    lifecycleGeneration += 1;
    const watcherToClose = detachActiveResources();
    await closeNativeWatcher(watcherToClose);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    await stop();
    events.removeAllListeners();
  }

  async function runPollingScan(session, label = "scan") {
    if (!isSessionActive(session)) return { success: false, stale: true };
    if (session.pollInFlight) return session.pollInFlight;

    let runPromise;
    runPromise = Promise.resolve()
      .then(async () => {
        assertSessionActive(session);
        await scanFolderForChanges(
          session.folderPath,
          pollingOptions(session)
        );
        assertSessionActive(session);
        return { success: true };
      })
      .catch((error) => {
        if (!isSessionActive(session) || isStaleSessionError(error)) {
          return { success: false, stale: true, error };
        }
        logger.error(`[watch] Polling ${label} failed:`, error);
        events.emit("error", error, eventMetadata(session));
        return { success: false, stale: false, error };
      })
      .finally(() => {
        if (session.pollInFlight === runPromise) {
          session.pollInFlight = null;
        }
      });

    session.pollInFlight = runPromise;
    return runPromise;
  }

  function startPollingMode(session) {
    if (!isSessionActive(session)) return;

    logger.log(
      "[watch] Starting polling mode:",
      session.folderPath,
      `(recursive=${session.recursive})`
    );
    events.emit("mode", {
      mode: "polling",
      recursive: session.recursive,
      ...eventMetadata(session),
    });

    // Polling owns a separate single-flight scan lane. It must not wait for a
    // retired native-event enrichment that may be stalled indefinitely.
    void runPollingScan(session, "initial scan");
    pollingInterval = setInterval(() => {
      void runPollingScan(session);
    }, 5000);

    return {
      success: true,
      mode: "polling",
      recursive: session.recursive,
      sessionId: session.sessionId,
    };
  }

  function createCancellation() {
    let cancel;
    const promise = new Promise((resolve) => {
      cancel = resolve;
    });
    return { promise, cancel };
  }

  function trackRawEnrichment(item, creation) {
    const record = { item, creation };
    rawEnrichments.set(item.id, record);
    enrichmentTotals.rawStarted += 1;
    const settle = () => {
      if (rawEnrichments.get(item.id) !== record) return;
      rawEnrichments.delete(item.id);
      enrichmentTotals.rawSettled += 1;
      drainEnrichmentQueue();
      maybeRunOverflowReconciliation();
    };
    void creation.then(settle, settle);
    return creation;
  }

  function assertEnrichmentActive(item) {
    if (
      item.cancelled ||
      !isSessionActive(item.session) ||
      activeEnrichments.get(item.filePath) !== item
    ) {
      throw new StaleWatcherSessionError();
    }
  }

  async function emitVideoEvent(item) {
    const { session, eventName, filePath } = item;
    if (!isSessionActive(session) || !isVideoFile(filePath)) return;

    try {
      assertEnrichmentActive(item);
      let creation;
      try {
        creation = Promise.resolve(
          createVideoFileObject(
            filePath,
            session.folderPath,
            helperContext(session, item)
          )
        );
      } catch (error) {
        creation = Promise.reject(error);
      }
      trackRawEnrichment(item, creation);
      const outcome = await Promise.race([
        creation.then(
          (videoFile) => ({ videoFile }),
          (error) => ({ error })
        ),
        item.cancellation.promise.then(() => ({ cancelled: true })),
      ]);
      if (outcome.cancelled) return;
      if (outcome.error) throw outcome.error;
      assertEnrichmentActive(item);
      if (outcome.videoFile) {
        events.emit(eventName, outcome.videoFile, eventMetadata(session));
      }
    } catch (error) {
      if (
        item.cancelled ||
        !isSessionActive(session) ||
        isStaleSessionError(error)
      ) {
        return;
      }
      logger.error(
        `[watch:${eventName === "added" ? "add" : "change"}] createVideoFileObject failed:`,
        error
      );
      events.emit("error", error, eventMetadata(session));
    }
  }

  function mergeEventName(current, incoming) {
    return current === "added" || incoming === "added" ? "added" : "changed";
  }

  function markOverflowReconciliation(session) {
    if (!isSessionActive(session)) return;
    session.reconciliationNeeded = true;
    session.reconciliationVersion += 1;
    session.reconciliationAttempts = 0;
    session.reconciliationRetryExhausted = false;
    if (session.reconciliationRetryTimer) {
      clearTimeout(session.reconciliationRetryTimer);
      session.reconciliationRetryTimer = null;
    }
  }

  function scheduleReconciliationRetry(session) {
    if (
      !isSessionActive(session) ||
      session.reconciliationRetryTimer ||
      session.reconciliationRetryExhausted
    ) {
      return;
    }
    if (session.reconciliationAttempts > reconciliationRetryLimit) {
      session.reconciliationRetryExhausted = true;
      return;
    }
    const exponent = Math.max(0, session.reconciliationAttempts - 1);
    const delay = reconciliationRetryBase * Math.min(16, 2 ** exponent);
    session.reconciliationRetryTimer = setTimeout(() => {
      session.reconciliationRetryTimer = null;
      if (!isSessionActive(session)) return;
      enrichmentTotals.reconciliationRetries += 1;
      maybeRunOverflowReconciliation(session);
    }, delay);
  }

  function maybeRunOverflowReconciliation(session = activeSession) {
    if (
      !isSessionActive(session) ||
      !session.reconciliationNeeded ||
      session.reconciliationInFlight ||
      session.reconciliationRetryTimer ||
      session.reconciliationRetryExhausted ||
      activeEnrichments.size > 0 ||
      pendingEnrichments.size > 0
    ) {
      return;
    }

    const attemptedVersion = session.reconciliationVersion;
    enrichmentTotals.reconciliations += 1;
    const reconciliation = runPollingScan(session, "overflow reconciliation");
    session.reconciliationInFlight = reconciliation;
    const finishReconciliation = (result) => {
      if (session.reconciliationInFlight === reconciliation) {
        session.reconciliationInFlight = null;
      }
      if (result?.success) {
        session.reconciliationAttempts = 0;
        session.reconciliationRetryExhausted = false;
        if (session.reconciliationVersion === attemptedVersion) {
          session.reconciliationNeeded = false;
        }
      } else if (isSessionActive(session) && !result?.stale) {
        enrichmentTotals.reconciliationFailures += 1;
        session.reconciliationAttempts += 1;
        scheduleReconciliationRetry(session);
      }
      drainEnrichmentQueue();
      maybeRunOverflowReconciliation(session);
    };
    void reconciliation.then(finishReconciliation, (error) =>
      finishReconciliation({ success: false, stale: false, error })
    );
  }

  function releaseActiveEnrichment(item) {
    if (item.released) return false;
    item.released = true;
    if (activeEnrichments.get(item.filePath) === item) {
      activeEnrichments.delete(item.filePath);
    }
    return true;
  }

  function cancelActiveEnrichment(item) {
    if (!item || item.cancelled) return false;
    item.cancelled = true;
    item.followUpEventName = null;
    item.abortController?.abort();
    item.cancellation.cancel();
    releaseActiveEnrichment(item);
    enrichmentTotals.cancelled += 1;
    return true;
  }

  function cancelActiveEnrichmentsForSession(session) {
    if (!session) return;
    for (const item of [...activeEnrichments.values()]) {
      if (item.session === session) cancelActiveEnrichment(item);
    }
  }

  function drainEnrichmentQueue() {
    if (activeSession?.reconciliationInFlight) return;

    while (
      activeEnrichments.size < enrichmentConcurrencyLimit &&
      rawEnrichments.size < outstandingEnrichmentLimit &&
      pendingEnrichments.size > 0
    ) {
      const [filePath, item] = pendingEnrichments.entries().next().value;
      pendingEnrichments.delete(filePath);
      if (!isSessionActive(item.session)) continue;

      const cancellation = createCancellation();
      const activeItem = {
        ...item,
        id: ++enrichmentSequence,
        filePath,
        cancellation,
        abortController: new AbortController(),
        cancelled: false,
        released: false,
        followUpEventName: null,
      };
      activeEnrichments.set(filePath, activeItem);
      const enrichment = emitVideoEvent(activeItem);
      const finishEnrichment = () => {
        const followUpEventName = activeItem.cancelled
          ? null
          : activeItem.followUpEventName;
        releaseActiveEnrichment(activeItem);
        enrichmentTotals.completed += 1;
        if (followUpEventName && isSessionActive(activeItem.session)) {
          enqueueVideoEvent(
            activeItem.session,
            followUpEventName,
            activeItem.filePath
          );
        }
        drainEnrichmentQueue();
        maybeRunOverflowReconciliation();
      };
      void enrichment.then(finishEnrichment, finishEnrichment);
    }

    maybeRunOverflowReconciliation();
  }

  function enqueueVideoEvent(session, eventName, filePath) {
    if (!isSessionActive(session)) return false;
    if (
      session.reconciliationNeeded &&
      session.reconciliationRetryExhausted
    ) {
      session.reconciliationRetryExhausted = false;
      session.reconciliationAttempts = 0;
    }
    const active = activeEnrichments.get(filePath);
    if (active && active.session === session && !active.cancelled) {
      active.followUpEventName = active.followUpEventName
        ? mergeEventName(active.followUpEventName, eventName)
        : eventName;
      enrichmentTotals.coalesced += 1;
      return true;
    }
    const existing = pendingEnrichments.get(filePath);
    if (existing) {
      existing.eventName = mergeEventName(existing.eventName, eventName);
      enrichmentTotals.coalesced += 1;
      return true;
    }

    if (pendingEnrichments.size >= pendingEnrichmentLimit) {
      markOverflowReconciliation(session);
      enrichmentTotals.overflowed += 1;
      maybeRunOverflowReconciliation(session);
      return false;
    }

    pendingEnrichments.set(filePath, { eventName, session });
    enrichmentTotals.queued += 1;
    drainEnrichmentQueue();
    return true;
  }

  function dispatchDebouncedChange(filePath, entry) {
    if (changeTimeouts.get(filePath) !== entry) return;
    changeTimeouts.delete(filePath);
    if (!isSessionActive(entry.session)) return;
    logger.log("Video file changed:", filePath);
    enqueueVideoEvent(entry.session, "changed", filePath);
  }

  function flushOldestChangeDebouncer() {
    const oldest = changeTimeouts.entries().next().value;
    if (!oldest) return;
    const [filePath, entry] = oldest;
    clearTimeout(entry.timer);
    dispatchDebouncedChange(filePath, entry);
  }

  async function start(folderPath, options = {}) {
    if (disposed) {
      throw new Error("Folder watcher is disposed");
    }
    const recursive = options.recursive ?? true;
    const context =
      options.context && typeof options.context === "object"
        ? options.context
        : EMPTY_CONTEXT;

    // An identical request can reuse the existing watcher. A new context is a
    // new ownership generation even when the root path did not change.
    if (
      currentFolder === folderPath &&
      currentOptions.recursive === recursive &&
      currentOptions.context === context &&
      isSessionActive(activeSession) &&
      (fileWatcher || pollingInterval)
    ) {
      return {
        success: true,
        mode: isPolling() ? "polling" : "watch",
        recursive,
        sessionId: activeSession.sessionId,
      };
    }

    const startGeneration = ++lifecycleGeneration;
    const watcherToClose = detachActiveResources();
    await closeNativeWatcher(watcherToClose);

    // A later start/stop superseded this request while the old watcher closed.
    if (startGeneration !== lifecycleGeneration) {
      return { success: false, cancelled: true, recursive };
    }

    const session = createSession(folderPath, { recursive, context });
    let nativeWatcher;
    try {
      // Create chokidar watcher (native events)
      nativeWatcher = chokidar.watch(folderPath, {
        ignored: [
          /(^|[\/\\])\../,      // ignore dot files/dirs
          "**/node_modules/**",
          "**/.git/**",
          "**/System Volume Information/**",
          "**/$RECYCLE.BIN/**",
        ],
        persistent: true,
        ignoreInitial: true,
        ...(recursive
          ? { depth }
          : { depth: 0 }), // follow recursion preference

        // Prefer native events
        usePolling: false,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },

        // Churn/permissions
        atomic: true,
        alwaysStat: false,
        followSymlinks: false,
        ignorePermissionErrors: true,

        // Platform quirks
        ...(process.platform === "darwin" && { useFsEvents: true }),
        ...(process.platform === "win32" && { useReaddir: false }),
      });
    } catch (error) {
      if (isSessionActive(session)) {
        detachActiveResources();
      }
      throw error;
    }

    fileWatcher = nativeWatcher;

    // ---- events ----
    nativeWatcher.on("ready", () => {
      if (!isSessionActive(session) || fileWatcher !== nativeWatcher) return;
      // Instrumentation: count directories/files chokidar believes it has
      try {
        const watched = nativeWatcher.getWatched?.() || {};
        const dirs = Object.keys(watched).length;
        let files = 0;
        for (const dir in watched) files += watched[dir].length;
        logger.log(`[watch] ready: dirs=${dirs} files=${files}`);
      } catch {}
      events.emit("mode", {
        mode: "watch",
        recursive: session.recursive,
        ...eventMetadata(session),
      });
      events.emit("ready", eventMetadata(session));
      logger.log("[watch] Watching:", session.folderPath);
    });

    nativeWatcher.on("add", (filePath) => {
      if (!isSessionActive(session) || !isVideoFile(filePath)) return;
      logger.log("Video file added:", filePath);
      enqueueVideoEvent(session, "added", filePath);
    });

    nativeWatcher.on("unlink", (filePath) => {
      if (!isSessionActive(session) || !isVideoFile(filePath)) return;
      const pendingChange = changeTimeouts.get(filePath);
      if (pendingChange) {
        clearTimeout(pendingChange.timer);
        changeTimeouts.delete(filePath);
      }
      pendingEnrichments.delete(filePath);
      const active = activeEnrichments.get(filePath);
      if (active?.session === session) {
        cancelActiveEnrichment(active);
      }
      logger.log("Video file removed:", filePath);
      events.emit("removed", filePath, eventMetadata(session));
      drainEnrichmentQueue();
    });

    nativeWatcher.on("change", (filePath) => {
      if (!isSessionActive(session) || !isVideoFile(filePath)) return;

      const existing = changeTimeouts.get(filePath);
      if (existing) {
        clearTimeout(existing.timer);
        changeTimeouts.delete(filePath);
      } else if (changeTimeouts.size >= changeDebouncerLimit) {
        // Preserve the oldest notification by moving it into the independently
        // bounded enrichment queue before accepting another debounce key.
        flushOldestChangeDebouncer();
      }

      const entry = { session, timer: null };
      entry.timer = setTimeout(() => {
        dispatchDebouncedChange(filePath, entry);
      }, 1000);
      changeTimeouts.set(filePath, entry);
    });

    nativeWatcher.on("error", async (error) => {
      if (!isSessionActive(session)) return;
      const code = error && error.code;
      const isLimitError = code === "EMFILE" || code === "ENOSPC";

      if (isLimitError && !session.fellBack) {
        session.fellBack = true; // one-shot per watcher session
        logger.warn("[watch] Limit hit:", code, "→ switching to polling");

        // Detach this native watcher before awaiting close. A new start/stop can
        // now invalidate the session without being clobbered by this callback.
        if (fileWatcher === nativeWatcher) {
          fileWatcher = null;
        }
        clearChangeDebouncers();
        clearPendingEnrichments();
        cancelActiveEnrichmentsForSession(session);
        await closeNativeWatcher(nativeWatcher);
        if (!isSessionActive(session)) return;

        startPollingMode(session);
        // Preserve the existing UI hint while attaching session metadata.
        events.emit(
          "error",
          new Error("Switched to polling mode"),
          eventMetadata(session)
        );
        return;
      }

      // Non-limit errors or repeated limit errors
      logger.error("File watcher error:", error);
      events.emit("error", error, eventMetadata(session));
    });

    return {
      success: true,
      mode: "watch",
      recursive,
      sessionId: session.sessionId,
    };
  }

  // public API
  return {
    start,
    stop,
    dispose,
    isPolling,
    getCurrentFolder,
    getSnapshot,
    on: (...args) => events.on(...args),
    off: (...args) => events.off?.(...args) || events.removeListener(...args),
    once: (...args) => events.once(...args),
    events,
  };
}

module.exports = { DEFAULT_WATCHER_LIMITS, createFolderWatcher };
