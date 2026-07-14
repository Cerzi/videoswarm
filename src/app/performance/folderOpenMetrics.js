const EVENT_NAME = "videoswarm:folder-performance";
const MARK_PREFIX = "videoswarm:folder-open";
const MAX_RETAINED_SCANS = 16;

export const FOLDER_OPEN_MILESTONES = Object.freeze({
  REQUEST: "request",
  CACHED_PREVIEW: "cached-preview",
  FIRST_BATCH: "first-batch",
  FIRST_USABLE_GRID: "first-usable-grid",
  ENRICHMENT_COMPLETE: "enrichment-complete",
  SCAN_COMPLETE: "scan-complete",
  CANCELLED: "cancelled",
  ERROR: "error",
});

const ALLOWED_MILESTONES = new Set(Object.values(FOLDER_OPEN_MILESTONES));
const TERMINAL_MILESTONES = new Set([
  FOLDER_OPEN_MILESTONES.SCAN_COMPLETE,
  FOLDER_OPEN_MILESTONES.CANCELLED,
  FOLDER_OPEN_MILESTONES.ERROR,
]);
const sessions = new Map();

function now() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function markName(scanId, milestone) {
  return `${MARK_PREFIX}:${scanId}:${milestone}`;
}

function measureName(scanId, milestone) {
  return `${MARK_PREFIX}:${scanId}:request-to-${milestone}`;
}

function callPerformance(method, ...args) {
  try {
    if (typeof performance?.[method] === "function") {
      performance[method](...args);
    }
  } catch {
    // User Timing is observability only. It must never break folder opening.
  }
}

function clearSessionTiming(scanId) {
  for (const milestone of ALLOWED_MILESTONES) {
    callPerformance("clearMarks", markName(scanId, milestone));
    callPerformance("clearMeasures", measureName(scanId, milestone));
  }
}

function trimSessions() {
  while (sessions.size > MAX_RETAINED_SCANS) {
    const oldestScanId = sessions.keys().next().value;
    sessions.delete(oldestScanId);
    clearSessionTiming(oldestScanId);
  }
}

function dispatchMetric(detail) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") {
    return;
  }

  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  } catch {
    // Some non-browser test runtimes do not expose CustomEvent.
  }
}

function normalizeDetails(details) {
  if (!details || typeof details !== "object") return {};
  const normalized = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      normalized[key] = value;
    } else if (typeof value === "string") {
      normalized[key] = value.slice(0, 512);
    }
  }
  return normalized;
}

export function beginFolderOpenMeasurement({
  scanId,
  rootPath = "",
  recursive = false,
} = {}) {
  if (typeof scanId !== "string" || scanId.length === 0) return null;

  clearSessionTiming(scanId);
  const startedAt = now();
  const session = {
    scanId,
    rootPath: typeof rootPath === "string" ? rootPath.slice(0, 4096) : "",
    recursive: Boolean(recursive),
    startedAt,
    milestones: new Map(),
    terminal: false,
    terminalMilestone: null,
  };
  sessions.delete(scanId);
  sessions.set(scanId, session);
  trimSessions();
  callPerformance("mark", markName(scanId, FOLDER_OPEN_MILESTONES.REQUEST));

  const detail = Object.freeze({
    schemaVersion: 1,
    scanId,
    milestone: FOLDER_OPEN_MILESTONES.REQUEST,
    elapsedMs: 0,
    recursive: session.recursive,
    rootPath: session.rootPath,
  });
  session.milestones.set(FOLDER_OPEN_MILESTONES.REQUEST, detail);
  dispatchMetric(detail);
  return detail;
}

export function recordFolderOpenMilestone(scanId, milestone, details = {}) {
  if (!ALLOWED_MILESTONES.has(milestone)) return null;
  const session = sessions.get(scanId);
  if (!session || session.milestones.has(milestone)) return null;
  if (
    session.terminal &&
    !TERMINAL_MILESTONES.has(milestone) &&
    !(
      session.terminalMilestone === FOLDER_OPEN_MILESTONES.SCAN_COMPLETE &&
      milestone === FOLDER_OPEN_MILESTONES.FIRST_USABLE_GRID
    )
  ) {
    return null;
  }

  const elapsedMs = Math.max(0, now() - session.startedAt);
  callPerformance("mark", markName(scanId, milestone));
  callPerformance(
    "measure",
    measureName(scanId, milestone),
    markName(scanId, FOLDER_OPEN_MILESTONES.REQUEST),
    markName(scanId, milestone)
  );

  const detail = Object.freeze({
    schemaVersion: 1,
    scanId,
    milestone,
    elapsedMs,
    recursive: session.recursive,
    rootPath: session.rootPath,
    ...normalizeDetails(details),
  });
  session.milestones.set(milestone, detail);
  if (TERMINAL_MILESTONES.has(milestone)) {
    session.terminal = true;
    session.terminalMilestone = milestone;
  }
  dispatchMetric(detail);
  return detail;
}

export function getFolderOpenMeasurement(scanId) {
  const session = sessions.get(scanId);
  if (!session) return null;
  return {
    scanId: session.scanId,
    rootPath: session.rootPath,
    recursive: session.recursive,
    terminal: session.terminal,
    milestones: Object.fromEntries(session.milestones),
  };
}

export function resetFolderOpenMeasurements() {
  for (const scanId of sessions.keys()) clearSessionTiming(scanId);
  sessions.clear();
}

export const FOLDER_OPEN_PERFORMANCE_EVENT = EVENT_NAME;
