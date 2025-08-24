// main.js — solid + guarded: libmpv gating, single-preload discipline, robust settings/watch/recent

console.log("=== COMMAND LINE ARGS ===");
console.log(process.argv);

const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  Menu,
} = require("electron");
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");

// Wire bulk/single trash handlers (existing module in your project)
require("./main/ipc-trash")(ipcMain);

console.log("=== MAIN.JS LOADING ===");
console.log("Node version:", process.version);
console.log("Electron version:", process.versions.electron);

// Forward renderer + preload console messages to terminal
app.on("web-contents-created", (_evt, contents) => {
  contents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  // Optional: URL/type trace to see who loads what
  contents.on("did-finish-load", () => {
    try {
      const type = contents.getType?.();
      const url = contents.getURL?.();
      console.log("[trace] webContents:", { id: contents.id, type, url });
    } catch {}
  });
});

const preloadPath = path.join(__dirname, "preload.js");
console.log(
  "[main] using preload at:",
  preloadPath,
  "exists=",
  fsSync.existsSync(preloadPath)
);

// --- Linux + libmpv gating ---
const enableLibmpv =
  process.platform === "linux" &&
  (process.env.USE_LIBMPV_LINUX === "1" ||
    app.commandLine.hasSwitch("use-libmpv"));

if (process.platform === "linux") {
  if (enableLibmpv) {
    // We let mpv own GPU; disable Electron’s GPU entirely to avoid ANGLE/GL spam
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch(
      "disable-features",
      [
        "VaapiVideoDecoder",
        "VaapiVideoEncoder",
        "VaapiOnNvidiaGPUs",
        "AcceleratedVideoDecodeLinuxGL",
        "AcceleratedVideoDecodeLinuxZeroCopyGL",
        "UseChromeOSDirectVideoDecoder",
      ].join(",")
    );
    delete process.env.LIBVA_DRIVER_NAME;
    delete process.env.LIBVA_DRI3_DISABLE;
    delete process.env.NVD_BACKEND;
    console.log("🎬 libmpv native pipeline ENABLED (Linux)");
    console.log("🧯 Electron hardware acceleration disabled (libmpv active)");
  } else {
    // Only use these Chromium GL switches when NOT in libmpv mode
    app.commandLine.appendSwitch("ozone-platform", "x11");
    app.commandLine.appendSwitch("use-gl", "desktop");
    app.commandLine.appendSwitch("use-angle", "gl");
    console.log(
      "ozone-platform =",
      app.commandLine.getSwitchValue("ozone-platform")
    );
    console.log("use-gl         =", app.commandLine.getSwitchValue("use-gl"));
    console.log(
      "use-angle      =",
      app.commandLine.getSwitchValue("use-angle")
    );
    console.log("🎬 libmpv native pipeline DISABLED (Linux)");
  }
}
// Allow manual GC (dev aid)
app.commandLine.appendSwitch("js-flags", "--expose-gc");
console.log("🧠 Enabled garbage collection access");

// Log where settings live
console.log("📁 userData path:", app.getPath("userData"));

// ---------- Settings helpers ----------
function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function getDefaultZoomForScreen() {
  try {
    const { screen } = require("electron");
    const { workAreaSize } = screen.getPrimaryDisplay();
    const { width, height } = workAreaSize;
    console.log(`🖥️ Display workArea: ${width}x${height}`);
    if (width >= 3840 || height >= 2160) return 2; // 150%
    if (width >= 2560 || height >= 1440) return 2; // 150%
    return 1; // 100%
  } catch {
    console.log("🖥️ Screen not ready; using 150% zoom fallback");
    return 2;
  }
}

const defaultSettings = {
  recursiveMode: false,
  maxConcurrentPlaying: 50,
  zoomLevel: 1,
  showFilenames: true,
  windowBounds: {
    width: 1400,
    height: 900,
    x: undefined,
    y: undefined,
  },
};

let mainWindow;
let currentSettings = null;

// ===== Watcher integration =====
const { createFolderWatcher } = require("./main/watcher");
let lastFolderScan = new Map();

function isVideoFile(fileName) {
  const exts = [
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".webm",
    ".m4v",
    ".flv",
    ".wmv",
    ".3gp",
    ".ogv",
  ];
  return exts.includes(path.extname(fileName).toLowerCase());
}
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024,
    sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
async function createVideoFileObject(filePath, baseFolderPath) {
  try {
    const stats = await fs.stat(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    return {
      id: filePath,
      name: fileName,
      fullPath: filePath,
      relativePath: path.relative(baseFolderPath, filePath),
      extension: ext,
      size: stats.size,
      dateModified: stats.mtime,
      dateCreated: stats.birthtime,
      isElectronFile: true,
      metadata: {
        folder: path.dirname(filePath),
        baseName: path.basename(fileName, ext),
        sizeFormatted: formatFileSize(stats.size),
        dateModifiedFormatted: stats.mtime.toLocaleDateString(),
        dateCreatedFormatted: stats.birthtime.toLocaleDateString(),
      },
    };
  } catch (error) {
    console.warn(`Error creating file object for ${filePath}:`, error.message);
    return null;
  }
}
async function scanFolderForChanges(folderPath) {
  try {
    const exts = [
      ".mp4",
      ".mov",
      ".avi",
      ".mkv",
      ".webm",
      ".m4v",
      ".flv",
      ".wmv",
      ".3gp",
      ".ogv",
    ];
    const currentFiles = new Map();

    async function scanDirectory(dirPath, depth = 0) {
      if (depth > 10) return;
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dirPath, file.name);
        if (file.isFile()) {
          const ext = path.extname(file.name).toLowerCase();
          if (exts.includes(ext)) {
            try {
              const stats = await fs.stat(fullPath);
              currentFiles.set(fullPath, {
                size: stats.size,
                mtime: stats.mtime.getTime(),
              });
            } catch {
              /* ignore */
            }
          }
        } else if (file.isDirectory() && !file.name.startsWith(".")) {
          await scanDirectory(fullPath, depth + 1);
        }
      }
    }

    await scanDirectory(folderPath);

    if (lastFolderScan.size > 0 && mainWindow && !mainWindow.isDestroyed()) {
      for (const [filePath, fileInfo] of currentFiles) {
        if (!lastFolderScan.has(filePath)) {
          const vf = await createVideoFileObject(filePath, folderPath);
          if (vf) mainWindow.webContents.send("file-added", vf);
        } else {
          const lastInfo = lastFolderScan.get(filePath);
          if (
            lastInfo.mtime !== fileInfo.mtime ||
            lastInfo.size !== fileInfo.size
          ) {
            const vf = await createVideoFileObject(filePath, folderPath);
            if (vf) mainWindow.webContents.send("file-changed", vf);
          }
        }
      }
      for (const filePath of lastFolderScan.keys()) {
        if (!currentFiles.has(filePath)) {
          mainWindow.webContents.send("file-removed", filePath);
        }
      }
    }

    lastFolderScan = currentFiles;
  } catch (error) {
    console.error("Error in polling mode scan:", error);
  }
}

const folderWatcher = createFolderWatcher({
  isVideoFile,
  createVideoFileObject,
  scanFolderForChanges,
  logger: console,
  depth: 10,
});

function wireWatcherEvents(win) {
  folderWatcher.on("added", (videoFile) =>
    win.webContents.send("file-added", videoFile)
  );
  folderWatcher.on("removed", (filePath) =>
    win.webContents.send("file-removed", filePath)
  );
  folderWatcher.on("changed", (videoFile) =>
    win.webContents.send("file-changed", videoFile)
  );
  folderWatcher.on("mode", ({ mode, folderPath }) => {
    console.log(`[watch] mode=${mode} path=${folderPath}`);
  });
  folderWatcher.on("error", (err) => {
    const msg = (err && err.message) || String(err);
    win.webContents.send("file-watch-error", msg);
  });
  folderWatcher.on("ready", ({ folderPath }) => {
    console.log("Started watching folder:", folderPath);
  });
}

// ---------- Settings load/save ----------
async function loadSettings() {
  const settingsPath = getSettingsPath();
  try {
    const data = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(data);
    console.log("Settings loaded:", settings);

    const { layoutMode, autoplayEnabled, ...cleanSettings } = settings;

    if (cleanSettings.zoomLevel === undefined) {
      cleanSettings.zoomLevel = getDefaultZoomForScreen();
      console.log(
        "🔍 No saved zoom level, using screen-based default:",
        cleanSettings.zoomLevel
      );
    }

    currentSettings = { ...defaultSettings, ...cleanSettings };
    return currentSettings;
  } catch {
    console.log("No settings file found, using defaults");
    const settingsWithScreenZoom = { ...defaultSettings };
    try {
      settingsWithScreenZoom.zoomLevel = getDefaultZoomForScreen();
    } catch {
      settingsWithScreenZoom.zoomLevel = 1;
    }
    currentSettings = settingsWithScreenZoom;
    return currentSettings;
  }
}
async function saveSettings(settings) {
  const settingsPath = getSettingsPath();
  try {
    const { layoutMode, autoplayEnabled, ...cleanSettings } = settings;
    await fs.writeFile(settingsPath, JSON.stringify(cleanSettings, null, 2));
    currentSettings = cleanSettings;
    console.log("Settings saved:", cleanSettings, "→", settingsPath);
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}
function saveWindowBounds() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    saveSettingsPartial({ windowBounds: bounds }).catch(console.error);
  }
}
async function saveSettingsPartial(partialSettings) {
  try {
    const current = await loadSettings();
    const newSettings = { ...current, ...partialSettings };
    await saveSettings(newSettings);
  } catch (error) {
    console.error("Failed to save partial settings:", error);
  }
}

// ---------- Window/Menu ----------
async function createWindow() {
  const settings = await loadSettings();

  mainWindow = new BrowserWindow({
    width: settings.windowBounds.width,
    height: settings.windowBounds.height,
    x: settings.windowBounds.x,
    y: settings.windowBounds.y,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false, // as in your current dev setup
      preload: preloadPath, // ONLY main window gets the preload
      experimentalFeatures: true,
      backgroundThrottling: false,
      offscreen: false,
      spellcheck: false,
      v8CacheOptions: "bypassHeatCheck",
    },
    icon: path.join(__dirname, "icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
  });

  try {
    const prefs = mainWindow.webContents.getLastWebPreferences();
    console.log("[main] last web prefs:", {
      preload: prefs?.preload,
      preloadURL: prefs?.preloadURL,
    });
  } catch (e) {
    console.log("[main] getLastWebPreferences failed:", e.message);
  }

  const isDev =
    process.argv.includes("--dev") || !!process.env.VITE_DEV_SERVER_URL;

  if (isDev) {
    console.log(
      "Development mode: Loading from Vite server at http://localhost:5173"
    );
    await mainWindow.loadURL("http://localhost:5173");
  } else {
    console.log("Production mode: Loading from index.html");
    await mainWindow.loadFile(path.join(__dirname, "dist-react", "index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("Page loaded, sending settings immediately");
    mainWindow.webContents.send("settings-loaded", currentSettings);
  });
  mainWindow.webContents.on("dom-ready", () => {
    console.log("DOM ready, sending settings");
    mainWindow.webContents.send("settings-loaded", currentSettings);
  });

  // Linux-only: wire the NativeVideoManager AFTER the window exists (when enabled)
  if (enableLibmpv) {
    const { NativeVideoManager } = require("./main/native-video");
    const nativeVideoMgr = new NativeVideoManager({
      mpvPath: process.env.MPV_PATH || "mpv",
    });
    await nativeVideoMgr.init();
  }

  // Crash/unresponsive diagnostics
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("🔥 RENDERER PROCESS CRASHED:", {
      reason: details.reason,
      exitCode: details.exitCode,
      at: new Date().toISOString(),
    });
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        console.log("🔄 Attempting to reload...");
        mainWindow.reload();
      }
    }, 1000);
  });
  mainWindow.webContents.on("unresponsive", () =>
    console.error("🔥 RENDERER UNRESPONSIVE")
  );
  mainWindow.webContents.on("responsive", () =>
    console.log("✅ RENDERER RESPONSIVE AGAIN")
  );

  mainWindow.on("moved", saveWindowBounds);
  mainWindow.on("resized", saveWindowBounds);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // Wire watcher events after window exists
  wireWatcherEvents(mainWindow);
}

function createMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Folder",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ["openDirectory"],
              title: "Select Video Folder",
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send(
                "folder-selected",
                result.filePaths[0]
              );
            }
          },
        },
        { type: "separator" },
        {
          label: "Quit",
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
          click: () => app.quit(),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ===== Recent Folders Store =====
let recentStore = null;
async function initRecentStore() {
  try {
    const mod = await import("electron-store"); // ESM in v9+
    const Store = mod.default || mod.Store || mod;
    recentStore = new Store({
      name: "recent-folders",
      fileExtension: "json",
      clearInvalidConfig: true,
      accessPropertiesByDotNotation: false,
    });
    console.log("📁 recentStore initialized");
  } catch (e) {
    console.warn("📁 electron-store unavailable:", e?.message);
    recentStore = null;
  }
}
async function getRecentFolders() {
  if (!recentStore) return [];
  try {
    return recentStore.get("items", []);
  } catch (e) {
    console.error("Failed to get recent folders:", e);
    return [];
  }
}
async function saveRecentFolders(items) {
  if (!recentStore) return;
  try {
    recentStore.set("items", items);
    console.log("📁 Saved recent folders:", items.length, "items");
  } catch (e) {
    console.error("Failed to save recent folders:", e);
  }
}
async function addRecentFolder(folderPath) {
  try {
    const name = path.basename(folderPath);
    const now = Date.now();
    const items = (await getRecentFolders()).filter(
      (x) => x.path !== folderPath
    );
    items.unshift({ path: folderPath, name, lastOpened: now });
    await saveRecentFolders(items.slice(0, 10));
    return await getRecentFolders();
  } catch (e) {
    console.error("Failed to add recent folder:", e);
    return [];
  }
}
async function removeRecentFolder(folderPath) {
  try {
    const items = (await getRecentFolders()).filter(
      (x) => x.path !== folderPath
    );
    await saveRecentFolders(items);
    return await getRecentFolders();
  } catch (e) {
    console.error("Failed to remove recent folder:", e);
    return [];
  }
}
async function clearRecentFolders() {
  try {
    await saveRecentFolders([]);
    return await getRecentFolders();
  } catch (e) {
    console.error("Failed to clear recent folders:", e);
    return [];
  }
}

// ===== IPC Handlers =====
ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("save-settings", async (_event, settings) => {
  await saveSettings(settings);
  return { success: true };
});

ipcMain.handle("load-settings", async () => {
  return await loadSettings();
});

ipcMain.handle("get-settings", async () => {
  console.log("get-settings called, returning:", currentSettings);
  return currentSettings || defaultSettings;
});

ipcMain.handle("request-settings", async () => {
  console.log("request-settings called, sending settings via IPC");
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "settings-loaded",
      currentSettings || defaultSettings
    );
  }
  return { success: true };
});

ipcMain.handle("save-settings-partial", async (_event, partialSettings) => {
  await saveSettingsPartial(partialSettings);
  return { success: true };
});

ipcMain.handle("select-folder", async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Select Video Folder",
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, folderPath: result.filePaths[0] };
    }
    return { success: false, canceled: true };
  } catch (error) {
    console.error("Error showing folder dialog:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("show-item-in-folder", async (_event, filePath) => {
  try {
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (e) {
    console.error("Failed to show item in folder:", e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle("open-in-external-player", async (_event, filePath) => {
  try {
    await shell.openPath(filePath);
    return { success: true };
  } catch (e) {
    console.error("Failed to open in external player:", e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle("copy-to-clipboard", async (_event, text) => {
  try {
    const { clipboard } = require("electron");
    clipboard.writeText(text);
    return { success: true };
  } catch (e) {
    console.error("Failed to copy to clipboard:", e);
    return { success: false, error: e.message };
  }
});

// Directory scan
ipcMain.handle(
  "read-directory",
  async (_event, folderPath, recursive = false) => {
    try {
      const exts = [
        ".mp4",
        ".mov",
        ".avi",
        ".mkv",
        ".webm",
        ".m4v",
        ".flv",
        ".wmv",
        ".3gp",
        ".ogv",
      ];
      const videoFiles = [];

      async function scanDirectory(dirPath, depth = 0) {
        const files = await fs.readdir(dirPath, { withFileTypes: true });
        for (const file of files) {
          const fullPath = path.join(dirPath, file.name);
          if (file.isFile()) {
            const ext = path.extname(file.name).toLowerCase();
            if (exts.includes(ext)) {
              try {
                const stats = await fs.stat(fullPath);
                videoFiles.push({
                  id: fullPath,
                  name: file.name,
                  fullPath,
                  relativePath: path.relative(folderPath, fullPath),
                  extension: ext,
                  size: stats.size,
                  dateModified: stats.mtime,
                  dateCreated: stats.birthtime,
                  isElectronFile: true,
                  metadata: {
                    folder: path.dirname(fullPath),
                    baseName: path.basename(file.name, ext),
                    sizeFormatted: formatFileSize(stats.size),
                    dateModifiedFormatted: stats.mtime.toLocaleDateString(),
                    dateCreatedFormatted: stats.birthtime.toLocaleDateString(),
                  },
                });
              } catch (error) {
                console.warn(
                  `Error reading file stats for ${fullPath}:`,
                  error.message
                );
                videoFiles.push({
                  id: fullPath,
                  name: file.name,
                  fullPath,
                  relativePath: path.relative(folderPath, fullPath),
                  extension: ext,
                  isElectronFile: true,
                  metadata: { folder: path.dirname(fullPath) },
                });
              }
            }
          } else if (file.isDirectory() && recursive && depth < 10) {
            if (
              !file.name.startsWith(".") &&
              ![
                "node_modules",
                "System Volume Information",
                "$RECYCLE.BIN",
                ".git",
              ].includes(file.name)
            ) {
              try {
                await scanDirectory(fullPath, depth + 1);
              } catch (error) {
                console.warn(
                  `Skipping directory ${fullPath}: ${error.message}`
                );
              }
            }
          }
        }
      }

      await scanDirectory(folderPath);
      return videoFiles.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error("Error reading directory:", error);
      throw error;
    }
  }
);

ipcMain.handle("get-file-info", async (_event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return {
      name: path.basename(filePath),
      size: stats.size,
      isFile: stats.isFile(),
      path: filePath,
    };
  } catch (error) {
    console.error("Error getting file info:", error);
    return null;
  }
});

// Prefer Electron's built-in trash API for single-item moves
ipcMain.handle("move-to-trash", async (_event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (e) {
    console.error("Failed to move to trash:", e);
    return { success: false, error: e.message };
  }
});

// Bulk trash is implemented in ./main/ipc-trash

ipcMain.handle("copy-file", async (_event, sourcePath, destPath) => {
  try {
    await fs.copyFile(sourcePath, destPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle("get-file-properties", async (_event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      isDirectory: stats.isDirectory(),
      permissions: stats.mode,
    };
  } catch {
    return null;
  }
});

// NOTE: removed any 'nativeVideo:*' handlers from main.js to avoid double-registration.
// They are now registered exclusively in main/native-video/index.js.

// Recent folders IPC
ipcMain.handle("recent:get", async () => await getRecentFolders());
ipcMain.handle(
  "recent:add",
  async (_e, folderPath) => await addRecentFolder(folderPath)
);
ipcMain.handle(
  "recent:remove",
  async (_e, folderPath) => await removeRecentFolder(folderPath)
);
ipcMain.handle("recent:clear", async () => await clearRecentFolders());

// Watcher IPC
ipcMain.handle("start-folder-watch", async (_event, folderPath) => {
  try {
    const result = await folderWatcher.start(folderPath);
    return { success: true, mode: result.mode };
  } catch (e) {
    console.error("Error starting folder watch:", e);
    return { success: false, error: e.message || String(e) };
  }
});
ipcMain.handle("stop-folder-watch", async () => {
  try {
    await folderWatcher.stop();
    lastFolderScan.clear();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
});

// ---------- App lifecycle ----------
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.whenReady().then(async () => {
  try {
    console.log("GPU status:", app.getGPUFeatureStatus());
    await initRecentStore();
    await createWindow();
    createMenu();
  } catch (err) {
    console.error("❌ Startup failure:", err);
  }

  // Optional diagnostics windows (NEVER preload)
  if (process.argv.includes("--gpu-diagnostics")) {
    const w1 = new BrowserWindow({
      width: 1000,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: undefined,
      },
    });
    await w1.loadURL("chrome://gpu");
    const w2 = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: undefined,
      },
    });
    await w2.loadURL("chrome://media-internals");
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Ensure watcher cleanup on quit
app.on("before-quit", async () => {
  try {
    await folderWatcher.stop();
  } catch {}
});
app.on("will-quit", async () => {
  try {
    await folderWatcher.stop();
  } catch {}
});
