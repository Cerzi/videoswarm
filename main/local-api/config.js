const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeFileAtomically } = require("../settings-writer");

// The local read API's one file (docs/architecture/local-read-api.md): the
// switch, the port and the token, in Video Swarm's data folder beside
// `profiles/`, the same for every profile, readable by the user only. Apps
// that read the API find the port and token here.

const LOCAL_API_FILE = "local-api.json";
const DEFAULT_LOCAL_API_PORT = 47821;
const MAX_CONFIG_BYTES = 4 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

class LocalApiConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LocalApiConfigError";
    this.code = "LOCAL_API_SETTING_INVALID";
  }
}

const newLocalApiToken = () => crypto.randomBytes(32).toString("base64url");

const isPort = (value) => Number.isInteger(value) && value >= 1024 && value <= 65535;

/** The stored file, made safe: anything unusable reads as off on the default port. */
function normalizeLocalApiConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const token = typeof source.token === "string" && TOKEN_PATTERN.test(source.token) ? source.token : null;
  return {
    version: 1,
    enabled: source.enabled === true && Boolean(token),
    port: isPort(source.port) ? source.port : DEFAULT_LOCAL_API_PORT,
    token,
    // Apps may follow saved views (view-feeds.md): its own switch, off by
    // default, since it lists paths.
    feeds: source.feeds === true,
  };
}

/**
 * A change from Preferences: on or off, a port from 1024 to 65535, and
 * whether apps may follow saved views (kept as it was when not given).
 */
function validateLocalApiChange(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocalApiConfigError("Expected a local API setting");
  }
  const port = Number(input.port);
  if (!isPort(port)) throw new LocalApiConfigError("The port must be a whole number from 1024 to 65535");
  const change = { enabled: input.enabled === true, port };
  if (input.feeds !== undefined) change.feeds = input.feeds === true;
  return change;
}

function localApiConfigPath(dataDir) {
  return path.join(dataDir, LOCAL_API_FILE);
}

async function readLocalApiConfig(dataDir, { fsApi = fs.promises } = {}) {
  try {
    const raw = await fsApi.readFile(localApiConfigPath(dataDir), "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) return normalizeLocalApiConfig(null);
    return normalizeLocalApiConfig(JSON.parse(raw));
  } catch {
    return normalizeLocalApiConfig(null);
  }
}

async function writeLocalApiConfig(dataDir, config, { fsApi = fs.promises } = {}) {
  const value = normalizeLocalApiConfig(config);
  const filePath = localApiConfigPath(dataDir);
  await writeFileAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`, { fsApi });
  // The writer creates the file 0600; keep it so if it already existed.
  await fsApi.chmod?.(filePath, 0o600).catch?.(() => {});
  return value;
}

module.exports = {
  DEFAULT_LOCAL_API_PORT,
  LOCAL_API_FILE,
  LocalApiConfigError,
  localApiConfigPath,
  newLocalApiToken,
  normalizeLocalApiConfig,
  readLocalApiConfig,
  validateLocalApiChange,
  writeLocalApiConfig,
};
