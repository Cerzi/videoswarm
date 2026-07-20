const fs = require("fs");
const path = require("path");

const IPC_LIMITS = Object.freeze({
  maxArrayEntries: 20_000,
  maxClipboardBytes: 1024 * 1024,
  maxImageDataUrlBytes: 32 * 1024 * 1024,
  maxPathChars: 32 * 1024,
  maxPayloadBytes: 4 * 1024 * 1024,
  maxShortStringChars: 256,
});
const CLIPBOARD_IMAGE_LIMITS = Object.freeze({
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 32 * 1024 * 1024,
});
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

class IpcSecurityError extends Error {
  constructor(message, code = "IPC_SECURITY_ERROR") {
    super(message);
    this.name = "IpcSecurityError";
    this.code = code;
  }
}

function resolveOptionList(value) {
  const resolved = typeof value === "function" ? value() : value;
  return Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
}

function normalizedUrl(value) {
  const url = new URL(String(value || ""));
  url.hash = "";
  url.search = "";
  return url.href;
}

function isAllowedFrameUrl(frameUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(String(frameUrl || ""));
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;

  const allowedUrls = resolveOptionList(options.allowedFrameUrls);
  for (const candidate of allowedUrls) {
    try {
      if (normalizedUrl(parsed.href) === normalizedUrl(candidate)) return true;
    } catch {
      // Ignore a malformed configuration entry rather than trusting it.
    }
  }

  const allowedOrigins = resolveOptionList(options.allowedOrigins);
  return allowedOrigins.some((origin) => {
    try {
      const candidate = new URL(String(origin));
      return (
        candidate.protocol !== "file:" &&
        parsed.origin !== "null" &&
        parsed.origin === candidate.origin
      );
    } catch {
      return false;
    }
  });
}

function createIpcTrustValidator(options = {}) {
  const { getMainWindow } = options;
  if (typeof getMainWindow !== "function") {
    throw new TypeError("createIpcTrustValidator requires getMainWindow");
  }

  return function assertTrustedSender(event) {
    const win = getMainWindow();
    const expectedSender = win && !win.isDestroyed?.() ? win.webContents : null;
    const sender = event?.sender;
    const senderFrame = event?.senderFrame;

    if (
      !expectedSender ||
      !sender ||
      sender !== expectedSender ||
      sender.isDestroyed?.()
    ) {
      throw new IpcSecurityError("IPC sender is not the active application window", "UNTRUSTED_SENDER");
    }
    if (!senderFrame || senderFrame !== sender.mainFrame) {
      throw new IpcSecurityError("IPC is only accepted from the main frame", "UNTRUSTED_FRAME");
    }
    if (!isAllowedFrameUrl(senderFrame.url, options)) {
      throw new IpcSecurityError("IPC frame URL is not authorized", "UNTRUSTED_ORIGIN");
    }

    return Object.freeze({
      sender,
      senderFrame,
      senderId: sender.id,
      frameUrl: senderFrame.url,
    });
  };
}

function createTrustedIpcRegistrar({ ipcMain, assertTrustedSender, logger = console }) {
  if (!ipcMain?.handle || !ipcMain?.on) {
    throw new TypeError("createTrustedIpcRegistrar requires ipcMain");
  }
  if (typeof assertTrustedSender !== "function") {
    throw new TypeError("A sender trust validator is required");
  }

  const registeredHandles = new Set();
  const registeredListeners = new Map();

  function handle(channel, listener, options = {}) {
    if (typeof channel !== "string" || !channel) {
      throw new TypeError("IPC channel is required");
    }
    if (typeof listener !== "function") {
      throw new TypeError(`IPC listener for '${channel}' must be a function`);
    }
    if (registeredHandles.has(channel)) {
      throw new Error(`IPC handler '${channel}' is already registered`);
    }

    const trustContext = Object.freeze({ channel });
    const wrapped = async (event, ...args) => {
      const context = assertTrustedSender(event, trustContext);
      if (options.maxPayloadBytes !== null) {
        assertPayloadSize(
          args,
          options.maxPayloadBytes ?? IPC_LIMITS.maxPayloadBytes
        );
      }
      const validatedArgs = options.validate
        ? await options.validate(args, context)
        : args;
      if (!Array.isArray(validatedArgs)) {
        throw new TypeError(`IPC validator for '${channel}' must return an argument array`);
      }
      return listener(event, ...validatedArgs);
    };
    ipcMain.handle(channel, wrapped);
    registeredHandles.add(channel);
    return wrapped;
  }

  function on(channel, listener, options = {}) {
    if (typeof channel !== "string" || !channel) {
      throw new TypeError("IPC channel is required");
    }
    if (typeof listener !== "function") {
      throw new TypeError(`IPC listener for '${channel}' must be a function`);
    }

    const trustContext = Object.freeze({ channel });
    const wrapped = async (event, ...args) => {
      try {
        const context = assertTrustedSender(event, trustContext);
        if (options.maxPayloadBytes !== null) {
          assertPayloadSize(
            args,
            options.maxPayloadBytes ?? IPC_LIMITS.maxPayloadBytes
          );
        }
        const validatedArgs = options.validate
          ? await options.validate(args, context)
          : args;
        if (!Array.isArray(validatedArgs)) {
          throw new TypeError(`IPC validator for '${channel}' must return an argument array`);
        }
        await listener(event, ...validatedArgs);
      } catch (error) {
        if (typeof options.onError === "function") {
          options.onError(error, event);
        } else {
          logger?.warn?.(`[ipc-security] Rejected event on '${channel}'`, {
            code: error?.code || "IPC_EVENT_ERROR",
            message: error?.message || String(error),
          });
        }
      }
    };
    ipcMain.on(channel, wrapped);
    const listeners = registeredListeners.get(channel) || new Set();
    listeners.add(wrapped);
    registeredListeners.set(channel, listeners);
    return wrapped;
  }

  function dispose() {
    for (const channel of registeredHandles) {
      ipcMain.removeHandler?.(channel);
    }
    for (const [channel, listeners] of registeredListeners) {
      for (const listener of listeners) ipcMain.removeListener?.(channel, listener);
    }
    registeredHandles.clear();
    registeredListeners.clear();
  }

  return { handle, on, dispose };
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function assertPlainObject(value, name = "payload") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IpcSecurityError(`${name} must be an object`, "INVALID_PAYLOAD");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new IpcSecurityError(`${name} must be a plain object`, "INVALID_PAYLOAD");
  }
  return value;
}

function assertPayloadSize(value, maxBytes = IPC_LIMITS.maxPayloadBytes) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new IpcSecurityError("Payload is not serializable", "INVALID_PAYLOAD");
  }
  if (serialized === undefined || byteLength(serialized) > maxBytes) {
    throw new IpcSecurityError("Payload exceeds the allowed size", "PAYLOAD_TOO_LARGE");
  }
  return value;
}

function assertString(value, options = {}) {
  const {
    name = "value",
    minChars = 0,
    maxChars = IPC_LIMITS.maxShortStringChars,
    trim = false,
    allowNul = false,
  } = options;
  if (typeof value !== "string") {
    throw new IpcSecurityError(`${name} must be a string`, "INVALID_PAYLOAD");
  }
  const result = trim ? value.trim() : value;
  if (
    result.length < minChars ||
    result.length > maxChars ||
    (!allowNul && result.includes("\0"))
  ) {
    throw new IpcSecurityError(`${name} is outside the allowed bounds`, "INVALID_PAYLOAD");
  }
  return result;
}

function assertBoolean(value, name = "value") {
  if (typeof value !== "boolean") {
    throw new IpcSecurityError(`${name} must be a boolean`, "INVALID_PAYLOAD");
  }
  return value;
}

function assertInteger(value, options = {}) {
  const { name = "value", min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = options;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new IpcSecurityError(`${name} must be a safe integer`, "INVALID_PAYLOAD");
  }
  return value;
}

function assertPathString(value, options = {}) {
  const candidate = assertString(value, {
    name: options.name || "path",
    minChars: 1,
    maxChars: options.maxChars || IPC_LIMITS.maxPathChars,
    trim: true,
  });
  if (options.absolute !== false && !path.isAbsolute(candidate)) {
    throw new IpcSecurityError(`${options.name || "path"} must be absolute`, "INVALID_PATH");
  }
  return path.resolve(candidate);
}

function assertStringArray(value, options = {}) {
  const {
    name = "values",
    minEntries = 0,
    maxEntries = IPC_LIMITS.maxArrayEntries,
    item = {},
    dedupe = true,
  } = options;
  if (!Array.isArray(value) || value.length < minEntries || value.length > maxEntries) {
    throw new IpcSecurityError(`${name} is outside the allowed bounds`, "INVALID_PAYLOAD");
  }
  const result = value.map((entry, index) =>
    assertString(entry, { ...item, name: `${name}[${index}]` })
  );
  return dedupe ? [...new Set(result)] : result;
}

function assertPngDataUrlDimensions(value, options = {}) {
  const maxWidth = options.maxWidth ?? CLIPBOARD_IMAGE_LIMITS.maxWidth;
  const maxHeight = options.maxHeight ?? CLIPBOARD_IMAGE_LIMITS.maxHeight;
  const maxPixels = options.maxPixels ?? CLIPBOARD_IMAGE_LIMITS.maxPixels;
  if (!value.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new IpcSecurityError(
      "Clipboard image must be a base64 PNG",
      "INVALID_IMAGE_DATA"
    );
  }

  // Width and height live in PNG's fixed IHDR prefix. Decode only that small
  // header before Electron sees the full compressed payload, preventing a
  // renderer-controlled image from amplifying into an unbounded allocation.
  const header = Buffer.from(
    value.slice(PNG_DATA_URL_PREFIX.length, PNG_DATA_URL_PREFIX.length + 44),
    "base64"
  );
  if (
    header.length < 24 ||
    !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
    header.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new IpcSecurityError(
      "Clipboard image has an invalid PNG header",
      "INVALID_IMAGE_DATA"
    );
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  const pixels = width * height;
  if (
    width < 1 ||
    height < 1 ||
    width > maxWidth ||
    height > maxHeight ||
    !Number.isSafeInteger(pixels) ||
    pixels > maxPixels
  ) {
    throw new IpcSecurityError(
      "Clipboard image dimensions are outside the allowed bounds",
      "IMAGE_DIMENSIONS_TOO_LARGE"
    );
  }
  return { width, height, pixels };
}

function normalizeAuthorityKey(value, name) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new IpcSecurityError(`${name} is invalid`, "INVALID_AUTHORITY_KEY");
    }
    return String(value);
  }
  return assertString(value, { name, minChars: 1, maxChars: 256, trim: true });
}

function isPathInsideRoot(rootPath, targetPath, pathApi = path) {
  const relative = pathApi.relative(rootPath, targetPath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

function createPathAuthority(options = {}) {
  const {
    fsApi = fs.promises,
    pathApi = path,
    maxRootsPerOwner = 256,
  } = options;
  const scopes = new Map();
  let disposed = false;
  let revocationGeneration = 0;

  function ownerRoots(ownerId, scopeId, create = false) {
    const ownerKey = normalizeAuthorityKey(ownerId, "ownerId");
    const scopeKey = normalizeAuthorityKey(scopeId, "scopeId");
    let owners = scopes.get(scopeKey);
    if (!owners && create) {
      owners = new Map();
      scopes.set(scopeKey, owners);
    }
    let roots = owners?.get(ownerKey);
    if (!roots && create) {
      roots = new Map();
      owners.set(ownerKey, roots);
    }
    return { ownerKey, scopeKey, owners, roots };
  }

  function assertUsable() {
    if (disposed) {
      throw new IpcSecurityError("Path authority is disposed", "PATH_AUTHORITY_DISPOSED");
    }
  }

  function assertAuthorityCurrent(generation) {
    assertUsable();
    if (generation !== revocationGeneration) {
      throw new IpcSecurityError(
        "Filesystem authority changed during validation",
        "PATH_NOT_AUTHORIZED"
      );
    }
  }

  async function canonicalize(candidate) {
    const absolutePath = assertPathString(candidate);
    return pathApi.resolve(await fsApi.realpath(absolutePath));
  }

  async function grantRoot({ ownerId, scopeId, rootPath }) {
    assertUsable();
    const generation = revocationGeneration;
    const canonicalRoot = await canonicalize(rootPath);
    assertAuthorityCurrent(generation);
    const stats = await fsApi.stat(canonicalRoot);
    assertAuthorityCurrent(generation);
    if (!stats?.isDirectory?.()) {
      throw new IpcSecurityError("Authorized root must be a directory", "INVALID_AUTHORIZED_ROOT");
    }
    const { roots } = ownerRoots(ownerId, scopeId, true);
    if (!roots.has(canonicalRoot) && roots.size >= maxRootsPerOwner) {
      const oldestRoot = roots.keys().next().value;
      roots.delete(oldestRoot);
    }
    // Touch insertion order so bounded snapshots retain recently used roots.
    roots.delete(canonicalRoot);
    roots.set(canonicalRoot, { path: canonicalRoot, grantedAt: Date.now() });
    return canonicalRoot;
  }

  async function assertAuthorizedPath({ ownerId, scopeId, targetPath, kind = null }) {
    assertUsable();
    const generation = revocationGeneration;
    const authority = ownerRoots(ownerId, scopeId, false);
    const { roots } = authority;
    if (!roots?.size) {
      throw new IpcSecurityError("No filesystem roots are authorized", "PATH_NOT_AUTHORIZED");
    }
    const canonicalTarget = await canonicalize(targetPath);
    assertAuthorityCurrent(generation);
    const currentAuthority = ownerRoots(
      authority.ownerKey,
      authority.scopeKey,
      false
    );
    if (
      currentAuthority.owners !== authority.owners ||
      currentAuthority.roots !== roots
    ) {
      throw new IpcSecurityError(
        "Filesystem authority changed during validation",
        "PATH_NOT_AUTHORIZED"
      );
    }
    const matchingRoot = [...roots.keys()].find((root) =>
      isPathInsideRoot(root, canonicalTarget, pathApi)
    );
    if (!matchingRoot) {
      throw new IpcSecurityError("Path is outside the authorized roots", "PATH_NOT_AUTHORIZED");
    }
    if (kind) {
      const stats = await fsApi.stat(canonicalTarget);
      assertAuthorityCurrent(generation);
      const afterStatAuthority = ownerRoots(
        authority.ownerKey,
        authority.scopeKey,
        false
      );
      if (
        afterStatAuthority.owners !== authority.owners ||
        afterStatAuthority.roots !== roots
      ) {
        throw new IpcSecurityError(
          "Filesystem authority changed during validation",
          "PATH_NOT_AUTHORIZED"
        );
      }
      const valid = kind === "file" ? stats?.isFile?.() : kind === "directory" ? stats?.isDirectory?.() : false;
      if (!valid) {
        throw new IpcSecurityError(`Authorized path is not a ${kind}`, "INVALID_PATH_KIND");
      }
    }
    const record = roots.get(matchingRoot);
    roots.delete(matchingRoot);
    roots.set(matchingRoot, record);
    return { path: canonicalTarget, rootPath: matchingRoot };
  }

  function revokeOwner(ownerId) {
    revocationGeneration += 1;
    const ownerKey = normalizeAuthorityKey(ownerId, "ownerId");
    let removed = 0;
    for (const [scopeKey, owners] of scopes) {
      const roots = owners.get(ownerKey);
      if (roots) removed += roots.size;
      owners.delete(ownerKey);
      if (!owners.size) scopes.delete(scopeKey);
    }
    return removed;
  }

  function revokeScope(scopeId) {
    revocationGeneration += 1;
    const scopeKey = normalizeAuthorityKey(scopeId, "scopeId");
    const owners = scopes.get(scopeKey);
    let removed = 0;
    for (const roots of owners?.values?.() || []) removed += roots.size;
    scopes.delete(scopeKey);
    return removed;
  }

  function snapshot() {
    let ownerCount = 0;
    let rootCount = 0;
    for (const owners of scopes.values()) {
      ownerCount += owners.size;
      for (const roots of owners.values()) rootCount += roots.size;
    }
    return { disposed, scopes: scopes.size, owners: ownerCount, roots: rootCount };
  }

  function dispose() {
    if (disposed) return false;
    revocationGeneration += 1;
    disposed = true;
    scopes.clear();
    return true;
  }

  return {
    grantRoot,
    assertAuthorizedPath,
    revokeOwner,
    revokeScope,
    snapshot,
    dispose,
  };
}

module.exports = {
  IPC_LIMITS,
  IpcSecurityError,
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
  isPathInsideRoot,
};
