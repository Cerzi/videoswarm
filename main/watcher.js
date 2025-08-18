// main/watcher.js
// Single-instance folder watcher with graceful polling fallback.
// Emits: 'mode', 'ready', 'added', 'removed', 'changed', 'error'

const chokidar = require("chokidar");
const path = require("path");
const { EventEmitter } = require("events");

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

  let fileWatcher = null;          // active chokidar watcher (native events)
  let pollingInterval = null;      // setInterval id (polling fallback)
  let currentFolder = null;        // current root
  let fellBackThisSession = false; // one-shot fallback flag per folder
  const changeTimeouts = new Map();// debounce timers per file

  // ---- helpers ----
  function isPolling() {
    return !!pollingInterval;
  }
  function getCurrentFolder() {
    return currentFolder;
  }
  function clearChangeDebouncers() {
    for (const t of changeTimeouts.values()) clearTimeout(t);
    changeTimeouts.clear();
  }

  async function stop() {
    try {
      if (fileWatcher) {
        fileWatcher.removeAllListeners?.();
        await fileWatcher.close();
      }
    } catch (e) {
      logger.warn("[watch] Error closing watcher:", e);
    } finally {
      fileWatcher = null;
    }

    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    clearChangeDebouncers();
  }

  function startPollingMode(folderPath) {
    // Ensure single instance
    stop().catch(() => {});
    currentFolder = folderPath;

    logger.log("[watch] Starting polling mode:", folderPath);
    events.emit("mode", { mode: "polling", folderPath });

    // Initial scan
    try {
      scanFolderForChanges(folderPath);
    } catch (e) {
      logger.error("[watch] Polling initial scan failed:", e);
      events.emit("error", e);
    }

    // Poll every 5 seconds (matches your previous behavior)
    pollingInterval = setInterval(() => {
      try {
        scanFolderForChanges(folderPath);
      } catch (e) {
        logger.error("[watch] Polling scan failed:", e);
        events.emit("error", e);
      }
    }, 5000);

    return { success: true, mode: "polling" };
  }

  async function start(folderPath) {
    // If already watching the same folder, return current mode
    if (currentFolder === folderPath && (fileWatcher || pollingInterval)) {
      return { success: true, mode: isPolling() ? "polling" : "watch" };
    }

    await stop();
    currentFolder = folderPath;
    fellBackThisSession = false; // allow native attempt on each new folder

    // Create chokidar watcher (native events)
    fileWatcher = chokidar.watch(folderPath, {
      ignored: [
        /(^|[\/\\])\../,      // ignore dot files/dirs
        "**/node_modules/**",
        "**/.git/**",
      ],
      persistent: true,
      ignoreInitial: true,
      depth,                  // recursion limit (unchanged)

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

    // ---- events ----
    fileWatcher.on("ready", () => {
      // Instrumentation: count directories/files chokidar believes it has
      try {
        const watched = fileWatcher.getWatched?.() || {};
        const dirs = Object.keys(watched).length;
        let files = 0; for (const d in watched) files += watched[d].length;
        logger.log(`[watch] ready: dirs=${dirs} files=${files}`);
      } catch {}
      events.emit("mode", { mode: "watch", folderPath });
      events.emit("ready", { folderPath });
      logger.log("[watch] Watching:", folderPath);
    });

    fileWatcher.on("add", async (filePath) => {
      if (!isVideoFile(filePath)) return;
      logger.log("Video file added:", filePath);
      try {
        const videoFile = await createVideoFileObject(filePath, folderPath);
        if (videoFile) events.emit("added", videoFile);
      } catch (e) {
        logger.error("[watch:add] createVideoFileObject failed:", e);
        events.emit("error", e);
      }
    });

    fileWatcher.on("unlink", (filePath) => {
      if (!isVideoFile(filePath)) return;
      logger.log("Video file removed:", filePath);
      events.emit("removed", filePath);
    });

    fileWatcher.on("change", async (filePath) => {
      if (!isVideoFile(filePath)) return;

      if (changeTimeouts.has(filePath)) {
        clearTimeout(changeTimeouts.get(filePath));
      }
      changeTimeouts.set(
        filePath,
        setTimeout(async () => {
          logger.log("Video file changed:", filePath);
          try {
            const videoFile = await createVideoFileObject(filePath, folderPath);
            if (videoFile) events.emit("changed", videoFile);
          } catch (e) {
            logger.error("[watch:change] createVideoFileObject failed:", e);
            events.emit("error", e);
          } finally {
            changeTimeouts.delete(filePath);
          }
        }, 1000)
      );
    });

    fileWatcher.on("error", async (error) => {
      const code = error && error.code;
      const isLimitError = code === "EMFILE" || code === "ENOSPC";

      if (isLimitError && !fellBackThisSession) {
        fellBackThisSession = true; // one-shot per folder
        logger.warn("[watch] Limit hit:", code, "→ switching to polling");
        // Close partially-initialized watcher before falling back
        try {
          await stop();
        } catch {}

        // Start polling for the same folder
        startPollingMode(currentFolder);
        // Emit mode explicitly because 'ready' may never fire when erroring early
        events.emit("mode", { mode: "polling", folderPath: currentFolder });
        // Optional UI hint
        events.emit("error", new Error("Switched to polling mode"));
        return;
      }

      // Non-limit errors or repeated limit errors
      logger.error("File watcher error:", error);
      events.emit("error", error);
    });

    return { success: true, mode: "watch" };
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
