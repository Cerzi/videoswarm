const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_MAX_SETTINGS_BYTES = 64 * 1024;

class SettingsWriterError extends Error {
  constructor(message, code = "SETTINGS_WRITE_ERROR", cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "SettingsWriterError";
    this.code = code;
  }
}

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function assertProfileId(profileId) {
  if (
    typeof profileId !== "string" ||
    !profileId.trim() ||
    profileId.length > 256 ||
    profileId.includes("\0")
  ) {
    throw new SettingsWriterError("A valid profile id is required", "INVALID_PROFILE_ID");
  }
  return profileId.trim();
}

function assertSettingsObject(value, name = "settings") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SettingsWriterError(`${name} must be an object`, "INVALID_SETTINGS");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SettingsWriterError(`${name} must be a plain object`, "INVALID_SETTINGS");
  }
  for (const unsafeKey of ["__proto__", "constructor", "prototype"]) {
    if (Object.prototype.hasOwnProperty.call(value, unsafeKey)) {
      throw new SettingsWriterError(
        `${name} contains a reserved key`,
        "INVALID_SETTINGS"
      );
    }
  }
  return value;
}

function serializeSettings(value, maxBytes = DEFAULT_MAX_SETTINGS_BYTES) {
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw new SettingsWriterError("Settings are not serializable", "INVALID_SETTINGS", error);
  }
  if (serialized === undefined) {
    throw new SettingsWriterError("Settings are not serializable", "INVALID_SETTINGS");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new SettingsWriterError("Settings exceed the size limit", "SETTINGS_TOO_LARGE");
  }
  return serialized;
}

function cloneSettings(value, maxBytes) {
  return JSON.parse(serializeSettings(value, maxBytes));
}

function settingsFileTooLarge(maxBytes) {
  return new SettingsWriterError(
    `Settings exceed the ${maxBytes}-byte size limit`,
    "SETTINGS_TOO_LARGE"
  );
}

/**
 * Read one settings snapshot through a single file handle. The initial stat
 * avoids reading an already-oversized regular file, while the max+1 bounded
 * read also catches a file that grows after stat without allocating or parsing
 * attacker/corruption-controlled input of unbounded size.
 */
async function readSettingsFileBounded(
  filePath,
  { fsApi = fs.promises, maxBytes = DEFAULT_MAX_SETTINGS_BYTES } = {}
) {
  const byteLimit = Number(maxBytes);
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) {
    throw new TypeError("Settings byte limit must be a positive safe integer");
  }
  let handle = null;
  try {
    handle = await fsApi.open(filePath, "r");
    const stats = await handle.stat();
    const size = Number(stats?.size);
    if (!Number.isFinite(size) || size < 0 || !stats?.isFile?.()) {
      throw new SettingsWriterError(
        "Settings path is not a regular file",
        "INVALID_SETTINGS_FILE"
      );
    }
    if (size > byteLimit) throw settingsFileTooLarge(byteLimit);
    if (!Number.isSafeInteger(size)) {
      throw new SettingsWriterError(
        "Settings file has an invalid size",
        "INVALID_SETTINGS_FILE"
      );
    }

    const buffer = Buffer.allocUnsafe(byteLimit + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total
      );
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
        throw new SettingsWriterError(
          "Unable to read settings file",
          "INVALID_SETTINGS_FILE"
        );
      }
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > byteLimit) throw settingsFileTooLarge(byteLimit);
    return buffer.toString("utf8", 0, total);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // A read/validation error is authoritative; close is best effort.
      }
    }
  }
}

async function removeTemporaryFile(fsApi, temporaryPath) {
  try {
    if (typeof fsApi.rm === "function") {
      await fsApi.rm(temporaryPath, { force: true });
    } else {
      await fsApi.unlink(temporaryPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * Write a UTF-8 file without exposing a partially written destination. The
 * temporary file lives beside the target so rename remains on one filesystem.
 */
async function writeFileAtomically(
  destination,
  contents,
  { fsApi = fs.promises, sequence = 0, assertActive = null } = {}
) {
  if (assertActive !== null && typeof assertActive !== "function") {
    throw new TypeError("writeFileAtomically assertActive must be a function");
  }
  const filePath = path.resolve(destination);
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${sequence}.${crypto.randomUUID()}.tmp`
  );
  let handle = null;
  let renamed = false;

  await fsApi.mkdir(directory, { recursive: true });
  try {
    handle = await fsApi.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    // This is the publication ownership boundary. Callers that captured a
    // renderer/profile generation can prevent stale work from replacing the
    // destination after an asynchronous write or native dialog yield.
    assertActive?.();
    await fsApi.rename(temporaryPath, filePath);
    renamed = true;

    // Persist the directory entry where the platform permits directory fsync.
    // Windows commonly rejects opening directories; the rename is still the
    // atomic boundary there, so this durability enhancement is best effort.
    let directoryHandle = null;
    try {
      directoryHandle = await fsApi.open(directory, "r");
      await directoryHandle.sync();
    } catch {
      // Best effort only.
    } finally {
      await directoryHandle?.close?.().catch?.(() => {});
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) await removeTemporaryFile(fsApi, temporaryPath).catch(() => {});
  }
}

function createSettingsWriter(options = {}) {
  const {
    resolvePath,
    normalizeSettings = (settings) => settings,
    fsApi = fs.promises,
    clock = defaultClock(),
    logger = console,
    debounceMs = 150,
    maxWaitMs = 1000,
    retryBaseMs = 250,
    maxPersistRetries = 3,
    maxProfiles = 64,
    maxBytes = DEFAULT_MAX_SETTINGS_BYTES,
  } = options;

  if (typeof resolvePath !== "function") {
    throw new TypeError("createSettingsWriter requires resolvePath(profileId)");
  }
  if (typeof normalizeSettings !== "function") {
    throw new TypeError("normalizeSettings must be a function");
  }
  if (!fsApi?.open || !fsApi?.rename) {
    throw new TypeError("A complete fs.promises-compatible API is required");
  }

  const states = new Map();
  let accepting = true;
  let disposed = false;
  let disposePromise = null;
  let temporarySequence = 0;

  function assertAccepting() {
    if (!accepting || disposed) {
      throw new SettingsWriterError("Settings writer is disposed", "SETTINGS_WRITER_DISPOSED");
    }
  }

  function settingsPath(profileId) {
    const candidate = resolvePath(profileId);
    if (
      typeof candidate !== "string" ||
      !candidate ||
      candidate.includes("\0") ||
      !path.isAbsolute(candidate)
    ) {
      throw new SettingsWriterError("Settings path must be absolute", "INVALID_SETTINGS_PATH");
    }
    return path.resolve(candidate);
  }

  function stateFor(profileId, create = true) {
    const id = assertProfileId(profileId);
    let state = states.get(id);
    if (!state && create) {
      if (states.size >= maxProfiles) {
        throw new SettingsWriterError("Settings profile limit reached", "SETTINGS_PROFILE_LIMIT");
      }
      state = {
        profileId: id,
        filePath: settingsPath(id),
        snapshot: null,
        loadPromise: null,
        mutationChain: Promise.resolve(),
        revision: 0,
        persistedRevision: 0,
        writingPromise: null,
        timer: null,
        firstDirtyAt: null,
        retryAttempts: 0,
        lastError: null,
        retiring: false,
      };
      states.set(id, state);
    }
    if (state?.retiring && create) {
      throw new SettingsWriterError(
        `Settings for profile '${state.profileId}' are being forgotten`,
        "SETTINGS_PROFILE_RETIRING"
      );
    }
    return state || null;
  }

  function prepareSnapshot(value, profileId) {
    assertSettingsObject(value);
    let normalized;
    try {
      normalized = normalizeSettings(value, profileId);
    } catch (error) {
      if (error instanceof SettingsWriterError) throw error;
      throw new SettingsWriterError("Settings normalization failed", "INVALID_SETTINGS", error);
    }
    if (normalized && typeof normalized.then === "function") {
      throw new SettingsWriterError("Settings normalization must be synchronous", "INVALID_SETTINGS");
    }
    assertSettingsObject(normalized);
    return cloneSettings(normalized, maxBytes);
  }

  async function ensureLoaded(state) {
    if (state.snapshot) return state.snapshot;
    if (!state.loadPromise) {
      state.loadPromise = (async () => {
        let raw = "{}";
        try {
          raw = await readSettingsFileBounded(state.filePath, {
            fsApi,
            maxBytes,
          });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw || "{}");
        } catch (error) {
          throw new SettingsWriterError(
            `Unable to parse settings for profile '${state.profileId}'`,
            "INVALID_SETTINGS_FILE",
            error
          );
        }
        state.snapshot = prepareSnapshot(parsed, state.profileId);
        return state.snapshot;
      })().finally(() => {
        state.loadPromise = null;
      });
    }
    return state.loadPromise;
  }

  function clearTimer(state) {
    if (state.timer !== null) {
      clock.clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function schedulePersist(state, requestedDelay = debounceMs) {
    if (!accepting || disposed || state.persistedRevision >= state.revision) return;
    clearTimer(state);
    const now = clock.now();
    if (state.firstDirtyAt === null) state.firstDirtyAt = now;
    const untilMaxWait = Math.max(0, maxWaitMs - (now - state.firstDirtyAt));
    const delay = Math.max(0, Math.min(requestedDelay, untilMaxWait));
    state.timer = clock.setTimeout(async () => {
      state.timer = null;
      try {
        await persistState(state);
      } catch (error) {
        state.lastError = error;
        logger?.error?.("[settings] Deferred write failed", error);
        if (
          accepting &&
          !disposed &&
          state.persistedRevision < state.revision &&
          state.retryAttempts < maxPersistRetries
        ) {
          state.retryAttempts += 1;
          const retryDelay = retryBaseMs * 2 ** (state.retryAttempts - 1);
          schedulePersist(state, retryDelay);
        }
      }
    }, delay);
  }

  async function persistState(state) {
    clearTimer(state);
    if (state.writingPromise) {
      await state.writingPromise;
      if (state.persistedRevision >= state.revision) return;
    }

    const write = async () => {
      while (state.persistedRevision < state.revision) {
        const revision = state.revision;
        const serialized = serializeSettings(state.snapshot, maxBytes);
        await writeFileAtomically(state.filePath, serialized, {
          fsApi,
          sequence: ++temporarySequence,
        });
        state.persistedRevision = revision;
        state.lastError = null;
        state.retryAttempts = 0;
      }
      state.firstDirtyAt = null;
    };

    const writingPromise = write();
    state.writingPromise = writingPromise;
    try {
      await writingPromise;
    } finally {
      if (state.writingPromise === writingPromise) state.writingPromise = null;
    }
  }

  function enqueueMutation(state, operation) {
    const result = state.mutationChain.then(operation);
    state.mutationChain = result.catch(() => {});
    return result;
  }

  async function drainStateOperations(state) {
    while (true) {
      const mutationChain = state.mutationChain;
      const loadPromise = state.loadPromise;
      await mutationChain;
      if (loadPromise) await loadPromise;
      if (
        mutationChain === state.mutationChain &&
        state.loadPromise === null
      ) {
        return;
      }
    }
  }

  function markChanged(state, snapshot) {
    state.snapshot = snapshot;
    state.revision += 1;
    state.lastError = null;
    if (state.firstDirtyAt === null) state.firstDirtyAt = clock.now();
  }

  function seed(profileId, settings) {
    assertAccepting();
    const state = stateFor(profileId);
    if (
      state.revision !== state.persistedRevision ||
      state.writingPromise ||
      state.loadPromise
    ) {
      throw new SettingsWriterError(
        `Cannot seed dirty settings for profile '${state.profileId}'`,
        "SETTINGS_ALREADY_ACTIVE"
      );
    }
    state.snapshot = prepareSnapshot(settings, state.profileId);
    return cloneSettings(state.snapshot, maxBytes);
  }

  function patch(profileId, partialSettings, options = {}) {
    assertAccepting();
    assertSettingsObject(partialSettings, "partialSettings");
    const safePatch = cloneSettings(partialSettings, maxBytes);
    const state = stateFor(profileId);
    return enqueueMutation(state, async () => {
      const current = await ensureLoaded(state);
      const merged = Object.assign(Object.create(null), current, safePatch);
      markChanged(state, prepareSnapshot(merged, state.profileId));
      if (options.debounce) {
        schedulePersist(state, options.debounceMs ?? debounceMs);
      } else {
        await persistState(state);
      }
      return cloneSettings(state.snapshot, maxBytes);
    });
  }

  function replace(profileId, settings, options = {}) {
    assertAccepting();
    const prepared = prepareSnapshot(settings, assertProfileId(profileId));
    const state = stateFor(profileId);
    return enqueueMutation(state, async () => {
      await ensureLoaded(state);
      markChanged(state, prepared);
      if (options.debounce) {
        schedulePersist(state, options.debounceMs ?? debounceMs);
      } else {
        await persistState(state);
      }
      return cloneSettings(state.snapshot, maxBytes);
    });
  }

  async function flushState(state) {
    await drainStateOperations(state);
    clearTimer(state);
    if (state.persistedRevision < state.revision) await persistState(state);
  }

  async function flush(profileId = null) {
    if (disposed) return;
    const targetStates = profileId === null
      ? [...states.values()]
      : [stateFor(profileId, false)].filter(Boolean);
    const results = await Promise.allSettled(targetStates.map(flushState));
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Multiple settings files failed to flush");
    }
  }

  function getSnapshot(profileId) {
    assertAccepting();
    const state = stateFor(profileId);
    return enqueueMutation(state, async () => {
      await ensureLoaded(state);
      return cloneSettings(state.snapshot, maxBytes);
    });
  }

  async function forget(profileId, options = {}) {
    const state = stateFor(profileId, false);
    if (!state) return false;
    if (state.retiring) {
      throw new SettingsWriterError(
        `Settings for profile '${state.profileId}' are already being forgotten`,
        "SETTINGS_PROFILE_RETIRING"
      );
    }
    state.retiring = true;
    try {
      if (options.flush !== false) {
        await flushState(state);
      } else {
        clearTimer(state);
        await drainStateOperations(state);
        clearTimer(state);
        await state.writingPromise;
      }
      if (states.get(state.profileId) === state) {
        states.delete(state.profileId);
      }
      return true;
    } catch (error) {
      state.retiring = false;
      throw error;
    }
  }

  function snapshot() {
    let dirtyProfiles = 0;
    let writingProfiles = 0;
    let scheduledProfiles = 0;
    for (const state of states.values()) {
      if (state.persistedRevision < state.revision) dirtyProfiles += 1;
      if (state.writingPromise) writingProfiles += 1;
      if (state.timer !== null) scheduledProfiles += 1;
    }
    return {
      accepting,
      disposed,
      profiles: states.size,
      dirtyProfiles,
      writingProfiles,
      scheduledProfiles,
    };
  }

  function dispose(options = {}) {
    if (disposePromise) return disposePromise;
    accepting = false;
    for (const state of states.values()) clearTimer(state);
    disposePromise = (async () => {
      try {
        if (options.flush !== false) {
          await flush();
        } else {
          const results = await Promise.allSettled(
            [...states.values()].map(async (state) => {
              await state.mutationChain;
              clearTimer(state);
              await state.writingPromise;
            })
          );
          const failures = results
            .filter((result) => result.status === "rejected")
            .map((result) => result.reason);
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(
              failures,
              "Multiple settings operations failed during disposal"
            );
          }
        }
      } finally {
        disposed = true;
        states.clear();
      }
    })();
    return disposePromise;
  }

  return {
    seed,
    patch,
    replace,
    flush,
    forget,
    getSnapshot,
    snapshot,
    dispose,
  };
}

module.exports = {
  DEFAULT_MAX_SETTINGS_BYTES,
  SettingsWriterError,
  createSettingsWriter,
  readSettingsFileBounded,
  serializeSettings,
  writeFileAtomically,
};
