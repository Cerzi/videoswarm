const finiteCount = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
};

const nullableCount = (value, fallback = null) => {
  if (value === null || value === undefined) return fallback;
  return finiteCount(value, fallback ?? 0);
};

export const SCAN_PHASE_MESSAGES = Object.freeze({
  preparing: "Preparing folder scan",
  enumerating: "Discovering video files",
  indexing: "Indexing and fingerprinting files",
  reconciling: "Updating the library index",
  enriching: "Reading video details",
  finalizing: "Preparing the video grid",
  complete: "Collection ready",
  cancelled: "Scan cancelled",
  error: "Couldn’t open this collection",
});

export const EMPTY_SCAN_LOADING_STATUS = Object.freeze({
  scanId: null,
  phase: "idle",
  rootPath: "",
  currentPath: "",
  recursive: false,
  directoriesScanned: 0,
  entriesInspected: 0,
  videosDiscovered: 0,
  indexed: 0,
  prepared: 0,
  completed: null,
  total: null,
  fingerprintsReused: 0,
  warnings: 0,
  startedAt: null,
  updatedAt: null,
  message: "",
  error: null,
});

export function createScanLoadingStatus({
  scanId,
  rootPath,
  recursive = false,
  startedAt = Date.now(),
} = {}) {
  return {
    ...EMPTY_SCAN_LOADING_STATUS,
    scanId: scanId ?? null,
    phase: "preparing",
    rootPath: rootPath || "",
    recursive: Boolean(recursive),
    startedAt,
    updatedAt: startedAt,
    message: "Preparing folder scan",
  };
}

export function mergeScanLoadingProgress(previous, payload = {}) {
  const base = previous || EMPTY_SCAN_LOADING_STATUS;
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(payload, key);
  const rawCurrent = hasOwn("phaseCurrent")
    ? payload.phaseCurrent
    : hasOwn("completed")
      ? payload.completed
      : payload.current;
  const rawTotal = hasOwn("phaseTotal")
    ? payload.phaseTotal
    : payload.total;
  const hasExplicitCurrent =
    hasOwn("phaseCurrent") || hasOwn("completed") || hasOwn("current");
  const hasExplicitTotal = hasOwn("phaseTotal") || hasOwn("total");
  const phaseCurrent =
    hasExplicitCurrent && rawCurrent === null
      ? null
      : nullableCount(rawCurrent, base.completed);
  const phaseTotal =
    hasExplicitTotal && rawTotal === null
      ? null
      : nullableCount(rawTotal, base.total);
  const nextPhase = payload.phase || base.phase;
  const phaseChanged = nextPhase !== base.phase;
  const defaultMessage = SCAN_PHASE_MESSAGES[nextPhase] || base.message;

  return {
    ...base,
    scanId: payload.scanId ?? base.scanId,
    phase: nextPhase,
    rootPath: payload.rootPath ?? base.rootPath,
    currentPath: payload.currentPath ?? base.currentPath,
    recursive:
      payload.recursive === undefined
        ? base.recursive
        : Boolean(payload.recursive),
    directoriesScanned: finiteCount(
      payload.directoriesScanned,
      base.directoriesScanned
    ),
    entriesInspected: finiteCount(
      payload.entriesInspected ?? payload.entriesChecked,
      base.entriesInspected
    ),
    videosDiscovered: finiteCount(
      payload.videosDiscovered ?? payload.videosFound,
      base.videosDiscovered
    ),
    indexed: finiteCount(
      payload.indexed ?? payload.indexedFiles,
      base.indexed
    ),
    prepared: finiteCount(
      payload.prepared ?? payload.enrichedFiles,
      base.prepared
    ),
    completed: phaseCurrent,
    total: phaseTotal,
    fingerprintsReused: finiteCount(
      payload.fingerprintsReused,
      base.fingerprintsReused
    ),
    warnings: finiteCount(payload.warnings, base.warnings),
    startedAt: payload.startedAt ?? base.startedAt,
    updatedAt: payload.updatedAt ?? Date.now(),
    message:
      payload.message ?? (phaseChanged ? defaultMessage : base.message),
    error: payload.error ?? null,
  };
}

export function getLoadingProgressPercent(status) {
  const current = nullableCount(status?.completed);
  const total = nullableCount(status?.total);
  if (current === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}
