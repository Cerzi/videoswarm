const path = require("path");

class DirectoryAggregateBatcherError extends Error {
  constructor(message, code = "DIRECTORY_AGGREGATE_BATCHER_ERROR", cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = "DirectoryAggregateBatcherError";
    this.code = code;
  }
}

class StaleDirectoryAggregateContextError extends DirectoryAggregateBatcherError {
  constructor() {
    super(
      "Directory aggregate ownership is stale",
      "STALE_DIRECTORY_AGGREGATE_CONTEXT"
    );
    this.name = "StaleDirectoryAggregateContextError";
  }
}

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function normalizeProfileId(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    value.includes("\0")
  ) {
    throw new DirectoryAggregateBatcherError(
      "A valid profile id is required",
      "INVALID_AGGREGATE_CONTEXT"
    );
  }
  return value.trim();
}

function normalizeGeneration(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DirectoryAggregateBatcherError(
        "Aggregate generation must be a non-negative safe integer",
        "INVALID_AGGREGATE_CONTEXT"
      );
    }
    return value;
  }
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    value.includes("\0")
  ) {
    throw new DirectoryAggregateBatcherError(
      "A valid aggregate generation is required",
      "INVALID_AGGREGATE_CONTEXT"
    );
  }
  return value.trim();
}

function normalizeRootPath(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 32 * 1024 ||
    value.includes("\0") ||
    !path.isAbsolute(value.trim())
  ) {
    throw new DirectoryAggregateBatcherError(
      "An absolute directory root is required",
      "INVALID_AGGREGATE_ROOT"
    );
  }
  return path.resolve(value.trim());
}

function normalizeOwnership(value, fallback = null) {
  const profileId = value?.profileId ?? fallback?.profileId;
  const generation = value?.generation ?? fallback?.generation;
  return Object.freeze({
    profileId: normalizeProfileId(profileId),
    generation: normalizeGeneration(generation),
  });
}

function sameOwnership(left, right) {
  return Boolean(
    left &&
      right &&
      left.profileId === right.profileId &&
      left.generation === right.generation
  );
}

function entryKey(ownership, rootPath) {
  return `${ownership.profileId}\0${String(ownership.generation)}\0${rootPath}`;
}

function createDirectoryAggregateBatcher(options = {}) {
  const {
    refresh,
    isContextActive = () => true,
    clock = defaultClock(),
    logger = console,
    debounceMs = 150,
    maxWaitMs = 1000,
    maxDirtyRoots = 128,
    retryBaseMs = 250,
    maxRetries = 3,
    maxDrainPasses = 32,
  } = options;

  if (typeof refresh !== "function") {
    throw new TypeError("createDirectoryAggregateBatcher requires refresh");
  }
  if (typeof isContextActive !== "function") {
    throw new TypeError("isContextActive must be a function");
  }
  for (const [name, value, minimum] of [
    ["debounceMs", debounceMs, 0],
    ["maxWaitMs", maxWaitMs, 1],
    ["maxDirtyRoots", maxDirtyRoots, 1],
    ["retryBaseMs", retryBaseMs, 0],
    ["maxRetries", maxRetries, 0],
    ["maxDrainPasses", maxDrainPasses, 1],
  ]) {
    if (!Number.isFinite(value) || value < minimum) {
      throw new TypeError(`${name} is outside the allowed bounds`);
    }
  }

  const entries = new Map();
  let activeOwnership = null;
  let operationTail = Promise.resolve();
  let queuedOperations = 0;
  let accepting = true;
  let disposed = false;
  let disposePromise = null;

  const totals = {
    marked: 0,
    coalesced: 0,
    refreshesStarted: 0,
    refreshesCompleted: 0,
    refreshesFailed: 0,
    staleCancelled: 0,
    overflowRejected: 0,
  };

  function contextIsActive(ownership) {
    if (disposed || !sameOwnership(activeOwnership, ownership)) return false;
    try {
      return isContextActive(ownership) !== false;
    } catch {
      return false;
    }
  }

  function assertEntryActive(entry) {
    if (entry.cancelled || !contextIsActive(entry.ownership)) {
      throw new StaleDirectoryAggregateContextError();
    }
  }

  function clearTimer(entry) {
    if (entry.timer !== null) {
      clock.clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function removeEntry(entry) {
    clearTimer(entry);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  }

  function cancelEntry(entry) {
    if (!entry || entry.cancelled) return false;
    entry.cancelled = true;
    clearTimer(entry);
    removeEntry(entry);
    totals.staleCancelled += 1;
    return true;
  }

  function cancelInactiveEntries() {
    let cancelled = 0;
    for (const entry of [...entries.values()]) {
      if (!contextIsActive(entry.ownership) && cancelEntry(entry)) cancelled += 1;
    }
    return cancelled;
  }

  function activate(context) {
    if (!accepting || disposed) {
      throw new DirectoryAggregateBatcherError(
        "Directory aggregate batcher is disposed",
        "DIRECTORY_AGGREGATE_BATCHER_DISPOSED"
      );
    }
    const nextOwnership = normalizeOwnership(context);
    if (sameOwnership(activeOwnership, nextOwnership)) return 0;
    activeOwnership = nextOwnership;
    return cancelInactiveEntries();
  }

  function invalidate(context = null) {
    if (context && !sameOwnership(activeOwnership, normalizeOwnership(context))) {
      return 0;
    }
    activeOwnership = null;
    return cancelInactiveEntries();
  }

  function scheduleEntry(entry, options = {}) {
    if (entry.cancelled || !contextIsActive(entry.ownership)) {
      cancelEntry(entry);
      return;
    }
    clearTimer(entry);
    const now = clock.now();
    if (entry.firstDirtyAt === null) entry.firstDirtyAt = now;
    let delay = options.delay ?? debounceMs;
    if (options.respectMaxWait !== false) {
      const remaining = Math.max(0, maxWaitMs - (now - entry.firstDirtyAt));
      delay = Math.min(delay, remaining);
    }
    entry.timer = clock.setTimeout(async () => {
      entry.timer = null;
      try {
        await enqueueRefresh(entry);
      } catch (error) {
        if (error?.code === "STALE_DIRECTORY_AGGREGATE_CONTEXT") return;
        logger?.error?.("[directory-aggregates] Deferred refresh failed", error);
      }
    }, Math.max(0, delay));
  }

  async function runRefresh(entry) {
    if (entry.cancelled || !contextIsActive(entry.ownership)) {
      cancelEntry(entry);
      return { refreshed: false, stale: true, rootPath: entry.rootPath };
    }

    entry.queued = false;
    entry.inFlight = true;
    clearTimer(entry);
    const targetVersion = entry.dirtyVersion;
    // New marks arriving during this operation begin a fresh debounce cycle.
    entry.firstDirtyAt = null;
    totals.refreshesStarted += 1;
    try {
      assertEntryActive(entry);
      const result = await refresh({
        rootPath: entry.rootPath,
        profileId: entry.ownership.profileId,
        generation: entry.ownership.generation,
        assertActive: () => assertEntryActive(entry),
      });
      assertEntryActive(entry);
      entry.refreshedVersion = Math.max(entry.refreshedVersion, targetVersion);
      entry.retryAttempts = 0;
      entry.lastError = null;
      totals.refreshesCompleted += 1;
      return {
        refreshed: true,
        stale: false,
        rootPath: entry.rootPath,
        result,
      };
    } catch (error) {
      if (
        error?.code === "STALE_DIRECTORY_AGGREGATE_CONTEXT" ||
        !contextIsActive(entry.ownership)
      ) {
        cancelEntry(entry);
        return { refreshed: false, stale: true, rootPath: entry.rootPath };
      }
      entry.lastError = error;
      entry.retryAttempts += 1;
      totals.refreshesFailed += 1;
      const changedDuringFailure = entry.dirtyVersion > targetVersion;
      if (
        changedDuringFailure &&
        entry.retryAttempts > maxRetries &&
        accepting
      ) {
        // The exhausted attempt covered an older version. A mutation that
        // arrived while it ran is a fresh debounced generation, not permission
        // to retry the same failed state forever and not work to silently drop.
        entry.retryAttempts = 0;
        entry.lastError = null;
        entry.firstDirtyAt = clock.now();
        scheduleEntry(entry);
      } else if (entry.retryAttempts <= maxRetries && accepting) {
        if (entry.firstDirtyAt === null) entry.firstDirtyAt = clock.now();
        scheduleEntry(entry, {
          delay: retryBaseMs * 2 ** (entry.retryAttempts - 1),
          respectMaxWait: false,
        });
      }
      throw error;
    } finally {
      entry.inFlight = false;
      entry.currentPromise = null;
      if (entry.cancelled) {
        removeEntry(entry);
      } else if (entry.refreshedVersion >= entry.dirtyVersion) {
        removeEntry(entry);
      } else if (entry.timer === null && accepting && !entry.lastError) {
        scheduleEntry(entry);
      }
    }
  }

  function enqueueRefresh(entry) {
    if (entry.cancelled || !contextIsActive(entry.ownership)) {
      cancelEntry(entry);
      return Promise.resolve({
        refreshed: false,
        stale: true,
        rootPath: entry.rootPath,
      });
    }
    clearTimer(entry);
    if (entry.currentPromise) return entry.currentPromise;

    entry.queued = true;
    queuedOperations += 1;
    const operation = operationTail.then(() => runRefresh(entry));
    entry.currentPromise = operation;
    operationTail = operation.catch(() => {}).finally(() => {
      queuedOperations = Math.max(0, queuedOperations - 1);
    });
    return operation;
  }

  function markDirty(input = {}) {
    if (!accepting || disposed) {
      throw new DirectoryAggregateBatcherError(
        "Directory aggregate batcher is disposed",
        "DIRECTORY_AGGREGATE_BATCHER_DISPOSED"
      );
    }
    const ownership = normalizeOwnership(input, activeOwnership);
    if (!contextIsActive(ownership)) {
      totals.staleCancelled += 1;
      return false;
    }
    const rootPath = normalizeRootPath(input.rootPath);
    const key = entryKey(ownership, rootPath);
    let entry = entries.get(key);
    if (!entry) {
      cancelInactiveEntries();
      if (entries.size >= maxDirtyRoots) {
        totals.overflowRejected += 1;
        throw new DirectoryAggregateBatcherError(
          `Directory aggregate root limit of ${maxDirtyRoots} reached`,
          "DIRECTORY_AGGREGATE_ROOT_LIMIT"
        );
      }
      entry = {
        key,
        ownership,
        rootPath,
        dirtyVersion: 0,
        refreshedVersion: 0,
        firstDirtyAt: null,
        lastDirtyAt: null,
        retryAttempts: 0,
        lastError: null,
        timer: null,
        queued: false,
        inFlight: false,
        currentPromise: null,
        cancelled: false,
      };
      entries.set(key, entry);
    } else {
      totals.coalesced += 1;
    }

    const now = clock.now();
    if (
      entry.lastError &&
      entry.retryAttempts > maxRetries &&
      !entry.inFlight &&
      !entry.queued
    ) {
      // A later filesystem mutation may rearm an exhausted root, but the
      // failed generation itself must not become an unbounded timer loop.
      entry.retryAttempts = 0;
      entry.lastError = null;
      entry.firstDirtyAt = null;
    }
    entry.dirtyVersion += 1;
    entry.lastDirtyAt = now;
    if (entry.firstDirtyAt === null) entry.firstDirtyAt = now;
    totals.marked += 1;
    if (!entry.inFlight && !entry.queued) scheduleEntry(entry);
    return true;
  }

  function findEntry(input) {
    const ownership = normalizeOwnership(input || {}, activeOwnership);
    const rootPath = normalizeRootPath(
      typeof input === "string" ? input : input?.rootPath
    );
    return entries.get(entryKey(ownership, rootPath)) || null;
  }

  async function flushRoot(input) {
    const normalizedInput = typeof input === "string" ? { rootPath: input } : input;
    const entry = findEntry(normalizedInput);
    if (!entry) {
      return {
        refreshed: false,
        stale: false,
        rootPath: normalizeRootPath(normalizedInput?.rootPath),
      };
    }
    let lastResult = null;
    for (let pass = 0; pass < maxDrainPasses; pass += 1) {
      if (entry.cancelled || entries.get(entry.key) !== entry) {
        return lastResult || {
          refreshed: false,
          stale: true,
          rootPath: entry.rootPath,
        };
      }
      clearTimer(entry);
      lastResult = await enqueueRefresh(entry);
      if (
        entry.cancelled ||
        entries.get(entry.key) !== entry ||
        entry.refreshedVersion >= entry.dirtyVersion
      ) {
        return lastResult;
      }
      // A mutation landed while the prior version was refreshing. The normal
      // path schedules another debounce in runRefresh.finally; an explicit
      // flush must consume that version immediately instead of returning stale
      // counts to a catalog read/profile transition/shutdown caller.
      clearTimer(entry);
    }
    if (!entry.cancelled && entries.get(entry.key) === entry && accepting) {
      scheduleEntry(entry);
    }
    throw new DirectoryAggregateBatcherError(
      `Directory aggregate flush exceeded ${maxDrainPasses} passes`,
      "DIRECTORY_AGGREGATE_DRAIN_LIMIT"
    );
  }

  async function flushAll() {
    const values = [];
    for (let pass = 0; pass < maxDrainPasses; pass += 1) {
      cancelInactiveEntries();
      const pendingEntries = [...entries.values()].filter(
        (entry) => !entry.cancelled
      );
      if (!pendingEntries.length) return values;
      const results = await Promise.allSettled(
        pendingEntries.map((entry) => flushRoot({
          ...entry.ownership,
          rootPath: entry.rootPath,
        }))
      );
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "Multiple directory aggregate roots failed to refresh"
        );
      }
      values.push(...results.map((result) => result.value));
      cancelInactiveEntries();
      if (![...entries.values()].some((entry) => !entry.cancelled)) {
        return values;
      }
    }
    throw new DirectoryAggregateBatcherError(
      `Directory aggregate flush-all exceeded ${maxDrainPasses} passes`,
      "DIRECTORY_AGGREGATE_DRAIN_LIMIT"
    );
  }

  function snapshot() {
    let scheduledRoots = 0;
    let queuedRoots = 0;
    let inFlightRoots = 0;
    for (const entry of entries.values()) {
      if (entry.timer !== null) scheduledRoots += 1;
      if (entry.queued) queuedRoots += 1;
      if (entry.inFlight) inFlightRoots += 1;
    }
    return {
      accepting,
      disposed,
      activeOwnership: activeOwnership ? { ...activeOwnership } : null,
      dirtyRoots: entries.size,
      scheduledRoots,
      queuedRoots,
      inFlightRoots,
      queuedOperations,
      limits: {
        debounceMs,
        maxWaitMs,
        maxDirtyRoots,
        maxRetries,
        maxDrainPasses,
      },
      totals: { ...totals },
    };
  }

  function dispose(options = {}) {
    if (disposePromise) return disposePromise;
    accepting = false;
    for (const entry of entries.values()) clearTimer(entry);
    disposePromise = (async () => {
      try {
        if (options.flush !== false) {
          await flushAll();
        } else {
          for (const entry of [...entries.values()]) cancelEntry(entry);
        }
        await operationTail;
      } finally {
        disposed = true;
        activeOwnership = null;
        for (const entry of entries.values()) clearTimer(entry);
        entries.clear();
      }
    })();
    return disposePromise;
  }

  return {
    activate,
    invalidate,
    markDirty,
    flushRoot,
    flushAll,
    snapshot,
    dispose,
  };
}

module.exports = {
  DirectoryAggregateBatcherError,
  StaleDirectoryAggregateContextError,
  createDirectoryAggregateBatcher,
  normalizeOwnership,
  normalizeRootPath,
  sameOwnership,
};
