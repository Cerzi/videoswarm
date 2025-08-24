// preload.js — single, SOLID bridge for renderer <-> main
// - Restores full settings + FS + recent folders API
// - Injects nativeVideo shim without require() in renderer world
// - Skips internal pages (devtools/chrome)
// - Geometry patch to avoid NaN -> mpv
(() => {
  // Basic breadcrumbs
  try {
    console.log("[preload] main preload running");
    console.log("[preload] contextIsolation =", process.contextIsolated);
  } catch {}

  // Don’t run on devtools/chrome internal pages
  const isInternalPage =
    typeof location !== "undefined" &&
    (location.protocol === "chrome:" || location.protocol === "devtools:");

  // Only proceed if we have Node in this preload and not sandboxed
  const canUseNode =
    typeof require === "function" &&
    !!process?.versions?.electron &&
    !process.sandboxed;

  if (!canUseNode) {
    console.warn("[preload] Node APIs unavailable in this renderer (sandboxed?)");
    return;
  }
  if (isInternalPage) {
    console.warn("[preload] skipping preload on internal page:", location.href);
    return;
  }

  const { contextBridge, ipcRenderer } = require("electron");
  const fs = require("fs");
  const path = require("path");

  // ---------- Safe event subscription helper ----------
  const allowedEvents = new Set([
    "settings-loaded",
    "file-added",
    "file-removed",
    "file-changed",
    "file-watch-error",
    "folder-selected",
  ]);
  function on(channel, listener) {
    if (!allowedEvents.has(channel)) {
      console.warn(`[preload] blocked subscription to ${channel}`);
      return () => {};
    }
    const wrapped = (_e, ...args) => {
      try {
        listener(...args);
      } catch (err) {
        console.error(`[preload] listener for ${channel} threw:`, err);
      }
    };
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }

  // ---------- Exposed API (restores all of your old surface) ----------
  const api = {
    // Platform detection
    platform: process.platform,
    isElectron: true,

    // App
    getAppVersion: () => ipcRenderer.invoke("get-app-version"),

    // Settings
    saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
    loadSettings: () => ipcRenderer.invoke("load-settings"),
    saveSettingsPartial: (partial) =>
      ipcRenderer.invoke("save-settings-partial", partial),
    getSettings: () => ipcRenderer.invoke("get-settings"),
    requestSettings: () => ipcRenderer.invoke("request-settings"),
    onSettingsLoaded: (cb) => on("settings-loaded", cb),

    // Directory reading / FS
    readDirectory: (folderPath, recursive = false) =>
      ipcRenderer.invoke("read-directory", folderPath, recursive),
    getFileInfo: (filePath) => ipcRenderer.invoke("get-file-info", filePath),
    getFileProperties: (filePath) =>
      ipcRenderer.invoke("get-file-properties", filePath),
    copyFile: (src, dest) => ipcRenderer.invoke("copy-file", src, dest),

    // Watcher control + events
    startFolderWatch: (folderPath) =>
      ipcRenderer.invoke("start-folder-watch", folderPath),
    stopFolderWatch: () => ipcRenderer.invoke("stop-folder-watch"),
    onFileAdded: (cb) => on("file-added", cb),
    onFileRemoved: (cb) => on("file-removed", cb),
    onFileChanged: (cb) => on("file-changed", cb),
    onFileWatchError: (cb) => on("file-watch-error", cb),

    // Folder chooser
    selectFolder: () => ipcRenderer.invoke("select-folder"),
    onFolderSelected: (cb) => on("folder-selected", cb),

    // Shell helpers
    showItemInFolder: (filePath) =>
      ipcRenderer.invoke("show-item-in-folder", filePath),
    openInExternalPlayer: (filePath) =>
      ipcRenderer.invoke("open-in-external-player", filePath),

    // Clipboard
    copyToClipboard: (text) => ipcRenderer.invoke("copy-to-clipboard", text),

    // Trash (single + bulk)
    moveToTrash: (filePath) => ipcRenderer.invoke("move-to-trash", filePath),
    bulkMoveToTrash: (paths) => ipcRenderer.invoke("bulk-move-to-trash", paths),

    // Recent folders
    recent: {
      get: () => ipcRenderer.invoke("recent:get"),
      add: (folderPath) => ipcRenderer.invoke("recent:add", folderPath),
      remove: (folderPath) => ipcRenderer.invoke("recent:remove", folderPath),
      clear: () => ipcRenderer.invoke("recent:clear"),
    },
  };

  contextBridge.exposeInMainWorld("electronAPI", api);

  // ---------- Inject renderer-side nativeVideo shim ----------
  // We avoid require() inside isolated world; we read the file and <script> it.
  try {
    const nativePreloadPath = path.join(
      __dirname,
      "src/renderer/preload/nativeVideo.js"
    );
    console.log(
      "[preload] nativePreloadPath:",
      nativePreloadPath,
      "exists=",
      fs.existsSync(nativePreloadPath)
    );

    if (fs.existsSync(nativePreloadPath)) {
      const code = fs.readFileSync(nativePreloadPath, "utf8");
      const inject = () => {
        const el = document.createElement("script");
        el.type = "text/javascript";
        el.textContent = code;
        (document.documentElement || document.head || document.body).appendChild(
          el
        );
        el.remove();
        console.log("[preload] nativeVideo preload loaded");
      };

      if (document.readyState === "loading") {
        // Ensure DOM exists
        window.addEventListener("DOMContentLoaded", inject, { once: true });
      } else {
        inject();
      }
    } else {
      console.warn("[preload] nativeVideo preload missing");
    }
  } catch (e) {
    console.error("[preload] nativeVideo preload load failed:", e);
  }

  // ---------- Geometry safety patch (prevents NaN -> main -> mpv) ----------
  try {
    const applyPatch = () => {
      const nv = window.NativeVideo;
      if (!nv || typeof nv.fromClientRect !== "function") return;

      const original = nv.fromClientRect.bind(nv);
      const toInt = (n) => {
        const v = Math.round(Number(n));
        return Number.isFinite(v) ? v : 0;
        // fall back to 0; we’ll clamp min size below
      };
      nv.fromClientRect = (rect) => {
        const r = rect || {};
        const safe = {
          x: toInt(r.x ?? r.left ?? 0),
          y: toInt(r.y ?? r.top ?? 0),
          width: toInt(r.width ?? (r.right - r.left) ?? 0),
          height: toInt(r.height ?? (r.bottom - r.top) ?? 0),
        };
        if (safe.width <= 0) safe.width = 64;
        if (safe.height <= 0) safe.height = 64;

        const out = original(safe);
        if (!nv.__geomPatchedLogged) {
          console.log("[preload] NativeVideo.fromClientRect patched for safety");
          nv.__geomPatchedLogged = true;
        }
        return out;
      };
    };

    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", () => setTimeout(applyPatch, 0), {
        once: true,
      });
    } else {
      setTimeout(applyPatch, 0);
    }
  } catch (e) {
    console.warn("[preload] geometry patch failed:", e);
  }

  // ---------- Bootstrap: ask main to push current settings ----------
  try {
    ipcRenderer.invoke("request-settings").catch(() => {});
  } catch {}

  // Debug flags
  try {
    const flags = {
      hasRequire: typeof require === "function",
      sandboxed: !!process.sandboxed,
      platform: process.platform,
      electron: process.versions.electron,
    };
    console.log("[preload] node flags:", JSON.stringify(flags));
  } catch {}
})();
