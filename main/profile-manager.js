const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG_FILE_NAME = "profiles.json";
const PROFILES_DIR_NAME = "profiles";
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_NAME = "Default";

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
      baseUserDataPath = app.getPath("userData");
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
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
}

function loadConfigFromDisk() {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
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
  ensureDirectory(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function normaliseProfileEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const id = typeof entry.id === "string" && entry.id.trim().length > 0
    ? entry.id.trim()
    : null;
  if (!id) return null;
  const name = typeof entry.name === "string" && entry.name.trim().length > 0
    ? entry.name.trim()
    : id;
  return { id, name };
}

function ensureDefaultProfile(config) {
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  let cleanProfiles = profiles
    .map(normaliseProfileEntry)
    .filter(Boolean);

  if (!cleanProfiles.find((p) => p.id === DEFAULT_PROFILE_ID)) {
    cleanProfiles.unshift({ id: DEFAULT_PROFILE_ID, name: DEFAULT_PROFILE_NAME });
  }

  const active =
    typeof config?.activeProfileId === "string" && config.activeProfileId.trim().length > 0
      ? config.activeProfileId.trim()
      : DEFAULT_PROFILE_ID;

  if (!cleanProfiles.find((p) => p.id === active)) {
    cleanProfiles.unshift({ id: active, name: active });
  }

  return {
    profiles: cleanProfiles,
    activeProfileId: cleanProfiles.find((p) => p.id === active)?.id || DEFAULT_PROFILE_ID,
  };
}

function persistState() {
  if (!state) return;
  writeConfigToDisk(state);
}

function ensureInitialised() {
  if (state) {
    return state;
  }
  const configFromDisk = loadConfigFromDisk();
  const initialState = ensureDefaultProfile(configFromDisk || {});
  ensureDirectory(getProfilesRoot());
  initialState.profiles.forEach((profile) => {
    ensureDirectory(resolveProfilePath(profile.id));
  });
  state = initialState;
  persistState();
  return state;
}

function initializeProfileManager(customBasePath = null) {
  if (customBasePath) {
    baseUserDataPath = customBasePath;
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
  const id = typeof profileId === "string" && profileId.trim().length > 0
    ? profileId.trim()
    : getActiveProfile();
  const base = getProfilesRoot();
  const resolved = path.join(base, id);
  ensureDirectory(resolved);
  return resolved;
}

function setActiveProfile(profileId) {
  const id = typeof profileId === "string" ? profileId.trim() : "";
  if (!id) {
    throw new Error("Profile id must be a non-empty string");
  }
  const currentState = ensureInitialised();
  const exists = currentState.profiles.find((profile) => profile.id === id);
  if (!exists) {
    throw new Error(`Profile '${id}' does not exist`);
  }
  if (currentState.activeProfileId === id) {
    return currentState.activeProfileId;
  }
  currentState.activeProfileId = id;
  ensureDirectory(resolveProfilePath(id));
  persistState();
  return currentState.activeProfileId;
}

function makeProfileId(name) {
  const base = (name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  if (base) {
    let candidate = base;
    let counter = 1;
    const existing = new Set(listProfiles().map((p) => p.id));
    while (existing.has(candidate)) {
      counter += 1;
      candidate = `${base}-${counter}`;
    }
    return candidate;
  }
  return `profile-${crypto.randomUUID()}`;
}

function createProfile(name) {
  const currentState = ensureInitialised();
  const trimmedName = typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  const id = makeProfileId(trimmedName || "profile");
  const profileName = trimmedName || `Profile ${currentState.profiles.length + 1}`;
  const newProfile = { id, name: profileName };
  currentState.profiles.push(newProfile);
  ensureDirectory(resolveProfilePath(id));
  persistState();
  return { ...newProfile };
}

function renameProfile(profileId, newName) {
  const id = typeof profileId === "string" ? profileId.trim() : "";
  if (!id) {
    throw new Error("Profile id must be provided");
  }
  const name = typeof newName === "string" ? newName.trim() : "";
  if (!name) {
    throw new Error("Profile name must be provided");
  }
  const currentState = ensureInitialised();
  const entry = currentState.profiles.find((profile) => profile.id === id);
  if (!entry) {
    throw new Error(`Profile '${id}' does not exist`);
  }
  entry.name = name;
  persistState();
  return { ...entry };
}

function deleteProfile(profileId) {
  const id = typeof profileId === "string" ? profileId.trim() : "";
  if (!id) {
    throw new Error("Profile id must be provided");
  }
  const currentState = ensureInitialised();
  if (id === DEFAULT_PROFILE_ID && currentState.profiles.length === 1) {
    throw new Error("Cannot delete the last remaining profile");
  }

  const index = currentState.profiles.findIndex((profile) => profile.id === id);
  if (index === -1) {
    throw new Error(`Profile '${id}' does not exist`);
  }

  const [removed] = currentState.profiles.splice(index, 1);
  if (currentState.activeProfileId === id) {
    const fallback = currentState.profiles[0] || { id: DEFAULT_PROFILE_ID };
    currentState.activeProfileId = fallback.id;
  }
  persistState();

  const profilePath = path.join(getProfilesRoot(), id);
  try {
    if (fs.existsSync(profilePath)) {
      fs.rmSync(profilePath, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn("[profile-manager] Failed to delete profile directory", error);
  }
  return removed ? { ...removed } : null;
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
  resetForTests,
  getUserDataPath,
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
};
