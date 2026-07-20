const ZOOM_MIN_LEVEL = 0;
const ZOOM_MAX_LEVEL = 4;
const ZOOM_LEVEL_STEP = 0.5;

function normalizeZoomLevel(value, fallback = 1) {
  const fallbackNumber = Number(fallback);
  const safeFallback = Number.isFinite(fallbackNumber)
    ? fallbackNumber
    : 1;
  const numeric = Number(value);
  const candidate = Number.isFinite(numeric) ? numeric : safeFallback;
  const clamped = Math.min(
    ZOOM_MAX_LEVEL,
    Math.max(ZOOM_MIN_LEVEL, candidate)
  );
  return (
    Math.round((clamped - ZOOM_MIN_LEVEL) / ZOOM_LEVEL_STEP) *
      ZOOM_LEVEL_STEP +
    ZOOM_MIN_LEVEL
  );
}

module.exports = {
  ZOOM_LEVEL_STEP,
  ZOOM_MAX_LEVEL,
  ZOOM_MIN_LEVEL,
  normalizeZoomLevel,
};
