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
// (keep aligned with your CSS minmax widths/heights)
export const ZOOM_TILE_WIDTHS = [150, 200, 300, 400, 650];

export const ZOOM_MIN_INDEX = 0;
export const ZOOM_MAX_INDEX = ZOOM_TILE_WIDTHS.length - 1;
