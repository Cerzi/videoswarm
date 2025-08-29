// main.js
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
require('./main/ipc-trash')(ipcMain);

console.log("=== MAIN.JS LOADING ===");
console.log("Node version:", process.version);
console.log("Electron version:", process.versions.electron);

if (process.platform === "linux") {
  console.log("=== USING NEW CHROMIUM GL FLAGS ===");

  // NEW format (Electron 37+ / Chromium 123+)
  app.commandLine.appendSwitch("gl", "egl-angle");
  app.commandLine.appendSwitch("angle", "opengl");

  // Keep these for compatibility
  app.commandLine.appendSwitch("ignore-gpu-blocklist");

  console.log("Using new GL flag format for recent Electron versions");
}

// Enable GC in both dev and production for memory management
app.commandLine.appendSwitch("js-flags", "--expose-gc");
console.log("🧠 Enabled garbage collection access");

const settingsPath = path.join(app.getPath("userData"), "settings.json");

// Enhanced default zoom detection based on screen size
function getDefaultZoomForScreen() {
  try {
    const { screen } = require("electron");
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    console.log(`🖥️ Detected display: ${width}x${height}`);

    // For 4K+ monitors, FORCE minimum 150% (index 2) to prevent crashes
    if (width >= 3840 || height >= 2160) {
      console.log(
        "🖥️ 4K+ display detected, defaulting to 150% zoom for memory safety"
      );
      return 2; // 150%
    }

    // For high-DPI displays, default to 150% for safety
    if (width >= 2560 || height >= 1440) {
      console.log(
        "🖥️ High-DPI display detected, defaulting to 150% zoom for safety"
      );
      return 2; // 150%
    }

    // For standard displays, 100% should be safe
    if (width >= 1920 || height >= 1080) {
      console.log("🖥️ Standard HD display detected, defaulting to 100% zoom");
      return 1; // 100%
    }

    // For smaller displays, 100% is definitely safe
    console.log("🖥️ Small display detected, defaulting to 100% zoom");
    return 1; // 100%
  } catch (error) {
    console.log("🖥️ Screen not available yet, using safe default zoom (150%)");
    return 2; // Default to 150% for safety when screen is not available
  }
}

// SIMPLIFIED: Removed layoutMode and autoplayEnabled from default settings
// Note: zoomLevel will be set dynamically after app is ready
const defaultSettings = {
  recursiveMode: false,
  maxConcurrentPlaying: 50,
  zoomLevel: 1, // Will be updated after app ready if no saved setting
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

// We keep scanFolderForChanges so the watcher module can call it in polling mode.
let lastFolderScan = new Map();

// Helper function to check if file is a video
function isVideoFile(fileName) {
  const videoExtensions = [
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
  const ext = path.extname(fileName).toLowerCase();
  return videoExtensions.includes(ext);
}

// Helper function to format file sizes
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Helper function to create rich file object
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

// Scan folder and detect changes (used by watcher in polling mode)
async function scanFolderForChanges(folderPath) {
  try {
    const videoExtensions = [
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
      if (depth > 10) return; // Limit depth
      const files = await fs.readdir(dirPath, { withFileTypes: true });

      for (const file of files) {
        const fullPath = path.join(dirPath, file.name);

        if (file.isFile()) {
          const ext = path.extname(file.name).toLowerCase();
          if (videoExtensions.includes(ext)) {
            try {
              const stats = await fs.stat(fullPath);
              currentFiles.set(fullPath, {
                size: stats.size,
                mtime: stats.mtime.getTime(),
              });
            } catch {
              // File might have been deleted while scanning
            }
          }
        } else if (file.isDirectory() && !file.name.startsWith(".")) {
          await scanDirectory(fullPath, depth + 1);
        }
      }
    }

    await scanDirectory(folderPath);

    if (lastFolderScan.size > 0 && mainWindow && !mainWindow.isDestroyed()) {
      // Added/changed
      for (const [filePath, fileInfo] of currentFiles) {
        if (!lastFolderScan.has(filePath)) {
          const videoFile = await createVideoFileObject(filePath, folderPath);
          if (videoFile) {
            mainWindow.webContents.send("file-added", videoFile);
          }
        } else {
          const lastInfo = lastFolderScan.get(filePath);
          if (
            lastInfo.mtime !== fileInfo.mtime ||
            lastInfo.size !== fileInfo.size
          ) {
            const videoFile = await createVideoFileObject(filePath, folderPath);
            if (videoFile) {
              mainWindow.webContents.send("file-changed", videoFile);
            }
          }
        }
      }
      // Removed
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

// Instantiate watcher (single instance, logic in ./main/watcher.js)
const folderWatcher = createFolderWatcher({
  isVideoFile,
  createVideoFileObject,
  scanFolderForChanges,
  logger: console,
  depth: 10, // unchanged from your previous config
});

// Wire watcher events to the renderer (native watch mode)
function wireWatcherEvents(win) {
  folderWatcher.on("added", (videoFile) => {
    win.webContents.send("file-added", videoFile);
  });
  folderWatcher.on("removed", (filePath) => {
    win.webContents.send("file-removed", filePath);
  });
  folderWatcher.on("changed", (videoFile) => {
    win.webContents.send("file-changed", videoFile);
  });
  folderWatcher.on("mode", ({ mode, folderPath }) => {
    console.log(`[watch] mode=${mode} path=${folderPath}`);
    // Optionally notify the renderer:
    // win.webContents.send("file-watch-mode", mode);
  });
  folderWatcher.on("error", (err) => {
    const msg = (err && err.message) || String(err);
    win.webContents.send("file-watch-error", msg);
  });
  folderWatcher.on("ready", ({ folderPath }) => {
    console.log("Started watching folder:", folderPath);
  });
}

// ===== Settings load/save =====
async function loadSettings() {
  try {
    const data = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(data);
    console.log("Settings loaded:", settings);

    const { layoutMode, autoplayEnabled, ...cleanSettings } = settings;

    if (cleanSettings.zoomLevel === undefined) {
      const defaultZoom = getDefaultZoomForScreen();
      cleanSettings.zoomLevel = defaultZoom;
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
  try {
    const { layoutMode, autoplayEnabled, ...cleanSettings } = settings;
    await fs.writeFile(settingsPath, JSON.stringify(cleanSettings, null, 2));
    currentSettings = cleanSettings;
    console.log("Settings saved:", cleanSettings);
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}

function saveWindowBounds() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    const settings = {
      windowBounds: bounds,
    };
    saveSettingsPartial(settings).catch(console.error);
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

// ===== Window/Menu =====
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
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: false,

      // Enhanced memory management
      experimentalFeatures: true,
      backgroundThrottling: false,
      offscreen: false,
      spellcheck: false,
      v8CacheOptions: "bypassHeatCheck",
    },
    icon: path.join(__dirname, "icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
  });

  const isDev =
    process.argv.includes("--dev") || !!process.env.VITE_DEV_SERVER_URL;

  if (isDev) {
    console.log(
      "Development mode: Loading from Vite server at http://localhost:5173"
    );
    mainWindow.loadURL("http://localhost:5173");
  } else {
    console.log("Production mode: Loading from index.html");
    mainWindow.loadFile(path.join(__dirname, "dist-react", "index.html"));
  }

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("Page loaded, sending settings immediately");
    mainWindow.webContents.send("settings-loaded", currentSettings);
  });

  mainWindow.webContents.on("dom-ready", () => {
    console.log("DOM ready, sending settings");
    mainWindow.webContents.send("settings-loaded", currentSettings);
  });

  // Enhanced crash detection
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    console.error("🔥 RENDERER PROCESS CRASHED:");
    console.error("  Reason:", details.reason);
    console.error("  Exit code:", details.exitCode);
    console.error("  Timestamp:", new Date().toISOString());
    try {
      console.error("  System memory:", process.getSystemMemoryInfo());
      console.error("  Process memory:", process.getProcessMemoryInfo());
    } catch (e) {
      console.error("  Could not get memory info:", e.message);
    }
    if (details.reason === "oom") {
      console.error(
        "💥 CONFIRMED: Out of Memory crash - consider increasing zoom level"
      );
    } else if (details.reason === "crashed") {
      console.error("💥 Generic crash - likely memory related");
    }
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        console.log("🔄 Attempting to reload...");
        mainWindow.reload();
      }
    }, 1000);
  });

  mainWindow.webContents.on("unresponsive", () => {
    console.error("🔥 RENDERER UNRESPONSIVE");
  });
  mainWindow.webContents.on("responsive", () => {
    console.log("✅ RENDERER RESPONSIVE AGAIN");
  });

  mainWindow.on("moved", saveWindowBounds);
  mainWindow.on("resized", saveWindowBounds);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Wire watcher events after window exists
  wireWatcherEvents(mainWindow);
}

// Create application menu with folder selection
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

// ===== Recent Folders Store (ESM import) =====
let recentStore = null;

async function initRecentStore() {
  try {
    const mod = await import("electron-store"); // ESM-only in v9+
    const StoreClass = mod.default || mod.Store || mod;
    recentStore = new StoreClass({
      name: "recent-folders",
      fileExtension: "json",
      clearInvalidConfig: true,
      accessPropertiesByDotNotation: false,
    });
    console.log("📁 recentStore initialized");
  } catch (e) {
    console.warn("📁 electron-store unavailable:", e?.message);
    recentStore = null; // feature gracefully disabled
  }
}

async function getRecentFolders() {
  if (!recentStore) {
    console.log("📁 Recent store not available, returning empty array");
    return [];
  }
  try {
    return recentStore.get("items", []);
  } catch (error) {
    console.error("Failed to get recent folders:", error);
    return [];
  }
}

async function saveRecentFolders(items) {
  if (!recentStore) {
    console.log("📁 Recent store not available, cannot save");
    return;
  }
  try {
    recentStore.set("items", items);
    console.log("📁 Saved recent folders:", items.length, "items");
  } catch (error) {
    console.error("Failed to save recent folders:", error);
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
  } catch (error) {
    console.error("Failed to add recent folder:", error);
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
  } catch (error) {
    console.error("Failed to remove recent folder:", error);
    return [];
  }
}

async function clearRecentFolders() {
  try {
    await saveRecentFolders([]);
    return await getRecentFolders();
  } catch (error) {
    console.error("Failed to clear recent folders:", error);
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
  const settings = await loadSettings();
  return settings;
});

// NEW: Synchronous-ish settings getter - returns cached settings immediately
ipcMain.handle("get-settings", async () => {
  console.log("get-settings called, returning:", currentSettings);
  return currentSettings || defaultSettings;
});

// NEW: Request settings (for refresh scenarios)
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
    } else {
      return { success: false, canceled: true };
    }
  } catch (error) {
    console.error("Error showing folder dialog:", error);
    return { success: false, error: error.message };
  }
});

// Handle file manager opening
ipcMain.handle("show-item-in-folder", async (_event, filePath) => {
  try {
    console.log("Attempting to show in folder:", filePath);
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error) {
    console.error("Failed to show item in folder:", error);
    return { success: false, error: error.message };
  }
});

// Open file in external application (default video player)
ipcMain.handle("open-in-external-player", async (_event, filePath) => {
  try {
    console.log("Opening in external player:", filePath);
    await shell.openPath(filePath);
    return { success: true };
  } catch (error) {
    console.error("Failed to open in external player:", error);
    return { success: false, error: error.message };
  }
});

// Copy text to clipboard
ipcMain.handle("copy-to-clipboard", async (_event, text) => {
  try {
    const { clipboard } = require("electron");
    clipboard.writeText(text);
    console.log("Copied to clipboard:", text);
    return { success: true };
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);
    return { success: false, error: error.message };
  }
});

// Read directory and return video files with metadata
ipcMain.handle(
  "read-directory",
  async (_event, folderPath, recursive = false) => {
    try {
      console.log(`Reading directory: ${folderPath} (recursive: ${recursive})`);
      const videoExtensions = [
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
            if (videoExtensions.includes(ext)) {
              try {
                const stats = await fs.stat(fullPath);
                const videoFile = {
                  id: fullPath,
                  name: file.name,
                  fullPath: fullPath,
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
                };
                videoFiles.push(videoFile);
              } catch (error) {
                console.warn(
                  `Error reading file stats for ${fullPath}:`,
                  error.message
                );
                videoFiles.push({
                  id: fullPath,
                  name: file.name,
                  fullPath: fullPath,
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

      console.log(
        `Found ${videoFiles.length} video files in ${folderPath} (recursive: ${recursive})`
      );

      return videoFiles.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error("Error reading directory:", error);
      throw error;
    }
  }
);

// File info helpers
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

// keep single-file API but implement it via bulk for consistency
ipcMain.handle("move-to-trash", async (_event, filePath) => {
  try {
    await trash([filePath]); // batch of size 1
    return { success: true };
  } catch (error) {
    console.error("Failed to move to trash:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("copy-file", async (_event, sourcePath, destPath) => {
  try {
    await fs.copyFile(sourcePath, destPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
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

// Recent folders IPC
ipcMain.handle("recent:get", async () => await getRecentFolders());
ipcMain.handle("recent:add", async (_e, folderPath) => await addRecentFolder(folderPath));
ipcMain.handle("recent:remove", async (_e, folderPath) => await removeRecentFolder(folderPath));
ipcMain.handle("recent:clear", async () => await clearRecentFolders());

// Watcher IPC (delegated to file watcher module)
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

ipcMain.handle('mem:get', () => {
  // app.getAppMetrics(): memory fields are in KB
  const procs = app.getAppMetrics();
  const totals = procs.reduce(
    (acc, p) => {
      const m = p.memory || {};
      acc.workingSetKB += m.workingSetSize || 0; // KB
      acc.privateKB += m.privateBytes || 0; // KB
      acc.sharedKB += m.sharedBytes || 0; // KB
      return acc;
    },
    { workingSetKB: 0, privateKB: 0, sharedKB: 0 }
  );

  // System memory (also in KB)
  const sys = process.getSystemMemoryInfo(); // { total, free, ... } in KB
  const totalMB = Math.round((sys.total || 0) / 1024);             // KB -> MB
  const wsMB = Math.round((totals.workingSetKB || 0) / 1024);   // KB -> MB

  return {
    processes: procs.map(p => ({
      pid: p.pid,
      type: p.type,
      memory: p.memory, // raw KB figures
    })),
    totals: {
      ...totals,  // workingSetKB/privateKB/sharedKB (KB)
      wsMB,       // working set across all Electron processes (MB)
      totalMB,    // system total RAM (MB)
    },
  };
});


// App lifecycle
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.whenReady().then(async () => {
  try {
    console.log("GPU status:", app.getGPUFeatureStatus());
    await initRecentStore(); // safe no-op if it fails
    await createWindow();
    createMenu();
  } catch (err) {
    console.error("❌ Startup failure:", err);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Ensure watcher cleanup on quit
app.on("before-quit", async () => { await folderWatcher.stop(); });
app.on("will-quit", async () => { await folderWatcher.stop(); });
