const fs = require('fs');
const net = require('net');
const path = require('path');

// The ComfyUI connection setting, per profile. Off by default; when on, only a
// loopback address is accepted, never another host, so Video Swarm never
// reaches the network beyond this machine. The output directory is where
// ComfyUI saves, needed to put a final beside its draft.
// See docs/architecture/comfy-queue-integration.md, Section 7.

const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_URL_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;

const DEFAULT_COMFY_CONNECTION = Object.freeze({
  enabled: false,
  url: DEFAULT_COMFY_URL,
  outputDir: null,
});

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

// The stored setting, made safe: anything unusable turns the connection off.
function normalizeComfyConnection(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let url = DEFAULT_COMFY_URL;
  let urlValid = true;
  if (source.url !== undefined) {
    try {
      url = parseComfyUrl(source.url);
    } catch {
      urlValid = false;
    }
  }
  const outputDir =
    typeof source.outputDir === 'string' &&
    source.outputDir.length <= MAX_PATH_LENGTH &&
    path.isAbsolute(source.outputDir)
      ? path.normalize(source.outputDir)
      : null;
  return { enabled: source.enabled === true && urlValid, url, outputDir };
}

// Validate a connection change from the user: the address must be loopback
// and the output directory must exist.
// @returns the normalized setting, or throws ComfyConnectionError
async function validateComfyConnection(input, { fsPromises = fs.promises } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ComfyConnectionError('COMFY_SETTING_INVALID', 'Expected a connection setting');
  }
  const url = parseComfyUrl(input.url ?? DEFAULT_COMFY_URL);
  let outputDir = null;
  if (input.outputDir !== undefined && input.outputDir !== null && input.outputDir !== '') {
    if (typeof input.outputDir !== 'string' || input.outputDir.length > MAX_PATH_LENGTH || !path.isAbsolute(input.outputDir)) {
      throw new ComfyConnectionError('COMFY_OUTPUT_DIR_INVALID', "ComfyUI's output folder must be an absolute path");
    }
    let stats;
    try {
      outputDir = await fsPromises.realpath(input.outputDir);
      stats = await fsPromises.stat(outputDir);
    } catch {
      throw new ComfyConnectionError('COMFY_OUTPUT_DIR_MISSING', `No folder at ${input.outputDir}`);
    }
    if (!stats.isDirectory()) {
      throw new ComfyConnectionError('COMFY_OUTPUT_DIR_MISSING', `${input.outputDir} is not a folder`);
    }
  }
  const enabled = input.enabled === true;
  if (enabled && !outputDir) {
    throw new ComfyConnectionError(
      'COMFY_OUTPUT_DIR_REQUIRED',
      "Choose ComfyUI's output folder, so finals can be saved beside their drafts"
    );
  }
  return { enabled, url, outputDir };
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
