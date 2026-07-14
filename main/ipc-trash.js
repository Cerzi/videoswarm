const crypto = require("crypto");
const path = require("path");

const DEFAULT_MAX_TRASH_ITEMS = 2_000;
const DEFAULT_TRASH_CONFIRMATION_TTL_MS = 30_000;
const DEFAULT_MAX_TRASH_CONFIRMATION_GRANTS = 64;
const TRASH_CONFIRMATION_TOKEN_BYTES = 32;

class TrashConfirmationError extends Error {
  constructor(message, code = "TRASH_CONFIRMATION_ERROR") {
    super(message);
    this.name = "TrashConfirmationError";
    this.code = code;
  }
}

function normalizeCapabilityKey(value, name) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TrashConfirmationError(
        `${name} is invalid`,
        "INVALID_TRASH_CONFIRMATION_CONTEXT"
      );
    }
    return String(value);
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new TrashConfirmationError(
      `${name} is invalid`,
      "INVALID_TRASH_CONFIRMATION_CONTEXT"
    );
  }
  return value.trim();
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TrashConfirmationError(
      "generation is invalid",
      "INVALID_TRASH_CONFIRMATION_CONTEXT"
    );
  }
  return value;
}

function normalizeCapabilityPaths(paths, maxPaths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > maxPaths) {
    throw new TrashConfirmationError(
      `Trash confirmation paths must contain 1-${maxPaths} entries`,
      "INVALID_TRASH_CONFIRMATION_PATHS"
    );
  }
  const normalized = new Set();
  for (const candidate of paths) {
    if (
      typeof candidate !== "string" ||
      !candidate.trim() ||
      candidate.length > 32 * 1024 ||
      candidate.includes("\0") ||
      !path.isAbsolute(candidate.trim())
    ) {
      throw new TrashConfirmationError(
        "Trash confirmation paths must be canonical absolute paths",
        "INVALID_TRASH_CONFIRMATION_PATHS"
      );
    }
    normalized.add(path.resolve(candidate.trim()));
  }
  return [...normalized];
}

function normalizePathBindings(bindings, paths) {
  if (bindings === undefined || bindings === null) {
    return new Map(paths.map((candidate) => [candidate, null]));
  }
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new TrashConfirmationError(
      "Trash confirmation bindings are invalid",
      "INVALID_TRASH_CONFIRMATION_BINDINGS"
    );
  }
  const normalized = new Map();
  for (const candidate of paths) {
    const value = bindings[candidate];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 512 ||
      value.includes("\0")
    ) {
      throw new TrashConfirmationError(
        "Trash confirmation binding is missing or invalid",
        "INVALID_TRASH_CONFIRMATION_BINDINGS"
      );
    }
    normalized.set(candidate, value);
  }
  if (Object.keys(bindings).length !== paths.length) {
    throw new TrashConfirmationError(
      "Trash confirmation bindings do not match the path set",
      "INVALID_TRASH_CONFIRMATION_BINDINGS"
    );
  }
  return normalized;
}

function createTrashConfirmationStore(options = {}) {
  const {
    clock = { now: () => Date.now() },
    randomBytes = crypto.randomBytes,
    ttlMs = DEFAULT_TRASH_CONFIRMATION_TTL_MS,
    maxGrants = DEFAULT_MAX_TRASH_CONFIRMATION_GRANTS,
    maxPaths = DEFAULT_MAX_TRASH_ITEMS,
  } = options;
  if (!clock || typeof clock.now !== "function") {
    throw new TypeError("Trash confirmation store requires clock.now()");
  }
  if (typeof randomBytes !== "function") {
    throw new TypeError("Trash confirmation store requires randomBytes()");
  }
  for (const [name, value] of [
    ["ttlMs", ttlMs],
    ["maxGrants", maxGrants],
    ["maxPaths", maxPaths],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }

  const grants = new Map();
  let disposed = false;

  function assertUsable() {
    if (disposed) {
      throw new TrashConfirmationError(
        "Trash confirmation store is disposed",
        "TRASH_CONFIRMATION_STORE_DISPOSED"
      );
    }
  }

  function now() {
    const value = Number(clock.now());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TrashConfirmationError(
        "Trash confirmation clock is invalid",
        "INVALID_TRASH_CONFIRMATION_CLOCK"
      );
    }
    return value;
  }

  function pruneExpired(at = now()) {
    let removed = 0;
    for (const [token, grant] of grants) {
      if (at < grant.expiresAt) continue;
      grants.delete(token);
      removed += 1;
    }
    return removed;
  }

  function createToken() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = randomBytes(TRASH_CONFIRMATION_TOKEN_BYTES);
      if (!Buffer.isBuffer(bytes) || bytes.length !== TRASH_CONFIRMATION_TOKEN_BYTES) {
        throw new TrashConfirmationError(
          "Unable to create trash confirmation token",
          "INVALID_TRASH_CONFIRMATION_RANDOM_SOURCE"
        );
      }
      const token = bytes.toString("hex");
      if (!grants.has(token)) return token;
    }
    throw new TrashConfirmationError(
      "Unable to allocate a unique trash confirmation token",
      "TRASH_CONFIRMATION_TOKEN_COLLISION"
    );
  }

  function issue({ ownerId, scopeId, generation, paths, bindings } = {}) {
    assertUsable();
    const issuedAt = now();
    const normalizedOwnerId = normalizeCapabilityKey(ownerId, "ownerId");
    const normalizedScopeId = normalizeCapabilityKey(scopeId, "scopeId");
    const normalizedGeneration = normalizeGeneration(generation);
    const normalizedPaths = normalizeCapabilityPaths(paths, maxPaths);
    const normalizedBindings = normalizePathBindings(bindings, normalizedPaths);
    pruneExpired(issuedAt);
    if (grants.size >= maxGrants) {
      throw new TrashConfirmationError(
        `Trash confirmation grant limit of ${maxGrants} reached`,
        "TRASH_CONFIRMATION_GRANT_LIMIT"
      );
    }
    const token = createToken();
    const expiresAt = issuedAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new TrashConfirmationError(
        "Trash confirmation expiry is invalid",
        "INVALID_TRASH_CONFIRMATION_CLOCK"
      );
    }
    grants.set(token, {
      token,
      ownerId: normalizedOwnerId,
      scopeId: normalizedScopeId,
      generation: normalizedGeneration,
      paths: new Set(normalizedPaths),
      bindings: normalizedBindings,
      issuedAt,
      expiresAt,
    });
    return Object.freeze({ token, expiresAt, pathCount: normalizedPaths.length });
  }

  function validate({ token, ownerId, scopeId, generation, paths } = {}) {
    assertUsable();
    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token)
    ) {
      throw new TrashConfirmationError(
        "Trash confirmation token is invalid",
        "INVALID_TRASH_CONFIRMATION_TOKEN"
      );
    }
    const grant = grants.get(token);
    if (!grant) {
      throw new TrashConfirmationError(
        "Trash confirmation was not found",
        "TRASH_CONFIRMATION_NOT_FOUND"
      );
    }
    const checkedAt = now();
    if (checkedAt >= grant.expiresAt) {
      grants.delete(token);
      throw new TrashConfirmationError(
        "Trash confirmation has expired",
        "TRASH_CONFIRMATION_EXPIRED"
      );
    }
    if (
      grant.ownerId !== normalizeCapabilityKey(ownerId, "ownerId") ||
      grant.scopeId !== normalizeCapabilityKey(scopeId, "scopeId") ||
      grant.generation !== normalizeGeneration(generation)
    ) {
      throw new TrashConfirmationError(
        "Trash confirmation ownership changed",
        "TRASH_CONFIRMATION_CONTEXT_MISMATCH"
      );
    }
    const requestedPaths = normalizeCapabilityPaths(paths, maxPaths);
    if (requestedPaths.some((candidate) => !grant.paths.has(candidate))) {
      throw new TrashConfirmationError(
        "Trash request is outside the confirmed path set",
        "TRASH_CONFIRMATION_PATH_MISMATCH"
      );
    }
    return Object.freeze({
      token,
      paths: Object.freeze(requestedPaths),
      bindings: Object.freeze(
        Object.fromEntries(
          requestedPaths.map((candidate) => [
            candidate,
            grant.bindings.get(candidate),
          ])
        )
      ),
      expiresAt: grant.expiresAt,
    });
  }

  function consume(request = {}) {
    const validated = validate(request);
    grants.delete(validated.token);
    return validated;
  }

  function revokeOwner(ownerId) {
    const ownerKey = normalizeCapabilityKey(ownerId, "ownerId");
    let removed = 0;
    for (const [token, grant] of grants) {
      if (grant.ownerId !== ownerKey) continue;
      grants.delete(token);
      removed += 1;
    }
    return removed;
  }

  function revokeScope(scopeId, generation = null) {
    const scopeKey = normalizeCapabilityKey(scopeId, "scopeId");
    const normalizedGeneration = generation === null
      ? null
      : normalizeGeneration(generation);
    let removed = 0;
    for (const [token, grant] of grants) {
      if (
        grant.scopeId !== scopeKey ||
        (normalizedGeneration !== null && grant.generation !== normalizedGeneration)
      ) {
        continue;
      }
      grants.delete(token);
      removed += 1;
    }
    return removed;
  }

  function revokeAll() {
    const removed = grants.size;
    grants.clear();
    return removed;
  }

  function snapshot() {
    if (!disposed) pruneExpired();
    return {
      disposed,
      grants: grants.size,
      limits: { ttlMs, maxGrants, maxPaths },
    };
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    grants.clear();
    return true;
  }

  return {
    issue,
    validate,
    consume,
    revokeOwner,
    revokeScope,
    revokeAll,
    snapshot,
    dispose,
  };
}

/**
 * Move a bounded set of already user-selected files to the platform trash.
 * Authorization is deliberately injected so this module has one reusable,
 * testable destructive implementation without owning Electron IPC itself.
 */
async function trashAuthorizedPaths({
  paths,
  shell,
  authorizePath,
  maxItems = DEFAULT_MAX_TRASH_ITEMS,
  logger = console,
} = {}) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > maxItems) {
    throw new TypeError(`Trash paths must contain 1-${maxItems} entries`);
  }
  if (!shell || typeof shell.trashItem !== "function") {
    throw new TypeError("Electron shell.trashItem is required");
  }
  if (typeof authorizePath !== "function") {
    throw new TypeError("A path authorizer is required");
  }

  const moved = [];
  const failed = [];
  const seen = new Set();
  for (const candidate of paths) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      failed.push({ path: candidate ?? null, error: "Invalid path" });
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const authorized = await authorizePath(candidate);
      const filePath = typeof authorized === "string"
        ? authorized
        : authorized?.path;
      if (!filePath) throw new Error("Path is not authorized");
      await shell.trashItem(filePath);
      moved.push(candidate);
    } catch (error) {
      const message = error?.message || String(error);
      logger?.warn?.("[trash] Failed to move item", { message });
      failed.push({ path: candidate, error: message });
    }
  }

  return {
    success: failed.length === 0,
    moved,
    failed,
  };
}

module.exports = {
  DEFAULT_MAX_TRASH_ITEMS,
  DEFAULT_MAX_TRASH_CONFIRMATION_GRANTS,
  DEFAULT_TRASH_CONFIRMATION_TTL_MS,
  TrashConfirmationError,
  createTrashConfirmationStore,
  trashAuthorizedPaths,
};
