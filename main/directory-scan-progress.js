const DEFAULT_THROTTLE_MS = 150;
const DEFAULT_YIELD_EVERY = 64;

const COUNTER_FIELDS = [
  "directoriesScanned",
  "entriesChecked",
  "videosFound",
  "indexedFiles",
  "enrichedFiles",
  "fingerprintsReused",
  "warnings",
];

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function normalizeOptionalTotal(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return nonNegativeInteger(value, null);
}

function canSend(sender) {
  if (!sender || typeof sender.send !== "function") {
    return false;
  }
  try {
    return typeof sender.isDestroyed !== "function" || !sender.isDestroyed();
  } catch {
    return false;
  }
}

/**
 * Create a scan-owned telemetry reporter. Updates are merged before throttling,
 * so the next emitted snapshot always contains the newest counters. Lifetime
 * counters never move backwards; phaseCurrent may reset when the phase changes.
 */
function createDirectoryScanProgressReporter({
  scanId,
  sender,
  rootPath = "",
  recursive = false,
  throttleMs = DEFAULT_THROTTLE_MS,
  now = Date.now,
} = {}) {
  if (typeof scanId !== "string" || scanId.length === 0) {
    throw new TypeError("A non-empty scanId is required");
  }

  const startedAt = nonNegativeInteger(now(), Date.now());
  const safeThrottleMs = nonNegativeInteger(throttleMs, DEFAULT_THROTTLE_MS);
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let sequence = 0;
  let state = {
    scanId,
    phase: "preparing",
    phaseCurrent: 0,
    phaseTotal: null,
    directoriesScanned: 0,
    entriesChecked: 0,
    videosFound: 0,
    indexedFiles: 0,
    enrichedFiles: 0,
    fingerprintsReused: 0,
    warnings: 0,
    currentPath: "",
    rootPath: typeof rootPath === "string" ? rootPath : "",
    recursive: Boolean(recursive),
    message: null,
    startedAt,
  };

  function updateState(patch = {}) {
    const phaseChanged =
      typeof patch.phase === "string" && patch.phase !== state.phase;
    const next = { ...state, ...patch };

    next.scanId = scanId;
    next.rootPath = state.rootPath;
    next.recursive = state.recursive;
    next.startedAt = startedAt;
    next.phase =
      typeof next.phase === "string" && next.phase.length > 0
        ? next.phase
        : state.phase;
    next.phaseCurrent = nonNegativeInteger(
      next.phaseCurrent,
      phaseChanged ? 0 : state.phaseCurrent
    );
    next.phaseTotal = normalizeOptionalTotal(next.phaseTotal);
    if (
      next.phaseTotal !== null &&
      next.phaseCurrent > next.phaseTotal
    ) {
      next.phaseCurrent = next.phaseTotal;
    }

    COUNTER_FIELDS.forEach((field) => {
      next[field] = Math.max(
        state[field],
        nonNegativeInteger(next[field], state[field])
      );
    });

    next.currentPath =
      typeof next.currentPath === "string" ? next.currentPath : state.currentPath;
    next.message =
      typeof next.message === "string" && next.message.length > 0
        ? next.message
        : null;
    state = next;
    return phaseChanged;
  }

  function report(patch = {}, options = {}) {
    const phaseChanged = updateState(patch);
    const updatedAt = nonNegativeInteger(now(), startedAt);
    const force = Boolean(options.force || phaseChanged);
    if (!force && updatedAt - lastSentAt < safeThrottleMs) {
      return false;
    }
    if (!canSend(sender)) {
      return false;
    }

    const snapshot = {
      ...state,
      sequence: sequence + 1,
      updatedAt,
      elapsedMs: Math.max(0, updatedAt - startedAt),
    };
    try {
      sender.send("directory-scan-progress", snapshot);
    } catch {
      return false;
    }

    sequence += 1;
    lastSentAt = updatedAt;
    return true;
  }

  function setPhase(phase, patch = {}) {
    return report({ ...patch, phase, phaseCurrent: patch.phaseCurrent ?? 0 }, {
      force: true,
    });
  }

  function getSnapshot() {
    const updatedAt = nonNegativeInteger(now(), startedAt);
    return {
      ...state,
      sequence,
      updatedAt,
      elapsedMs: Math.max(0, updatedAt - startedAt),
    };
  }

  return { report, setPhase, getSnapshot };
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Return a cheap counter function. It returns null most of the time and a
 * Promise only when a real event-loop yield is due, avoiding an `await` and
 * Promise allocation on every item in a hot loop.
 */
function createPeriodicEventLoopYielder({
  every = DEFAULT_YIELD_EVERY,
  yieldFn = yieldToEventLoop,
} = {}) {
  const safeEvery = Math.max(1, nonNegativeInteger(every, DEFAULT_YIELD_EVERY));
  let pendingOperations = 0;

  return function maybeYield(operations = 1) {
    pendingOperations += Math.max(1, nonNegativeInteger(operations, 1));
    if (pendingOperations < safeEvery) {
      return null;
    }
    pendingOperations = 0;
    return Promise.resolve().then(yieldFn);
  };
}

module.exports = {
  DEFAULT_THROTTLE_MS,
  DEFAULT_YIELD_EVERY,
  createDirectoryScanProgressReporter,
  createPeriodicEventLoopYielder,
  yieldToEventLoop,
};
