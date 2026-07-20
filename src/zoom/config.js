// Central zoom configuration

// Class names must match your CSS definitions in App.css
export const ZOOM_CLASSES = [
  "zoom-small",
  "zoom-medium",
  "zoom-large",
  "zoom-xlarge",
  "zoom-xxlarge",
];

// Approx. tile widths used by the memory-safety estimator
export const ZOOM_TILE_WIDTHS = [150, 200, 300, 400, 650];

export const ZOOM_MIN_INDEX = 0;
export const ZOOM_MAX_INDEX = ZOOM_TILE_WIDTHS.length - 1;

// Preserve the meaning of the five historic integer levels while exposing a
// useful intermediate size between each pair. This avoids silently resizing
// existing profiles when the control gains more precision.
export const ZOOM_LEVEL_STEP = 0.5;

export const ZOOM_LEVELS = Object.freeze(
  Array.from(
    { length: Math.round((ZOOM_MAX_INDEX - ZOOM_MIN_INDEX) / ZOOM_LEVEL_STEP) + 1 },
    (_, index) => ZOOM_MIN_INDEX + index * ZOOM_LEVEL_STEP
  )
);
