// How much media a card needs for the size it is shown at.
//
// A playback proxy fits a 1280x720 box (main/proxy-manager.js), so a card
// shown much larger than that plays the original instead. A card's still
// frame is captured near the card's width, in steps, so that zooming changes
// the props of big cards only.

export const PROXY_BOX = Object.freeze({ width: 1280, height: 720 });

// How far a proxy may be stretched before it looks soft.
const PROXY_STRETCH = 1.15;

export const POSTER_WIDTHS = Object.freeze({ base: 480, step: 160, max: 1280 });

const devicePixels = (cssPixels, pixelRatio) =>
  (Number(cssPixels) || 0) * (Number(pixelRatio) > 0 ? Number(pixelRatio) : 1);

/**
 * Whether a card of this size still looks sharp playing the clip's proxy.
 * Clips of unknown dimensions keep the proxy, as before.
 */
export function proxyIsSharpEnough(dimensions, cardWidth, cardHeight, pixelRatio = 1) {
  const width = Number(dimensions?.width);
  const height = Number(dimensions?.height);
  if (!(width > 0 && height > 0)) return true;
  const scale = Math.min(1, PROXY_BOX.width / width, PROXY_BOX.height / height);
  return (
    devicePixels(cardWidth, pixelRatio) <= width * scale * PROXY_STRETCH &&
    devicePixels(cardHeight, pixelRatio) <= height * scale * PROXY_STRETCH
  );
}

/** The width to capture a card's still frame at, in device pixels. */
export function posterWidthFor(cardWidth, pixelRatio = 1) {
  const { base, step, max } = POSTER_WIDTHS;
  const wanted = devicePixels(cardWidth, pixelRatio);
  if (!(wanted > base)) return base;
  return Math.min(max, base + Math.ceil((wanted - base) / step) * step);
}
