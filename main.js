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
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const fsPromises = fs.promises;
const { DataLocationManager } = require("./main/data-location-manager");
const dataLocationManager = new DataLocationManager({ app, dialog });
const { source: dataLocationSource } = dataLocationManager.bootstrap(process.argv);

const { getEmbeddedDragIcon } = require("./main/drag-icon");
const { getVideoDimensions } = require("./main/videoDimensions");
require("./main/ipc-trash")(ipcMain);
const { initMetadataStore, getMetadataStore, resetDatabase } = require("./main/database");
const profileManager = require("./main/profile-manager");
const { thumbnailCache } = require("./main/thumb-cache");
const { migrateLegacyProfileData } = require("./main/profile-migration");

const DEFAULT_DONATION_URL = "https://ko-fi.com/videoswarm";

function loadSupportContent() {
  try {
    return require("./src/config/supportContent.json");
  } catch (error) {
    console.warn("⚠️ Unable to load supportContent.json via require", error);

    const basePaths = [
      path.join(__dirname, "src", "config", "supportContent.json"),
    ];

    if (app?.isPackaged) {
      basePaths.push(
        path.join(process.resourcesPath, "src", "config", "supportContent.json")
      );
      basePaths.push(
        path.join(process.resourcesPath, "config", "supportContent.json")
      );
      basePaths.push(path.join(process.resourcesPath, "supportContent.json"));
    }

    for (const candidatePath of basePaths) {
      try {
        if (fs.existsSync(candidatePath)) {
          const raw = fs.readFileSync(candidatePath, "utf8");
          return JSON.parse(raw);
        }
      } catch (fsError) {
        console.warn(
          `⚠️ Failed to read support content from ${candidatePath}:`,
          fsError
        );
      }
    }

    console.error(
      "❌ Falling back to default donation URL because support content could not be loaded"
    );

    return { donationUrl: DEFAULT_DONATION_URL };
  }
}

const supportContent = loadSupportContent();

function openDonationPage() {
  const url = supportContent?.donationUrl || DEFAULT_DONATION_URL;
  return shell.openExternal(url);
}

// --- Icon resolver: works in dev and when packaged (asar/resources) ---
function assetPath(...p) {
  // When packaged, electron-builder copies buildResources into process.resourcesPath
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  return path.join(base, ...p);
}

console.log("=== MAIN.JS LOADING ===");
console.log("Node version:", process.version);
console.log("Electron version:", process.versions.electron);
console.log(
  `📁 Using user data path: ${app.getPath("userData")}` +
    (dataLocationSource ? ` [source: ${dataLocationSource}]` : "")
);

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

let activeProfileId = null;
let currentSettingsProfileId = null;

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
  renderLimitStep: 10,
  zoomLevel: 1, // Will be updated after app ready if no saved setting
  showFilenames: true,
  sortKey: "name",
  sortDir: "asc",
  groupByFolders: true,
  randomSeed: null,
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

function getActiveProfileId() {
  try {
    return activeProfileId || profileManager.getActiveProfile();
  } catch (error) {
    console.warn("[profile] Unable to resolve active profile", error);
    return activeProfileId;
  }
}

function getProfilePath(profileId = getActiveProfileId()) {
  return profileManager.resolveProfilePath(profileId);
}

function getSettingsPath(profileId = getActiveProfileId()) {
  const profilePath = getProfilePath(profileId);
  return path.join(profilePath, "settings.json");
}

function getProfileDisplayName(profileId = getActiveProfileId()) {
  const profiles = profileManager.listProfiles();
  const match = profiles.find((profile) => profile.id === profileId);
  return match?.name || profileId;
}

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
    const stats = await fsPromises.stat(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    let dirname = path.relative(baseFolderPath, path.dirname(filePath));
    if (dirname === ".") dirname = "";

    let fingerprint = null;
    let tags = [];
    let rating = null;
    let dimensions = null;

    const isValidDimensions = (dims) =>
      dims && Number.isFinite(dims.width) && Number.isFinite(dims.height) && dims.width > 0 && dims.height > 0;

    try {
      const metadataStore = getMetadataStore();
      const info = await metadataStore.indexFile({ filePath, stats });
      fingerprint = info?.fingerprint ?? null;
      tags = Array.isArray(info?.tags) ? info.tags : [];
      rating =
        typeof info?.rating === "number" && Number.isFinite(info.rating)
          ? info.rating
          : null;

      if (isValidDimensions(info?.dimensions)) {
        dimensions = info.dimensions;
      } else if (fingerprint) {
        const storedDims = metadataStore.getDimensions(fingerprint);
        if (isValidDimensions(storedDims)) {
          dimensions = storedDims;
        }
      }

      if (!isValidDimensions(dimensions)) {
        const computed = await getVideoDimensions(filePath, stats);
        if (isValidDimensions(computed)) {
          dimensions = computed;
          if (fingerprint) {
            metadataStore.setDimensions(fingerprint, computed);
          }
        }
      }
    } catch (metaError) {
      console.warn(
        `[metadata] Failed to index ${filePath}:`,
        metaError?.message || metaError
      );
    }

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
      basename: fileName,
      dirname,
      createdMs: stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs,
      fingerprint,
      tags,
      rating,
      dimensions: dimensions
        ? {
          width: Math.round(dimensions.width),
          height: Math.round(dimensions.height),
          aspectRatio:
            Number.isFinite(dimensions.aspectRatio) && dimensions.aspectRatio > 0
              ? dimensions.aspectRatio
              : dimensions.width / dimensions.height,
        }
        : null,
      aspectRatio:
        dimensions && isValidDimensions(dimensions)
          ? (Number.isFinite(dimensions.aspectRatio) && dimensions.aspectRatio > 0
            ? dimensions.aspectRatio
            : dimensions.width / dimensions.height)
          : null,
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
async function scanFolderForChanges(folderPath, options = {}) {
  const { recursive = true } = options;
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
      if (!recursive && depth > 0) return;
      if (recursive && depth > 10) return; // Limit depth when recursing
      const files = await fsPromises.readdir(dirPath, { withFileTypes: true });

      for (const file of files) {
        const fullPath = path.join(dirPath, file.name);

        if (file.isFile()) {
          const ext = path.extname(file.name).toLowerCase();
          if (videoExtensions.includes(ext)) {
            try {
              const stats = await fsPromises.stat(fullPath);
              currentFiles.set(fullPath, {
                size: stats.size,
                mtime: stats.mtime.getTime(),
              });
            } catch {
              // File might have been deleted while scanning
            }
          }
        } else if (
          recursive &&
          file.isDirectory() &&
          depth < 10 &&
          !file.name.startsWith(".")
        ) {
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
function computeDefaultZoomLevel() {
  try {
    return getDefaultZoomForScreen();
  } catch {
    return defaultSettings.zoomLevel;
  }
}

function normaliseLoadedSettings(rawSettings) {
  const { layoutMode, autoplayEnabled, ...cleanSettings } = rawSettings || {};
  const merged = { ...defaultSettings, ...cleanSettings };
  const hasZoom = Object.prototype.hasOwnProperty.call(cleanSettings, "zoomLevel")
    && cleanSettings.zoomLevel !== null
    && cleanSettings.zoomLevel !== undefined;
  if (!hasZoom) {
    merged.zoomLevel = computeDefaultZoomLevel();
  }
  return merged;
}

async function tryMigrateLegacySettings(profileId, targetPath) {
  if (profileId !== profileManager.DEFAULT_PROFILE_ID) {
    return null;
  }
  if (typeof profileManager.getUserDataPath !== "function") {
    return null;
  }

  let userDataPath;
  try {
    userDataPath = profileManager.getUserDataPath();
  } catch (error) {
    console.warn("[settings] Unable to resolve userData path for migration", error);
    return null;
  }

  const legacyPath = path.join(userDataPath, "settings.json");
  if (legacyPath === targetPath) {
    return null;
  }

  try {
    const legacyRaw = await fsPromises.readFile(legacyPath, "utf8");
    const legacySettings = JSON.parse(legacyRaw);
    const migrated = normaliseLoadedSettings(legacySettings);
    const { layoutMode, autoplayEnabled, ...toPersist } = migrated;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, JSON.stringify(toPersist, null, 2));
    console.log("[settings] Migrated legacy settings.json into profile scope");
    return migrated;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("[settings] Failed to migrate legacy settings", error);
    }
    return null;
  }
}

async function loadSettings(profileId = getActiveProfileId()) {
  const settingsFile = getSettingsPath(profileId);
  try {
    const data = await fsPromises.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(data);
    const settings = normaliseLoadedSettings(parsed);
    currentSettingsProfileId = profileId;
    currentSettings = settings;
    return currentSettings;
  } catch (error) {
    const migrated = await tryMigrateLegacySettings(profileId, settingsFile);
    if (migrated) {
      currentSettingsProfileId = profileId;
      currentSettings = migrated;
      return currentSettings;
    }

    if (error?.code !== "ENOENT") {
      console.warn(
        "[settings] Failed to read settings for profile, using defaults",
        error
      );
    } else {
      console.log(
        "No settings file found for profile",
        profileId,
        "— using defaults"
      );
    }

    const defaults = normaliseLoadedSettings(null);
    currentSettingsProfileId = profileId;
    currentSettings = defaults;
    return currentSettings;
  }
}

async function saveSettings(settings, profileId = getActiveProfileId()) {
  try {
    const { layoutMode, autoplayEnabled, ...cleanSettings } = settings || {};
    const settingsFile = getSettingsPath(profileId);
    await fsPromises.mkdir(path.dirname(settingsFile), { recursive: true });
    await fsPromises.writeFile(settingsFile, JSON.stringify(cleanSettings, null, 2));
    currentSettingsProfileId = profileId;
    currentSettings = normaliseLoadedSettings(cleanSettings);
    console.log("Settings saved for profile", profileId);
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

async function saveSettingsPartial(partialSettings, profileId = getActiveProfileId()) {
  try {
    const current =
      currentSettings && currentSettingsProfileId === profileId
        ? currentSettings
        : await loadSettings(profileId);
    const newSettings = { ...current, ...partialSettings };
    await saveSettings(newSettings, profileId);
  } catch (error) {
    console.error("Failed to save partial settings:", error);
  }
}

function broadcastProfileChange(settings = currentSettings) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const payload = {
      profileId: getActiveProfileId(),
      profileName: getProfileDisplayName(),
      profiles: profileManager.listProfiles(),
      settings: settings || currentSettings || defaultSettings,
    };
    mainWindow.webContents.send("settings-loaded", payload.settings);
    mainWindow.webContents.send("profile-changed", payload);
  }
}

async function reconfigureForProfile(profileId, { broadcast = true } = {}) {
  const targetId = profileManager.setActiveProfile(profileId);
  activeProfileId = targetId;
  const profilePath = getProfilePath(targetId);

  if (typeof profileManager.getUserDataPath === "function") {
    try {
      const userDataPath = profileManager.getUserDataPath();
      await migrateLegacyProfileData({
        profileId: targetId,
        profilePath,
        userDataPath,
        defaultProfileId: profileManager.DEFAULT_PROFILE_ID,
      });
    } catch (error) {
      console.warn("[profile] Legacy data migration failed", error);
    }
  }

  try {
    await folderWatcher.stop();
  } catch (error) {
    console.warn("[profile] Failed to stop watcher during profile switch", error);
  }
  lastFolderScan = new Map();

  if (typeof thumbnailCache.reset === "function") {
    try {
      thumbnailCache.reset();
    } catch (error) {
      console.warn("[profile] Failed to reset thumbnail cache", error);
    }
  }
  try {
    thumbnailCache.init(app, profilePath);
  } catch (error) {
    console.warn("[profile] Failed to init thumbnail cache for new profile", error);
  }

  resetDatabase();
  await initMetadataStore(app, profilePath);
  await ensureRecentStore(targetId);

  currentSettings = null;
  currentSettingsProfileId = null;
  const settings = await loadSettings(targetId);

  if (broadcast) {
    broadcastProfileChange(settings);
  }

  createMenu();
  return settings;
}

// ===== Window/Menu =====
async function createWindow() {
  const settings = await loadSettings();
  const appVersion = app.getVersion();

  // Choose the right icon per platform
  const iconPath =
    process.platform === "win32"
      ? assetPath("assets", "icons", "videoswarm.ico")
      : assetPath("assets", "icons", "videoswarm.png");


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
    icon: iconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    title: `Video Swarm v${appVersion}`,
  });

  // set the dock icon explicitly on macOS
  if (process.platform === "darwin") {
    try {
      app.dock.setIcon(nativeImage.createFromPath(
        assetPath("assets", "icons", "videoswarm.png")
      ));
    } catch { }
  }

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
    mainWindow.setTitle(`Video Swarm v${appVersion}`);
    mainWindow.webContents.send("settings-loaded", currentSettings);
    mainWindow.webContents.send("profile-changed", {
      profileId: getActiveProfileId(),
      profileName: getProfileDisplayName(),
      profiles: profileManager.listProfiles(),
      settings: currentSettings,
    });
  });

  mainWindow.webContents.on("dom-ready", () => {
    console.log("DOM ready, sending settings");
    mainWindow.setTitle(`Video Swarm v${appVersion}`);
    mainWindow.webContents.send("settings-loaded", currentSettings);
    mainWindow.webContents.send("profile-changed", {
      profileId: getActiveProfileId(),
      profileName: getProfileDisplayName(),
      profiles: profileManager.listProfiles(),
      settings: currentSettings,
    });
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

async function promptForProfileName(defaultValue, { title, message }) {
  if (typeof dialog.showInputBox === "function") {
    const result = await dialog.showInputBox({
      title,
      message,
      buttonLabel: "Save",
      value: defaultValue ?? "",
      inputLabel: message,
      cancelId: 1,
    });
    if (result?.canceled || result?.response === 1) {
      return null;
    }
    const value = result?.value ?? result?.textValue ?? result?.inputValue ?? "";
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length ? trimmed : null;
  }

  if (mainWindow?.webContents) {
    const requestId = `profile-prompt-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    return await new Promise((resolve) => {
      let settled = false;
      const channel = "profiles:prompt-response";
      const cleanup = () => {
        if (settled) return;
        settled = true;
        ipcMain.removeListener(channel, handler);
        clearTimeout(timeoutId);
      };
      const handler = (_event, payload) => {
        if (!payload || payload.requestId !== requestId) {
          return;
        }
        cleanup();
        const value =
          typeof payload.value === "string" ? payload.value.trim() : "";
        resolve(value.length ? value : null);
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 45000);

      ipcMain.on(channel, handler);
      try {
        mainWindow.webContents.send("profiles:prompt-input", {
          requestId,
          defaultValue,
          title,
          message,
        });
      } catch (error) {
        cleanup();
        console.warn("[profiles] Failed to request renderer prompt", error);
        resolve(null);
      }
    });
  }

  const { response } = await dialog.showMessageBox(mainWindow || null, {
    type: "question",
    buttons: ["Use Suggested", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title,
    message,
    detail:
      "Your Electron version does not provide text input dialogs. Choose 'Use Suggested' to accept the suggested name.",
  });
  if (response === 0) {
    const trimmed = typeof defaultValue === "string" ? defaultValue.trim() : "";
    return trimmed.length ? trimmed : null;
  }
  return null;
}

async function handleCreateProfileFromMenu() {
  const profiles = profileManager.listProfiles();
  const suggested = `Profile ${profiles.length + 1}`;
  const name = await promptForProfileName(suggested, {
    title: "Create Profile",
    message: "Enter a name for the new profile:",
  });
  if (!name) return;
  try {
    const profile = profileManager.createProfile(name);
    await reconfigureForProfile(profile.id);
  } catch (error) {
    console.error("Failed to create profile", error);
    await dialog.showMessageBox(mainWindow || null, {
      type: "error",
      title: "Create Profile Failed",
      message: "Could not create the profile.",
      detail: error?.message || String(error),
    });
  }
}

async function handleRenameActiveProfileFromMenu() {
  const activeId = getActiveProfileId();
  const currentName = getProfileDisplayName(activeId);
  const name = await promptForProfileName(currentName, {
    title: "Rename Profile",
    message: "Enter a new name for the active profile:",
  });
  if (!name || name === currentName) {
    return;
  }
  try {
    profileManager.renameProfile(activeId, name);
    createMenu();
    broadcastProfileChange(currentSettings);
  } catch (error) {
    console.error("Failed to rename profile", error);
    await dialog.showMessageBox(mainWindow || null, {
      type: "error",
      title: "Rename Profile Failed",
      message: "Could not rename the profile.",
      detail: error?.message || String(error),
    });
  }
}

async function handleDeleteActiveProfileFromMenu() {
  const activeId = getActiveProfileId();
  const profiles = profileManager.listProfiles();
  if (profiles.length <= 1) {
    await dialog.showMessageBox(mainWindow || null, {
      type: "warning",
      title: "Delete Profile",
      message: "At least one profile must remain.",
    });
    return;
  }

  const activeName = getProfileDisplayName(activeId);
  const { response } = await dialog.showMessageBox(mainWindow || null, {
    type: "warning",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Delete Profile",
    message: `Delete the profile "${activeName}"?`,
    detail:
      "All settings and cached data for this profile will be removed. This cannot be undone.",
  });
  if (response !== 0) {
    return;
  }

  try {
    profileManager.deleteProfile(activeId);
    await reconfigureForProfile(profileManager.getActiveProfile());
  } catch (error) {
    console.error("Failed to delete profile", error);
    await dialog.showMessageBox(mainWindow || null, {
      type: "error",
      title: "Delete Profile Failed",
      message: "Could not delete the profile.",
      detail: error?.message || String(error),
    });
  }
}

function buildProfilesMenuTemplate() {
  const profiles = profileManager.listProfiles();
  if (!profiles.length) {
    return [];
  }
  const activeId = getActiveProfileId();
  const activeName = getProfileDisplayName(activeId);

  const submenu = [
    { label: `Active: ${activeName}`, enabled: false },
    { type: "separator" },
    ...profiles.map((profile) => ({
      label: profile.name,
      type: "radio",
      checked: profile.id === activeId,
      click: () => {
        if (profile.id !== getActiveProfileId()) {
          reconfigureForProfile(profile.id).catch((error) => {
            console.error("Failed to switch profile", error);
          });
        }
      },
    })),
    { type: "separator" },
    {
      label: "Create Profile…",
      click: () => {
        handleCreateProfileFromMenu().catch((error) => {
          console.error("Create profile handler failed", error);
        });
      },
    },
    {
      label: "Rename Profile…",
      enabled: profiles.length > 0,
      click: () => {
        handleRenameActiveProfileFromMenu().catch((error) => {
          console.error("Rename profile handler failed", error);
        });
      },
    },
    {
      label: "Delete Profile…",
      enabled: profiles.length > 1,
      click: () => {
        handleDeleteActiveProfileFromMenu().catch((error) => {
          console.error("Delete profile handler failed", error);
        });
      },
    },
  ];

  return submenu;
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
      label: "Profiles",
      submenu: buildProfilesMenuTemplate(),
    },
    {
      label: "Options",
      submenu: [
        {
          label: "Data Location",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("ui:open-data-location");
            }
          },
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
    {
      label: "Help",
      submenu: [
        {
          label: "About VideoSwarm",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("ui:open-about");
            }
          },
        },
        {
          label: "Support VideoSwarm on Ko-fi",
          click: () => {
            openDonationPage().catch((error) => {
              console.warn("Failed to open support link", error);
            });
          },
        },
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
let RecentStoreClass = null;
let recentStoreProfilePath = null;

async function loadRecentStoreClass() {
  if (RecentStoreClass) {
    return RecentStoreClass;
  }
  const mod = await import("electron-store");
  RecentStoreClass = mod.default || mod.Store || mod;
  return RecentStoreClass;
}

async function initRecentStore(profilePath) {
  try {
    const normalized = typeof profilePath === "string" ? profilePath.trim() : "";
    if (!normalized) {
      throw new Error("Profile path is required for recent store initialization");
    }
    const StoreClass = await loadRecentStoreClass();
    recentStore = new StoreClass({
      name: "recent-folders",
      cwd: normalized,
      fileExtension: "json",
      clearInvalidConfig: true,
      accessPropertiesByDotNotation: false,
    });
    recentStoreProfilePath = normalized;
    console.log("📁 recentStore initialized for", normalized);
  } catch (e) {
    console.warn("📁 electron-store unavailable:", e?.message);
    recentStore = null; // feature gracefully disabled
    recentStoreProfilePath = null;
  }
}

async function ensureRecentStore(profileId = getActiveProfileId()) {
  const profilePath = getProfilePath(profileId);
  if (!recentStore || recentStoreProfilePath !== profilePath) {
    await initRecentStore(profilePath);
  }
}

async function getRecentFolders() {
  await ensureRecentStore();
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
  await ensureRecentStore();
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
  await ensureRecentStore();
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
  await ensureRecentStore();
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
  await ensureRecentStore();
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

ipcMain.handle("support:open-donation", async () => {
  try {
    await openDonationPage();
    return true;
  } catch (error) {
    console.warn("Failed to open support link", error);
    throw error;
  }
});

ipcMain.handle("data-location:get-state", async () => {
  try {
    return dataLocationManager.getRendererState();
  } catch (error) {
    console.warn("[data-location] Failed to get state", error);
    return dataLocationManager.getRendererState();
  }
});

ipcMain.handle("data-location:browse", async () => {
  const browser = BrowserWindow.getFocusedWindow() || mainWindow || null;
  return dataLocationManager.browseForDirectory(browser);
});

ipcMain.handle("data-location:apply", async (_event, payload) => {
  const browser = BrowserWindow.getFocusedWindow() || mainWindow || null;
  return dataLocationManager.applySelection(payload, browser);
});

ipcMain.handle("profiles:list", async () => ({
  success: true,
  profiles: profileManager.listProfiles(),
  activeProfileId: getActiveProfileId(),
  profileName: getProfileDisplayName(),
}));

ipcMain.handle("profiles:get-active", async () => ({
  profileId: getActiveProfileId(),
  profileName: getProfileDisplayName(),
  profiles: profileManager.listProfiles(),
}));

ipcMain.handle("profiles:set-active", async (_event, profileId) => {
  try {
    await reconfigureForProfile(profileId);
    return {
      success: true,
      profileId: getActiveProfileId(),
      profileName: getProfileDisplayName(),
      profiles: profileManager.listProfiles(),
    };
  } catch (error) {
    console.error("Failed to switch profile", error);
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("profiles:create", async (_event, name) => {
  try {
    const profile = profileManager.createProfile(name);
    await reconfigureForProfile(profile.id);
    return {
      success: true,
      profile,
      activeProfileId: getActiveProfileId(),
      profiles: profileManager.listProfiles(),
    };
  } catch (error) {
    console.error("Failed to create profile via IPC", error);
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("profiles:rename", async (_event, profileId, newName) => {
  try {
    const renamed = profileManager.renameProfile(profileId, newName);
    createMenu();
    if (profileId === getActiveProfileId()) {
      broadcastProfileChange(currentSettings);
    }
    return {
      success: true,
      profile: renamed,
      profiles: profileManager.listProfiles(),
    };
  } catch (error) {
    console.error("Failed to rename profile via IPC", error);
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("profiles:delete", async (_event, profileId) => {
  try {
    const removed = profileManager.deleteProfile(profileId);
    await reconfigureForProfile(profileManager.getActiveProfile());
    return {
      success: true,
      removed,
      activeProfileId: getActiveProfileId(),
      profiles: profileManager.listProfiles(),
    };
  } catch (error) {
    console.error("Failed to delete profile via IPC", error);
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.on("thumb:put", (event, payload) => {
  try {
    if (!thumbnailCache.initialized) {
      try {
        thumbnailCache.init(app, getProfilePath(getActiveProfileId()));
      } catch (initError) {
        console.warn("[thumb-cache] late init failed", initError);
      }
    }
    const result = thumbnailCache.put(nativeImage, payload);
    event.returnValue = result;
  } catch (error) {
    console.error("[thumb-cache] put failed", error);
    event.returnValue = {
      ok: false,
      error: error?.message || "UNKNOWN_ERROR",
    };
  }
});

ipcMain.on("thumb:get", (event, payload) => {
  try {
    if (!thumbnailCache.initialized) {
      try {
        thumbnailCache.init(app, getProfilePath(getActiveProfileId()));
      } catch (initError) {
        console.warn("[thumb-cache] late init failed", initError);
      }
    }
    const pathKey = payload?.path;
    const signature = payload?.signature;
    const result = thumbnailCache.has(pathKey, signature);
    event.returnValue = result;
  } catch (error) {
    console.error("[thumb-cache] get failed", error);
    event.returnValue = {
      ok: false,
      error: error?.message || "UNKNOWN_ERROR",
    };
  }
});

ipcMain.on("dnd:start-file", (event, payload) => {
  const normalize = (value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray(value.paths)) {
      return value.paths;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return [value];
    }
    return [];
  };

  try {
    if (!thumbnailCache.initialized) {
      try {
        thumbnailCache.init(app, getProfilePath(getActiveProfileId()));
      } catch (initError) {
        console.warn("[thumb-cache] late init failed", initError);
      }
    }

    const candidates = normalize(payload).filter(
      (entry) => typeof entry === "string" && entry.trim().length > 0
    );
    const filePath = candidates[0];
    if (!filePath) {
      event.returnValue = { ok: false, error: "NO_FILE" };
      return;
    }

    let icon = thumbnailCache.getForDrag(nativeImage, filePath);
    if (!icon || (typeof icon.isEmpty === "function" && icon.isEmpty())) {
      icon = getEmbeddedDragIcon(nativeImage);
    }

    if (!icon || (typeof icon.isEmpty === "function" && icon.isEmpty())) {
      event.returnValue = { ok: false, error: "NO_ICON" };
      return;
    }

    event.sender.startDrag({
      file: filePath,
      icon,
    });
    event.returnValue = { ok: true };
  } catch (error) {
    console.error("Failed to start native drag:", error);
    event.returnValue = {
      ok: false,
      error: error?.message || "UNKNOWN_ERROR",
    };
  }
});

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

ipcMain.handle("confirm-move-to-trash", async (event, payload = {}) => {
  const requester = event?.sender;
  const win = requester ? BrowserWindow.fromWebContents(requester) : mainWindow;
  const count = Number(payload?.count) || 0;
  const sampleName = payload?.sampleName || "";

  const message = count === 1 && sampleName
    ? `Move "${sampleName}" to Recycle Bin?`
    : count === 1
      ? "Move this item to Recycle Bin?"
      : `Move ${count} item${count === 1 ? "" : "s"} to Recycle Bin?`;

  try {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Move to Bin", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message,
    });

    const confirmed = response === 0;

    const refocus = () => {
      if (!win || win.isDestroyed()) return;
      try {
        win.focus();
      } catch { }
      try {
        win.webContents.focus();
      } catch { }
    };

    refocus();
    setTimeout(refocus, 0);

    return confirmed;
  } catch (error) {
    console.error("Failed to show confirm dialog:", error);
    if (win && !win.isDestroyed()) {
      try {
        win.focus();
        win.webContents.focus();
      } catch { }
    }
    return false;
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
        const files = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const file of files) {
          const fullPath = path.join(dirPath, file.name);

          if (file.isFile()) {
            const ext = path.extname(file.name).toLowerCase();
            if (videoExtensions.includes(ext)) {
              try {
                const videoFile = await createVideoFileObject(
                  fullPath,
                  folderPath
                );
                if (videoFile) {
                  videoFiles.push(videoFile);
                }
              } catch (error) {
                console.warn(
                  `Error reading file stats for ${fullPath}:`,
                  error.message
                );
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

ipcMain.handle("metadata:list-tags", async () => {
  try {
    const store = getMetadataStore();
    return { tags: store.listTags() };
  } catch (error) {
    console.error("Failed to list tags:", error);
    return { tags: [], error: error?.message || String(error) };
  }
});

ipcMain.handle(
  "metadata:add-tags",
  async (_event, fingerprints = [], tagNames = []) => {
    try {
      const store = getMetadataStore();
      const cleanFingerprints = Array.isArray(fingerprints)
        ? fingerprints.filter(Boolean)
        : [];
      const cleanNames = Array.isArray(tagNames)
        ? tagNames
          .map((name) => (name ?? "").toString().trim())
          .filter(Boolean)
        : [];
      if (!cleanFingerprints.length || !cleanNames.length) {
        return { updates: {}, tags: store.listTags() };
      }
      const updates = store.assignTags(cleanFingerprints, cleanNames);
      return { updates, tags: store.listTags() };
    } catch (error) {
      console.error("Failed to assign tags:", error);
      return { updates: {}, error: error?.message || String(error) };
    }
  }
);

ipcMain.handle(
  "metadata:remove-tag",
  async (_event, fingerprints = [], tagName) => {
    try {
      const store = getMetadataStore();
      const cleanFingerprints = Array.isArray(fingerprints)
        ? fingerprints.filter(Boolean)
        : [];
      const cleanName = (tagName ?? "").toString().trim();
      if (!cleanFingerprints.length || !cleanName) {
        return { updates: {}, tags: store.listTags() };
      }
      const updates = store.removeTag(cleanFingerprints, cleanName);
      return { updates, tags: store.listTags() };
    } catch (error) {
      console.error("Failed to remove tag:", error);
      return { updates: {}, error: error?.message || String(error) };
    }
  }
);

ipcMain.handle(
  "metadata:set-rating",
  async (_event, fingerprints = [], ratingValue) => {
    try {
      const store = getMetadataStore();
      const cleanFingerprints = Array.isArray(fingerprints)
        ? fingerprints.filter(Boolean)
        : [];
      if (!cleanFingerprints.length) {
        return { updates: {} };
      }
      const rating =
        ratingValue === null || ratingValue === undefined
          ? null
          : Math.max(0, Math.min(5, Math.round(Number(ratingValue))));
      const updates = store.setRating(cleanFingerprints, rating);
      return { updates };
    } catch (error) {
      console.error("Failed to set rating:", error);
      return { updates: {}, error: error?.message || String(error) };
    }
  }
);

ipcMain.handle("metadata:get", async (_event, fingerprints = []) => {
  try {
    const store = getMetadataStore();
    const cleanFingerprints = Array.isArray(fingerprints)
      ? fingerprints.filter(Boolean)
      : [];
    return { updates: store.getMetadataForFingerprints(cleanFingerprints) };
  } catch (error) {
    console.error("Failed to load metadata:", error);
    return { updates: {}, error: error?.message || String(error) };
  }
});

// File info helpers
ipcMain.handle("get-file-info", async (_event, filePath) => {
  try {
    const stats = await fsPromises.stat(filePath);
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
    await fsPromises.copyFile(sourcePath, destPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle("get-file-properties", async (_event, filePath) => {
  try {
    const stats = await fsPromises.stat(filePath);
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
ipcMain.handle("start-folder-watch", async (_event, folderPath, recursive) => {
  try {
    const result = await folderWatcher.start(folderPath, {
      recursive: recursive ?? true,
    });
    return {
      success: true,
      mode: result.mode,
      recursive: result.recursive,
    };
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
    await dataLocationManager.ensureReady();
    profileManager.initializeProfileManager(app.getPath("userData"));
    activeProfileId = profileManager.getActiveProfile();
    console.log("GPU status:", app.getGPUFeatureStatus());
    await reconfigureForProfile(activeProfileId, { broadcast: false });
    await createWindow();
    broadcastProfileChange(currentSettings || defaultSettings);
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
app.on("will-quit", async () => {
  await folderWatcher.stop();
  try {
    thumbnailCache.shutdown();
  } catch (error) {
    console.warn("[thumb-cache] shutdown failed", error);
  }
});
