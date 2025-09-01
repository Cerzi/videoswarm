import {
  ZOOM_CLASSES,
  ZOOM_TILE_WIDTHS,
  ZOOM_MIN_INDEX,
  ZOOM_MAX_INDEX,
} from "./config.js";

export const clampZoomIndex = (i) =>
  Math.min(ZOOM_MAX_INDEX, Math.max(ZOOM_MIN_INDEX, i));

export const zoomClassForLevel = (i) =>
  ZOOM_CLASSES[clampZoomIndex(i)] ?? ZOOM_CLASSES[1];

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
  const perRow = ZOOM_TILE_WIDTHS.map((w) =>
    Math.max(1, Math.floor(windowWidth / w))
  );
  const visible = perRow.map((n) => n * rowsVisible);
  const pressure = visible.map((v) => (v * mbPerTile) / mbBudget);

  const idx = pressure.findIndex((p) => p < pressureThreshold);
  return idx !== -1 ? idx : ZOOM_MAX_INDEX;
}
