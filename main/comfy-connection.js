const net = require('net');

// The ComfyUI address setting, per profile: where a clip's embedded workflow
// opens (docs/architecture/comfy-workflow-window.md). Only a loopback
// address is accepted, never another host, so Video Swarm never reaches the
// network beyond this machine.

const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_URL_LENGTH = 256;

const DEFAULT_COMFY_CONNECTION = Object.freeze({ url: DEFAULT_COMFY_URL });

class ComfyConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComfyConnectionError';
    this.code = code;
  }
}

// The origin of a loopback ComfyUI URL (`http://127.0.0.1:8188`), or throws.
function parseComfyUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_URL_LENGTH) {
    throw new ComfyConnectionError('COMFY_URL_INVALID', 'Enter the ComfyUI address, for example http://127.0.0.1:8188');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ComfyConnectionError('COMFY_URL_INVALID', 'The ComfyUI address is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ComfyConnectionError('COMFY_URL_INVALID', 'The ComfyUI address must start with http:// or https://');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ComfyConnectionError(
      'COMFY_URL_NOT_LOOPBACK',
      'Only a ComfyUI on this computer can be used: localhost, 127.0.0.1 or [::1]'
    );
  }
  if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new ComfyConnectionError('COMFY_URL_INVALID', 'The ComfyUI address must be only a host and port');
  }
  return url.origin;
}

// Loopback addresses as the resolver returns them. `localhost` is resolved
// by the system, and a hosts file could point it elsewhere.
function isLoopbackAddress(address) {
  if (net.isIPv4(address)) return address.startsWith('127.');
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower.startsWith('::ffff:127.');
  }
  return false;
}

// The stored setting, made safe: an unusable address falls back to the
// default. Fields from the removed re-render queue are dropped.
function normalizeComfyConnection(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (source.url === undefined) return { url: DEFAULT_COMFY_URL };
  try {
    return { url: parseComfyUrl(source.url) };
  } catch {
    return { url: DEFAULT_COMFY_URL };
  }
}

// Validate an address change from the user.
// @returns the normalized setting, or throws ComfyConnectionError
function validateComfyConnection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ComfyConnectionError('COMFY_SETTING_INVALID', 'Expected a connection setting');
  }
  return { url: parseComfyUrl(input.url ?? DEFAULT_COMFY_URL) };
}

module.exports = {
  ComfyConnectionError,
  DEFAULT_COMFY_CONNECTION,
  DEFAULT_COMFY_URL,
  isLoopbackAddress,
  normalizeComfyConnection,
  parseComfyUrl,
  validateComfyConnection,
};
