// Central zoom configuration

// Class names must match your CSS definitions in App.css
export const ZOOM_CLASSES = [
  "zoom-small",
  "zoom-medium",
  "zoom-large",
  "zoom-xlarge",
  "zoom-xxlarge",
];

// Card width at each whole zoom level (a column's width in the masonry
// layout; a row's height is this width at 16:9). Levels 0-4 are the historic
// five and keep their widths, so a saved zoom shows the same size; 5-8 go on
// to about two cards across a 4K screen, each roughly 1.3x the one before.
export const ZOOM_TILE_WIDTHS = [150, 200, 300, 400, 650, 850, 1100, 1450, 1900];

export const ZOOM_MIN_INDEX = 0;
export const ZOOM_MAX_INDEX = ZOOM_TILE_WIDTHS.length - 1;

// Levels between the whole ones interpolate their widths, so the historic
// whole and half levels keep their meaning while the control gains precision:
// a quarter step is about 8% from 650px up. main/zoom-settings.js keeps the
// same range and step for saved settings.
export const ZOOM_LEVEL_STEP = 0.25;

export const ZOOM_LEVELS = Object.freeze(
  Array.from(
    { length: Math.round((ZOOM_MAX_INDEX - ZOOM_MIN_INDEX) / ZOOM_LEVEL_STEP) + 1 },
    (_, index) => ZOOM_MIN_INDEX + index * ZOOM_LEVEL_STEP
  )
);
