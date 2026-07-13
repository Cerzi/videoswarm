// main/watcher.js
// Single-instance folder watcher with graceful polling fallback.
// Emits: 'mode', 'ready', 'added', 'removed', 'changed', 'error'

const chokidar = require("chokidar");
const { EventEmitter } = require("events");

const EMPTY_CONTEXT = Object.freeze({});

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

  let fileWatcher = null; // active chokidar watcher (native events)
  let pollingInterval = null; // setInterval id (polling fallback)
  let currentFolder = null; // current root
  let currentOptions = { recursive: true, context: EMPTY_CONTEXT };
  let activeSession = null;
  let sessionSequence = 0;
  let lifecycleGeneration = 0;
  const changeTimeouts = new Map(); // debounce timers per file

  // ---- helpers ----
  function isPolling() {
    return !!pollingInterval;
  }

  function getCurrentFolder() {
    return currentFolder;
  }

  function clearChangeDebouncers() {
    for (const entry of changeTimeouts.values()) {
      clearTimeout(entry.timer);
    }
    changeTimeouts.clear();
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

  function helperContext(session) {
    return {
      ...session.context,
      assertActive: () => assertSessionActive(session),
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
    invalidateActiveSession();
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

  async function runPollingScan(session, label = "scan") {
    if (!isSessionActive(session)) return;
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
      })
      .catch((error) => {
        if (!isSessionActive(session) || isStaleSessionError(error)) return;
        logger.error(`[watch] Polling ${label} failed:`, error);
        events.emit("error", error, eventMetadata(session));
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

    // Initial scan. runPollingScan owns rejection handling and coalesces timer
    // ticks while a previous scan is still in flight.
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

  async function emitVideoEvent(session, eventName, filePath) {
    if (!isSessionActive(session) || !isVideoFile(filePath)) return;

    try {
      assertSessionActive(session);
      const videoFile = await createVideoFileObject(
        filePath,
        session.folderPath,
        helperContext(session)
      );
      assertSessionActive(session);
      if (videoFile) {
        events.emit(eventName, videoFile, eventMetadata(session));
      }
    } catch (error) {
      if (!isSessionActive(session) || isStaleSessionError(error)) return;
      logger.error(
        `[watch:${eventName === "added" ? "add" : "change"}] createVideoFileObject failed:`,
        error
      );
      events.emit("error", error, eventMetadata(session));
    }
  }

  async function start(folderPath, options = {}) {
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
      void emitVideoEvent(session, "added", filePath);
    });

    nativeWatcher.on("unlink", (filePath) => {
      if (!isSessionActive(session) || !isVideoFile(filePath)) return;
      logger.log("Video file removed:", filePath);
      events.emit("removed", filePath, eventMetadata(session));
    });

    nativeWatcher.on("change", (filePath) => {
      if (!isSessionActive(session) || !isVideoFile(filePath)) return;

      const existing = changeTimeouts.get(filePath);
      if (existing) {
        clearTimeout(existing.timer);
      }

      const entry = { session, timer: null };
      entry.timer = setTimeout(() => {
        if (changeTimeouts.get(filePath) !== entry) return;
        changeTimeouts.delete(filePath);
        if (!isSessionActive(session)) return;
        logger.log("Video file changed:", filePath);
        void emitVideoEvent(session, "changed", filePath);
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
    isPolling,
    getCurrentFolder,
    on: (...args) => events.on(...args),
    off: (...args) => events.off?.(...args) || events.removeListener(...args),
    once: (...args) => events.once(...args),
    events,
  };
}

module.exports = { createFolderWatcher };
