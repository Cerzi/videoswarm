export const PLAYBACK_MODES = Object.freeze({
  BALANCED: "balanced",
  ADAPTIVE_MOTION: "adaptive-motion",
  ALL_MOTION: "all-motion",
  STATIC_HOVER: "static-hover",
});

export const DEFAULT_PLAYBACK_MODE = PLAYBACK_MODES.BALANCED;

const MODE_VALUES = new Set(Object.values(PLAYBACK_MODES));
const DEFAULT_PIXEL_AREA = 1280 * 720;
const CLEAN_WINDOWS_TO_RECOVER = 3;

const finiteNumber = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const positiveInteger = (value, fallback) =>
  Math.max(1, Math.floor(finiteNumber(value, fallback)));

const nonNegativeInteger = (value, fallback = 0) =>
  Math.max(0, Math.floor(finiteNumber(value, fallback)));

const asSet = (value) => {
  if (value && typeof value.has === "function") return value;
  if (value && typeof value[Symbol.iterator] === "function") {
    return new Set(value);
  }
  return new Set();
};

export function normalizePlaybackMode(value) {
  return MODE_VALUES.has(value) ? value : DEFAULT_PLAYBACK_MODE;
}

/**
 * Derive a conservative upper bound before runtime health feedback is applied.
 * The cap represents simultaneous original-video decoders, not loaded cards.
 */
export function derivePlaybackSafetyCap({
  mode = DEFAULT_PLAYBACK_MODE,
  visibleCount = 0,
  platform = "linux",
  hardwareConcurrency = 4,
  systemMemoryMB = 8192,
  availableMemoryMB,
  averagePixelArea = DEFAULT_PIXEL_AREA,
} = {}) {
  const normalizedMode = normalizePlaybackMode(mode);
  const visible = nonNegativeInteger(visibleCount);
  if (visible === 0) return 0;

  // This is the explicit legacy-behaviour mode: every visible card may own a
  // decoder. Resource ownership, visibility suspension, and physical cleanup
  // still apply, but telemetry must not silently turn "All Motion" into a
  // partial-motion mode.
  if (normalizedMode === PLAYBACK_MODES.ALL_MOTION) return visible;

  const linux = String(platform || "").toLowerCase() === "linux";
  const cores = positiveInteger(hardwareConcurrency, 4);
  const systemMB = Math.max(1024, finiteNumber(systemMemoryMB, 8192));
  const availableMB = Math.max(
    0,
    finiteNumber(availableMemoryMB, systemMB * 0.5)
  );
  const pixelArea = Math.max(
    320 * 180,
    finiteNumber(averagePixelArea, DEFAULT_PIXEL_AREA)
  );

  const adaptiveMotion = normalizedMode === PLAYBACK_MODES.ADAPTIVE_MOTION;
  const coreMultiplier = adaptiveMotion
    ? linux
      ? 3
      : 4
    : linux
      ? 1
      : 1.5;
  const coreCap = Math.max(1, Math.floor(cores * coreMultiplier));

  // Keep a meaningful amount of RAM outside Chromium's decoded-frame pool.
  const totalMemoryPerDecoderMB = adaptiveMotion ? 640 : 896;
  const availableMemoryPerDecoderMB = adaptiveMotion ? 256 : 384;
  const totalMemoryCap = Math.max(
    1,
    Math.floor(systemMB / totalMemoryPerDecoderMB)
  );
  const availableMemoryCap = Math.max(
    1,
    Math.floor(availableMB / availableMemoryPerDecoderMB)
  );

  // Decode cost follows source pixels rather than the rendered tile size.
  const pixelsPerCore = (linux ? 1920 * 1080 : 2560 * 1440) *
    (adaptiveMotion ? 3 : 1.5);
  const pixelCap = Math.max(
    1,
    Math.floor((cores * pixelsPerCore) / pixelArea)
  );

  const platformCeiling = adaptiveMotion
    ? linux
      ? 64
      : 96
    : linux
      ? 24
      : 48;

  let cap = Math.min(
    visible,
    coreCap,
    totalMemoryCap,
    availableMemoryCap,
    pixelCap,
    platformCeiling
  );

  if (normalizedMode === PLAYBACK_MODES.STATIC_HOVER) {
    cap = Math.min(cap, 4);
  }

  return Math.max(1, cap);
}

const readPreviousDecision = (previous) => {
  if (Number.isFinite(Number(previous))) {
    return {
      target: nonNegativeInteger(previous),
      cleanWindows: 0,
      mode: null,
      health: "unknown",
      reasons: [],
    };
  }
  return {
    target: nonNegativeInteger(previous?.target),
    cleanWindows: nonNegativeInteger(previous?.cleanWindows),
    mode: previous?.mode ? normalizePlaybackMode(previous.mode) : null,
    health:
      typeof previous?.health === "string" ? previous.health : "unknown",
    reasons: Array.isArray(previous?.reasons) ? previous.reasons : [],
  };
};

const observedMetric = (value) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value));

/**
 * Advance the playback budget by one telemetry window.
 *
 * `previous` may be the prior decision object or a numeric prior target. The
 * returned object can be supplied directly as the next call's `previous`.
 */
export function nextPlaybackDecision(previous = null, input = {}) {
  const mode = normalizePlaybackMode(input.mode);
  const visibleCount = nonNegativeInteger(input.visibleCount);
  const prior = readPreviousDecision(previous);

  if (input.suspended || visibleCount === 0) {
    return {
      mode,
      target: 0,
      safetyCap: 0,
      cleanWindows: 0,
      health: input.suspended ? "suspended" : "idle",
      reasons: [input.suspended ? "suspended" : "no-visible-media"],
    };
  }

  if (mode === PLAYBACK_MODES.ALL_MOTION) {
    return {
      mode,
      target: visibleCount,
      safetyCap: visibleCount,
      cleanWindows: 0,
      health: "unrestricted",
      reasons: [],
    };
  }

  const safetyCap = derivePlaybackSafetyCap({ ...input, mode, visibleCount });
  const modeChanged = prior.mode !== null && prior.mode !== mode;
  let target = modeChanged
    ? safetyCap
    : prior.target > 0
    ? Math.min(prior.target, safetyCap)
    : safetyCap;

  // Visibility, layout, and source-pixel updates can all arrive between two
  // telemetry samples. Recalculate the structural cap for those updates, but
  // do not repeatedly apply the same health window and collapse the budget.
  if (input.advanceHealth === false) {
    const resetHealth =
      modeChanged || prior.health === "suspended" || prior.health === "idle";
    return {
      mode,
      target,
      safetyCap,
      cleanWindows: resetHealth ? 0 : prior.cleanWindows,
      health: resetHealth ? "unknown" : prior.health,
      reasons: resetHealth ? [] : prior.reasons,
    };
  }

  const frameDelayMs = finiteNumber(input.frameDelayMs, 0);
  const longTaskRate = finiteNumber(input.longTaskRate, 0);
  const droppedFrameRatio = finiteNumber(input.droppedFrameRatio, 0);
  const workingSetDeltaMB = finiteNumber(input.workingSetDeltaMB, 0);
  const systemMemoryMB = Math.max(
    1,
    finiteNumber(input.systemMemoryMB, 8192)
  );
  const availableMemoryMB = Math.max(
    0,
    finiteNumber(input.availableMemoryMB, systemMemoryMB * 0.5)
  );
  const availableFraction = availableMemoryMB / systemMemoryMB;

  const severeReasons = [];
  if (observedMetric(input.droppedFrameRatio) && droppedFrameRatio >= 0.1) {
    severeReasons.push("dropped-frames");
  }
  if (observedMetric(input.frameDelayMs) && frameDelayMs >= 120) {
    severeReasons.push("frame-delay");
  }
  if (observedMetric(input.longTaskRate) && longTaskRate >= 0.2) {
    severeReasons.push("long-tasks");
  }
  if (observedMetric(input.workingSetDeltaMB) && workingSetDeltaMB >= 256) {
    severeReasons.push("working-set-growth");
  }
  if (observedMetric(input.availableMemoryMB) && availableFraction < 0.05) {
    severeReasons.push("available-memory");
  }

  const moderateReasons = [];
  if (observedMetric(input.droppedFrameRatio) && droppedFrameRatio >= 0.04) {
    moderateReasons.push("dropped-frames");
  }
  if (observedMetric(input.frameDelayMs) && frameDelayMs >= 65) {
    moderateReasons.push("frame-delay");
  }
  if (observedMetric(input.longTaskRate) && longTaskRate >= 0.08) {
    moderateReasons.push("long-tasks");
  }
  if (observedMetric(input.workingSetDeltaMB) && workingSetDeltaMB >= 96) {
    moderateReasons.push("working-set-growth");
  }
  if (observedMetric(input.availableMemoryMB) && availableFraction < 0.1) {
    moderateReasons.push("available-memory");
  }

  if (severeReasons.length) {
    target = Math.max(1, Math.min(target - 1, Math.floor(target * 0.6)));
    return {
      mode,
      target,
      safetyCap,
      cleanWindows: 0,
      health: "critical",
      reasons: [...new Set(severeReasons)],
    };
  }

  if (moderateReasons.length) {
    const reduction = Math.max(1, Math.ceil(target * 0.25));
    target = Math.max(1, target - reduction);
    return {
      mode,
      target,
      safetyCap,
      cleanWindows: 0,
      health: "strained",
      reasons: [...new Set(moderateReasons)],
    };
  }

  const hasHealthSignal = [
    input.frameDelayMs,
    input.longTaskRate,
    input.droppedFrameRatio,
    input.workingSetDeltaMB,
    input.availableMemoryMB,
  ].some(observedMetric);
  const clean =
    hasHealthSignal &&
    (!observedMetric(input.frameDelayMs) || frameDelayMs <= 32) &&
    (!observedMetric(input.longTaskRate) || longTaskRate <= 0.02) &&
    (!observedMetric(input.droppedFrameRatio) || droppedFrameRatio <= 0.01) &&
    (!observedMetric(input.workingSetDeltaMB) || workingSetDeltaMB <= 32) &&
    (!observedMetric(input.availableMemoryMB) || availableFraction >= 0.15);

  let cleanWindows = clean ? prior.cleanWindows + 1 : 0;
  if (target < safetyCap && cleanWindows >= CLEAN_WINDOWS_TO_RECOVER) {
    target = Math.min(safetyCap, target + 1);
    cleanWindows = 0;
  }

  return {
    mode,
    target,
    safetyCap,
    cleanWindows,
    health: clean ? "healthy" : "unknown",
    reasons: [],
  };
}

export function isPlaybackEligible({
  id,
  mode = DEFAULT_PLAYBACK_MODE,
  visibleIds,
  loadedIds = null,
  hoveredId = null,
  selectedIds,
} = {}) {
  if (id == null) return false;
  const visible = asSet(visibleIds);
  const loaded = loadedIds == null ? null : asSet(loadedIds);
  if (!visible.has(id) || (loaded && !loaded.has(id))) return false;

  if (normalizePlaybackMode(mode) !== PLAYBACK_MODES.STATIC_HOVER) {
    return true;
  }

  return id === hoveredId || asSet(selectedIds).has(id);
}

/**
 * Build a stable decoder candidate list without iterating a potentially huge
 * selection. Hover wins, followed by selected cards in viewport-center order,
 * then the remaining center-ordered visible cards.
 */
export function buildPlaybackPriority({
  mode = DEFAULT_PLAYBACK_MODE,
  visibleIds,
  loadedIds = null,
  viewportCenterIds = [],
  centerOrderedIds = null,
  hoveredId = null,
  selectedIds,
} = {}) {
  const normalizedMode = normalizePlaybackMode(mode);
  const visible = asSet(visibleIds);
  const loaded = loadedIds == null ? null : asSet(loadedIds);
  const selected = asSet(selectedIds);
  const centerOrder = centerOrderedIds || viewportCenterIds || [];
  const orderedVisible = [];
  const orderedVisibleSet = new Set();

  const noteVisible = (id) => {
    if (
      id == null ||
      orderedVisibleSet.has(id) ||
      !visible.has(id) ||
      (loaded && !loaded.has(id))
    ) {
      return;
    }
    orderedVisibleSet.add(id);
    orderedVisible.push(id);
  };

  for (const id of centerOrder) noteVisible(id);
  for (const id of visible) noteVisible(id);

  const result = [];
  const included = new Set();
  const add = (id) => {
    if (id == null || included.has(id) || !orderedVisibleSet.has(id)) return;
    included.add(id);
    result.push(id);
  };

  add(hoveredId);
  for (const id of orderedVisible) {
    if (selected.has(id)) add(id);
  }

  if (normalizedMode === PLAYBACK_MODES.STATIC_HOVER) {
    return result;
  }

  for (const id of orderedVisible) add(id);
  return result;
}
