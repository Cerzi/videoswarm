export const RENDER_LIMIT_MIN = 100;
export const RENDER_LIMIT_STEPS = 10;

export function clampRenderLimitStep(step) {
  if (!Number.isFinite(step)) return RENDER_LIMIT_STEPS;
  return Math.max(0, Math.min(RENDER_LIMIT_STEPS, Math.round(step)));
}

export function resolveRenderLimit(step, totalVideos) {
  const clampedStep = clampRenderLimitStep(step);
  const safeTotal = Number.isFinite(totalVideos) && totalVideos > 0 ? totalVideos : 0;

  if (safeTotal === 0) {
    return 0;
  }

  if (clampedStep >= RENDER_LIMIT_STEPS) {
    return safeTotal > 0 ? null : 0;
  }

  const effectiveMax = Math.max(RENDER_LIMIT_MIN, safeTotal);
  const range = Math.max(0, effectiveMax - RENDER_LIMIT_MIN);
  const fraction = clampedStep / RENDER_LIMIT_STEPS;
  const rawValue = Math.round(RENDER_LIMIT_MIN + range * fraction);
  return Math.min(rawValue, safeTotal || rawValue);
}

export function formatRenderLimitLabel(step, totalVideos) {
  const limit = resolveRenderLimit(step, totalVideos);
  if (limit === null) return "Max";
  if (limit <= 0) return "0";
  return String(limit);
}

export function inferRenderLimitStepFromLegacy(value) {
  if (!Number.isFinite(value) || value <= 0) return RENDER_LIMIT_STEPS;
  const LEGACY_MIN = 10;
  const LEGACY_MAX = 500;

  if (value >= LEGACY_MAX) return RENDER_LIMIT_STEPS;
  if (value <= RENDER_LIMIT_MIN) return 0;

  const normalized = (value - LEGACY_MIN) / (LEGACY_MAX - LEGACY_MIN);
  const clamped = Math.max(0, Math.min(1, normalized));
  return clampRenderLimitStep(Math.round(clamped * RENDER_LIMIT_STEPS));
}
