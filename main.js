// main.js
console.log("=== COMMAND LINE ARGS ===");
console.log(process.argv);

const {
  app,
  BrowserWindow,
  shell,
  ipcMain: rawIpcMain,
  dialog,
  Menu,
  nativeImage,
  clipboard,
  protocol,
} = require("electron");
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) {
  app.quit();
}
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const fsPromises = fs.promises;
const { DataLocationManager } = require("./main/data-location-manager");
const dataLocationManager = new DataLocationManager({ app, dialog });
const { source: dataLocationSource } = dataLocationManager.bootstrap(process.argv);

const { getEmbeddedDragIcon } = require("./main/drag-icon");
const {
  clearVideoDimensionsCache,
  getVideoDimensions,
} = require("./main/videoDimensions");
const { initMetadataStore, getMetadataStore, resetDatabase } = require("./main/database");
const profileManager = require("./main/profile-manager");
const { thumbnailCache } = require("./main/thumb-cache");
const { createProxyManager } = require("./main/proxy-manager");
const proxyManager = createProxyManager();
const {
  createLastFrameCaptureService,
} = require("./main/last-frame-capture");
const lastFrameCaptureService = createLastFrameCaptureService();
const {
  createNativeOwnerLifecycle,
} = require("./main/native-owner-lifecycle");
const nativeOwnerLifecycle = createNativeOwnerLifecycle();
const { createSidecarMetadataService } = require("./main/sidecar-metadata");
const { runProfileOwnedOperation } = require("./main/profile-owned-operation");
const {
  normalizeGenerationRequestToken,
  createGenerationRequestIdentity,
} = require("./main/generation-request");
const sidecarMetadataService = createSidecarMetadataService();
const { migrateLegacyProfileData } = require("./main/profile-migration");
const { pollFolderForChanges } = require("./main/polling-scanner");
const {
  createPlaybackCapabilities,
  normalizePlaybackMode,
} = require("./main/playback-capabilities");
const {
  attachWindowActivity,
  readWindowActivity,
} = require("./main/window-activity");
const {
  createDirectoryScanProgressReporter,
  createPeriodicEventLoopYielder,
} = require("./main/directory-scan-progress");
const {
  createCachedLibraryResponse,
} = require("./main/cached-library-snapshot");
const {
  IPC_LIMITS,
  assertBoolean,
  assertInteger,
  assertPathString,
  assertPayloadSize,
  assertPlainObject,
  assertPngDataUrlDimensions,
  assertString,
  assertStringArray,
  createIpcTrustValidator,
  createPathAuthority,
  createTrustedIpcRegistrar,
  isAllowedFrameUrl,
} = require("./main/ipc-security");
const {
  createMediaInstanceUrl,
  createMediaProxyUrl,
  createMediaProtocolService,
  registerMediaScheme,
} = require("./main/media-protocol");
const {
  createSettingsWriter,
  readSettingsFileBounded,
} = require("./main/settings-writer");
const {
  createDirectoryAggregateBatcher,
} = require("./main/directory-aggregate-batcher");
const {
  createTrashConfirmationStore,
  trashAuthorizedPaths,
} = require("./main/ipc-trash");
const {
  REVIEW_MANIFEST_MAX_RECORDS,
  normalizeManifestDirectory,
  normalizeManifestScope,
} = require("./main/review-manifest");
const {
  createReviewManifestExportCoordinator,
} = require("./main/review-manifest-export-coordinator");
const {
  normalizeReviewRestoreSnapshots,
} = require("./main/review-metadata-restore");
const {
  REVIEW_SESSION_FLUSH_ACK_CHANNEL,
  createReviewSessionFlushCoordinator,
} = require("./main/review-session-flush");

// Custom schemes must be declared before Electron finishes app readiness.
registerMediaScheme(protocol);

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
  playbackMode: "balanced",
  proxyPlaybackEnabled: false,
  reviewAutoAdvance: false,
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
let disposeMainWindowActivity = null;
let applicationInitializationPromise = null;
let applicationInitializationComplete = false;
let windowCreationPromise = null;
let nativeShutdownPreparing = false;
let nativeShutdownRequested = false;
let nativeShutdownPromise = null;
let nativeShutdownComplete = false;
let profileReconfigurationPending = 0;
let profileReconfigurationInProgress = false;
let reviewSessionFlushBarrierDepth = 0;
const pendingProfilePromptCancellations = new Set();
const dataLocationPathGrants = new Map();
const DATA_LOCATION_GRANT_TTL_MS = 5 * 60 * 1000;

function isLiveMainWindowOwner(owner) {
  return Boolean(
    owner &&
    mainWindow &&
    !mainWindow.isDestroyed?.() &&
    mainWindow.webContents === owner &&
    !owner.isDestroyed?.()
  );
}

const reviewSessionFlushCoordinator =
  createReviewSessionFlushCoordinator({
    sendRequest: (owner, channel, payload) => owner.send(channel, payload),
    isOwnerActive: isLiveMainWindowOwner,
  });

async function runReviewSessionFlushBarrier(
  owner = mainWindow && !mainWindow.isDestroyed?.()
    ? mainWindow.webContents
    : null
) {
  if (!isLiveMainWindowOwner(owner) || profileReconfigurationInProgress) {
    return Object.freeze({
      requested: false,
      acknowledged: false,
      reason: profileReconfigurationInProgress
        ? "profile-reconfiguration-in-progress"
        : "owner-unavailable",
    });
  }
  reviewSessionFlushBarrierDepth += 1;
  try {
    return await reviewSessionFlushCoordinator.request(owner);
  } finally {
    reviewSessionFlushBarrierDepth = Math.max(
      0,
      reviewSessionFlushBarrierDepth - 1
    );
  }
}

app.on("second-instance", () => {
  if (!ownsSingleInstanceLock) return;
  void ensureMainWindow()
    .then((window) => focusMainWindow(window))
    .catch((error) => {
      console.error("[window] Failed to restore the primary window", error);
    });
});

async function grantDataLocationPath(sender, candidate) {
  if (!sender || sender.isDestroyed?.() || !Number.isSafeInteger(sender.id)) {
    throw new Error("Data-location picker owner is no longer available");
  }
  const canonicalPath = path.resolve(await fsPromises.realpath(candidate));
  const stats = await fsPromises.stat(canonicalPath);
  if (!stats.isDirectory()) {
    throw new Error("The selected data location is not a directory");
  }
  if (sender.isDestroyed?.()) {
    throw new Error("Data-location picker owner is no longer available");
  }
  dataLocationPathGrants.set(sender.id, {
    path: canonicalPath,
    expiresAt: Date.now() + DATA_LOCATION_GRANT_TTL_MS,
  });
  return canonicalPath;
}

async function assertGrantedDataLocationPath(sender, candidate) {
  if (!sender || sender.isDestroyed?.()) {
    throw new Error("Data-location picker owner is no longer available");
  }
  const grant = dataLocationPathGrants.get(sender.id);
  if (!grant || grant.expiresAt < Date.now()) {
    dataLocationPathGrants.delete(sender.id);
    throw new Error("Select the data folder with the native picker first");
  }
  const requestedPath = assertPathString(candidate, {
    name: "custom data location",
  });
  const canonicalPath = path.resolve(await fsPromises.realpath(requestedPath));
  if (
    sender.isDestroyed?.() ||
    dataLocationPathGrants.get(sender.id) !== grant ||
    canonicalPath !== grant.path
  ) {
    throw new Error("The requested data folder is not authorized");
  }
  return canonicalPath;
}

function cancelPendingProfilePrompts() {
  const pending = [...pendingProfilePromptCancellations];
  pending.forEach((cancel) => cancel());
  return pending.length;
}

const PACKAGED_RENDERER_URL = pathToFileURL(
  path.join(__dirname, "dist-react", "index.html")
).href;

function getDevRendererOrigin() {
  try {
    return new URL(
      process.env.VITE_DEV_SERVER_URL || "http://localhost:5173"
    ).origin;
  } catch {
    return "http://localhost:5173";
  }
}

function isDevelopmentRuntime() {
  return (
    !app.isPackaged &&
    (process.argv.includes("--dev") || Boolean(process.env.VITE_DEV_SERVER_URL))
  );
}

function getTrustedDevOrigins() {
  return isDevelopmentRuntime() ? [getDevRendererOrigin()] : [];
}

function isTrustedRendererUrl(url) {
  return isAllowedFrameUrl(url, {
    allowedFrameUrls: [PACKAGED_RENDERER_URL],
    allowedOrigins: getTrustedDevOrigins(),
  });
}

const validateTrustedSender = createIpcTrustValidator({
  getMainWindow: () => mainWindow,
  allowedFrameUrls: () => [PACKAGED_RENDERER_URL],
  allowedOrigins: getTrustedDevOrigins,
});
const reviewSessionFlushInboundChannels = new Set([
  "review-sessions:save",
  REVIEW_SESSION_FLUSH_ACK_CHANNEL,
]);
const assertTrustedSender = (event, trustContext = {}) => {
  const trusted = validateTrustedSender(event);
  const flushIpcAllowed =
    reviewSessionFlushInboundChannels.has(trustContext?.channel) &&
    reviewSessionFlushCoordinator.isPendingOwner(event.sender);
  if (nativeShutdownRequested) {
    const error = new Error("Application shutdown is in progress");
    error.code = "APPLICATION_SHUTDOWN_REQUESTED";
    throw error;
  }
  if (
    (nativeShutdownPreparing || reviewSessionFlushBarrierDepth > 0) &&
    !flushIpcAllowed
  ) {
    const error = new Error("Application lifecycle flush is in progress");
    error.code = nativeShutdownPreparing
      ? "APPLICATION_SHUTDOWN_REQUESTED"
      : "PROFILE_RECONFIGURATION_IN_PROGRESS";
    throw error;
  }
  if (profileReconfigurationInProgress) {
    const error = new Error("Profile reconfiguration is in progress");
    error.code = "PROFILE_RECONFIGURATION_IN_PROGRESS";
    throw error;
  }
  return trusted;
};
const trustedIpc = createTrustedIpcRegistrar({
  ipcMain: rawIpcMain,
  assertTrustedSender,
  logger: console,
});

// Keep existing registration call sites readable while ensuring every static
// inbound channel passes through the same sender/frame/payload boundary.
const ipcMain = Object.freeze({
  handle: (...args) => trustedIpc.handle(...args),
  on: (...args) => trustedIpc.on(...args),
});

const pathAuthority = createPathAuthority();
const trashConfirmationStore = createTrashConfirmationStore();
const activeTrashOperations = new Set();
let trashAdmissionOpen = true;

function trashFileIdentity(stats) {
  if (!stats?.isFile?.()) {
    throw new Error("Trash confirmation target is not a regular file");
  }
  return [
    Number(stats.dev) || 0,
    Number(stats.ino) || 0,
    Number(stats.size) || 0,
    Number(stats.mtimeMs) || 0,
    Number(stats.ctimeMs) || 0,
    Number(stats.birthtimeMs) || 0,
  ].join(":");
}

async function readTrashFileIdentity(filePath) {
  return trashFileIdentity(await fsPromises.stat(filePath));
}

async function drainActiveTrashOperations() {
  while (activeTrashOperations.size > 0) {
    await Promise.allSettled([...activeTrashOperations]);
  }
}

function trackTrashOperation(operation) {
  const tracked = Promise.resolve(operation);
  activeTrashOperations.add(tracked);
  tracked.then(
    () => activeTrashOperations.delete(tracked),
    () => activeTrashOperations.delete(tracked)
  );
  return tracked;
}

function getAuthorityScopeId() {
  return getActiveProfileId() || "startup";
}

async function grantRendererRoot(sender, rootPath) {
  if (
    !sender ||
    !Number.isSafeInteger(sender.id) ||
    sender.isDestroyed?.()
  ) {
    throw new TypeError("A live renderer owner is required");
  }
  if (profileReconfigurationInProgress) {
    throw Object.assign(new Error("Profile reconfiguration is in progress"), {
      code: "PROFILE_RECONFIGURATION_IN_PROGRESS",
    });
  }
  const scopeId = getAuthorityScopeId();
  const profileGeneration = metadataProfileGeneration;
  const canonicalRoot = await pathAuthority.grantRoot({
    ownerId: sender.id,
    scopeId,
    rootPath,
  });
  if (
    profileReconfigurationInProgress ||
    nativeShutdownPreparing ||
    nativeShutdownRequested ||
    sender.isDestroyed?.() ||
    scopeId !== getAuthorityScopeId() ||
    profileGeneration !== metadataProfileGeneration
  ) {
    pathAuthority.revokeScope(scopeId);
    throw Object.assign(new Error("Profile root grant became stale"), {
      code: "PROFILE_RECONFIGURATION_IN_PROGRESS",
    });
  }
  return canonicalRoot;
}

async function grantKnownRendererRoots(sender, rootPaths) {
  const results = await Promise.allSettled(
    [...new Set((Array.isArray(rootPaths) ? rootPaths : []).filter(Boolean))]
      .slice(0, 256)
      .map((rootPath) => grantRendererRoot(sender, rootPath))
  );
  return results.filter((result) => result.status === "fulfilled").length;
}

async function assertRendererPath(event, targetPath, kind = null) {
  if (profileReconfigurationInProgress) {
    throw Object.assign(new Error("Profile reconfiguration is in progress"), {
      code: "PROFILE_RECONFIGURATION_IN_PROGRESS",
    });
  }
  const scopeId = getAuthorityScopeId();
  const profileGeneration = metadataProfileGeneration;
  const authorized = await pathAuthority.assertAuthorizedPath({
    ownerId: event.sender.id,
    scopeId,
    targetPath: assertPathString(targetPath),
    kind,
  });
  if (
    profileReconfigurationInProgress ||
    nativeShutdownPreparing ||
    nativeShutdownRequested ||
    scopeId !== getAuthorityScopeId() ||
    profileGeneration !== metadataProfileGeneration
  ) {
    throw Object.assign(new Error("Filesystem authority became stale"), {
      code: "PROFILE_RECONFIGURATION_IN_PROGRESS",
    });
  }
  return authorized;
}

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

// Only one interactive directory scan may be active per renderer. Keeping the
// generation in the main process prevents a slow, older request from continuing
// to index files after the renderer has opened another folder or changed profile.
const activeDirectoryScans = new Map();
const DIRECTORY_SCAN_PROTOCOL_VERSION = 1;
const DIRECTORY_SCAN_FIRST_BATCH_SIZE = 32;
const DIRECTORY_SCAN_BATCH_SIZE = 128;
const DIRECTORY_SCAN_PATCH_BATCH_SIZE = 32;
const DIRECTORY_SCAN_INDEX_BATCH_SIZE = 64;
const DIRECTORY_SCAN_INDEX_CONCURRENCY = 4;
const DIRECTORY_SCAN_ENRICHMENT_CONCURRENCY = 2;
const DIRECTORY_SCAN_PRIORITY_LIMIT = 256;
let legacyDirectoryScanSequence = 0;
let metadataProfileGeneration = 0;
let configuredMetadataProfileGeneration = 0;
let profileReconfigureQueue = Promise.resolve();
let activeWatcherContext = null;
let watcherContextSequence = 0;
let videoDimensionsRootPath = null;
const registeredNativeWorkOwners = new WeakSet();

class DirectoryScanCancelledError extends Error {
  constructor() {
    super("Directory scan cancelled");
    this.name = "DirectoryScanCancelledError";
    this.code = "DIRECTORY_SCAN_CANCELLED";
  }
}

class ProfileReconfigurationSupersededError extends Error {
  constructor() {
    super("Profile switch superseded by a newer request");
    this.name = "ProfileReconfigurationSupersededError";
    this.code = "PROFILE_RECONFIGURATION_SUPERSEDED";
  }
}

class ProfileOperationInvalidatedError extends Error {
  constructor() {
    super("Profile-scoped operation was invalidated");
    this.name = "ProfileOperationInvalidatedError";
    this.code = "PROFILE_OPERATION_INVALIDATED";
  }
}

class ApplicationShutdownRequestedError extends Error {
  constructor() {
    super("Application shutdown is in progress");
    this.name = "ApplicationShutdownRequestedError";
    this.code = "APPLICATION_SHUTDOWN_REQUESTED";
  }
}

function isDirectoryScanCancelled(error) {
  return error?.code === "DIRECTORY_SCAN_CANCELLED";
}

function beginDirectoryScan(senderId, requestedScanId) {
  const previous = activeDirectoryScans.get(senderId);
  if (previous) {
    previous.cancelled = true;
    markDirectoryScanInterrupted(previous);
  }

  const scanId =
    typeof requestedScanId === "string" && requestedScanId.length > 0
      ? requestedScanId
      : `legacy-${Date.now()}-${++legacyDirectoryScanSequence}`;
  const scan = {
    senderId,
    scanId,
    cancelled: false,
    recordSequence: 0,
    priorityIds: [],
  };
  activeDirectoryScans.set(senderId, scan);
  return scan;
}

function updateDirectoryScanPriorities(senderId, scanId, ids) {
  const scan = activeDirectoryScans.get(senderId);
  if (!scan || scan.cancelled || scan.scanId !== scanId) return false;
  const seen = new Set();
  scan.priorityIds = (Array.isArray(ids) ? ids : [])
    .filter((id) => {
      if (typeof id !== "string" || !id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, DIRECTORY_SCAN_PRIORITY_LIMIT);
  return true;
}

function takePrioritizedDirectoryScanBatch(pending, scan, limit) {
  const batch = [];
  for (const id of scan.priorityIds) {
    const entry = pending.get(id);
    if (!entry) continue;
    pending.delete(id);
    batch.push(entry);
    if (batch.length >= limit) return batch;
  }
  while (batch.length < limit && pending.size > 0) {
    const [id, entry] = pending.entries().next().value;
    pending.delete(id);
    batch.push(entry);
  }
  return batch;
}

function assertDirectoryScanActive(scan) {
  if (
    !scan ||
    scan.cancelled ||
    activeDirectoryScans.get(scan.senderId) !== scan
  ) {
    throw new DirectoryScanCancelledError();
  }
}

function cancelDirectoryScan(senderId, scanId = null) {
  const scan = activeDirectoryScans.get(senderId);
  if (!scan || (scanId && scan.scanId !== scanId)) {
    return false;
  }
  scan.cancelled = true;
  markDirectoryScanInterrupted(scan);
  activeDirectoryScans.delete(senderId);
  return true;
}

function cancelAllDirectoryScans() {
  for (const scan of activeDirectoryScans.values()) {
    scan.cancelled = true;
    markDirectoryScanInterrupted(scan);
  }
  activeDirectoryScans.clear();
}

function markDirectoryScanInterrupted(scan) {
  const context = scan?.metadataContext;
  if (
    !scan?.rootPath ||
    !context?.metadataStore ||
    context.generation !== metadataProfileGeneration ||
    context.profileId !== getActiveProfileId()
  ) {
    return;
  }
  try {
    context.metadataStore.registerLibraryRoot(scan.rootPath, {
      recursive: scan.recursive,
      refreshState: "interrupted",
    });
  } catch (error) {
    console.warn("[metadata] Failed to mark interrupted scan", error);
  }
}

function captureMetadataContext() {
  if (
    profileReconfigurationInProgress ||
    nativeShutdownRequested ||
    configuredMetadataProfileGeneration !== metadataProfileGeneration
  ) {
    throw new DirectoryScanCancelledError();
  }
  return {
    profileId: getActiveProfileId(),
    generation: metadataProfileGeneration,
    metadataStore: getMetadataStore(),
  };
}

function assertMetadataContextActive(context) {
  if (
    !context ||
    nativeShutdownRequested ||
    configuredMetadataProfileGeneration !== metadataProfileGeneration ||
    context.generation !== metadataProfileGeneration ||
    context.profileId !== getActiveProfileId()
  ) {
    throw new DirectoryScanCancelledError();
  }
}

function captureProfileGenerationContext() {
  if (
    profileReconfigurationInProgress ||
    nativeShutdownRequested ||
    configuredMetadataProfileGeneration !== metadataProfileGeneration
  ) {
    throw new ProfileOperationInvalidatedError();
  }
  return {
    profileId: getActiveProfileId(),
    generation: metadataProfileGeneration,
  };
}

function assertProfileGenerationContextActive(context) {
  if (
    !context ||
    nativeShutdownRequested ||
    configuredMetadataProfileGeneration !== metadataProfileGeneration ||
    context.generation !== metadataProfileGeneration ||
    context.profileId !== getActiveProfileId()
  ) {
    throw new ProfileOperationInvalidatedError();
  }
}

const mediaProtocolService = createMediaProtocolService({
  resolveInstance: async (instanceId, { target } = {}) => {
    const context = captureMetadataContext();
    if (target?.generation !== context.generation) return null;
    const instance = context.metadataStore.getFileInstanceById(instanceId);
    assertMetadataContextActive(context);
    if (!instance?.present || !instance.absolutePath) return null;
    return { path: instance.absolutePath, present: true, instanceId };
  },
  resolveProxy: async (signature, { target } = {}) => {
    const context = captureMetadataContext();
    if (target?.generation !== context.generation) return null;
    const resolved = await proxyManager.resolveProtocolProxy(signature);
    assertMetadataContextActive(context);
    return resolved;
  },
  authorizePath: async (canonicalPath, target) => {
    if (target?.kind === "proxy") {
      // ProxyManager resolves only the current generation's signature-derived
      // file and rejects cache-directory symlink escapes. It is an
      // application-owned path, not a renderer-selected library path.
      return;
    }
    const sender = mainWindow?.webContents;
    if (!sender || sender.isDestroyed?.()) {
      const error = new Error("Media owner is unavailable");
      error.status = 403;
      throw error;
    }
    try {
      await pathAuthority.assertAuthorizedPath({
        ownerId: sender.id,
        scopeId: getAuthorityScopeId(),
        targetPath: canonicalPath,
        kind: "file",
      });
    } catch (error) {
      error.status = 403;
      throw error;
    }
  },
  logger: console,
});

function setVideoDimensionsRoot(folderPath = null) {
  const normalized = folderPath ? path.resolve(folderPath) : null;
  if (normalized === videoDimensionsRootPath) return;
  clearVideoDimensionsCache();
  videoDimensionsRootPath = normalized;
}

function registerNativeWorkOwner(sender) {
  if (!sender || (typeof sender !== "object" && typeof sender !== "function")) {
    return null;
  }
  const ownerId = sender.id;
  nativeOwnerLifecycle.ensure(sender);
  if (!registeredNativeWorkOwners.has(sender)) {
    registeredNativeWorkOwners.add(sender);
    sender.once?.("destroyed", () => {
      disposeNativeWorkOwner(sender);
    });
  }
  return ownerId;
}

function invalidateNativeWorkOwner(sender) {
  if (!sender) return false;
  reviewSessionFlushCoordinator.cancelOwner(sender);
  nativeOwnerLifecycle.invalidate(sender);
  const ownerId = sender.id;
  thumbnailCache.cancelOwner(ownerId);
  lastFrameCaptureService.cancelOwner(ownerId);
  proxyManager.disposeOwner(ownerId);
  return true;
}

function activateNativeWorkOwner(sender) {
  if (
    nativeShutdownPreparing ||
    nativeShutdownRequested ||
    !sender ||
    !nativeOwnerLifecycle.activate(sender)
  ) {
    return false;
  }
  proxyManager.setOwnerActive(sender.id, true);
  return true;
}

function disposeNativeWorkOwner(sender) {
  if (!sender) return false;
  reviewSessionFlushCoordinator.cancelOwner(sender);
  nativeOwnerLifecycle.dispose(sender);
  const ownerId = sender.id;
  thumbnailCache.cancelOwner(ownerId);
  lastFrameCaptureService.cancelOwner(ownerId);
  proxyManager.disposeOwner(ownerId);
  pathAuthority.revokeOwner(ownerId);
  trashConfirmationStore.revokeOwner(ownerId);
  dataLocationPathGrants.delete(ownerId);
  return true;
}

function assertProfileReconfigurationActive(generation) {
  if (nativeShutdownPreparing || nativeShutdownRequested) {
    throw new ApplicationShutdownRequestedError();
  }
  if (generation !== metadataProfileGeneration) {
    throw new ProfileReconfigurationSupersededError();
  }
}

function invalidateWatcherContext() {
  if (activeWatcherContext) {
    activeWatcherContext.cancelled = true;
  }
  activeWatcherContext = null;
}

function createWatcherContext(folderPath, recursive, options = {}) {
  const metadataContext = captureMetadataContext();
  const context = {
    ...metadataContext,
    watcherContextId: ++watcherContextSequence,
    rootPath: path.resolve(folderPath),
    recursive: Boolean(recursive),
    scanId:
      typeof options.scanId === "string" && options.scanId
        ? options.scanId
        : null,
    bufferInitialEvents: Boolean(options.bufferInitialEvents),
    watcherSessionId: null,
    cancelled: false,
  };
  invalidateWatcherContext();
  activeWatcherContext = context;
  return context;
}

function assertWatcherContextActive(context) {
  if (
    !context ||
    context.cancelled ||
    activeWatcherContext !== context
  ) {
    throw new DirectoryScanCancelledError();
  }
  assertMetadataContextActive(context);
}

function isWatcherContextActive(context) {
  try {
    assertWatcherContextActive(context);
    return true;
  } catch {
    return false;
  }
}

const directoryAggregateBatcher = createDirectoryAggregateBatcher({
  refresh: async ({ rootPath, profileId, generation, assertActive }) => {
    const context = {
      profileId,
      generation,
      metadataStore: getMetadataStore(),
    };
    assertMetadataContextActive(context);
    assertActive();
    const directories = context.metadataStore.refreshDirectoryCounts(rootPath);
    assertActive();
    assertMetadataContextActive(context);
    return directories;
  },
  isContextActive: ({ profileId, generation }) =>
    !nativeShutdownRequested &&
    configuredMetadataProfileGeneration === generation &&
    metadataProfileGeneration === generation &&
    getActiveProfileId() === profileId,
  logger: console,
  debounceMs: 150,
  maxWaitMs: 1000,
  maxDirtyRoots: 128,
});

function activeAggregateOwnership() {
  return {
    profileId: getActiveProfileId(),
    generation: metadataProfileGeneration,
  };
}

async function flushDirectoryAggregates(rootPath = null) {
  if (!rootPath) return directoryAggregateBatcher.flushAll();
  return directoryAggregateBatcher.flushRoot({
    ...activeAggregateOwnership(),
    rootPath: path.resolve(rootPath),
  });
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

const IGNORED_SCAN_DIRECTORY_NAMES = new Set([
  "node_modules",
  "System Volume Information",
  "$RECYCLE.BIN",
  ".git",
]);

function isIgnoredScanDirectory(directoryName) {
  return (
    directoryName.startsWith(".") ||
    IGNORED_SCAN_DIRECTORY_NAMES.has(directoryName)
  );
}

// Helper function to format file sizes
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function createEnumeratedVideoFileObject(filePath, baseFolderPath, stats) {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  let dirname = path.relative(baseFolderPath, path.dirname(filePath));
  if (dirname === ".") dirname = "";
  return {
    id: filePath,
    instanceId: null,
    sourceUrl: null,
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
    fingerprint: null,
    tags: [],
    rating: null,
    reviewState: "unreviewed",
    dimensions: null,
    aspectRatio: null,
    enrichmentState: "enumerated",
    metadata: {
      folder: path.dirname(filePath),
      baseName: path.basename(fileName, ext),
      sizeFormatted: formatFileSize(stats.size),
      dateModifiedFormatted: stats.mtime.toLocaleDateString(),
      dateCreatedFormatted: stats.birthtime.toLocaleDateString(),
    },
  };
}

function sendDirectoryScanRecords(scan, sender, rootPath, kind, records) {
  if (!Array.isArray(records) || records.length === 0) return false;
  assertDirectoryScanActive(scan);
  if (sender?.isDestroyed?.()) throw new DirectoryScanCancelledError();
  scan.recordSequence += 1;
  sender.send("directory-scan-records", {
    protocolVersion: DIRECTORY_SCAN_PROTOCOL_VERSION,
    scanId: scan.scanId,
    sequence: scan.recordSequence,
    rootPath,
    recursive: Boolean(scan.recursive),
    kind,
    records,
  });
  return true;
}

// Helper function to create rich file object
async function createVideoFileObject(
  filePath,
  baseFolderPath,
  options = {}
) {
  const {
    assertActive,
    stats: providedStats,
    indexedInfo,
    metadataStore: providedMetadataStore,
    rootPath = baseFolderPath,
    recursive = true,
    refreshDirectoryCounts = true,
  } = options;
  const hasIndexedInfo = Object.prototype.hasOwnProperty.call(
    options,
    "indexedInfo"
  );

  try {
    const stats = providedStats || (await fsPromises.stat(filePath));
    assertActive?.();

    let fingerprint = null;
    let tags = [];
    let rating = null;
    let reviewState = "unreviewed";
    let dimensions = null;
    let instanceId = null;

    const isValidDimensions = (dims) =>
      dims && Number.isFinite(dims.width) && Number.isFinite(dims.height) && dims.width > 0 && dims.height > 0;

    try {
      assertActive?.();
      const metadataStore = providedMetadataStore || getMetadataStore();
      const info = hasIndexedInfo
        ? indexedInfo
        : await metadataStore.indexFile({
          filePath,
          stats,
          rootPath,
          recursive,
          assertActive,
          refreshDirectoryCounts,
        });
      assertActive?.();
      fingerprint = info?.fingerprint ?? null;
      instanceId = info?.instance?.id ?? null;
      tags = Array.isArray(info?.tags) ? info.tags : [];
      rating =
        typeof info?.rating === "number" && Number.isFinite(info.rating)
          ? info.rating
          : null;
      reviewState = ["unreviewed", "reviewed", "pick", "reject"].includes(
        info?.reviewState
      )
        ? info.reviewState
        : rating !== null
          ? "reviewed"
          : "unreviewed";

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
        assertActive?.();
        if (isValidDimensions(computed)) {
          dimensions = computed;
          if (fingerprint) {
            assertActive?.();
            metadataStore.setDimensions(fingerprint, computed);
          }
        }
      }
    } catch (metaError) {
      if (isDirectoryScanCancelled(metaError)) {
        throw metaError;
      }
      assertActive?.();
      console.warn(
        `[metadata] Failed to index ${filePath}:`,
        metaError?.message || metaError
      );
    }

    const sourceUrl = instanceId
      ? createMediaInstanceUrl(instanceId, {
          version: `${Math.max(0, Number(stats.size) || 0)}-${Math.max(
            0,
            Number(stats.mtimeMs) || 0
          )}`,
          generation:
            options.generation === undefined
              ? metadataProfileGeneration
              : options.generation,
        })
      : null;

    return {
      ...createEnumeratedVideoFileObject(filePath, baseFolderPath, stats),
      instanceId,
      sourceUrl,
      fingerprint,
      tags,
      rating,
      reviewState,
      enrichmentState: "ready",
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
    };
  } catch (error) {
    if (isDirectoryScanCancelled(error)) {
      throw error;
    }
    // A watcher uses its own stale-session error. Re-running its ownership
    // assertion here lets that cancellation propagate instead of being
    // downgraded to an ordinary per-file read failure.
    assertActive?.();
    console.warn(`Error creating file object for ${filePath}:`, error.message);
    return null;
  }
}

// Scan folder and detect changes (used by watcher in polling mode)
async function scanFolderForChanges(folderPath, options = {}) {
  const metadataStore =
    options.metadataStore || options.context?.metadataStore || getMetadataStore();
  const ownerWebContentsId = options.ownerWebContentsId;
  return pollFolderForChanges({
    rootPath: options.rootPath || folderPath,
    recursive: options.recursive ?? true,
    depth: 10,
    metadataStore,
    createVideoFileObject,
    isVideoFile,
    isIgnoredDirectory: isIgnoredScanDirectory,
    assertActive: options.assertActive,
    pollingState: options.pollingState,
    refreshDirectoryCounts: options.refreshDirectoryCounts,
    sendEvent:
      typeof options.sendEvent === "function"
        ? options.sendEvent
        : (channel, payload) => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (
              ownerWebContentsId !== undefined &&
              mainWindow.webContents.id !== ownerWebContentsId
            ) {
              return;
            }
            mainWindow.webContents.send(channel, payload);
          },
  });
}

// Instantiate watcher (single instance, logic in ./main/watcher.js)
const folderWatcher = createFolderWatcher({
  isVideoFile,
  createVideoFileObject,
  scanFolderForChanges,
  onDirectoryAggregatesDirty: ({ rootPath, profileId, generation }) =>
    directoryAggregateBatcher.markDirty({ rootPath, profileId, generation }),
  logger: console,
  depth: 10, // unchanged from your previous config
});

// Wire watcher events to the renderer (native watch mode)
let disposeWatcherEventWiring = null;

function wireWatcherEvents(win) {
  disposeWatcherEventWiring?.();
  const ownerWebContentsId = win.webContents.id;
  const sendToRenderer = (channel, payload) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };
  const ownsEvent = (eventMetadata) => {
    const context = eventMetadata?.context;
    return (
      isWatcherContextActive(context) &&
      context.ownerWebContentsId === ownerWebContentsId
    );
  };
  const createWatchMetadata = (eventMetadata) => ({
    sessionId: eventMetadata?.sessionId || null,
    scanId: eventMetadata?.context?.scanId || null,
    rootPath: eventMetadata?.folderPath || null,
  });

  const handleAdded = (videoFile, eventMetadata) => {
    if (!ownsEvent(eventMetadata)) return;
    sendToRenderer("file-added", {
      videoFile,
      watch: createWatchMetadata(eventMetadata),
    });
  };
  const handleRemoved = (filePath, eventMetadata) => {
    const context = eventMetadata?.context;
    if (!ownsEvent(eventMetadata)) return;
    try {
      context.metadataStore.markFileMissing(filePath, {
        rootPath: context.rootPath,
        assertActive: () => assertWatcherContextActive(context),
        refreshDirectoryCounts: false,
      });
      assertWatcherContextActive(context);
      sendToRenderer("file-removed", {
        filePath,
        watch: createWatchMetadata(eventMetadata),
      });
    } catch (error) {
      if (isDirectoryScanCancelled(error)) return;
      console.warn(`[metadata] Failed to mark ${filePath} missing:`, error);
      // The filesystem event remains authoritative for the live UI even if
      // catalog persistence failed. A future scan can repair the index.
      if (isWatcherContextActive(context)) {
        sendToRenderer("file-removed", {
          filePath,
          watch: createWatchMetadata(eventMetadata),
        });
      }
    }
  };
  const handleChanged = (videoFile, eventMetadata) => {
    if (!ownsEvent(eventMetadata)) return;
    sendToRenderer("file-changed", {
      videoFile,
      watch: createWatchMetadata(eventMetadata),
    });
  };
  const handleMode = ({ mode, folderPath, context }) => {
    if (!ownsEvent({ context })) return;
    console.log(`[watch] mode=${mode} path=${folderPath}`);
    // Optionally notify the renderer:
    // win.webContents.send("file-watch-mode", mode);
  };
  const handleError = (err, eventMetadata) => {
    if (eventMetadata?.context && !ownsEvent(eventMetadata)) return;
    const msg = (err && err.message) || String(err);
    sendToRenderer("file-watch-error", msg);
  };
  const handleReady = ({ folderPath, context }) => {
    if (!ownsEvent({ context })) return;
    console.log("Started watching folder:", folderPath);
  };

  folderWatcher.on("added", handleAdded);
  folderWatcher.on("removed", handleRemoved);
  folderWatcher.on("changed", handleChanged);
  folderWatcher.on("mode", handleMode);
  folderWatcher.on("error", handleError);
  folderWatcher.on("ready", handleReady);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    folderWatcher.off("added", handleAdded);
    folderWatcher.off("removed", handleRemoved);
    folderWatcher.off("changed", handleChanged);
    folderWatcher.off("mode", handleMode);
    folderWatcher.off("error", handleError);
    folderWatcher.off("ready", handleReady);
    if (disposeWatcherEventWiring === dispose) {
      disposeWatcherEventWiring = null;
    }
  };
  disposeWatcherEventWiring = dispose;

  win.once("closed", () => {
    dispose();
    if (activeWatcherContext?.ownerWebContentsId === ownerWebContentsId) {
      invalidateWatcherContext();
      void folderWatcher.stop();
    }
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
  const source = rawSettings && typeof rawSettings === "object" &&
    !Array.isArray(rawSettings)
    ? rawSettings
    : {};
  const bounds = source.windowBounds &&
    typeof source.windowBounds === "object" &&
    !Array.isArray(source.windowBounds)
    ? source.windowBounds
    : {};
  const clampInteger = (value, fallback, minimum, maximum) => {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.max(minimum, Math.min(maximum, Math.round(number)))
      : fallback;
  };
  const normalizeCoordinate = (value) => {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.max(-100_000, Math.min(100_000, Math.round(number)))
      : undefined;
  };
  const hasZoom = Object.prototype.hasOwnProperty.call(source, "zoomLevel") &&
    source.zoomLevel !== null && source.zoomLevel !== undefined;
  const sortKey = ["name", "created", "random"].includes(source.sortKey)
    ? source.sortKey
    : defaultSettings.sortKey;
  const randomSeed = source.randomSeed !== null &&
    source.randomSeed !== undefined &&
    Number.isFinite(Number(source.randomSeed))
    ? Math.max(
        Number.MIN_SAFE_INTEGER,
        Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number(source.randomSeed)))
      )
    : null;

  return {
    recursiveMode: Boolean(source.recursiveMode),
    renderLimitStep: clampInteger(
      source.renderLimitStep,
      defaultSettings.renderLimitStep,
      0,
      10
    ),
    playbackMode: normalizePlaybackMode(source.playbackMode),
    proxyPlaybackEnabled: Boolean(source.proxyPlaybackEnabled),
    reviewAutoAdvance: source.reviewAutoAdvance === true,
    zoomLevel: clampInteger(
      hasZoom ? source.zoomLevel : computeDefaultZoomLevel(),
      defaultSettings.zoomLevel,
      0,
      4
    ),
    showFilenames:
      source.showFilenames === undefined
        ? defaultSettings.showFilenames
        : Boolean(source.showFilenames),
    sortKey,
    sortDir: source.sortDir === "desc" ? "desc" : "asc",
    groupByFolders:
      source.groupByFolders === undefined
        ? defaultSettings.groupByFolders
        : Boolean(source.groupByFolders),
    randomSeed,
    windowBounds: {
      width: clampInteger(bounds.width, defaultSettings.windowBounds.width, 800, 10_000),
      height: clampInteger(bounds.height, defaultSettings.windowBounds.height, 600, 10_000),
      x: normalizeCoordinate(bounds.x),
      y: normalizeCoordinate(bounds.y),
    },
  };
}

const settingsWriter = createSettingsWriter({
  resolvePath: (profileId) => getSettingsPath(profileId),
  normalizeSettings: normaliseLoadedSettings,
  debounceMs: 150,
  maxWaitMs: 1000,
  maxBytes: 64 * 1024,
  logger: console,
});

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
    const legacyRaw = await readSettingsFileBounded(legacyPath, {
      fsApi: fsPromises,
      maxBytes: 64 * 1024,
    });
    const legacySettings = JSON.parse(legacyRaw);
    const migrated = normaliseLoadedSettings(legacySettings);
    const {
      layoutMode: _layoutMode,
      autoplayEnabled: _autoplayEnabled,
      ...toPersist
    } = migrated;
    await settingsWriter.replace(profileId, toPersist);
    console.log("[settings] Migrated legacy settings.json into profile scope");
    return migrated;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("[settings] Failed to migrate legacy settings", error);
    }
    return null;
  }
}

async function loadSettings(
  profileId = getActiveProfileId(),
  { allowDuringReconfiguration = false } = {}
) {
  const loadContext = {
    profileId,
    generation: metadataProfileGeneration,
  };
  const publishIfCurrent = (settings, allowDuringReconfiguration = false) => {
    if (
      loadContext.profileId === getActiveProfileId() &&
      loadContext.generation === metadataProfileGeneration &&
      (allowDuringReconfiguration || !profileReconfigurationInProgress)
    ) {
      currentSettings = settings;
    }
    return settings;
  };
  const settingsFile = getSettingsPath(profileId);
  try {
    let targetExists = true;
    try {
      await fsPromises.access(settingsFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      targetExists = false;
    }
    if (!targetExists) {
      await tryMigrateLegacySettings(profileId, settingsFile);
    }
    const settings = await settingsWriter.getSnapshot(profileId);
    return publishIfCurrent(settings, allowDuringReconfiguration);
  } catch (error) {
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
    await settingsWriter.forget(profileId, { flush: false }).catch(() => {});
    settingsWriter.seed(profileId, defaults);
    return publishIfCurrent(defaults, allowDuringReconfiguration);
  }
}

async function saveSettings(settings, profileId = getActiveProfileId()) {
  const generation = metadataProfileGeneration;
  const snapshot = await settingsWriter.replace(profileId, settings);
  if (
    profileId === getActiveProfileId() &&
    generation === metadataProfileGeneration &&
    !profileReconfigurationInProgress
  ) {
    currentSettings = snapshot;
  }
  console.log("Settings saved for profile", profileId);
  return snapshot;
}

async function saveSettingsPartial(
  partialSettings,
  profileId = getActiveProfileId(),
  options = {}
) {
  const generation = metadataProfileGeneration;
  const snapshot = await settingsWriter.patch(profileId, partialSettings, options);
  if (
    profileId === getActiveProfileId() &&
    generation === metadataProfileGeneration &&
    !profileReconfigurationInProgress
  ) {
    currentSettings = snapshot;
  }
  return snapshot;
}

function captureSettingsContext() {
  return {
    profileId: getActiveProfileId(),
    generation: metadataProfileGeneration,
  };
}

function assertSettingsContextActive(context) {
  if (
    !context ||
    profileReconfigurationInProgress ||
    nativeShutdownPreparing ||
    nativeShutdownRequested ||
    context.profileId !== getActiveProfileId() ||
    context.generation !== metadataProfileGeneration
  ) {
    throw new ProfileOperationInvalidatedError();
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

async function initializeProfileRuntime(
  targetId,
  generation,
  { migrateLegacy = true } = {}
) {
  const profilePath = getProfilePath(targetId);
  if (migrateLegacy && typeof profileManager.getUserDataPath === "function") {
    try {
      await migrateLegacyProfileData({
        profileId: targetId,
        profilePath,
        userDataPath: profileManager.getUserDataPath(),
        defaultProfileId: profileManager.DEFAULT_PROFILE_ID,
      });
    } catch (error) {
      console.warn("[profile] Legacy data migration failed", error);
    }
    assertProfileReconfigurationActive(generation);
  }

  await thumbnailCache.reset().catch((error) => {
    console.warn("[profile] Failed to invalidate thumbnail cache", error);
  });
  assertProfileReconfigurationActive(generation);
  try {
    await thumbnailCache.init(app, profilePath);
  } catch (error) {
    console.warn("[profile] Failed to init thumbnail cache for profile", error);
  }
  assertProfileReconfigurationActive(generation);
  try {
    await proxyManager.init(profilePath);
  } catch (error) {
    console.warn("[profile] Failed to initialize playback proxy cache", error);
  }

  assertProfileReconfigurationActive(generation);
  resetDatabase();
  initMetadataStore(app, profilePath);
  await ensureRecentStore(targetId);
  assertProfileReconfigurationActive(generation);

  const settings = await loadSettings(targetId, {
    allowDuringReconfiguration: true,
  });
  assertProfileReconfigurationActive(generation);
  configuredMetadataProfileGeneration = generation;
  directoryAggregateBatcher.activate({ profileId: targetId, generation });
  return settings;
}

async function performProfileReconfiguration(requestedProfileId, broadcast) {
  if (nativeShutdownPreparing || nativeShutdownRequested) {
    throw new ApplicationShutdownRequestedError();
  }

  const outgoingProfileId = getActiveProfileId();
  // Quiesce filesystem producers before the durable boundary. Cancellation is
  // cooperative but immediate: any scan continuation must reassert ownership
  // before another database mutation. Watcher.stop() then drains native event
  // delivery, after which the aggregate flush can be genuinely final.
  cancelAllDirectoryScans();
  try {
    await folderWatcher.stop();
  } catch (error) {
    console.warn("[profile] Failed to stop watcher before profile flush", error);
  }
  invalidateWatcherContext();
  sidecarMetadataService.cancelAll();
  lastFrameCaptureService.cancelAll("Profile changed during frame capture");
  mediaProtocolService.cancelActiveStreams();
  await Promise.all([
    settingsWriter.flush(outgoingProfileId),
    flushDirectoryAggregates(),
  ]);

  const reconfigureGeneration = ++metadataProfileGeneration;
  configuredMetadataProfileGeneration = 0;
  currentSettings = null;
  setVideoDimensionsRoot(null);
  directoryAggregateBatcher.invalidate();
  if (outgoingProfileId) pathAuthority.revokeScope(outgoingProfileId);

  let targetId = null;
  try {
    assertProfileReconfigurationActive(reconfigureGeneration);
    targetId = profileManager.setActiveProfile(requestedProfileId);
    activeProfileId = targetId;
    const settings = await initializeProfileRuntime(
      targetId,
      reconfigureGeneration
    );
    if (broadcast) broadcastProfileChange(settings);
    createMenu();
    return settings;
  } catch (error) {
    const rollbackGeneration = ++metadataProfileGeneration;
    configuredMetadataProfileGeneration = 0;
    currentSettings = null;
    directoryAggregateBatcher.invalidate();
    if (targetId) pathAuthority.revokeScope(targetId);
    try {
      const restoredProfileId = profileManager.setActiveProfile(
        outgoingProfileId
      );
      activeProfileId = restoredProfileId;
      const restoredSettings = await initializeProfileRuntime(
        restoredProfileId,
        rollbackGeneration,
        { migrateLegacy: false }
      );
      if (mainWindow && !mainWindow.isDestroyed()) {
        broadcastProfileChange(restoredSettings);
      }
      createMenu();
    } catch (rollbackError) {
      configuredMetadataProfileGeneration = 0;
      currentSettings = null;
      error.rollbackError = rollbackError;
      console.error("[profile] Failed to restore outgoing profile", rollbackError);
    }
    throw error;
  }
}

async function reconfigureForProfile(profileId, { broadcast = true } = {}) {
  if (nativeShutdownPreparing || nativeShutdownRequested) {
    throw new ApplicationShutdownRequestedError();
  }
  const requestedProfileId =
    typeof profileId === "string" ? profileId.trim() : "";
  const profileExists = requestedProfileId && profileManager
    .listProfiles()
    .some((profile) => profile.id === requestedProfileId);
  if (!profileExists) {
    throw new Error(`Profile '${requestedProfileId || profileId}' does not exist`);
  }

  await runReviewSessionFlushBarrier();
  if (nativeShutdownPreparing || nativeShutdownRequested) {
    throw new ApplicationShutdownRequestedError();
  }

  return runSerializedProfileOperation(() =>
    performProfileReconfiguration(requestedProfileId, broadcast)
  );
}

async function runSerializedProfileOperation(run) {
  if (typeof run !== "function") {
    throw new TypeError("A profile operation is required");
  }
  if (nativeShutdownPreparing || nativeShutdownRequested) {
    throw new ApplicationShutdownRequestedError();
  }
  profileReconfigurationPending += 1;
  profileReconfigurationInProgress = true;
  const guardedRun = async () => {
    trashAdmissionOpen = false;
    await Promise.all([
      drainActiveTrashOperations(),
      reviewManifestExportCoordinator.pauseAndDrain(),
    ]);
    trashConfirmationStore.revokeAll();
    try {
      return await run();
    } finally {
      if (!nativeShutdownPreparing && !nativeShutdownRequested) {
        trashAdmissionOpen = true;
        reviewManifestExportCoordinator.resume();
      }
    }
  };
  const operation = profileReconfigureQueue.then(guardedRun, guardedRun);
  profileReconfigureQueue = operation.catch(() => {});
  try {
    return await operation;
  } finally {
    profileReconfigurationPending = Math.max(
      0,
      profileReconfigurationPending - 1
    );
    profileReconfigurationInProgress = profileReconfigurationPending > 0;
  }
}

async function deleteProfileWithTransition(profileId, { broadcast = true } = {}) {
  const requestedProfileId =
    typeof profileId === "string" ? profileId.trim() : "";
  if (!requestedProfileId) {
    throw new Error("Profile id must be provided");
  }

  if (requestedProfileId === getActiveProfileId()) {
    await runReviewSessionFlushBarrier();
  }

  return runSerializedProfileOperation(async () => {
    const profiles = profileManager.listProfiles();
    const target = profiles.find((profile) => profile.id === requestedProfileId);
    if (!target) {
      throw new Error(`Profile '${requestedProfileId}' does not exist`);
    }
    if (profiles.length <= 1) {
      throw new Error("Cannot delete the last remaining profile");
    }

    const switchedFromDeletedProfile =
      requestedProfileId === getActiveProfileId();
    if (switchedFromDeletedProfile) {
      const fallback = profiles.find(
        (profile) => profile.id !== requestedProfileId
      );
      await performProfileReconfiguration(fallback.id, false);
    }

    let removed;
    try {
      await settingsWriter.forget(requestedProfileId, { flush: false });
      try {
        removed = profileManager.deleteProfile(requestedProfileId);
      } catch (error) {
        if (!error?.profileDeleted) throw error;
        // The catalog commit is authoritative; quarantine cleanup is retried on
        // the next startup and must not leave the renderer believing the profile
        // is still selectable.
        console.warn("[profile] Deleted profile needs deferred cleanup", error);
        removed = { ...target, cleanupPending: true };
      }
    } catch (error) {
      if (switchedFromDeletedProfile && !error?.profileDeleted) {
        try {
          await performProfileReconfiguration(requestedProfileId, false);
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
          console.error(
            "[profile] Failed to restore profile after deletion failure",
            rollbackError
          );
        }
        createMenu();
        if (broadcast) broadcastProfileChange(currentSettings);
      }
      throw error;
    }
    createMenu();
    if (broadcast) broadcastProfileChange(currentSettings);
    return removed;
  });
}

// ===== Window/Menu =====
async function createWindow() {
  if (nativeShutdownPreparing || nativeShutdownRequested) return null;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const settings = await loadSettings();
  // loadSettings may cross profile I/O. Reassert both shutdown and singleton
  // state before allocating native resources.
  if (nativeShutdownPreparing || nativeShutdownRequested) return null;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const appVersion = app.getVersion();
  const isDev = isDevelopmentRuntime();

  // Choose the right icon per platform
  const iconPath =
    process.platform === "win32"
      ? assetPath("assets", "icons", "videoswarm.ico")
      : assetPath("assets", "icons", "videoswarm.png");


  const createdWindow = new BrowserWindow({
    width: settings.windowBounds.width,
    height: settings.windowBounds.height,
    x: settings.windowBounds.x,
    y: settings.windowBounds.y,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: isDev,

      // Enhanced memory management
      // Keep Chromium scheduling consistent for every media element from the
      // moment the renderer is created. The renderer already physically
      // suspends media and background work when the window is hidden or
      // minimized, so changing this at runtime only destabilizes players
      // admitted after a scroll/mode transition.
      backgroundThrottling: false,
      offscreen: false,
      spellcheck: false,
      v8CacheOptions: "bypassHeatCheck",
    },
    icon: iconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    title: `Video Swarm v${appVersion}`,
  });
  mainWindow = createdWindow;
  // BrowserWindow.webContents throws once the window has been destroyed. Keep
  // the owner reference captured while the window is alive so late lifecycle
  // callbacks (notably `closed`) can finish idempotent native-work cleanup.
  const createdWebContents = createdWindow.webContents;
  const playbackOwnerId = createdWebContents.id;
  registerNativeWorkOwner(createdWebContents);

  createdWebContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const preventUntrustedNavigation = (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  };
  createdWebContents.on("will-navigate", preventUntrustedNavigation);
  createdWebContents.on("will-redirect", preventUntrustedNavigation);
  createdWebContents.on("will-attach-webview", (event) => event.preventDefault());
  createdWebContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false)
  );
  createdWebContents.session.setPermissionCheckHandler(() => false);

  disposeMainWindowActivity?.();
  const createdWindowActivityDisposer = attachWindowActivity(createdWindow, (activity) => {
    proxyManager.setOwnerActive(playbackOwnerId, activity.active);
    if (!createdWindow.isDestroyed()) {
      createdWebContents.send("playback:window-activity", activity);
    }
  });
  disposeMainWindowActivity = createdWindowActivityDisposer;

  // set the dock icon explicitly on macOS
  if (process.platform === "darwin") {
    try {
      app.dock.setIcon(nativeImage.createFromPath(
        assetPath("assets", "icons", "videoswarm.png")
      ));
    } catch { }
  }

  if (isDev) {
    const devRendererUrl =
      process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
    console.log(
      `Development mode: Loading from Vite server at ${devRendererUrl}`
    );
    createdWindow.loadURL(devRendererUrl);
  } else {
    console.log("Production mode: Loading from index.html");
    createdWindow.loadFile(path.join(__dirname, "dist-react", "index.html"));
  }

  createdWebContents.on("did-finish-load", () => {
    if (
      mainWindow !== createdWindow ||
      createdWindow.isDestroyed() ||
      createdWebContents.isDestroyed?.()
    ) {
      return;
    }
    activateNativeWorkOwner(createdWebContents);
    console.log("Page loaded, sending settings immediately");
    createdWindow.setTitle(`Video Swarm v${appVersion}`);
    createdWebContents.send("settings-loaded", currentSettings);
    createdWebContents.send("profile-changed", {
      profileId: getActiveProfileId(),
      profileName: getProfileDisplayName(),
      profiles: profileManager.listProfiles(),
      settings: currentSettings,
    });
  });

  createdWebContents.on("dom-ready", () => {
    if (
      mainWindow !== createdWindow ||
      createdWindow.isDestroyed() ||
      createdWebContents.isDestroyed?.()
    ) {
      return;
    }
    console.log("DOM ready, sending settings");
    createdWindow.setTitle(`Video Swarm v${appVersion}`);
    createdWebContents.send("settings-loaded", currentSettings);
    createdWebContents.send("profile-changed", {
      profileId: getActiveProfileId(),
      profileName: getProfileDisplayName(),
      profiles: profileManager.listProfiles(),
      settings: currentSettings,
    });
  });

  // Enhanced crash detection
  createdWebContents.on("render-process-gone", (event, details) => {
    invalidateNativeWorkOwner(createdWebContents);
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
      if (
        !nativeShutdownPreparing &&
        !nativeShutdownRequested &&
        mainWindow === createdWindow &&
        !createdWindow.isDestroyed() &&
        !createdWebContents.isDestroyed?.()
      ) {
        console.log("🔄 Attempting to reload...");
        createdWindow.reload();
      }
    }, 1000);
  });

  createdWebContents.on("unresponsive", () => {
    console.error("🔥 RENDERER UNRESPONSIVE");
  });
  createdWebContents.on("responsive", () => {
    console.log("✅ RENDERER RESPONSIVE AGAIN");
  });

  const saveCreatedWindowBounds = () => {
    if (mainWindow !== createdWindow || createdWindow.isDestroyed()) return;
    saveSettingsPartial(
      { windowBounds: createdWindow.getBounds() },
      getActiveProfileId(),
      { debounce: true }
    ).catch(console.error);
  };
  createdWindow.on("moved", saveCreatedWindowBounds);
  createdWindow.on("resized", saveCreatedWindowBounds);
  let closeApprovedAfterReviewFlush = false;
  let closeReviewFlushPromise = null;
  const holdCloseForReviewSessionFlush = (event) => {
    if (closeApprovedAfterReviewFlush || nativeShutdownComplete) return;
    event.preventDefault();
    if (nativeShutdownPreparing || nativeShutdownRequested) return;
    if (closeReviewFlushPromise) return;
    closeReviewFlushPromise = runReviewSessionFlushBarrier(createdWebContents)
      .catch((error) => {
        console.warn("[review-sessions] Window-close flush failed", error);
      })
      .finally(() => {
        closeApprovedAfterReviewFlush = true;
        if (!createdWindow.isDestroyed()) createdWindow.close();
      });
  };
  createdWindow.on("close", holdCloseForReviewSessionFlush);
  createdWindow.once("closed", () => {
    const closingWatcherRoot =
      activeWatcherContext?.ownerWebContentsId === createdWebContents.id
        ? activeWatcherContext.rootPath
        : null;
    if (closingWatcherRoot) invalidateWatcherContext();
    cancelDirectoryScan(createdWebContents.id);
    cancelPendingProfilePrompts();
    if (mainWindow === createdWindow) {
      disposeWatcherEventWiring?.();
      disposeWatcherEventWiring = null;
    }
    mediaProtocolService.cancelActiveStreams();
    disposeNativeWorkOwner(createdWebContents);
    createdWebContents.removeListener(
      "will-navigate",
      preventUntrustedNavigation
    );
    createdWebContents.removeListener(
      "will-redirect",
      preventUntrustedNavigation
    );
    createdWindow.removeListener("close", holdCloseForReviewSessionFlush);
    if (disposeMainWindowActivity === createdWindowActivityDisposer) {
      createdWindowActivityDisposer?.();
      disposeMainWindowActivity = null;
    }
    if (mainWindow === createdWindow) mainWindow = null;
    if (closingWatcherRoot) {
      void folderWatcher.stop()
        .then(() => flushDirectoryAggregates(closingWatcherRoot))
        .catch((error) => {
          console.warn("[window] Failed to stop watcher during close", error);
        });
    }
  });
  if (isDev) {
    createdWebContents.openDevTools();
  }

  // Wire watcher events after window exists
  wireWatcherEvents(createdWindow);
  return createdWindow;
}

function focusMainWindow(window = mainWindow) {
  if (!window || window.isDestroyed()) return false;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return true;
}

function ensureMainWindow() {
  if (
    !ownsSingleInstanceLock ||
    nativeShutdownPreparing ||
    nativeShutdownRequested
  ) {
    return Promise.resolve(null);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    return Promise.resolve(mainWindow);
  }
  if (!applicationInitializationComplete) {
    if (!applicationInitializationPromise) {
      return Promise.reject(
        new Error("Application initialization has not started")
      );
    }
    return applicationInitializationPromise.then(() => ensureMainWindow());
  }
  if (windowCreationPromise) return windowCreationPromise;

  let trackedCreation;
  const creation = Promise.resolve().then(() => createWindow());
  trackedCreation = creation.finally(() => {
    if (windowCreationPromise === trackedCreation) {
      windowCreationPromise = null;
    }
  });
  windowCreationPromise = trackedCreation;
  return trackedCreation;
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
    const expectedSender = mainWindow.webContents;
    const requestId = `profile-prompt-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    return await new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      let cancelPrompt = null;
      const channel = "profiles:prompt-response";
      const cleanup = () => {
        if (settled) return;
        settled = true;
        rawIpcMain.removeListener(channel, handler);
        if (timeoutId) clearTimeout(timeoutId);
        if (cancelPrompt) {
          pendingProfilePromptCancellations.delete(cancelPrompt);
        }
      };
      const settle = (value) => {
        if (settled) return;
        cleanup();
        resolve(value);
      };
      const handler = (event, payload) => {
        try {
          assertTrustedSender(event);
          assertPayloadSize(payload, 4096);
          assertPlainObject(payload, "profile prompt response");
        } catch {
          return;
        }
        if (event.sender !== expectedSender) return;
        if (!payload || payload.requestId !== requestId) {
          return;
        }
        const value =
          typeof payload.value === "string" ? payload.value.trim() : "";
        settle(value.length ? value : null);
      };
      cancelPrompt = () => settle(null);
      pendingProfilePromptCancellations.add(cancelPrompt);
      timeoutId = setTimeout(cancelPrompt, 45000);

      rawIpcMain.on(channel, handler);
      try {
        mainWindow.webContents.send("profiles:prompt-input", {
          requestId,
          defaultValue,
          title,
          message,
        });
      } catch (error) {
        console.warn("[profiles] Failed to request renderer prompt", error);
        settle(null);
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
    await deleteProfileWithTransition(activeId);
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
            const targetWindow = mainWindow;
            const targetWebContents = targetWindow?.webContents;
            if (
              !targetWindow ||
              targetWindow.isDestroyed() ||
              targetWebContents?.isDestroyed?.()
            ) {
              return;
            }
            const result = await dialog.showOpenDialog(targetWindow, {
              properties: ["openDirectory"],
              title: "Select Video Folder",
            });
            if (
              !result.canceled &&
              result.filePaths.length > 0 &&
              mainWindow === targetWindow &&
              !targetWindow.isDestroyed() &&
              !targetWebContents.isDestroyed?.()
            ) {
              const grantedPath = await grantRendererRoot(
                targetWebContents,
                result.filePaths[0]
              );
              if (
                mainWindow === targetWindow &&
                !targetWindow.isDestroyed() &&
                !targetWebContents.isDestroyed?.()
              ) {
                targetWebContents.send("folder-selected", grantedPath);
              }
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
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
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

ipcMain.handle("data-location:browse", async (event) => {
  const browser = BrowserWindow.fromWebContents(event.sender);
  if (!browser || browser.isDestroyed()) return null;
  const selectedPath = await dataLocationManager.browseForDirectory(browser);
  if (
    !selectedPath ||
    browser.isDestroyed() ||
    event.sender.isDestroyed?.() ||
    mainWindow !== browser
  ) {
    return null;
  }
  return grantDataLocationPath(event.sender, selectedPath);
});

ipcMain.handle("data-location:apply", async (event, payload) => {
  assertPlainObject(payload, "data location selection");
  assertPayloadSize(payload, 16 * 1024);
  const browser = BrowserWindow.fromWebContents(event.sender);
  if (!browser || browser.isDestroyed()) {
    throw new Error("Data-location window is no longer available");
  }
  const useDefault = assertBoolean(payload.useDefault, "useDefault");
  const customPath = useDefault
    ? null
    : await assertGrantedDataLocationPath(event.sender, payload.customPath);
  return dataLocationManager.applySelection(
    { useDefault, customPath },
    browser,
    {
      beforeRestart: beginNativeShutdown,
    }
  );
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
    const normalizedProfileId = assertString(profileId, {
      name: "profileId",
      minChars: 1,
      maxChars: 256,
      trim: true,
    });
    await reconfigureForProfile(normalizedProfileId);
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
    const profile = profileManager.createProfile(assertString(name, {
      name: "profile name",
      minChars: 1,
      maxChars: 128,
      trim: true,
    }));
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
    const normalizedProfileId = assertString(profileId, {
      name: "profileId",
      minChars: 1,
      maxChars: 256,
      trim: true,
    });
    const renamed = profileManager.renameProfile(
      normalizedProfileId,
      assertString(newName, {
        name: "profile name",
        minChars: 1,
        maxChars: 128,
        trim: true,
      })
    );
    createMenu();
    if (normalizedProfileId === getActiveProfileId()) {
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

ipcMain.handle("profiles:delete", async (event, profileId) => {
  try {
    const normalizedProfileId = assertString(profileId, {
      name: "profileId",
      minChars: 1,
      maxChars: 64,
      trim: true,
    });
    const profile = profileManager
      .listProfiles()
      .find((candidate) => candidate.id === normalizedProfileId);
    if (!profile) {
      throw new Error(`Profile '${normalizedProfileId}' does not exist`);
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(ownerWindow || null, {
      type: "warning",
      buttons: ["Delete", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: "Delete Profile",
      message: `Delete the profile "${profile.name}"?`,
      detail:
        "All settings and cached data for this profile will be removed. This cannot be undone.",
    });
    if (
      response !== 0 ||
      ownerWindow?.isDestroyed?.() ||
      event.sender.isDestroyed?.()
    ) {
      return {
        success: false,
        cancelled: true,
        activeProfileId: getActiveProfileId(),
        profiles: profileManager.listProfiles(),
      };
    }
    const removed = await deleteProfileWithTransition(normalizedProfileId);
    return {
      success: true,
      removed,
      activeProfileId: getActiveProfileId(),
      profiles: profileManager.listProfiles(),
    };
  } catch (error) {
    console.error("Failed to delete profile via IPC", error);
    return {
      success: false,
      error: error?.message || String(error),
      activeProfileId: getActiveProfileId(),
      profiles: profileManager.listProfiles(),
    };
  }
});

ipcMain.handle("thumb:put", async (event, payload) => {
  let context = null;
  try {
    assertPlainObject(payload, "thumbnail payload");
    assertPayloadSize(payload, IPC_LIMITS.maxImageDataUrlBytes);
    const authorized = await assertRendererPath(event, payload?.path, "file");
    context = captureProfileGenerationContext();
    const ownerId = registerNativeWorkOwner(event.sender);
    const result = await thumbnailCache.put(
      nativeImage,
      { ...payload, path: authorized.path },
      { ownerId }
    );
    assertProfileGenerationContextActive(context);
    return result;
  } catch (error) {
    console.error("[thumb-cache] put failed", error);
    return {
      ok: false,
      error: error?.code || error?.message || "CACHE_INVALIDATED",
    };
  }
}, { maxPayloadBytes: IPC_LIMITS.maxImageDataUrlBytes + 64 * 1024 });

ipcMain.handle("thumb:get", async (event, payload) => {
  let context = null;
  try {
    assertPlainObject(payload, "thumbnail payload");
    const authorized = await assertRendererPath(event, payload?.path, "file");
    context = captureProfileGenerationContext();
    const ownerId = registerNativeWorkOwner(event.sender);
    const pathKey = authorized.path;
    const signature = payload?.signature;
    const result = await thumbnailCache.has(
      pathKey,
      signature,
      nativeImage,
      { ownerId }
    );
    assertProfileGenerationContextActive(context);
    return result;
  } catch (error) {
    console.error("[thumb-cache] get failed", error);
    return {
      ok: false,
      error: error?.code || error?.message || "CACHE_INVALIDATED",
    };
  }
});

ipcMain.on("dnd:start-file", async (event, payload) => {
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
    registerNativeWorkOwner(event.sender);
    const candidates = normalize(payload).filter(
      (entry) => typeof entry === "string" && entry.trim().length > 0
    ).slice(0, 16);
    const filePath = candidates[0];
    if (!filePath) {
      return;
    }
    const authorized = await assertRendererPath(event, filePath, "file");

    let icon = thumbnailCache.getForDrag(nativeImage, authorized.path);
    if (!icon || (typeof icon.isEmpty === "function" && icon.isEmpty())) {
      icon = getEmbeddedDragIcon(nativeImage);
    }

    if (!icon || (typeof icon.isEmpty === "function" && icon.isEmpty())) {
      return;
    }

    event.sender.startDrag({
      file: authorized.path,
      icon,
    });
  } catch (error) {
    console.error("Failed to start native drag:", error);
  }
});

ipcMain.handle("save-settings", async (_event, settings) => {
  assertPlainObject(settings, "settings");
  assertPayloadSize(settings, 64 * 1024);
  const context = captureSettingsContext();
  await saveSettings(settings, context.profileId);
  assertSettingsContextActive(context);
  return { success: true };
});

ipcMain.handle("load-settings", async () => {
  const context = captureSettingsContext();
  const settings = await loadSettings(context.profileId);
  assertSettingsContextActive(context);
  return settings;
});

// NEW: Synchronous-ish settings getter - returns cached settings immediately
ipcMain.handle("get-settings", async () => {
  console.log("get-settings called, returning:", currentSettings);
  return currentSettings || defaultSettings;
});

// NEW: Request settings (for refresh scenarios)
ipcMain.handle("request-settings", async (event) => {
  console.log("request-settings called, sending settings via IPC");
  if (!event.sender.isDestroyed()) {
    event.sender.send(
      "settings-loaded",
      currentSettings || defaultSettings
    );
  }
  return { success: true };
});

ipcMain.handle("save-settings-partial", async (_event, partialSettings) => {
  assertPlainObject(partialSettings, "partial settings");
  assertPayloadSize(partialSettings, 64 * 1024);
  const context = captureSettingsContext();
  await saveSettingsPartial(partialSettings, context.profileId);
  assertSettingsContextActive(context);
  return { success: true };
});

ipcMain.handle("playback:get-capabilities", async () =>
  createPlaybackCapabilities({
    platform: process.platform,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    proxyAvailable: proxyManager.getSnapshot().ffmpegAvailable !== false,
  })
);

ipcMain.handle("playback:get-window-activity", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  return readWindowActivity(window);
});

ipcMain.handle("playback:set-renderer-active", (event, active) => {
  const normalizedActive = assertBoolean(active, "renderer active");
  const ownerId = registerNativeWorkOwner(event.sender);
  proxyManager.setOwnerActive(ownerId, normalizedActive);
  return { success: true, active: normalizedActive };
});

ipcMain.handle("playback:resolve-source", async (event, payload = {}) => {
  assertPlainObject(payload, "playback source request");
  const instanceId = assertInteger(Number(payload?.instanceId), {
    name: "instanceId",
    min: 1,
  });
  const context = captureMetadataContext();
  const instance = context.metadataStore.getFileInstanceById(instanceId);
  assertMetadataContextActive(context);
  if (!instance?.present || !instance.absolutePath) {
    return { status: "missing", sourceUrl: null, usingProxy: false, pending: false };
  }
  const authorized = await assertRendererPath(event, instance.absolutePath, "file");
  const originalSourceUrl = createMediaInstanceUrl(instanceId, {
    version: `${instance.size}-${instance.mtimeMs}`,
    generation: context.generation,
  });
  const resolved = await proxyManager.resolveSource({
    filePath: authorized.path,
    enabled: Boolean(payload?.enabled),
    ownerId: registerNativeWorkOwner(event.sender),
  });
  assertMetadataContextActive(context);
  return {
    status: resolved.status,
    sourceUrl:
      resolved.usingProxy && resolved.signature
        ? createMediaProxyUrl(resolved.signature, {
            generation: context.generation,
          })
        : originalSourceUrl,
    usingProxy: Boolean(resolved.usingProxy),
    pending: Boolean(resolved.pending),
  };
});

ipcMain.handle("select-folder", async (event) => {
  try {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { success: false, error: "Window is no longer available" };
    }
    const result = await dialog.showOpenDialog(targetWindow, {
      properties: ["openDirectory"],
      title: "Select Video Folder",
    });

    if (
      !result.canceled &&
      result.filePaths.length > 0 &&
      mainWindow === targetWindow &&
      !targetWindow.isDestroyed() &&
      !event.sender.isDestroyed?.()
    ) {
      const folderPath = await grantRendererRoot(event.sender, result.filePaths[0]);
      return { success: true, folderPath };
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
    const authorized = await assertRendererPath(event, filePath, "file");
    console.log("Attempting to show in folder:", authorized.path);
    shell.showItemInFolder(authorized.path);
    return { success: true };
  } catch (error) {
    console.error("Failed to show item in folder:", error);
    return { success: false, error: error.message };
  }
});

// Open file in external application (default video player)
ipcMain.handle("open-in-external-player", async (event, filePath) => {
  try {
    const authorized = await assertRendererPath(event, filePath, "file");
    console.log("Opening in external player:", authorized.path);
    const openError = await shell.openPath(authorized.path);
    if (openError) throw new Error(openError);
    return { success: true };
  } catch (error) {
    console.error("Failed to open in external player:", error);
    return { success: false, error: error.message };
  }
});

// Copy text to clipboard
ipcMain.handle("copy-to-clipboard", async (_event, text) => {
  try {
    const cleanText = assertString(text, {
      name: "clipboard text",
      maxChars: IPC_LIMITS.maxClipboardBytes,
    });
    if (Buffer.byteLength(cleanText, "utf8") > IPC_LIMITS.maxClipboardBytes) {
      throw new TypeError("Clipboard text is too large");
    }
    clipboard.writeText(cleanText);
    console.log("Copied text to clipboard");
    return { success: true };
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);
    return { success: false, error: error.message };
  }
});

// Copy image to clipboard
ipcMain.handle("copy-image-to-clipboard", async (_event, dataUrl) => {
  try {
    const normalizedDataUrl = assertString(dataUrl, {
      name: "clipboard image",
      minChars: 1,
      maxChars: IPC_LIMITS.maxImageDataUrlBytes,
    });
    assertPngDataUrlDimensions(normalizedDataUrl);
    const image = nativeImage.createFromDataURL(normalizedDataUrl);
    if (!image || image.isEmpty()) {
      return { success: false, error: "EMPTY_IMAGE" };
    }
    clipboard.writeImage(image);
    console.log("Copied image to clipboard");
    return { success: true };
  } catch (error) {
    console.error("Failed to copy image to clipboard:", error);
    return { success: false, error: error.message };
  }
}, { maxPayloadBytes: IPC_LIMITS.maxImageDataUrlBytes + 64 * 1024 });

// Copy the last frame through a bounded, owner-scoped ffmpeg runner.
ipcMain.handle("copy-last-frame-from-file", async (event, filePath) => {
  let context = null;
  let ownerContext = null;
  try {
    context = captureProfileGenerationContext();
    const authorized = await assertRendererPath(event, filePath, "file");
    const ownerId = registerNativeWorkOwner(event.sender);
    ownerContext = nativeOwnerLifecycle.capture(event.sender);
    const buffer = await lastFrameCaptureService.capture(authorized.path, { ownerId });
    assertProfileGenerationContextActive(context);
    nativeOwnerLifecycle.assertActive(ownerContext);
    if (event.sender?.isDestroyed?.()) {
      return { success: false, error: "OWNER_CANCELLED" };
    }

    const image = nativeImage.createFromBuffer(buffer);
    if (!image || image.isEmpty()) {
      return { success: false, error: "EMPTY_IMAGE" };
    }
    clipboard.writeImage(image);
    return { success: true };
  } catch (error) {
    console.error("Failed to copy last frame with ffmpeg:", error);
    return {
      success: false,
      error: error?.code || error?.message || "FRAME_CAPTURE_FAILED",
    };
  }
});

ipcMain.handle("confirm-move-to-trash", async (event, payload = {}) => {
  assertPlainObject(payload, "trash confirmation");
  if (!trashAdmissionOpen) {
    throw new ProfileOperationInvalidatedError();
  }
  const requestedPaths = assertStringArray(payload.paths, {
    name: "trash confirmation paths",
    minEntries: 1,
    maxEntries: 2_000,
    item: { minChars: 1, maxChars: IPC_LIMITS.maxPathChars, trim: true },
    dedupe: true,
  });
  const context = captureProfileGenerationContext();
  const canonicalPaths = [];
  const bindings = {};
  for (const requestedPath of requestedPaths) {
    const authorized = await assertRendererPath(event, requestedPath, "file");
    canonicalPaths.push(authorized.path);
    bindings[authorized.path] = await readTrashFileIdentity(authorized.path);
  }
  assertProfileGenerationContextActive(context);

  const requester = event.sender;
  const win = BrowserWindow.fromWebContents(requester);
  if (!win || win.isDestroyed()) {
    return { confirmed: false };
  }
  // Never let display text weaken the native confirmation boundary. The
  // renderer can supply only candidate paths; the prompt names the canonical
  // path that was actually authorized and identity-bound above.
  const sampleName = path.basename(canonicalPaths[0]);
  const count = canonicalPaths.length;
  const message =
    count === 1
      ? `Move "${sampleName}" to Recycle Bin?`
      : `Move ${count} items to Recycle Bin?`;

  try {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Move to Bin", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message,
    });

    if (
      response !== 0 ||
      win.isDestroyed() ||
      requester.isDestroyed?.() ||
      !trashAdmissionOpen ||
      profileReconfigurationInProgress
    ) {
      return { confirmed: false };
    }
    assertProfileGenerationContextActive(context);
    const grant = trashConfirmationStore.issue({
      ownerId: requester.id,
      scopeId: context.profileId,
      generation: context.generation,
      paths: canonicalPaths,
      bindings,
    });

    const refocus = () => {
      if (win.isDestroyed()) return;
      try {
        win.focus();
        win.webContents.focus();
      } catch { }
    };
    refocus();
    setTimeout(refocus, 0);

    return { confirmed: true, token: grant.token, expiresAt: grant.expiresAt };
  } catch (error) {
    console.error("Failed to show confirm dialog:", error);
    if (!win.isDestroyed()) {
      try {
        win.focus();
        win.webContents.focus();
      } catch { }
    }
    return { confirmed: false };
  }
});

// Return a serializable last-known grid before the authoritative filesystem
// refresh. SQLite owns this cache; no inactive media elements or renderer trees
// are retained in the main process.
ipcMain.handle(
  "read-directory-cache",
  async (
    event,
    folderPath,
    recursive = false,
    requestedScanId = null,
    cacheOptions = undefined
  ) => {
    const authorizedRoot = await assertRendererPath(
      event,
      folderPath,
      "directory"
    );
    assertBoolean(recursive, "recursive");
    if (requestedScanId !== null) {
      assertString(requestedScanId, {
        name: "scanId",
        minChars: 1,
        maxChars: 256,
      });
    }
    assertPlainObject(cacheOptions || {}, "cache options");
    const requestedLimit = cacheOptions?.limit;
    const limit = requestedLimit === undefined
      ? undefined
      : assertInteger(Number(requestedLimit), {
          name: "cache preview limit",
          min: 1,
          max: 128,
        });
    const metadataContext = captureMetadataContext();
    const normalizedRoot = authorizedRoot.path;
    await flushDirectoryAggregates(normalizedRoot);
    assertMetadataContextActive(metadataContext);
    const snapshot = metadataContext.metadataStore.getCachedLibrarySnapshot(
      normalizedRoot,
      {
        recursive: Boolean(recursive),
        limit,
        assertActive: () => assertMetadataContextActive(metadataContext),
      }
    );
    assertMetadataContextActive(metadataContext);
    return createCachedLibraryResponse(
      snapshot,
      normalizedRoot,
      requestedScanId,
      { generation: metadataContext.generation }
    );
  }
);

async function releaseWatcherInitializationForScan(scan, entries) {
  const context = activeWatcherContext;
  if (
    !context ||
    context.cancelled ||
    context.ownerWebContentsId !== scan.senderId ||
    context.scanId !== scan.scanId ||
    !context.watcherSessionId
  ) {
    return { success: false, unavailable: true };
  }
  const result = await folderWatcher.releaseInitialization(
    context.watcherSessionId,
    entries
  );
  assertDirectoryScanActive(scan);
  assertWatcherContextActive(context);
  return result;
}

async function stopWatcherForDirectoryScan(scan) {
  const context = activeWatcherContext;
  if (
    !context ||
    context.ownerWebContentsId !== scan.senderId ||
    context.scanId !== scan.scanId
  ) {
    return false;
  }
  await folderWatcher.stop();
  await flushDirectoryAggregates(context.rootPath);
  invalidateWatcherContext();
  return true;
}

// Read directory and return video files with metadata
ipcMain.handle(
  "read-directory",
  async (
    event,
    folderPath,
    recursive = false,
    requestedScanId = null,
    scanOptions = {}
  ) => {
    const authorizedRoot = await assertRendererPath(
      event,
      folderPath,
      "directory"
    );
    assertBoolean(recursive, "recursive");
    if (requestedScanId !== null) {
      assertString(requestedScanId, {
        name: "scanId",
        minChars: 1,
        maxChars: 256,
      });
    }
    assertPlainObject(scanOptions || {}, "scan options");
    assertPayloadSize(scanOptions || {}, 16 * 1024);
    const scan = beginDirectoryScan(event.sender.id, requestedScanId);
    const streamRecords = Boolean(scanOptions?.streamRecords);
    let metadataContext = null;
    let progressReporter = null;
    const progressCounters = {
      directoriesScanned: 0,
      entriesChecked: 0,
      videosFound: 0,
      indexedFiles: 0,
      enrichedFiles: 0,
      fingerprintsReused: 0,
      warnings: 0,
    };
    const assertActive = () => {
      assertDirectoryScanActive(scan);
      if (metadataContext) {
        assertMetadataContextActive(metadataContext);
      }
    };
    const handleSenderDestroyed = () => {
      if (cancelDirectoryScan(scan.senderId, scan.scanId)) {
        void stopWatcherForDirectoryScan(scan).catch(() => {});
      }
    };
    event.sender.once("destroyed", handleSenderDestroyed);

    try {
      assertActive();
      const normalizedRoot = authorizedRoot.path;
      metadataContext = captureMetadataContext();
      setVideoDimensionsRoot(normalizedRoot);
      scan.metadataContext = metadataContext;
      scan.rootPath = normalizedRoot;
      scan.recursive = Boolean(recursive);
      progressReporter = createDirectoryScanProgressReporter({
        scanId: scan.scanId,
        sender: event.sender,
        rootPath: normalizedRoot,
        recursive,
      });
      progressReporter.setPhase("enumerating", {
        currentPath: ".",
        ...progressCounters,
      });
      assertActive();

      const metadataStore = metadataContext.metadataStore;
      metadataStore.registerLibraryRoot(normalizedRoot, {
        recursive,
        refreshState: "scanning",
      });

      console.log(
        `Reading directory: ${normalizedRoot} (recursive: ${recursive})`
      );
      const entries = [];
      const scannedDirectories = new Set();
      const videoFiles = streamRecords ? null : [];
      const pendingEnumerationRecords = [];
      const pendingPatchRecords = [];
      let nextEnumerationBatchSize = DIRECTORY_SCAN_FIRST_BATCH_SIZE;
      let enrichedVideoCount = 0;
      let partialCoverage = false;
      const maybeYieldEnumeration = createPeriodicEventLoopYielder();
      const maybeYieldEnrichment = createPeriodicEventLoopYielder();

      const flushEnumerationRecords = () => {
        if (!streamRecords || pendingEnumerationRecords.length === 0) return;
        sendDirectoryScanRecords(
          scan,
          event.sender,
          normalizedRoot,
          "enumeration",
          pendingEnumerationRecords.splice(0)
        );
        nextEnumerationBatchSize = DIRECTORY_SCAN_BATCH_SIZE;
      };
      const flushPatchRecords = () => {
        if (!streamRecords || pendingPatchRecords.length === 0) return;
        sendDirectoryScanRecords(
          scan,
          event.sender,
          normalizedRoot,
          "patch",
          pendingPatchRecords.splice(0)
        );
      };

      const relativeProgressPath = (candidatePath) => {
        if (!candidatePath) return "";
        const relativePath = path.relative(normalizedRoot, candidatePath);
        return relativePath && relativePath !== "." ? relativePath : ".";
      };

      const reportEnumeration = (currentPath) => {
        progressReporter.report({
          ...progressCounters,
          currentPath: relativeProgressPath(currentPath),
        });
      };

      async function scanDirectory(dirPath, depth = 0) {
        assertActive();
        const files = await fsPromises.readdir(dirPath, { withFileTypes: true });
        assertActive();
        scannedDirectories.add(dirPath);
        progressCounters.directoriesScanned += 1;
        reportEnumeration(dirPath);

        for (const file of files) {
          assertActive();
          const fullPath = path.join(dirPath, file.name);
          progressCounters.entriesChecked += 1;

          if (file.isFile() && isVideoFile(file.name)) {
            try {
              const stats = await fsPromises.stat(fullPath);
              assertActive();
              const entry = { filePath: fullPath, stats };
              entries.push(entry);
              progressCounters.videosFound = entries.length;
              if (streamRecords) {
                pendingEnumerationRecords.push(
                  createEnumeratedVideoFileObject(
                    fullPath,
                    normalizedRoot,
                    stats
                  )
                );
                if (scan.priorityIds.length < DIRECTORY_SCAN_PRIORITY_LIMIT) {
                  scan.priorityIds.push(fullPath);
                }
                if (
                  pendingEnumerationRecords.length >= nextEnumerationBatchSize
                ) {
                  flushEnumerationRecords();
                }
              }
            } catch (error) {
              if (isDirectoryScanCancelled(error)) {
                throw error;
              }
              // Do not reconcile this directory when even one candidate could
              // not be inspected; otherwise a transient stat race could mark a
              // still-present instance missing.
              scannedDirectories.delete(dirPath);
              partialCoverage = true;
              progressCounters.warnings += 1;
              console.warn(
                `Error reading file stats for ${fullPath}:`,
                error.message
              );
            }
          } else if (file.isDirectory() && recursive) {
            if (isIgnoredScanDirectory(file.name)) {
              // Ignored application/cache directories are expected and do not
              // count as scan warnings.
            } else if (depth >= 10) {
              partialCoverage = true;
              progressCounters.warnings += 1;
            } else {
              try {
                await scanDirectory(fullPath, depth + 1);
                assertActive();
              } catch (error) {
                if (isDirectoryScanCancelled(error)) {
                  throw error;
                }
                partialCoverage = true;
                progressCounters.warnings += 1;
                console.warn(
                  `Skipping directory ${fullPath}: ${error.message}`
                );
              }
            }
          }

          reportEnumeration(dirPath);
          const pendingYield = maybeYieldEnumeration();
          if (pendingYield) {
            await pendingYield;
            assertActive();
          }
        }
      }

      await scanDirectory(normalizedRoot);
      assertActive();
      flushEnumerationRecords();
      progressReporter.report(
        { ...progressCounters, currentPath: "." },
        { force: true }
      );

      progressReporter.setPhase("indexing", {
        ...progressCounters,
        phaseCurrent: 0,
        phaseTotal: entries.length,
        currentPath: "",
      });

      metadataStore.registerDirectories(
        normalizedRoot,
        [...scannedDirectories],
        { recursive, refreshState: "scanning" }
      );
      assertActive();

      const indexedResults = [];
      const pendingIndexEntries = new Map(
        entries.map((entry) => [entry.filePath, entry])
      );
      while (pendingIndexEntries.size > 0) {
        assertActive();
        const batch = takePrioritizedDirectoryScanBatch(
          pendingIndexEntries,
          scan,
          DIRECTORY_SCAN_INDEX_BATCH_SIZE
        );
        const indexedOffset = indexedResults.length;
        const reusedOffset = progressCounters.fingerprintsReused;
        const batchResults = await metadataStore.indexFiles({
          rootPath: normalizedRoot,
          entries: batch,
          recursive,
          assertActive,
          concurrency: DIRECTORY_SCAN_INDEX_CONCURRENCY,
          onProgress: ({ indexedFiles, fingerprintsReused, filePath }) => {
            progressCounters.indexedFiles = indexedOffset + indexedFiles;
            progressCounters.fingerprintsReused =
              reusedOffset + fingerprintsReused;
            progressReporter.report({
              ...progressCounters,
              phaseCurrent: progressCounters.indexedFiles,
              phaseTotal: entries.length,
              currentPath: filePath || "",
            });
          },
        });
        assertActive();
        indexedResults.push(...batchResults);
        progressCounters.indexedFiles = indexedResults.length;
        progressCounters.fingerprintsReused =
          reusedOffset +
          batchResults.reduce(
            (count, result) => count + (result.fingerprintReused ? 1 : 0),
            0
          );
      }
      assertActive();
      progressCounters.indexedFiles = entries.length;
      progressReporter.report(
        {
          ...progressCounters,
          phaseCurrent: entries.length,
          phaseTotal: entries.length,
          currentPath: "",
        },
        { force: true }
      );
      const indexedByPath = new Map(
        indexedResults.map((result) => [result.filePath, result])
      );

      progressReporter.setPhase("reconciling", {
        ...progressCounters,
        phaseTotal: null,
        currentPath: "",
      });
      metadataStore.reconcileLibraryRoot(
        normalizedRoot,
        entries.map((entry) => entry.filePath),
        {
          recursive,
          scannedDirectories: [...scannedDirectories],
          // A complete recursive scan may safely mark instances and directory
          // rows from a subtree that disappeared wholesale. Partial scans and
          // direct-only scans stay conservative around unvisited branches.
          completeCoverage: Boolean(recursive) && !partialCoverage,
          assertActive,
        }
      );
      assertActive();

      if (partialCoverage) {
        metadataStore.registerLibraryRoot(normalizedRoot, {
          recursive,
          refreshState: "partial",
        });
      }

      progressReporter.setPhase("enriching", {
        ...progressCounters,
        phaseCurrent: 0,
        phaseTotal: entries.length,
        currentPath: "",
      });
      const pendingEnrichmentEntries = new Map(
        entries.map((entry) => [entry.filePath, entry])
      );
      const enrichmentWorkers = Array.from(
        {
          length: Math.min(
            DIRECTORY_SCAN_ENRICHMENT_CONCURRENCY,
            Math.max(1, entries.length)
          ),
        },
        async () => {
          while (pendingEnrichmentEntries.size > 0) {
            assertActive();
            const [entry] = takePrioritizedDirectoryScanBatch(
              pendingEnrichmentEntries,
              scan,
              1
            );
            if (!entry) return;
            const videoFile = await createVideoFileObject(
              entry.filePath,
              normalizedRoot,
              {
                stats: entry.stats,
                indexedInfo:
                  indexedByPath.get(path.resolve(entry.filePath)) || null,
                metadataStore,
                rootPath: normalizedRoot,
                recursive,
                generation: metadataContext.generation,
                assertActive,
              }
            );
            assertActive();
            if (videoFile) {
              enrichedVideoCount += 1;
              if (videoFiles) videoFiles.push(videoFile);
              if (streamRecords) {
                pendingPatchRecords.push(videoFile);
                if (
                  pendingPatchRecords.length >=
                  DIRECTORY_SCAN_PATCH_BATCH_SIZE
                ) {
                  flushPatchRecords();
                }
              }
            } else {
              progressCounters.warnings += 1;
            }
            progressCounters.enrichedFiles += 1;
            progressReporter.report({
              ...progressCounters,
              phaseCurrent: progressCounters.enrichedFiles,
              phaseTotal: entries.length,
              currentPath: relativeProgressPath(entry.filePath),
            });

            const pendingYield = maybeYieldEnrichment();
            if (pendingYield) {
              await pendingYield;
              assertActive();
            }
          }
        }
      );
      await Promise.all(enrichmentWorkers);
      assertActive();
      flushPatchRecords();

      await releaseWatcherInitializationForScan(scan, entries);
      assertActive();
      await flushDirectoryAggregates(normalizedRoot);
      assertActive();

      progressReporter.setPhase("finalizing", {
        ...progressCounters,
        phaseCurrent: enrichedVideoCount,
        phaseTotal: enrichedVideoCount,
        currentPath: "",
      });

      console.log(
        `Found ${enrichedVideoCount} video files in ${normalizedRoot} (recursive: ${recursive})`
      );

      const libraryTree = metadataStore.getLibraryTree(normalizedRoot);
      return {
        ...(streamRecords
          ? { streamed: true, fileCount: enrichedVideoCount }
          : {
              files: videoFiles.sort((a, b) =>
                a.name.localeCompare(b.name)
              ),
            }),
        root: libraryTree.root,
        directories: libraryTree.directories,
        scanId: scan.scanId,
        recordSequence: scan.recordSequence,
      };
    } catch (error) {
      if (isDirectoryScanCancelled(error)) {
        try {
          await stopWatcherForDirectoryScan(scan);
        } catch {}
        progressReporter?.setPhase("cancelled", {
          ...progressCounters,
          phaseTotal: null,
          currentPath: "",
        });
        return { cancelled: true, scanId: scan.scanId, files: [] };
      }
      progressCounters.warnings += 1;
      try {
        await stopWatcherForDirectoryScan(scan);
      } catch {}
      progressReporter?.setPhase("error", {
        ...progressCounters,
        phaseTotal: null,
        currentPath: "",
        message: error?.message || String(error),
      });
      if (metadataContext?.metadataStore && scan.rootPath) {
        try {
          assertMetadataContextActive(metadataContext);
          metadataContext.metadataStore.registerLibraryRoot(scan.rootPath, {
            recursive,
            refreshState: "error",
          });
        } catch (stateError) {
          if (!isDirectoryScanCancelled(stateError)) {
            console.warn("[metadata] Failed to record scan error", stateError);
          }
        }
      }
      console.error("Error reading directory:", error);
      throw error;
    } finally {
      event.sender.removeListener("destroyed", handleSenderDestroyed);
      if (activeDirectoryScans.get(scan.senderId) === scan) {
        activeDirectoryScans.delete(scan.senderId);
      }
    }
  }
);

ipcMain.handle("cancel-directory-scan", async (event, scanId = null) => {
  if (scanId !== null) {
    assertString(scanId, {
      name: "scanId",
      minChars: 1,
      maxChars: 256,
    });
  }
  const scan = activeDirectoryScans.get(event.sender.id) || null;
  const cancelled = cancelDirectoryScan(event.sender.id, scanId);
  if (cancelled && scan) {
    try {
      await stopWatcherForDirectoryScan(scan);
    } catch {}
  }
  return { success: true, cancelled };
});

ipcMain.on("prioritize-directory-scan", (event, payload = {}) => {
  assertPlainObject(payload, "scan priority");
  const scanId = assertString(payload?.scanId, {
    name: "scanId",
    minChars: 1,
    maxChars: 256,
  });
  const ids = assertStringArray(payload?.ids || [], {
    name: "priority ids",
    maxEntries: DIRECTORY_SCAN_PRIORITY_LIMIT,
    item: { minChars: 1, maxChars: IPC_LIMITS.maxPathChars },
  });
  updateDirectoryScanPriorities(
    event.sender.id,
    scanId,
    ids
  );
});

function normalizeLibraryIpcRootPath(payload) {
  const candidate = typeof payload === "string" ? payload : payload?.rootPath;
  if (
    typeof candidate !== "string" ||
    !candidate.trim() ||
    candidate.includes("\0")
  ) {
    throw new TypeError("A valid library root path is required");
  }
  return path.resolve(candidate.trim());
}

function normalizeReviewSessionIpcRootPath(payload) {
  const candidate = typeof payload === "string" ? payload : payload?.rootPath;
  return path.resolve(assertString(candidate, {
    name: "review session root path",
    minChars: 1,
    maxChars: IPC_LIMITS.maxPathChars,
    trim: true,
  }));
}

function runMetadataContextOperation(
  operation,
  defaultErrorCode = "PROFILE_OPERATION_ERROR"
) {
  return runProfileOwnedOperation({
    captureContext: captureMetadataContext,
    assertContextActive: assertMetadataContextActive,
    operation,
    getFallbackProfileId: getActiveProfileId,
    getFallbackGeneration: () => metadataProfileGeneration,
    defaultErrorCode,
  });
}

function runLibraryCatalogOperation(operation) {
  return runMetadataContextOperation(operation, "LIBRARY_CATALOG_ERROR");
}

const reviewManifestExportCoordinator =
  createReviewManifestExportCoordinator({
    captureContext: ({ owner }) => {
      const context = captureMetadataContext();
      registerNativeWorkOwner(owner);
      return {
        ...context,
        profileName: getProfileDisplayName(context.profileId),
        ownerContext: nativeOwnerLifecycle.capture(owner),
      };
    },
    assertActive: ({ owner, context }) => {
      assertMetadataContextActive(context);
      nativeOwnerLifecycle.assertActive(context.ownerContext);
      if (
        !owner ||
        owner.isDestroyed?.() ||
        !mainWindow ||
        mainWindow.isDestroyed() ||
        mainWindow.webContents !== owner
      ) {
        throw new ProfileOperationInvalidatedError();
      }
    },
    authorizeRoot: ({ owner, rootPath }) =>
      assertRendererPath({ sender: owner }, rootPath, "directory"),
    getRoot: ({ context, rootPath }) =>
      context.metadataStore.getLibraryRoot(rootPath),
    showSaveDialog: async ({ owner, defaultName }) => {
      const win = BrowserWindow.fromWebContents(owner);
      if (!win || win.isDestroyed() || owner.isDestroyed?.()) {
        throw new ProfileOperationInvalidatedError();
      }
      return dialog.showSaveDialog(win, {
        title: "Export review manifest",
        defaultPath: path.join(app.getPath("documents"), defaultName),
        filters: [{ name: "JSON manifest", extensions: ["json"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
    },
    queryScopeRecords: ({
      context,
      rootPath,
      directory,
      scope,
      limit,
      assertActive,
    }) => {
      const requestedMaximum = Number(limit) - 1;
      const maxRecords = Number.isSafeInteger(requestedMaximum)
        ? Math.max(
            1,
            Math.min(REVIEW_MANIFEST_MAX_RECORDS, requestedMaximum)
          )
        : REVIEW_MANIFEST_MAX_RECORDS;
      return context.metadataStore.getReviewManifestSnapshot(rootPath, {
        directory,
        scope,
        maxRecords,
        assertActive,
      });
    },
    logger: console,
  });

ipcMain.handle("library:list-roots", async (_event, options = {}) => {
  assertPlainObject(options, "library list options");
  return runLibraryCatalogOperation((metadataStore) => ({
    roots: metadataStore.listLibraryRoots({
      pinnedOnly: Boolean(options?.pinnedOnly),
    }),
  }));
});

// Catalog listing is intentionally not itself an unbounded authority grant.
// When the user opens an indexed root, grant that exact database-known root
// on demand and let the bounded LRU retain the roots that are actually used.
ipcMain.handle("library:authorize-root", async (event, payload = {}) => {
  assertPlainObject(payload, "library root authorization");
  const rootPath = normalizeLibraryIpcRootPath(payload);
  const catalogResult = runLibraryCatalogOperation((metadataStore) => {
    const root = metadataStore.getLibraryRoot(rootPath);
    if (!root) {
      throw new Error(`Library root has not been indexed: ${rootPath}`);
    }
    return { root };
  });
  if (catalogResult?.success === false) return catalogResult;
  if (
    catalogResult.profileId !== getActiveProfileId() ||
    catalogResult.generation !== metadataProfileGeneration
  ) {
    throw new ProfileOperationInvalidatedError();
  }
  const grantedPath = await grantRendererRoot(
    event.sender,
    catalogResult.root.rootPath
  );
  return { ...catalogResult, rootPath: grantedPath };
});

ipcMain.handle("library:get-tree", async (_event, payload = {}) => {
  assertPlainObject(payload, "library tree request");
  const rootPath = normalizeLibraryIpcRootPath(payload);
  await flushDirectoryAggregates(rootPath);
  return runLibraryCatalogOperation((metadataStore) => {
    const tree = metadataStore.getLibraryTree(rootPath, {
      includeMissing: Boolean(payload?.includeMissing),
    });
    if (!tree.root) {
      throw new Error(`Library root has not been indexed: ${rootPath}`);
    }
    return tree;
  });
});

ipcMain.handle("review:export-manifest", async (event, payload = {}) => {
  assertPlainObject(payload, "review manifest request");
  const requestedRoot = normalizeLibraryIpcRootPath(payload);
  const directory = normalizeManifestDirectory(
    assertString(payload?.directory ?? "", {
      name: "review manifest directory",
      maxChars: IPC_LIMITS.maxPathChars,
    })
  );
  const scope = normalizeManifestScope(
    assertString(payload?.scope, {
      name: "review manifest scope",
      minChars: 1,
      maxChars: 32,
    })
  );
  return reviewManifestExportCoordinator.exportManifest({
    owner: event.sender,
    rootPath: requestedRoot,
    directory,
    scope,
  });
});

ipcMain.handle("review-sessions:list", async () =>
  runMetadataContextOperation((metadataStore, context) => ({
    sessions: metadataStore.listReviewCheckpoints({
      assertActive: () => assertMetadataContextActive(context),
    }),
  }), "REVIEW_SESSION_LIST_ERROR")
);

ipcMain.handle("review-sessions:get", async (_event, payload = {}) =>
  runMetadataContextOperation((metadataStore, context) => {
    assertPlainObject(payload, "review session request");
    const rootPath = normalizeReviewSessionIpcRootPath(payload);
    return {
      checkpoint: metadataStore.getReviewCheckpoint(rootPath, {
        assertActive: () => assertMetadataContextActive(context),
      }),
    };
  }, "REVIEW_SESSION_GET_ERROR")
);

ipcMain.handle(
  "review-sessions:save",
  async (_event, payload = {}) =>
    runMetadataContextOperation((metadataStore, context) => {
      assertPlainObject(payload, "review session draft");
      const rootPath = normalizeReviewSessionIpcRootPath(payload);
      return {
        checkpoint: metadataStore.saveReviewCheckpoint(
          { ...payload, rootPath },
          { assertActive: () => assertMetadataContextActive(context) }
        ),
      };
    }, "REVIEW_SESSION_SAVE_ERROR"),
  { maxPayloadBytes: 384 * 1024 }
);

ipcMain.handle("review-sessions:clear", async (_event, payload = {}) =>
  runMetadataContextOperation((metadataStore, context) => {
    assertPlainObject(payload, "review session clear request");
    const rootPath = normalizeReviewSessionIpcRootPath(payload);
    return {
      deleted: metadataStore.clearReviewCheckpoint(rootPath, {
        assertActive: () => assertMetadataContextActive(context),
      }),
    };
  }, "REVIEW_SESSION_CLEAR_ERROR")
);

ipcMain.on(
  REVIEW_SESSION_FLUSH_ACK_CHANNEL,
  (event, payload = {}) => {
    assertPlainObject(payload, "review session flush acknowledgement");
    if (
      Object.keys(payload).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(payload, "requestId")
    ) {
      throw new TypeError("Review session flush acknowledgement is invalid");
    }
    const requestId = assertString(payload.requestId, {
      name: "review session flush request id",
      minChars: 1,
      maxChars: 256,
    });
    reviewSessionFlushCoordinator.acknowledge(event.sender, requestId);
  },
  { maxPayloadBytes: 4096 }
);

ipcMain.handle("library:set-pinned", async (_event, payload = {}) =>
  runLibraryCatalogOperation((metadataStore) => {
    const rootPath = normalizeLibraryIpcRootPath(payload);
    if (typeof payload?.pinned !== "boolean") {
      throw new TypeError("Library pin state must be a boolean");
    }
    return {
      root: metadataStore.setLibraryRootPinned(rootPath, payload.pinned),
    };
  })
);

ipcMain.handle("library:list-saved-views", async () =>
  runLibraryCatalogOperation((metadataStore) => ({
    views: metadataStore.listSavedViews(),
  }))
);

ipcMain.handle("library:create-saved-view", async (_event, payload = {}) =>
  runLibraryCatalogOperation((metadataStore) => ({
    view: metadataStore.createSavedView(payload?.name, payload?.definition),
  }))
);

ipcMain.handle("library:update-saved-view", async (_event, payload = {}) =>
  runLibraryCatalogOperation((metadataStore) => ({
    view: metadataStore.updateSavedView(payload?.id, {
      ...(Object.prototype.hasOwnProperty.call(payload, "name")
        ? { name: payload.name }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(payload, "definition")
        ? { definition: payload.definition }
        : {}),
    }),
  }))
);

ipcMain.handle("library:delete-saved-view", async (_event, payload = {}) =>
  runLibraryCatalogOperation((metadataStore) => ({
    deleted: metadataStore.deleteSavedView(payload?.id),
  }))
);

function normalizeFingerprintArray(fingerprints) {
  return assertStringArray(fingerprints, {
    name: "fingerprints",
    maxEntries: IPC_LIMITS.maxArrayEntries,
    item: { minChars: 1, maxChars: 512 },
  });
}

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
      const cleanFingerprints = normalizeFingerprintArray(fingerprints);
      const cleanNames = assertStringArray(tagNames, {
        name: "tag names",
        maxEntries: 128,
        item: { minChars: 1, maxChars: 256, trim: true },
      });
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
      const cleanFingerprints = normalizeFingerprintArray(fingerprints);
      const cleanName = assertString(tagName, {
        name: "tag name",
        minChars: 1,
        maxChars: 256,
        trim: true,
      });
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
      const cleanFingerprints = normalizeFingerprintArray(fingerprints);
      if (!cleanFingerprints.length) {
        return { updates: {} };
      }
      const rating =
        ratingValue === null || ratingValue === undefined
          ? null
          : assertInteger(Number(ratingValue), {
              name: "rating",
              min: 0,
              max: 5,
            });
      const updates = store.setRating(cleanFingerprints, rating);
      return { updates };
    } catch (error) {
      console.error("Failed to set rating:", error);
      return { updates: {}, error: error?.message || String(error) };
    }
  }
);

ipcMain.handle(
  "metadata:set-review-state",
  async (_event, fingerprints = [], reviewState) =>
    runMetadataContextOperation((store) => {
      const cleanFingerprints = normalizeFingerprintArray(fingerprints);
      const normalizedReviewState = assertString(reviewState, {
        name: "review state",
        minChars: 1,
        maxChars: 32,
      });
      if (!["unreviewed", "reviewed", "pick", "reject"].includes(normalizedReviewState)) {
        throw new TypeError("Invalid review state");
      }
      if (!cleanFingerprints.length) return { updates: {} };
      return { updates: store.setReviewState(cleanFingerprints, normalizedReviewState) };
    }, "REVIEW_STATE_ERROR")
);

ipcMain.handle("metadata:restore-review", async (_event, snapshots = []) =>
  runMetadataContextOperation((store, context) => {
    const normalizedSnapshots = normalizeReviewRestoreSnapshots(snapshots);
    if (!normalizedSnapshots.length) return { updates: {} };
    return {
      updates: store.restoreReviewMetadata(normalizedSnapshots, {
        assertActive: () => assertMetadataContextActive(context),
      }),
    };
  }, "REVIEW_RESTORE_ERROR")
);

ipcMain.handle("metadata:get-generation", async (event, payload = {}) => {
  if (typeof payload !== "number") {
    assertPlainObject(payload, "generation metadata request");
  }
  let context = null;
  let requestToken = null;
  const instanceId = Number(
    typeof payload === "number" ? payload : payload?.instanceId
  );
  if (!Number.isSafeInteger(instanceId) || instanceId <= 0) {
    return {
      success: false,
      instanceId: null,
      error: "A positive file instance id is required",
      code: "INVALID_INSTANCE_ID",
    };
  }
  try {
    requestToken = normalizeGenerationRequestToken(
      typeof payload === "object" ? payload?.requestToken : null
    );
  } catch (error) {
    return {
      success: false,
      instanceId,
      requestToken: null,
      error: error?.message || String(error),
      code: error?.code || "INVALID_GENERATION_REQUEST_TOKEN",
    };
  }

  try {
    context = captureMetadataContext();
    assertMetadataContextActive(context);
    const instance = context.metadataStore.getFileInstanceById(instanceId);
    if (!instance?.present || !instance.absolutePath) {
      throw Object.assign(new Error("File instance does not exist"), {
        code: "INSTANCE_NOT_FOUND",
      });
    }
    await assertRendererPath(event, instance.absolutePath, "file");
    assertMetadataContextActive(context);
    const { ownerId, scopeId } = createGenerationRequestIdentity({
      profileId: context.profileId,
      generation: context.generation,
      webContentsId: event.sender.id,
      requestToken,
    });
    const handleDestroyed = () => sidecarMetadataService.cancelOwner(ownerId);
    event.sender.once("destroyed", handleDestroyed);
    try {
      const result = await sidecarMetadataService.getMetadata({
        instanceId,
        ownerId,
        scopeId,
        metadataStore: context.metadataStore,
        assertActive: () => assertMetadataContextActive(context),
        authorizePath: async (candidatePath) => {
          await assertRendererPath(event, candidatePath, "file");
          assertMetadataContextActive(context);
        },
      });
      assertMetadataContextActive(context);
      return {
        success: true,
        profileId: context.profileId,
        generation: context.generation,
        requestToken,
        ...result,
        generationMetadata: result.metadata,
      };
    } finally {
      event.sender.removeListener("destroyed", handleDestroyed);
    }
  } catch (error) {
    return {
      success: false,
      profileId: context?.profileId || getActiveProfileId(),
      generation: context?.generation ?? metadataProfileGeneration,
      instanceId,
      requestToken,
      error: error?.message || String(error),
      code: error?.code || "GENERATION_METADATA_ERROR",
    };
  }
});

ipcMain.handle("metadata:cancel-generation", async (event, payload = {}) => {
  assertPlainObject(payload, "generation cancellation");
  let requestToken;
  try {
    requestToken = normalizeGenerationRequestToken(payload?.requestToken, {
      required: true,
    });
  } catch (error) {
    return {
      success: false,
      requestToken: null,
      cancelled: 0,
      error: error?.message || String(error),
      code: error?.code || "INVALID_GENERATION_REQUEST_TOKEN",
    };
  }

  return runMetadataContextOperation((_metadataStore, context) => {
    const { ownerId } = createGenerationRequestIdentity({
      profileId: context.profileId,
      generation: context.generation,
      webContentsId: event.sender.id,
      requestToken,
    });
    return {
      requestToken,
      cancelled: sidecarMetadataService.cancelOwner(ownerId),
    };
  }, "GENERATION_METADATA_ERROR");
});

ipcMain.handle("metadata:get", async (_event, fingerprints = []) => {
  try {
    const store = getMetadataStore();
    const cleanFingerprints = normalizeFingerprintArray(fingerprints);
    return { updates: store.getMetadataForFingerprints(cleanFingerprints) };
  } catch (error) {
    console.error("Failed to load metadata:", error);
    return { updates: {}, error: error?.message || String(error) };
  }
});

ipcMain.handle("bulk-move-to-trash", async (event, payload) => {
  assertPlainObject(payload, "trash request");
  if (!trashAdmissionOpen) {
    throw new ProfileOperationInvalidatedError();
  }
  const paths = assertStringArray(payload.paths, {
    name: "trash paths",
    minEntries: 1,
    maxEntries: 2_000,
    item: { minChars: 1, maxChars: IPC_LIMITS.maxPathChars, trim: true },
    dedupe: true,
  });
  const token = assertString(payload.confirmationToken, {
    name: "trash confirmation token",
    minChars: 64,
    maxChars: 64,
    trim: true,
  });
  const context = captureMetadataContext();
  const requester = event.sender;
  const requesterId = requester.id;
  const canonicalByRequestedPath = new Map();
  for (const requestedPath of paths) {
    const authorized = await assertRendererPath(event, requestedPath, "file");
    canonicalByRequestedPath.set(requestedPath, authorized.path);
  }
  assertMetadataContextActive(context);
  const confirmed = trashConfirmationStore.consume({
    token,
    ownerId: requesterId,
    scopeId: context.profileId,
    generation: context.generation,
    paths: [...canonicalByRequestedPath.values()],
  });
  const operation = (async () => {
    for (const canonicalPath of canonicalByRequestedPath.values()) {
      const currentIdentity = await readTrashFileIdentity(canonicalPath);
      if (currentIdentity !== confirmed.bindings[canonicalPath]) {
        throw new Error("A trash target changed after confirmation");
      }
    }
    const result = await trashAuthorizedPaths({
      paths,
      shell,
      authorizePath: async (filePath) => ({
        path: canonicalByRequestedPath.get(filePath),
      }),
      logger: console,
    });
    const canonicalMovedPaths = result.moved
      .map((requestedPath) => canonicalByRequestedPath.get(requestedPath))
      .filter(Boolean);
    if (canonicalMovedPaths.length > 0) {
      try {
        const catalogResult = context.metadataStore.markFilesMissing(
          canonicalMovedPaths,
          { assertActive: () => assertMetadataContextActive(context) }
        );
        result.catalogReconciled = true;
        result.catalogMarkedMissing = catalogResult.markedMissing;
      } catch (error) {
        // The filesystem result remains authoritative and must still reach the
        // renderer so moved cards are removed. Surface the catalog failure for
        // diagnostics; the active watcher/revisit scan can repair it later.
        console.error("[trash] Failed to reconcile moved files with metadata", error);
        result.catalogReconciled = false;
        result.catalogError = error?.message || String(error);
      }
    }
    const retryPaths = [];
    const retryBindings = {};
    for (const failure of result.failed) {
      const canonicalPath = canonicalByRequestedPath.get(failure.path);
      if (!canonicalPath) continue;
      try {
        const currentIdentity = await readTrashFileIdentity(canonicalPath);
        if (currentIdentity !== confirmed.bindings[canonicalPath]) {
          failure.error = "File changed after trash confirmation";
          continue;
        }
        retryPaths.push(canonicalPath);
        retryBindings[canonicalPath] = currentIdentity;
      } catch {
        // A missing path cannot be retried and needs no lingering capability.
      }
    }
    let retryContextActive = false;
    if (
      retryPaths.length > 0 &&
      trashAdmissionOpen &&
      !profileReconfigurationInProgress &&
      !requester.isDestroyed?.() &&
      mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.webContents === requester
    ) {
      try {
        assertMetadataContextActive(context);
        retryContextActive = true;
      } catch {
        // The completed result remains useful, but no capability may cross a
        // renderer/profile/shutdown ownership boundary.
      }
    }
    if (retryContextActive) {
      const retryGrant = trashConfirmationStore.issue({
        ownerId: requesterId,
        scopeId: context.profileId,
        generation: context.generation,
        paths: retryPaths,
        bindings: retryBindings,
      });
      result.retryConfirmationToken = retryGrant.token;
    }
    return result;
  })();
  return trackTrashOperation(operation);
});

// Recent folders IPC
ipcMain.handle("recent:get", async (event) => {
  const items = await getRecentFolders();
  await grantKnownRendererRoots(event.sender, items.map((item) => item.path));
  return items;
});
ipcMain.handle("recent:add", async (event, folderPath) => {
  const authorizedRoot = await assertRendererPath(
    event,
    folderPath,
    "directory"
  );
  return addRecentFolder(authorizedRoot.path);
});
ipcMain.handle("recent:remove", async (_e, folderPath) =>
  removeRecentFolder(assertPathString(folderPath))
);
ipcMain.handle("recent:clear", async () => await clearRecentFolders());

// Watcher IPC (delegated to file watcher module)
ipcMain.handle(
  "start-folder-watch",
  async (event, folderPath, recursive, watchOptions = {}) => {
  const authorizedRoot = await assertRendererPath(
    event,
    folderPath,
    "directory"
  );
  const normalizedRecursive = assertBoolean(recursive ?? true, "recursive");
  assertPlainObject(watchOptions || {}, "watch options");
  assertPayloadSize(watchOptions || {}, 16 * 1024);
  let context = null;
  try {
    context = createWatcherContext(
      authorizedRoot.path,
      normalizedRecursive,
      watchOptions
    );
    context.ownerWebContentsId = event.sender.id;
    assertWatcherContextActive(context);
    context.metadataStore.registerLibraryRoot(context.rootPath, {
      recursive: normalizedRecursive,
    });
    const result = await folderWatcher.start(context.rootPath, {
      recursive: normalizedRecursive,
      context,
      bufferInitialEvents: context.bufferInitialEvents,
    });
    assertWatcherContextActive(context);
    context.watcherSessionId = result.sessionId || null;
    return {
      success: true,
      mode: result.mode,
      recursive: result.recursive,
      sessionId: result.sessionId,
      initializing: Boolean(result.initializing),
    };
  } catch (e) {
    if (context && activeWatcherContext === context) {
      invalidateWatcherContext();
    }
    if (!isDirectoryScanCancelled(e)) {
      console.error("Error starting folder watch:", e);
    }
    return { success: false, error: e.message || String(e) };
  }
  }
);

ipcMain.handle("stop-folder-watch", async () => {
  try {
    const rootPath = activeWatcherContext?.rootPath || null;
    await folderWatcher.stop();
    if (rootPath) await flushDirectoryAggregates(rootPath);
    invalidateWatcherContext();
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
  const freeMB = Math.round((sys.free || 0) / 1024);
  const availableMB = Math.round(
    ((sys.available ?? sys.free) || 0) / 1024
  );
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
      freeMB,
      availableMB,
    },
  };
});


// App lifecycle
async function settleShutdownTasks(phase, tasks) {
  const entries = Object.entries(tasks);
  const results = await Promise.allSettled(
    entries.map(([, task]) => Promise.resolve().then(task))
  );
  const failures = [];
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    const [name] = entries[index];
    failures.push({ name, error: result.reason });
    console.error(`[shutdown] ${phase} task '${name}' failed`, result.reason);
  });
  return failures;
}

async function performNativeShutdown() {
  // The renderer owns only the latest debounced plain-data checkpoint draft.
  // Give it one bounded opportunity to persist through the still-current
  // profile/store before any native owner or generation is invalidated.
  await runReviewSessionFlushBarrier();
  // Mark scans interrupted while their old profile generation is still valid,
  // then stop every filesystem producer before the durable flush boundary.
  trashAdmissionOpen = false;
  const manifestShutdownDrain =
    reviewManifestExportCoordinator.closeAndDrain();
  cancelAllDirectoryScans();
  cancelPendingProfilePrompts();
  await Promise.all([
    drainActiveTrashOperations(),
    manifestShutdownDrain,
  ]);
  trashConfirmationStore.revokeAll();
  await folderWatcher.stop().catch((error) => {
    console.warn("[shutdown] Failed to stop watcher before flush", error);
  });
  invalidateWatcherContext();
  sidecarMetadataService.cancelAll();
  lastFrameCaptureService.cancelAll("Application shutdown requested");
  mediaProtocolService.cancelActiveStreams();
  const flushFailures = await settleShutdownTasks("flush", {
    directoryAggregates: () => flushDirectoryAggregates(),
    settings: () => settingsWriter.flush(),
  });
  if (flushFailures.some((failure) => failure.name === "settings")) {
    // Atomic replacement preserves the prior valid file. Make one final
    // explicit attempt so a transient rename/lock failure does not discard the
    // latest in-memory settings silently.
    await settleShutdownTasks("settings retry", {
      settings: () => settingsWriter.flush(),
    });
  }

  nativeShutdownRequested = true;
  metadataProfileGeneration += 1;
  disposeMainWindowActivity?.();
  disposeMainWindowActivity = null;
  sidecarMetadataService.shutdown();
  if (mainWindow && !mainWindow.isDestroyed()) {
    invalidateNativeWorkOwner(mainWindow.webContents);
  }
  setVideoDimensionsRoot(null);
  const pendingProfileReconfiguration = profileReconfigureQueue;
  await pendingProfileReconfiguration.catch(() => {});
  await settleShutdownTasks("dispose", {
    folderWatcher: () => folderWatcher.dispose(),
    frameCapture: () => lastFrameCaptureService.shutdown(),
    proxyManager: () => proxyManager.shutdown(),
    thumbnailCache: () => thumbnailCache.shutdown(),
    settingsWriter: () => settingsWriter.dispose(),
    directoryAggregates: () =>
      directoryAggregateBatcher.dispose({ flush: false }),
  });
  mediaProtocolService.dispose();
  trashConfirmationStore.dispose();
  reviewSessionFlushCoordinator.close();
  dataLocationPathGrants.clear();
  pathAuthority.dispose();
  trustedIpc.dispose();
}

function beginNativeShutdown() {
  if (nativeShutdownPromise) return nativeShutdownPromise;
  nativeShutdownPreparing = true;
  nativeShutdownPromise = performNativeShutdown();
  return nativeShutdownPromise;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

applicationInitializationPromise = app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) return;
  await dataLocationManager.ensureReady();
  profileManager.initializeProfileManager(app.getPath("userData"));
  activeProfileId = profileManager.getActiveProfile();
  console.log("GPU status:", app.getGPUFeatureStatus());
  await reconfigureForProfile(activeProfileId, { broadcast: false });
  mediaProtocolService.register(protocol);
  applicationInitializationComplete = true;
  await ensureMainWindow();
  broadcastProfileChange(currentSettings || defaultSettings);
});

void applicationInitializationPromise.catch((error) => {
  if (
    nativeShutdownPreparing ||
    nativeShutdownRequested ||
    error?.code === "APPLICATION_SHUTDOWN_REQUESTED"
  ) {
    console.log("[startup] Initialization cancelled by application shutdown");
    return;
  }
  console.error("❌ Startup failure:", error);
  try {
    dialog.showErrorBox(
      "Video Swarm could not start",
      error?.message || "The application failed during startup."
    );
  } catch (_) {}
  // The process owns the single-instance lock, so a failed startup must not
  // remain as an invisible primary instance. Settle native work, then exit.
  void beginNativeShutdown()
    .catch((shutdownError) => {
      console.error("[shutdown] Startup-failure cleanup failed", shutdownError);
    })
    .finally(() => {
      nativeShutdownComplete = true;
      app.exit(1);
    });
});

app.on("activate", () => {
  if (!ownsSingleInstanceLock) return;
  void ensureMainWindow().catch((error) => {
    console.error("[window] Failed to activate application window", error);
  });
});

// Electron does not await async event listeners. Hold the first quit request
// until native queues and atomic cache persistence have actually settled.
app.on("before-quit", (event) => {
  if (!ownsSingleInstanceLock) return;
  if (nativeShutdownComplete) return;
  event.preventDefault();
  if (nativeShutdownPromise) return;
  beginNativeShutdown().finally(() => {
    nativeShutdownComplete = true;
    app.quit();
  });
});
