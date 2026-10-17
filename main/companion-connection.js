const dns = require("dns");
const net = require("net");

// The companion app connection, per profile (docs/architecture/companion-app.md).
// Off by default. A companion is another program on this machine that
// describes clips and accepts them for work; Video Swarm only shows what it
// says. Only a loopback address is accepted, and the host name is checked
// again when it resolves, so Video Swarm never reaches beyond this machine.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_URL_LENGTH = 256;

const DEFAULT_COMPANION_CONNECTION = Object.freeze({ enabled: false, url: null });

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

module.exports = {
  CompanionConnectionError,
  DEFAULT_COMPANION_CONNECTION,
  isLoopbackAddress,
  loopbackLookup,
  normalizeCompanionConnection,
  parseCompanionUrl,
  validateCompanionConnection,
};
