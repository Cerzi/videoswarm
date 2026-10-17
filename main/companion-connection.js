const dns = require("dns");
const net = require("net");

// Companion app connections, per profile (docs/architecture/companion-app.md).
// None by default. A companion is another program on this machine that
// describes clips and accepts them for work; Video Swarm only shows what it
// says. A profile can connect up to four, each with a short id (`c1`…`c4`)
// that filters and saved views name it by, so changing its address keeps
// them. Only loopback addresses are accepted, and the host name is checked
// again when it resolves, so Video Swarm never reaches beyond this machine.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_URL_LENGTH = 256;

const DEFAULT_COMPANION_CONNECTION = Object.freeze({ enabled: false, url: null });
const MAX_COMPANIONS = 4;
const COMPANION_ID = /^c[1-9]$/u;

class CompanionConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CompanionConnectionError";
    this.code = code;
  }
}

// The origin of a loopback URL (`http://127.0.0.1:8000`), or throws.
function parseCompanionUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw new CompanionConnectionError(
      "COMPANION_URL_INVALID",
      "Enter the companion app's address, for example http://127.0.0.1:8000"
    );
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CompanionConnectionError("COMPANION_URL_INVALID", "The address is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CompanionConnectionError(
      "COMPANION_URL_INVALID",
      "The address must start with http:// or https://"
    );
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new CompanionConnectionError(
      "COMPANION_URL_NOT_LOOPBACK",
      "Only an app on this computer can be used: localhost, 127.0.0.1 or [::1]"
    );
  }
  if (
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new CompanionConnectionError(
      "COMPANION_URL_INVALID",
      "The address must be only a host and port"
    );
  }
  return url.origin;
}

// Loopback addresses as the resolver returns them. `localhost` is resolved
// by the system, and a hosts file could point it elsewhere.
function isLoopbackAddress(address) {
  if (net.isIPv4(address)) return address.startsWith("127.");
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("::ffff:127.");
  }
  return false;
}

function loopbackLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: false }, (error, address, family) => {
    if (error) return callback(error);
    if (!isLoopbackAddress(address)) {
      return callback(
        new CompanionConnectionError(
          "COMPANION_URL_NOT_LOOPBACK",
          `${hostname} does not resolve to this computer`
        )
      );
    }
    return callback(null, address, family);
  });
}

// The stored setting, made safe: anything unusable turns the connection off.
function normalizeCompanionConnection(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  let url = null;
  try {
    url = source.url ? parseCompanionUrl(source.url) : null;
  } catch {
    url = null;
  }
  return { enabled: source.enabled === true && Boolean(url), url };
}

// A connection change from the user. An address is needed to switch it on.
function validateCompanionConnection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CompanionConnectionError("COMPANION_SETTING_INVALID", "Expected a connection setting");
  }
  const hasUrl = typeof input.url === "string" && input.url.trim() !== "";
  const url = hasUrl ? parseCompanionUrl(input.url) : null;
  const enabled = input.enabled === true;
  if (enabled && !url) {
    throw new CompanionConnectionError(
      "COMPANION_URL_INVALID",
      "Enter the companion app's address to connect"
    );
  }
  return { enabled, url };
}

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function nextCompanionId(taken) {
  for (let number = 1; number <= 9; number += 1) {
    if (!taken.has(`c${number}`)) return `c${number}`;
  }
  return null;
}

/**
 * The stored list, made safe: at most four, unique ids and addresses, and an
 * entry without a usable address dropped. A profile saved before the list
 * existed has its single connection as the first entry, `c1`.
 */
function normalizeCompanionConnections(raw, legacy = null) {
  const source = Array.isArray(raw)
    ? raw
    : isPlainObject(legacy)
      ? [{ ...legacy, id: "c1" }]
      : [];
  const result = [];
  const ids = new Set();
  const urls = new Set();
  for (const entry of source) {
    if (result.length >= MAX_COMPANIONS) break;
    if (!isPlainObject(entry)) continue;
    const { url } = normalizeCompanionConnection({ ...entry, enabled: true });
    if (!url || urls.has(url)) continue;
    const id =
      COMPANION_ID.test(entry.id) && !ids.has(entry.id) ? entry.id : nextCompanionId(ids);
    if (!id) continue;
    ids.add(id);
    urls.add(url);
    result.push({ id, enabled: entry.enabled === true, url });
  }
  return result;
}

/**
 * The list as the user changed it. Every entry needs an address; one listed
 * twice, or more than four, is refused. A new entry gets the first free id.
 */
function validateCompanionConnections(input) {
  if (!Array.isArray(input)) {
    throw new CompanionConnectionError("COMPANION_SETTING_INVALID", "Expected a list of companion apps");
  }
  if (input.length > MAX_COMPANIONS) {
    throw new CompanionConnectionError(
      "COMPANION_SETTING_INVALID",
      `Up to ${MAX_COMPANIONS} companion apps can be connected`
    );
  }
  const declared = input
    .filter((entry) => isPlainObject(entry) && COMPANION_ID.test(entry.id))
    .map((entry) => entry.id);
  const ids = new Set(declared);
  if (ids.size !== declared.length) {
    throw new CompanionConnectionError("COMPANION_SETTING_INVALID", "Two companion apps share an id");
  }
  const urls = new Set();
  return input.map((entry) => {
    const { enabled, url } = validateCompanionConnection(entry);
    if (!url) {
      throw new CompanionConnectionError(
        "COMPANION_URL_INVALID",
        "Enter each companion app's address"
      );
    }
    if (urls.has(url)) {
      throw new CompanionConnectionError(
        "COMPANION_SETTING_INVALID",
        `${url} is listed twice`
      );
    }
    urls.add(url);
    let id = COMPANION_ID.test(entry.id) ? entry.id : null;
    if (!id) {
      id = nextCompanionId(ids);
      ids.add(id);
    }
    return { id, enabled, url };
  });
}

const isCompanionId = (value) => typeof value === "string" && COMPANION_ID.test(value);

module.exports = {
  CompanionConnectionError,
  DEFAULT_COMPANION_CONNECTION,
  MAX_COMPANIONS,
  isCompanionId,
  normalizeCompanionConnections,
  validateCompanionConnections,
  isLoopbackAddress,
  loopbackLookup,
  normalizeCompanionConnection,
  parseCompanionUrl,
  validateCompanionConnection,
};
