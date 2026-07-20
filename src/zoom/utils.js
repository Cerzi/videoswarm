import {
  ZOOM_CLASSES,
  ZOOM_TILE_WIDTHS,
  ZOOM_MIN_INDEX,
  ZOOM_MAX_INDEX,
  ZOOM_LEVEL_STEP,
  ZOOM_LEVELS,
} from "./config.js";

export const clampZoomIndex = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  const clamped = Math.min(
    ZOOM_MAX_INDEX,
    Math.max(ZOOM_MIN_INDEX, numeric)
  );
  return (
    Math.round((clamped - ZOOM_MIN_INDEX) / ZOOM_LEVEL_STEP) *
      ZOOM_LEVEL_STEP +
    ZOOM_MIN_INDEX
  );
};

export const zoomClassForLevel = (i) =>
  ZOOM_CLASSES[Math.round(clampZoomIndex(i))] ?? ZOOM_CLASSES[1];

export const getTileWidthForZoomLevel = (value) => {
  const level = clampZoomIndex(value);
  const lowerIndex = Math.floor(level);
  const upperIndex = Math.ceil(level);
  const lowerWidth = ZOOM_TILE_WIDTHS[lowerIndex] ?? ZOOM_TILE_WIDTHS[1] ?? 200;
  const upperWidth = ZOOM_TILE_WIDTHS[upperIndex] ?? lowerWidth;
  if (lowerIndex === upperIndex) return lowerWidth;
  const progress = level - lowerIndex;
  return Math.round(lowerWidth + (upperWidth - lowerWidth) * progress);
};

/**
 * Dynamic safety estimator: pick the first zoom level whose
 * memory pressure estimate is below the threshold; otherwise return the max.
 */
export function calculateSafeZoom(windowWidth, windowHeight, videoCount, {
  rowsVisible = 5,
  mbPerTile = 15,
  mbBudget = 3600,
  pressureThreshold = 0.8,
} = {}) {
  const perRow = ZOOM_LEVELS.map((level) =>
    getTileWidthForZoomLevel(level)
  ).map((w) =>
    Math.max(1, Math.floor(windowWidth / w))
  );
  const visible = perRow.map((n) => n * rowsVisible);
  const pressure = visible.map((v) => (v * mbPerTile) / mbBudget);

  const idx = pressure.findIndex((p) => p < pressureThreshold);
  return idx !== -1 ? ZOOM_LEVELS[idx] : ZOOM_MAX_INDEX;
}
