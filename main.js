console.log('=== COMMAND LINE ARGS ===');
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
const chokidar = require("chokidar");

console.log("=== MAIN.JS LOADING ===");
console.log("Node version:", process.version);
console.log("Electron version:", process.versions.electron);

if (process.platform === 'linux') {
  console.log('=== USING NEW CHROMIUM GL FLAGS ===');
  
  // NEW format (Electron 37+ / Chromium 123+)
  app.commandLine.appendSwitch('gl', 'egl-angle');
  app.commandLine.appendSwitch('angle', 'opengl');
  
  // Keep these for compatibility
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  
  console.log('Using new GL flag format for recent Electron versions');
}

// Enable GC in both dev and production for memory management
app.commandLine.appendSwitch('js-flags', '--expose-gc');
console.log('🧠 Enabled garbage collection access');

const settingsPath = path.join(app.getPath("userData"), "settings.json");

// Enhanced default zoom detection based on screen size
function getDefaultZoomForScreen() {
  try {
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    
    console.log(`🖥️ Detected display: ${width}x${height}`);
    
    // For 4K+ monitors, FORCE minimum 150% (index 2) to prevent crashes
    if (width >= 3840 || height >= 2160) {
      console.log('🖥️ 4K+ display detected, defaulting to 150% zoom for memory safety');
      return 2; // 150%
    }
    
    // For high-DPI displays, default to 150% for safety
    if (width >= 2560 || height >= 1440) {
      console.log('🖥️ High-DPI display detected, defaulting to 150% zoom for safety');
      return 2; // 150%
    }
    
    // For standard displays, 100% should be safe
    if (width >= 1920 || height >= 1080) {
      console.log('🖥️ Standard HD display detected, defaulting to 100% zoom');
      return 1; // 100%
    }
    
    // For smaller displays, 100% is definitely safe
    console.log('🖥️ Small display detected, defaulting to 100% zoom');
    return 1; // 100%
  } catch (error) {
    console.log('🖥️ Screen not available yet, using safe default zoom (150%)');
    return 2; // Default to 150% for safety when screen is not available
  }
}

// SIMPLIFIED: Removed layoutMode and autoplayEnabled from default settings
// Note: zoomLevel will be set dynamically after app is ready
const defaultSettings = {
  recursiveMode: false,
  maxConcurrentPlaying: 30,
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
let fileWatcher = null;
let currentWatchedFolder = null;
let pollingInterval = null;
let lastFolderScan = new Map();

async function loadSettings() {
  try {
    const data = await fs.readFile(settingsPath, "utf8");
    const settings = JSON.parse(data);
    console.log("Settings loaded:", settings);

    // Remove layoutMode and autoplayEnabled from loaded settings if they exist (cleanup)
    const { layoutMode, autoplayEnabled, ...cleanSettings } = settings;
    
    // If no zoomLevel in saved settings, detect based on screen (but only after app is ready)
    if (cleanSettings.zoomLevel === undefined) {
      const defaultZoom = getDefaultZoomForScreen();
      cleanSettings.zoomLevel = defaultZoom;
      console.log("🔍 No saved zoom level, using screen-based default:", cleanSettings.zoomLevel);
    }
    
    currentSettings = { ...defaultSettings, ...cleanSettings };
    return currentSettings;
  } catch (error) {
    console.log("No settings file found, using defaults");
    
    // Apply screen-based zoom to defaults (but only after app is ready)
    const settingsWithScreenZoom = { ...defaultSettings };
    try {
      settingsWithScreenZoom.zoomLevel = getDefaultZoomForScreen();
    } catch (screenError) {
      // Screen not ready yet, use default
      settingsWithScreenZoom.zoomLevel = 1;
    }
    
    currentSettings = settingsWithScreenZoom;
    return currentSettings;
  }
}

async function saveSettings(settings) {
  try {
    // Remove layoutMode and autoplayEnabled from settings if they exist (cleanup)
    const { layoutMode, autoplayEnabled, ...cleanSettings } = settings;
    await fs.writeFile(settingsPath, JSON.stringify(cleanSettings, null, 2));
    currentSettings = cleanSettings;
    console.log("Settings saved:", cleanSettings);
  } catch (error) {
    console.error("Failed to save settings:", error);
  }
}

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
      v8CacheOptions: 'bypassHeatCheck',
    },
    icon: path.join(__dirname, "icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
  });

  const isDev = process.argv.includes("--dev");

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
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('🔥 RENDERER PROCESS CRASHED:');
    console.error('  Reason:', details.reason);
    console.error('  Exit code:', details.exitCode);
    console.error('  Timestamp:', new Date().toISOString());
    
    // Get memory info at crash time
    try {
      console.error('  System memory:', process.getSystemMemoryInfo());
      console.error('  Process memory:', process.getProcessMemoryInfo());
    } catch (e) {
      console.error('  Could not get memory info:', e.message);
    }
    
    if (details.reason === 'oom') {
      console.error('💥 CONFIRMED: Out of Memory crash - consider increasing zoom level');
    } else if (details.reason === 'crashed') {
      console.error('💥 Generic crash - likely memory related');
    }
    
    // Auto-restart (optional)
    setTimeout(() => {
      if (!mainWindow.isDestroyed()) {
        console.log('🔄 Attempting to reload...');
        mainWindow.reload();
      }
    }, 1000);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.error('🔥 RENDERER UNRESPONSIVE');
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('✅ RENDERER RESPONSIVE AGAIN');
  });

  mainWindow.on("moved", saveWindowBounds);
  mainWindow.on("resized", saveWindowBounds);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
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

function saveWindowBounds() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    const settings = {
      windowBounds: bounds,
    };

    // Don't wait for this async operation
    saveSettingsPartial(settings).catch(console.error);
  }
}

async function saveSettingsPartial(partialSettings) {
  try {
    const currentSettings = await loadSettings();
    const newSettings = { ...currentSettings, ...partialSettings };
    await saveSettings(newSettings);
  } catch (error) {
    console.error("Failed to save partial settings:", error);
  }
}

// IPC Handlers
ipcMain.handle("save-settings", async (event, settings) => {
  await saveSettings(settings);
  return { success: true };
});

ipcMain.handle("load-settings", async (event) => {
  const settings = await loadSettings();
  return settings;
});

// NEW: Synchronous settings getter - returns cached settings immediately
ipcMain.handle("get-settings", async (event) => {
  console.log("get-settings called, returning:", currentSettings);
  return currentSettings || defaultSettings;
});

// NEW: Request settings (for refresh scenarios)
ipcMain.handle("request-settings", async (event) => {
  console.log("request-settings called, sending settings via IPC");
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "settings-loaded",
      currentSettings || defaultSettings
    );
  }
  return { success: true };
});

ipcMain.handle("save-settings-partial", async (event, partialSettings) => {
  await saveSettingsPartial(partialSettings);
  return { success: true };
});

ipcMain.handle("select-folder", async (event) => {
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
ipcMain.handle("show-item-in-folder", async (event, filePath) => {
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
ipcMain.handle("open-in-external-player", async (event, filePath) => {
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
ipcMain.handle("copy-to-clipboard", async (event, text) => {
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
  async (event, folderPath, recursive = false) => {
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
                // Get file stats for metadata
                const stats = await fs.stat(fullPath);

                // Create rich file object
                const videoFile = {
                  id: fullPath, // Use full path as unique ID
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
                // Fallback to basic file object
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
            // Limit depth to avoid infinite loops
            // Skip hidden directories and common non-media folders
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

      // Sort files by name for consistent ordering
      return videoFiles.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      console.error("Error reading directory:", error);
      throw error;
    }
  }
);

// Helper function to format file sizes
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

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

// Start watching a folder for file changes
ipcMain.handle("start-folder-watch", async (event, folderPath) => {
  try {
    // Stop any existing watcher
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }

    currentWatchedFolder = folderPath;

    // Create new watcher with optimized settings
    fileWatcher = chokidar.watch(path.join(folderPath, '**/'), {
      ignored: [
        /(^|[\/\\])\../, // Ignore hidden files/folders
        "**/node_modules/**", // Ignore node_modules
        "**/.git/**", // Ignore git folders
      ],
      persistent: true,
      ignoreInitial: true, // Don't fire events for existing files
      depth: 10, // Limit recursion depth

      // OPTIMIZATION: Watch directories only, not individual files
      usePolling: false, // Use native events (faster)
      awaitWriteFinish: {
        stabilityThreshold: 500, // Wait 500ms for file to stabilize
        pollInterval: 100,
      },

      // CRITICAL: Reduce file handle usage
      atomic: true, // Reduce duplicate events
      alwaysStat: false, // Don't automatically stat files
      followSymlinks: false, // Don't follow symlinks

      // Platform-specific optimizations
      ...(process.platform === "darwin" && {
        useFsEvents: true, // Use macOS FSEvents
      }),
      ...(process.platform === "win32" && {
        useReaddir: false, // Optimize for Windows
      }),
    });

    // File added
    fileWatcher.on("add", async (filePath) => {
      if (isVideoFile(filePath)) {
        console.log("Video file added:", filePath);
        const videoFile = await createVideoFileObject(filePath, folderPath);
        if (videoFile) {
          mainWindow.webContents.send("file-added", videoFile);
        }
      }
    });

    // File removed
    fileWatcher.on("unlink", (filePath) => {
      if (isVideoFile(filePath)) {
        console.log("Video file removed:", filePath);
        mainWindow.webContents.send("file-removed", filePath);
      }
    });

    // File changed (modified) - debounced to avoid spam
    let changeTimeouts = new Map();
    fileWatcher.on("change", async (filePath) => {
      if (isVideoFile(filePath)) {
        // Debounce changes to avoid spam
        if (changeTimeouts.has(filePath)) {
          clearTimeout(changeTimeouts.get(filePath));
        }

        changeTimeouts.set(
          filePath,
          setTimeout(async () => {
            console.log("Video file changed:", filePath);
            const videoFile = await createVideoFileObject(filePath, folderPath);
            if (videoFile) {
              mainWindow.webContents.send("file-changed", videoFile);
            }
            changeTimeouts.delete(filePath);
          }, 1000)
        ); // Wait 1 second before processing change
      }
    });

    // Handle errors gracefully
    fileWatcher.on("error", (error) => {
      console.error("File watcher error:", error);

      // Don't spam the renderer with errors
      if (error.code === "EMFILE" || error.code === "ENOSPC") {
        console.warn(
          "File watcher: Too many files to watch, falling back to polling mode"
        );

        // Close the problematic watcher
        if (fileWatcher) {
          fileWatcher.close();
          fileWatcher = null;
        }

        // Start polling mode as fallback
        startPollingMode(folderPath);

        mainWindow.webContents.send(
          "file-watch-error",
          "Switched to polling mode for better stability"
        );
      } else {
        mainWindow.webContents.send("file-watch-error", error.message);
      }
    });

    console.log("Started watching folder:", folderPath);
    return { success: true };
  } catch (error) {
    console.error("Error starting folder watch:", error);

    // Try fallback polling mode
    console.log("Attempting fallback to polling mode...");
    try {
      startPollingMode(folderPath);
      return { success: true, mode: "polling" };
    } catch (pollingError) {
      console.error("Polling mode also failed:", pollingError);
      return { success: false, error: error.message };
    }
  }
});

// Fallback polling mode for when file watching fails
function startPollingMode(folderPath) {
  console.log("Starting polling mode for:", folderPath);

  // Stop any existing polling
  if (pollingInterval) {
    clearInterval(pollingInterval);
  }

  // Initial scan
  scanFolderForChanges(folderPath);

  // Poll every 5 seconds
  pollingInterval = setInterval(() => {
    scanFolderForChanges(folderPath);
  }, 5000);
}

// Scan folder and detect changes (for polling mode)
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

    // Scan directory
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
            } catch (error) {
              // File might have been deleted while scanning
            }
          }
        } else if (file.isDirectory() && !file.name.startsWith(".")) {
          await scanDirectory(fullPath, depth + 1);
        }
      }
    }

    await scanDirectory(folderPath);

    // Compare with last scan
    if (lastFolderScan.size > 0) {
      // Check for new files
      for (const [filePath, fileInfo] of currentFiles) {
        if (!lastFolderScan.has(filePath)) {
          // File added
          const videoFile = await createVideoFileObject(filePath, folderPath);
          if (videoFile) {
            mainWindow.webContents.send("file-added", videoFile);
          }
        } else {
          // Check if file changed
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

      // Check for removed files
      for (const filePath of lastFolderScan.keys()) {
        if (!currentFiles.has(filePath)) {
          mainWindow.webContents.send("file-removed", filePath);
        }
      }
    }

    // Update last scan
    lastFolderScan = currentFiles;
  } catch (error) {
    console.error("Error in polling mode scan:", error);
  }
}

// Stop watching folder
ipcMain.handle("stop-folder-watch", async (event) => {
  try {
    if (fileWatcher) {
      fileWatcher.close();
      fileWatcher = null;
    }

    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    currentWatchedFolder = null;
    lastFolderScan.clear();
    console.log("Stopped folder watching");

    return { success: true };
  } catch (error) {
    console.error("Error stopping folder watch:", error);
    return { success: false, error: error.message };
  }
});

// Get file info
ipcMain.handle("get-file-info", async (event, filePath) => {
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

ipcMain.handle("delete-file", async (event, filePath) => {
  try {
    await fs.unlink(filePath);
    return { success: true };
  } catch (error) {
    console.error("Failed to delete file:", error);
    return { success: false, error: error.message };
  }
});

// Move file to trash (safer than permanent deletion)
ipcMain.handle("move-to-trash", async (event, filePath) => {
  try {
    const result = await shell.trashItem(filePath);
    return { success: true };
  } catch (error) {
    console.error("Failed to move to trash:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("copy-file", async (event, sourcePath, destPath) => {
  try {
    await fs.copyFile(sourcePath, destPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-file-properties", async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      isDirectory: stats.isDirectory(),
      permissions: stats.mode,
    };
  } catch (error) {
    return null;
  }
});

app.whenReady().then(() => {
  console.log("GPU status:", app.getGPUFeatureStatus());
  createWindow();
  createMenu();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});