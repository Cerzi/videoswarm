// Single-instance folder watcher with graceful polling fallback.
// Emits: 'ready', 'mode', 'added', 'removed', 'changed', 'error'

const chokidar = require("chokidar");
const path = require("path");
const { EventEmitter } = require("events");

function createFolderWatcher({
  isVideoFile,
  createVideoFileObject,
  scanFolderForChanges,
  logger = console,
  depth = 10,
}) {
  const events = new EventEmitter();

  let fileWatcher = null; // chokidar watcher
  let pollingInterval = null; // setInterval id
  let currentFolder = null;
  const changeTimeouts = new Map(); // debounce per file

  async function stop() {
    try {
      if (fileWatcher) {
        fileWatcher.removeAllListeners?.();
        await fileWatcher.close();
      }
    } catch (e) {
      logger.warn("Error closing file watcher:", e);
    } finally {
      fileWatcher = null;
    }
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  function isPolling() {
    return !!pollingInterval;
  }

  function getCurrentFolder() {
    return currentFolder;
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

    // Poll every 5s (kept from your code)
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
    // No-op if already watching the same folder
    if (currentFolder === folderPath && (fileWatcher || pollingInterval)) {
      return { success: true, mode: isPolling() ? "polling" : "watch" };
    }

    await stop();
    currentFolder = folderPath;

    // Create chokidar watcher (your options preserved)
    fileWatcher = chokidar.watch(path.join(folderPath, "**/"), {
      ignored: [
        /(^|[\/\\])\../, // dotfiles/folders
        "**/node_modules/**",
        "**/.git/**",
      ],
      persistent: true,
      ignoreInitial: true,
      depth, // keep your recursion limit

      // prefer native events
      usePolling: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },

      atomic: true,
      alwaysStat: false,
      followSymlinks: false,
      ignorePermissionErrors: true,

      ...(process.platform === "darwin" && { useFsEvents: true }),
      ...(process.platform === "win32" && { useReaddir: false }),
    });

    // Events
    fileWatcher.on("ready", () => {
      logger.log("[watch] Watching:", folderPath);
      events.emit("mode", { mode: "watch", folderPath });
      events.emit("ready", { folderPath });
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
      logger.error("File watcher error:", error);
      // On limits, fall back to polling
      if (error && (error.code === "EMFILE" || error.code === "ENOSPC")) {
        logger.warn("[watch] Too many files; switching to polling");
        events.emit("error", new Error("Switched to polling mode"));
        await stop();
        startPollingMode(folderPath);
      } else {
        events.emit("error", error);
      }
    });

    return { success: true, mode: "watch" };
  }

  return {
    // API
    start,
    stop,
    isPolling,
    getCurrentFolder,
    // event emitter
    on: (...args) => events.on(...args),
    off: (...args) => events.off?.(...args) || events.removeListener(...args),
    once: (...args) => events.once(...args),
    events,
  };
}

module.exports = { createFolderWatcher };
