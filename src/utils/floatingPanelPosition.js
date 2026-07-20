export const FloatingPanelSide = Object.freeze({
  LEFT: "left",
  RIGHT: "right",
  BELOW: "below",
  ABOVE: "above",
  SHEET: "sheet",
  FALLBACK: "fallback",
});

export const DEFAULT_FLOATING_PANEL_MARGIN = 12;
export const DEFAULT_FLOATING_PANEL_GAP = 12;
export const DEFAULT_NARROW_FLOATING_PANEL_BREAKPOINT = 680;

const finiteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const normalizeSize = (size) => ({
  width: Math.max(0, finiteNumber(size?.width)),
  height: Math.max(0, finiteNumber(size?.height)),
});

const normalizeRect = (rect) => {
  if (!rect) return null;

  const rawLeft = finiteNumber(rect.left, finiteNumber(rect.x));
  const rawTop = finiteNumber(rect.top, finiteNumber(rect.y));
  const rawRight = Number.isFinite(Number(rect.right))
    ? Number(rect.right)
    : rawLeft + Math.max(0, finiteNumber(rect.width));
  const rawBottom = Number.isFinite(Number(rect.bottom))
    ? Number(rect.bottom)
    : rawTop + Math.max(0, finiteNumber(rect.height));
  const left = Math.min(rawLeft, rawRight);
  const right = Math.max(rawLeft, rawRight);
  const top = Math.min(rawTop, rawBottom);
  const bottom = Math.max(rawTop, rawBottom);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
};

const intersectRects = (first, second) => {
  if (!first || !second) return null;
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  if (right <= left || bottom <= top) return null;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
};

const positionRect = (position, size) => ({
  left: position.x,
  top: position.y,
  right: position.x + size.width,
  bottom: position.y + size.height,
  width: size.width,
  height: size.height,
});

const intersectionArea = (first, second) => {
  const intersection = intersectRects(first, second);
  return intersection ? intersection.width * intersection.height : 0;
};

const overflowArea = (rect, bounds) => {
  const area = Math.max(1, rect.width * rect.height);
  return Math.max(0, area - intersectionArea(rect, bounds));
};

const insetRect = (rect, margin) => {
  const inset = Math.max(0, finiteNumber(margin));
  const horizontalInset = Math.min(inset, rect.width / 2);
  const verticalInset = Math.min(inset, rect.height / 2);
  return {
    left: rect.left + horizontalInset,
    top: rect.top + verticalInset,
    right: rect.right - horizontalInset,
    bottom: rect.bottom - verticalInset,
    width: Math.max(0, rect.width - horizontalInset * 2),
    height: Math.max(0, rect.height - verticalInset * 2),
  };
};

/**
 * Clamp viewport-space panel coordinates to a viewport-space bounding rect.
 * When the panel is larger than the available area, its leading edge remains
 * visible; the component should independently cap its CSS width and height.
 */
export function clampFloatingPanelPosition(
  position,
  panelSize,
  boundsRect,
  margin = DEFAULT_FLOATING_PANEL_MARGIN
) {
  const size = normalizeSize(panelSize);
  const bounds = normalizeRect(boundsRect) || {
    left: 0,
    top: 0,
    right: size.width,
    bottom: size.height,
    width: size.width,
    height: size.height,
  };
  const safeBounds = insetRect(bounds, margin);
  const minX = safeBounds.left;
  const minY = safeBounds.top;
  const maxX = Math.max(minX, safeBounds.right - size.width);
  const maxY = Math.max(minY, safeBounds.bottom - size.height);
  const requestedX = finiteNumber(position?.x, minX);
  const requestedY = finiteNumber(position?.y, minY);

  return {
    x: Math.max(minX, Math.min(requestedX, maxX)),
    y: Math.max(minY, Math.min(requestedY, maxY)),
  };
}

/**
 * Detect the compact bottom-sheet fallback used when a side-by-side inspector
 * would consume most of a narrow gallery. A valid side placement always wins.
 */
export function isNarrowFloatingPanel({
  boundsRect,
  galleryRect,
  anchorRect,
  panelSize,
  margin = DEFAULT_FLOATING_PANEL_MARGIN,
  gap = DEFAULT_FLOATING_PANEL_GAP,
  breakpoint = DEFAULT_NARROW_FLOATING_PANEL_BREAKPOINT,
} = {}) {
  const hardBounds = normalizeRect(boundsRect || galleryRect);
  if (!hardBounds) return false;
  const gallery =
    intersectRects(normalizeRect(galleryRect), hardBounds) || hardBounds;
  const safeGallery = insetRect(gallery, margin);
  const anchor = normalizeRect(anchorRect);
  const size = normalizeSize(panelSize);
  const usableWidth = safeGallery.width;
  const narrowWidth = Math.max(0, finiteNumber(breakpoint));

  if (size.width > usableWidth) return true;
  if (usableWidth <= narrowWidth) return true;

  if (!anchor) {
    return size.width >= usableWidth * 0.78;
  }

  const safeGap = Math.max(0, finiteNumber(gap));
  const leftSpace = Math.max(0, anchor.left - safeGallery.left - safeGap);
  const rightSpace = Math.max(0, safeGallery.right - anchor.right - safeGap);
  const sideFits = Math.max(leftSpace, rightSpace) >= size.width;

  if (sideFits) return false;
  return size.width >= usableWidth * 0.78;
}

const inferOppositeMenuSide = (anchor, avoid, fallbackSide) => {
  if (!anchor || !avoid) return fallbackSide;
  const anchorCenter = anchor.left + anchor.width / 2;
  const avoidCenter = avoid.left + avoid.width / 2;
  return avoidCenter < anchorCenter
    ? FloatingPanelSide.RIGHT
    : FloatingPanelSide.LEFT;
};

const preferredSideOrder = (preferredSide) => {
  const opposite =
    preferredSide === FloatingPanelSide.RIGHT
      ? FloatingPanelSide.LEFT
      : FloatingPanelSide.RIGHT;
  return [
    preferredSide,
    opposite,
    FloatingPanelSide.BELOW,
    FloatingPanelSide.ABOVE,
  ];
};

const makeCandidates = (anchor, size, gap) => ({
  [FloatingPanelSide.LEFT]: {
    x: anchor.left - gap - size.width,
    y: anchor.top,
  },
  [FloatingPanelSide.RIGHT]: {
    x: anchor.right + gap,
    y: anchor.top,
  },
  [FloatingPanelSide.BELOW]: {
    x: anchor.left + (anchor.width - size.width) / 2,
    y: anchor.bottom + gap,
  },
  [FloatingPanelSide.ABOVE]: {
    x: anchor.left + (anchor.width - size.width) / 2,
    y: anchor.top - gap - size.height,
  },
});

const scoreCandidate = ({
  rawPosition,
  clampedPosition,
  size,
  hardBounds,
  preferredBounds,
  anchor,
  avoid,
  preferenceRank,
}) => {
  const rawRect = positionRect(rawPosition, size);
  const clampedRect = positionRect(clampedPosition, size);
  const panelArea = Math.max(1, size.width * size.height);
  const hardOverflow = overflowArea(rawRect, hardBounds) / panelArea;
  const preferredOverflow = overflowArea(clampedRect, preferredBounds) / panelArea;
  const avoidOverlap = avoid
    ? intersectionArea(clampedRect, avoid) / panelArea
    : 0;
  const anchorOverlap = intersectionArea(clampedRect, anchor) / panelArea;
  const travel =
    (Math.abs(clampedPosition.x - rawPosition.x) +
      Math.abs(clampedPosition.y - rawPosition.y)) /
    Math.max(1, size.width + size.height);

  return (
    hardOverflow * 1000 +
    avoidOverlap * 500 +
    anchorOverlap * 350 +
    preferredOverflow * 120 +
    travel * 20 +
    preferenceRank
  );
};

/**
 * Compute an initial floating-panel position in viewport coordinates.
 *
 * `boundsRect` is the hard content-region boundary. `galleryRect` is the
 * preferred initial-placement area, so the library sidebar is avoided when
 * practical. `avoidRect` should be the context menu's fitted viewport rect.
 */
export function computeFloatingPanelPosition({
  anchorRect,
  panelSize,
  boundsRect,
  galleryRect,
  avoidRect,
  margin = DEFAULT_FLOATING_PANEL_MARGIN,
  gap = DEFAULT_FLOATING_PANEL_GAP,
  preferredSide = FloatingPanelSide.LEFT,
  narrowBreakpoint = DEFAULT_NARROW_FLOATING_PANEL_BREAKPOINT,
  forceSheet,
} = {}) {
  const size = normalizeSize(panelSize);
  const hardBounds = normalizeRect(boundsRect || galleryRect) || {
    left: 0,
    top: 0,
    right: size.width,
    bottom: size.height,
    width: size.width,
    height: size.height,
  };
  const preferredBounds =
    intersectRects(normalizeRect(galleryRect), hardBounds) || hardBounds;
  const anchor = normalizeRect(anchorRect);
  const avoid = normalizeRect(avoidRect);
  const safeMargin = Math.max(0, finiteNumber(margin));
  const safeGap = Math.max(0, finiteNumber(gap));
  const fallbackSide =
    preferredSide === FloatingPanelSide.RIGHT
      ? FloatingPanelSide.RIGHT
      : FloatingPanelSide.LEFT;
  const oppositeMenuSide = inferOppositeMenuSide(anchor, avoid, fallbackSide);
  const sheet =
    typeof forceSheet === "boolean"
      ? forceSheet
      : isNarrowFloatingPanel({
          boundsRect: hardBounds,
          galleryRect: preferredBounds,
          anchorRect: anchor,
          panelSize: size,
          margin: safeMargin,
          gap: safeGap,
          breakpoint: narrowBreakpoint,
        });

  if (sheet) {
    const sheetPosition = clampFloatingPanelPosition(
      {
        x: preferredBounds.left + (preferredBounds.width - size.width) / 2,
        y: preferredBounds.bottom - safeMargin - size.height,
      },
      size,
      hardBounds,
      safeMargin
    );
    return {
      ...sheetPosition,
      side: FloatingPanelSide.SHEET,
      sheet: true,
      preferredSide: oppositeMenuSide,
      anchored: Boolean(anchor),
    };
  }

  if (!anchor) {
    const fallbackPosition = clampFloatingPanelPosition(
      {
        x: preferredBounds.right - safeMargin - size.width,
        y: preferredBounds.top + safeMargin,
      },
      size,
      hardBounds,
      safeMargin
    );
    return {
      ...fallbackPosition,
      side: FloatingPanelSide.FALLBACK,
      sheet: false,
      preferredSide: oppositeMenuSide,
      anchored: false,
    };
  }

  const candidates = makeCandidates(anchor, size, safeGap);
  const sideOrder = preferredSideOrder(oppositeMenuSide);
  let best = null;

  sideOrder.forEach((side, preferenceRank) => {
    const rawPosition = candidates[side];
    const clampedPosition = clampFloatingPanelPosition(
      rawPosition,
      size,
      hardBounds,
      safeMargin
    );
    const score = scoreCandidate({
      rawPosition,
      clampedPosition,
      size,
      hardBounds: insetRect(hardBounds, safeMargin),
      preferredBounds: insetRect(preferredBounds, safeMargin),
      anchor,
      avoid,
      preferenceRank,
    });

    if (!best || score < best.score) {
      best = { side, score, position: clampedPosition };
    }
  });

  return {
    ...best.position,
    side: best.side,
    sheet: false,
    preferredSide: oppositeMenuSide,
    anchored: true,
  };
}
