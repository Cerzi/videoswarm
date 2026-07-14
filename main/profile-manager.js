const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG_FILE_NAME = "profiles.json";
const PROFILES_DIR_NAME = "profiles";
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_NAME = "Default";
const MAX_PROFILES = 64;
const MAX_PROFILE_ID_LENGTH = 64;
const MAX_PROFILE_NAME_LENGTH = 128;
const MAX_CONFIG_BYTES = 256 * 1024;
const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUARANTINE_PREFIX = ".profile-delete-";

let baseUserDataPath = null;
let state = null;

function resolveAppUserDataPath() {
  if (baseUserDataPath) {
    return baseUserDataPath;
  }

  try {
    // Lazy require to avoid issues when running in non-Electron environments (tests)
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      baseUserDataPath = path.resolve(app.getPath("userData"));
      return baseUserDataPath;
    }
  } catch (_) {
    // Ignored – tests will call initializeProfileManager with a custom path
  }

  throw new Error("Profile manager has not been initialised with a userData path");
}

function getConfigPath() {
  return path.join(resolveAppUserDataPath(), CONFIG_FILE_NAME);
}

function getProfilesRoot() {
  return path.join(resolveAppUserDataPath(), PROFILES_DIR_NAME);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stats = fs.statSync(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`Expected a directory at '${dirPath}'`);
  }
}

function fsyncDirectoryBestEffort(directoryPath) {
  let directoryHandle = null;
  try {
    directoryHandle = fs.openSync(directoryPath, "r");
    fs.fsyncSync(directoryHandle);
  } catch (_) {
    // Directory fsync is not available on every supported platform. The file
    // itself is always fsynced before its atomic rename.
  } finally {
    if (directoryHandle !== null) {
      try { fs.closeSync(directoryHandle); } catch (_) {}
    }
  }
}

function readCatalogFileBounded(configPath) {
  let fileHandle = null;
  try {
    fileHandle = fs.openSync(configPath, "r");
    const stats = fs.fstatSync(fileHandle);
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) {
      throw new Error("Profile catalog is not a bounded regular file");
    }
    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = fs.readSync(
        fileHandle,
        buffer,
        total,
        buffer.length - total,
        total
      );
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
        throw new Error("Profile catalog could not be read safely");
      }
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_CONFIG_BYTES) {
      throw new Error("Profile catalog exceeds its storage limit");
    }
    return buffer.toString("utf8", 0, total);
  } finally {
    if (fileHandle !== null) {
      try { fs.closeSync(fileHandle); } catch (_) {}
    }
  }
}

function loadConfigFromDisk() {
  const configPath = getConfigPath();
  try {
    const raw = readCatalogFileBounded(configPath);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("[profile-manager] Failed to read config, falling back to defaults", error);
    }
  }
  return null;
}

function writeConfigToDisk(config) {
  const configPath = getConfigPath();
  const configDirectory = path.dirname(configPath);
  ensureDirectory(configDirectory);
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("Profile catalog exceeds its storage limit");
  }

  const tempPath = path.join(
    configDirectory,
    `.${CONFIG_FILE_NAME}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  let fileHandle = null;
  try {
    fileHandle = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fileHandle, serialized, { encoding: "utf8" });
    fs.fsyncSync(fileHandle);
    fs.closeSync(fileHandle);
    fileHandle = null;
    fs.renameSync(tempPath, configPath);
    fsyncDirectoryBestEffort(configDirectory);
  } catch (error) {
    if (fileHandle !== null) {
      try { fs.closeSync(fileHandle); } catch (_) {}
    }
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function normalizeProfileId(value, label = "Profile id") {
  const id = typeof value === "string" ? value.trim() : "";
  if (
    !id ||
    id.length > MAX_PROFILE_ID_LENGTH ||
    !PROFILE_ID_PATTERN.test(id) ||
    id === "." ||
    id === ".."
  ) {
    throw new Error(
      `${label} must be 1-${MAX_PROFILE_ID_LENGTH} lowercase letters, numbers, or single hyphen-separated segments`
    );
  }
  return id;
}

function sanitizeProfileName(value, fallback) {
  const candidate = typeof value === "string" ? value : "";
  const clean = candidate
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROFILE_NAME_LENGTH)
    .trim();
  return clean || fallback;
}

function normalizeRequestedProfileName(value, { required = false } = {}) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    if (required) throw new Error("Profile name must be provided");
    return null;
  }
  if (name.length > MAX_PROFILE_NAME_LENGTH) {
    throw new Error(
      `Profile name must be at most ${MAX_PROFILE_NAME_LENGTH} characters`
    );
  }
  return sanitizeProfileName(name, null);
}

function normaliseProfileEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  let id;
  try {
    id = normalizeProfileId(entry.id);
  } catch (_) {
    return null;
  }
  return {
    id,
    name: sanitizeProfileName(entry.name, id),
  };
}

function ensureDefaultProfile(config) {
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  const seen = new Set();
  let defaultEntry = null;
  const otherProfiles = [];

  for (const rawEntry of profiles) {
    const entry = normaliseProfileEntry(rawEntry);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.id === DEFAULT_PROFILE_ID) {
      defaultEntry = entry;
      continue;
    }
    if (otherProfiles.length < MAX_PROFILES - 1) {
      otherProfiles.push(entry);
    }
  }

  const cleanProfiles = [
    defaultEntry || { id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME },
    ...otherProfiles,
  ].slice(0, MAX_PROFILES);

  let active = DEFAULT_PROFILE_ID;
  try {
    const requestedActive = normalizeProfileId(config?.activeProfileId);
    if (cleanProfiles.some((profile) => profile.id === requestedActive)) {
      active = requestedActive;
    }
  } catch (_) {
    // Invalid and orphaned active ids fall back to the known-safe default.
  }

  return { profiles: cleanProfiles, activeProfileId: active };
}

function discoverProfileDirectories() {
  const root = getProfilesRoot();
  ensureDirectory(root);
  const discovered = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    console.warn("[profile-manager] Failed to inspect profile directories", error);
    return discovered;
  }
  for (const entry of entries) {
    if (!entry?.isDirectory?.() || entry.name.startsWith(QUARANTINE_PREFIX)) {
      continue;
    }
    let id;
    try {
      id = normalizeProfileId(entry.name);
      const profilePath = path.join(root, id);
      const stats = fs.lstatSync(profilePath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    } catch (_) {
      continue;
    }
    discovered.push({
      id,
      name: id === DEFAULT_PROFILE_ID ? DEFAULT_PROFILE_NAME : id,
    });
    if (discovered.length >= MAX_PROFILES) break;
  }
  return discovered;
}

function resolveContainedProfilePath(profileId) {
  const id = normalizeProfileId(profileId);
  const root = path.resolve(getProfilesRoot());
  const resolved = path.resolve(root, id);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Profile path for '${id}' escapes the profiles directory`);
  }
  return { id, root, resolved };
}

function ensureContainedProfileDirectory(profileId) {
  const target = resolveContainedProfilePath(profileId);
  ensureDirectory(target.root);
  try {
    const existing = fs.lstatSync(target.resolved);
    if (existing.isSymbolicLink()) {
      throw new Error(`Profile directory '${target.id}' must not be a symbolic link`);
    }
    if (!existing.isDirectory()) {
      throw new Error(`Profile path '${target.id}' is not a directory`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.mkdirSync(target.resolved, { mode: 0o700 });
  }

  const canonicalRoot = fs.realpathSync(target.root);
  const canonicalProfilePath = fs.realpathSync(target.resolved);
  const canonicalRelative = path.relative(canonicalRoot, canonicalProfilePath);
  if (
    !canonicalRelative ||
    canonicalRelative === ".." ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(`Profile path for '${target.id}' escapes the profiles directory`);
  }
  return target.resolved;
}

function quarantinePrefixFor(profileId) {
  return `${QUARANTINE_PREFIX}${normalizeProfileId(profileId)}-`;
}

function createQuarantinePath(profileId) {
  const { root } = resolveContainedProfilePath(profileId);
  return path.join(
    root,
    `${quarantinePrefixFor(profileId)}${crypto.randomBytes(8).toString("hex")}`
  );
}

function listQuarantines(profileId) {
  const { root } = resolveContainedProfilePath(profileId);
  const prefix = quarantinePrefixFor(profileId);
  try {
    return fs.readdirSync(root)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => path.join(root, entry));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function stageProfileDirectory(profileId) {
  const target = resolveContainedProfilePath(profileId);
  ensureDirectory(target.root);
  try {
    fs.lstatSync(target.resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const quarantinePath = createQuarantinePath(target.id);
  fs.renameSync(target.resolved, quarantinePath);
  fsyncDirectoryBestEffort(target.root);
  return {
    id: target.id,
    root: target.root,
    originalPath: target.resolved,
    quarantinePath,
  };
}

function restoreStagedProfileDirectory(staged) {
  if (!staged) return;
  fs.renameSync(staged.quarantinePath, staged.originalPath);
  fsyncDirectoryBestEffort(staged.root);
}

function removeStagedProfileDirectory(staged) {
  if (!staged) return false;
  fs.rmSync(staged.quarantinePath, { recursive: true, force: false });
  fsyncDirectoryBestEffort(staged.root);
  return true;
}

function recoverQuarantinedDirectories(config) {
  const root = getProfilesRoot();
  ensureDirectory(root);
  const catalogIds = new Set(config.profiles.map((profile) => profile.id));
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (error) {
    console.warn("[profile-manager] Failed to inspect profile quarantine", error);
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(QUARANTINE_PREFIX)) continue;
    const match = /^\.profile-delete-(.+)-([a-f0-9]{16})$/.exec(entry);
    if (!match) continue;
    let id;
    try {
      id = normalizeProfileId(match[1]);
    } catch (_) {
      continue;
    }
    const quarantinePath = path.join(root, entry);
    const originalPath = resolveContainedProfilePath(id).resolved;
    try {
      if (catalogIds.has(id) && !fs.existsSync(originalPath)) {
        fs.renameSync(quarantinePath, originalPath);
      } else if (!catalogIds.has(id)) {
        fs.rmSync(quarantinePath, { recursive: true, force: false });
      }
    } catch (error) {
      console.warn(`[profile-manager] Failed to recover quarantined profile '${id}'`, error);
    }
  }
  fsyncDirectoryBestEffort(root);
}

function commitState(nextState) {
  writeConfigToDisk(nextState);
  state = nextState;
  return state;
}

function ensureInitialised() {
  if (state) {
    return state;
  }
  const configFromDisk = loadConfigFromDisk();
  const recoverableConfig = configFromDisk || {
    profiles: discoverProfileDirectories(),
    activeProfileId: DEFAULT_PROFILE_ID,
  };
  const initialState = ensureDefaultProfile(recoverableConfig);
  ensureDirectory(getProfilesRoot());
  recoverQuarantinedDirectories(initialState);
  initialState.profiles.forEach((profile) => {
    ensureContainedProfileDirectory(profile.id);
  });
  commitState(initialState);
  return state;
}

function initializeProfileManager(customBasePath = null) {
  if (customBasePath !== null && customBasePath !== undefined) {
    if (typeof customBasePath !== "string" || !customBasePath.trim()) {
      throw new Error("A valid userData path is required");
    }
    const nextBasePath = path.resolve(customBasePath.trim());
    if (baseUserDataPath && baseUserDataPath !== nextBasePath) {
      state = null;
    }
    baseUserDataPath = nextBasePath;
  }
  ensureDirectory(getProfilesRoot());
  return ensureInitialised();
}

function getUserDataPath() {
  return resolveAppUserDataPath();
}

function getActiveProfile() {
  const currentState = ensureInitialised();
  return currentState.activeProfileId;
}

function listProfiles() {
  const currentState = ensureInitialised();
  return currentState.profiles.map((profile) => ({ ...profile }));
}

function resolveProfilePath(profileId) {
  const id = profileId === null || profileId === undefined
    ? getActiveProfile()
    : normalizeProfileId(profileId);
  return ensureContainedProfileDirectory(id);
}

function setActiveProfile(profileId) {
  const id = normalizeProfileId(profileId);
  const currentState = ensureInitialised();
  const exists = currentState.profiles.find((profile) => profile.id === id);
  if (!exists) {
    throw new Error(`Profile '${id}' does not exist`);
  }
  if (currentState.activeProfileId === id) {
    return currentState.activeProfileId;
  }
  ensureContainedProfileDirectory(id);
  commitState({
    profiles: currentState.profiles.map((profile) => ({ ...profile })),
    activeProfileId: id,
  });
  return state.activeProfileId;
}

function makeProfileId(name, profiles) {
  const slug = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  if (slug) {
    const existing = new Set(profiles.map((profile) => profile.id));
    let counter = 1;
    while (counter < Number.MAX_SAFE_INTEGER) {
      const suffix = counter === 1 ? "" : `-${counter}`;
      const baseLength = MAX_PROFILE_ID_LENGTH - suffix.length;
      const boundedBase = slug.slice(0, baseLength).replace(/-+$/g, "") || "profile";
      const candidate = `${boundedBase}${suffix}`;
      if (!existing.has(candidate)) return normalizeProfileId(candidate);
      counter += 1;
    }
  }
  return normalizeProfileId(`profile-${crypto.randomUUID()}`);
}

function createProfile(name) {
  const currentState = ensureInitialised();
  if (currentState.profiles.length >= MAX_PROFILES) {
    throw new Error(`A maximum of ${MAX_PROFILES} profiles is supported`);
  }
  const trimmedName = normalizeRequestedProfileName(name);
  const id = makeProfileId(trimmedName || "profile", currentState.profiles);
  const profileName = trimmedName || `Profile ${currentState.profiles.length + 1}`;
  const newProfile = { id, name: profileName };
  const target = resolveContainedProfilePath(id);
  const directoryExisted = fs.existsSync(target.resolved);
  ensureContainedProfileDirectory(id);
  try {
    commitState({
      profiles: [...currentState.profiles.map((profile) => ({ ...profile })), newProfile],
      activeProfileId: currentState.activeProfileId,
    });
  } catch (error) {
    // No profile work can enter this newly created directory before the
    // synchronous catalog commit. Remove it when that commit fails, but never
    // touch a pre-existing directory that may contain recoverable user data.
    if (!directoryExisted) {
      try {
        fs.rmdirSync(target.resolved);
        fsyncDirectoryBestEffort(target.root);
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
        console.warn(
          `[profile-manager] Failed to remove uncommitted profile directory '${id}'`,
          cleanupError
        );
      }
    }
    throw error;
  }
  return { ...newProfile };
}

function renameProfile(profileId, newName) {
  const id = normalizeProfileId(profileId);
  const name = normalizeRequestedProfileName(newName, { required: true });
  const currentState = ensureInitialised();
  const entry = currentState.profiles.find((profile) => profile.id === id);
  if (!entry) {
    throw new Error(`Profile '${id}' does not exist`);
  }
  const profiles = currentState.profiles.map((profile) =>
    profile.id === id ? { ...profile, name } : { ...profile }
  );
  commitState({ profiles, activeProfileId: currentState.activeProfileId });
  return { ...profiles.find((profile) => profile.id === id) };
}

function deleteProfile(profileId, options = {}) {
  const id = normalizeProfileId(profileId);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Profile deletion options must be an object");
  }
  const removeFiles = options.removeFiles !== false;
  const currentState = ensureInitialised();
  if (currentState.profiles.length <= 1) {
    throw new Error("Cannot delete the last remaining profile");
  }

  const index = currentState.profiles.findIndex((profile) => profile.id === id);
  if (index === -1) {
    throw new Error(`Profile '${id}' does not exist`);
  }
  if (removeFiles && currentState.activeProfileId === id) {
    throw new Error("Switch away from the active profile before deleting its files");
  }

  const removed = { ...currentState.profiles[index] };
  const profiles = currentState.profiles
    .filter((profile) => profile.id !== id)
    .map((profile) => ({ ...profile }));
  const activeProfileId = currentState.activeProfileId === id
    ? profiles[0].id
    : currentState.activeProfileId;
  const nextState = { profiles, activeProfileId };
  const staged = removeFiles ? stageProfileDirectory(id) : null;

  try {
    writeConfigToDisk(nextState);
  } catch (error) {
    if (staged) {
      try {
        restoreStagedProfileDirectory(staged);
      } catch (restoreError) {
        const combined = new Error(
          `Failed to persist profile deletion and restore its directory: ${restoreError.message}`
        );
        combined.code = "PROFILE_DELETE_ROLLBACK_FAILED";
        combined.cause = error;
        combined.restoreError = restoreError;
        throw combined;
      }
    }
    throw error;
  }

  state = nextState;
  if (staged) {
    try {
      removeStagedProfileDirectory(staged);
    } catch (error) {
      const cleanupError = new Error(
        `Profile was deleted, but its quarantined directory could not be removed: ${error.message}`
      );
      cleanupError.code = "PROFILE_DIRECTORY_CLEANUP_FAILED";
      cleanupError.cause = error;
      cleanupError.profileDeleted = true;
      cleanupError.quarantinePath = staged.quarantinePath;
      console.warn("[profile-manager] Profile directory cleanup failed", cleanupError);
      throw cleanupError;
    }
  }
  return removed;
}

function removeProfileDirectory(profileId) {
  const id = normalizeProfileId(profileId);
  const currentState = ensureInitialised();
  if (currentState.profiles.some((profile) => profile.id === id)) {
    throw new Error("Remove the profile from the catalog before deleting its directory");
  }

  let removed = false;
  const staged = stageProfileDirectory(id);
  if (staged) {
    removeStagedProfileDirectory(staged);
    removed = true;
  }
  for (const quarantinePath of listQuarantines(id)) {
    fs.rmSync(quarantinePath, { recursive: true, force: false });
    removed = true;
  }
  fsyncDirectoryBestEffort(getProfilesRoot());
  return removed;
}

function resetForTests() {
  state = null;
  baseUserDataPath = null;
}

module.exports = {
  initializeProfileManager,
  getActiveProfile,
  setActiveProfile,
  listProfiles,
  resolveProfilePath,
  createProfile,
  renameProfile,
  deleteProfile,
  removeProfileDirectory,
  resetForTests,
  getUserDataPath,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  MAX_PROFILES,
  MAX_PROFILE_ID_LENGTH,
  MAX_CONFIG_BYTES,
};
