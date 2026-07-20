const DEFAULT_ASPECT_RATIO = 16 / 9;
const DEFAULT_MIN_ASPECT = 0.25;
const DEFAULT_MAX_ASPECT = 4;
const DEFAULT_TILE_WIDTH = 200;
const DEFAULT_GAP = 4;
const DEFAULT_PADDING = 16;
const DEFAULT_MAX_PINNED = 8;

const finiteNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const nonNegativeNumber = (value, fallback) =>
  Math.max(0, finiteNumber(value, fallback));

const positiveNumber = (value, fallback) => {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
};

const defaultGetId = (item, index) => item?.id ?? item?.fullPath ?? index;

const defaultGetAspectRatio = (item) => {
  const direct = Number(item?.aspectRatio);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const dimensionRatio = Number(item?.dimensions?.aspectRatio);
  if (Number.isFinite(dimensionRatio) && dimensionRatio > 0) {
    return dimensionRatio;
  }

  const width = Number(item?.dimensions?.width);
  const height = Number(item?.dimensions?.height);
  if (
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0
  ) {
    return width / height;
  }

  return null;
};

function normalizeAspectRatio(value, fallback, minAspect, maxAspect) {
  const candidate = Number(value);
  const aspect = Number.isFinite(candidate) && candidate > 0
    ? candidate
    : fallback;
  return Math.max(minAspect, Math.min(maxAspect, aspect));
}

/**
 * Build deterministic masonry geometry without reading or writing the DOM.
 * The returned position objects are shared by `positions`, `positionsById`,
 * and `columns`, and each owns one stable style object for this layout.
 */
export function computeMasonryLayout(items = [], options = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const containerWidth = positiveNumber(options.containerWidth, 1);
  const requestedPadding = nonNegativeNumber(options.padding, DEFAULT_PADDING);
  const padding = Math.min(requestedPadding, Math.max(0, (containerWidth - 1) / 2));
  const gap = nonNegativeNumber(options.gap, DEFAULT_GAP);
  const targetTileWidth = positiveNumber(
    options.targetTileWidth,
    DEFAULT_TILE_WIDTH
  );
  const minAspect = positiveNumber(options.minAspect, DEFAULT_MIN_ASPECT);
  const maxAspect = Math.max(
    minAspect,
    positiveNumber(options.maxAspect, DEFAULT_MAX_ASPECT)
  );
  const defaultAspect = normalizeAspectRatio(
    options.defaultAspect,
    DEFAULT_ASPECT_RATIO,
    minAspect,
    maxAspect
  );
  const getId = typeof options.getId === 'function' ? options.getId : defaultGetId;
  const getAspectRatio = typeof options.getAspectRatio === 'function'
    ? options.getAspectRatio
    : defaultGetAspectRatio;

  const availableWidth = Math.max(1, containerWidth - padding * 2);
  const columnCount = Math.max(
    1,
    Math.floor((availableWidth + gap) / (targetTileWidth + gap))
  );
  const columnWidth = Math.max(
    1,
    Math.floor(
      (availableWidth - gap * Math.max(0, columnCount - 1)) / columnCount
    )
  );

  const columnHeights = new Array(columnCount).fill(padding);
  const columns = Array.from({ length: columnCount }, () => []);
  const positions = [];
  const positionsById = new Map();

  safeItems.forEach((item, index) => {
    const resolvedId = getId(item, index);
    const id = resolvedId == null ? index : resolvedId;
    if (positionsById.has(id)) {
      throw new Error(`Duplicate masonry item id: ${String(id)}`);
    }

    const aspectRatio = normalizeAspectRatio(
      getAspectRatio(item, index),
      defaultAspect,
      minAspect,
      maxAspect
    );
    const height = Math.max(1, Math.round(columnWidth / aspectRatio));

    let column = 0;
    let shortestHeight = columnHeights[0];
    for (let candidate = 1; candidate < columnCount; candidate += 1) {
      if (columnHeights[candidate] < shortestHeight) {
        shortestHeight = columnHeights[candidate];
        column = candidate;
      }
    }

    const x = padding + column * (columnWidth + gap);
    const y = columnHeights[column];
    const bottom = y + height;
    const style = {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: `${columnWidth}px`,
      height: `${height}px`,
      transform: `translate3d(${x}px, ${y}px, 0)`,
    };
    const position = {
      id,
      item,
      index,
      column,
      x,
      y,
      width: columnWidth,
      height,
      bottom,
      style,
    };

    positions.push(position);
    positionsById.set(id, position);
    columns[column].push(position);
    columnHeights[column] = bottom + gap;
  });

  const visualOrderIds = positions
    .slice()
    .sort((left, right) =>
      left.y - right.y || left.x - right.x || left.index - right.index
    )
    .map((position) => position.id);

  let contentBottom = padding;
  positions.forEach((position) => {
    if (position.bottom > contentBottom) contentBottom = position.bottom;
  });
  const totalHeight = contentBottom + padding;

  return {
    positions,
    positionsById,
    columns,
    visualOrderIds,
    columnCount,
    columnWidth,
    totalHeight,
    padding,
    gap,
  };
}

function findFirstIntersectingPosition(column, top) {
  let low = 0;
  let high = column.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (column[middle].bottom > top) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function normalizePinnedIds(pinnedIds) {
  if (pinnedIds == null) return [];
  if (typeof pinnedIds === 'string') return [pinnedIds];
  if (typeof pinnedIds[Symbol.iterator] === 'function') {
    return pinnedIds;
  }
  return [];
}

/**
 * Return only positions intersecting the viewport/overscan band, plus at most
 * `maxPinned` additional positions. Column-local binary searches keep lookup
 * work proportional to the mounted window rather than the collection size.
 */
export function getVirtualMasonryWindow(
  layout,
  {
    scrollTop = 0,
    viewportHeight = 0,
    overscanPx = 0,
    pinnedIds = [],
    maxPinned = DEFAULT_MAX_PINNED,
  } = {}
) {
  if (!layout || !Array.isArray(layout.columns) || !layout.positionsById) {
    return [];
  }

  const safeScrollTop = nonNegativeNumber(scrollTop, 0);
  const safeViewportHeight = nonNegativeNumber(viewportHeight, 0);
  const safeOverscan = nonNegativeNumber(overscanPx, 0);
  const top = Math.max(0, safeScrollTop - safeOverscan);
  const bottom = safeScrollTop + safeViewportHeight + safeOverscan;
  const selected = new Map();

  layout.columns.forEach((column) => {
    if (!Array.isArray(column) || column.length === 0) return;
    let index = findFirstIntersectingPosition(column, top);
    while (index < column.length) {
      const position = column[index];
      if (position.y >= bottom) break;
      selected.set(position.id, position);
      index += 1;
    }
  });

  const pinnedLimit = Number.isFinite(Number(maxPinned))
    ? Math.max(0, Math.floor(Number(maxPinned)))
    : DEFAULT_MAX_PINNED;
  let addedPinned = 0;
  for (const id of normalizePinnedIds(pinnedIds)) {
    if (addedPinned >= pinnedLimit) break;
    if (selected.has(id)) continue;
    const position = layout.positionsById.get(id);
    if (!position) continue;
    selected.set(id, position);
    addedPinned += 1;
  }

  return [...selected.values()].sort((left, right) =>
    left.y - right.y || left.x - right.x || left.index - right.index
  );
}

export function getScrollTopForItem(
  layout,
  id,
  { viewportHeight = 0, align = 'center' } = {}
) {
  const position = layout?.positionsById?.get(id);
  if (!position) return null;

  const safeViewportHeight = nonNegativeNumber(viewportHeight, 0);
  let target;
  if (align === 'start') {
    target = position.y;
  } else if (align === 'end') {
    target = position.bottom - safeViewportHeight;
  } else {
    target = position.y + position.height / 2 - safeViewportHeight / 2;
  }

  const maximum = Math.max(0, finiteNumber(layout.totalHeight, 0) - safeViewportHeight);
  return Math.max(0, Math.min(maximum, target));
}

export function getAnchorScrollAdjustment(previousLayout, nextLayout, id) {
  const previous = previousLayout?.positionsById?.get(id);
  const next = nextLayout?.positionsById?.get(id);
  if (!previous || !next) return 0;
  return next.y - previous.y;
}
