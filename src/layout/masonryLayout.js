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
      // A 2D translate: a 3D one would give every slot, including those
      // with no video, its own compositor layer.
      transform: `translate(${x}px, ${y}px)`,
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

// Rows (View › Layout), an alternative to masonry columns: the reading order
// is the sort order, so range selection reads naturally. Every row but the
// last fills the grid's width exactly with no crop, by scaling the whole row
// (its height with its cards' widths), the justified layout photo grids use.
// A row breaks before or after the clip that overflows it, whichever leaves
// its height nearer the target, so heights stay close to it, closer the more
// clips a row holds.

// The typical clip's shape, for the target row height: the aspect ratio at
// which rows give the clips, on average, the area masonry columns give them,
// sqrt(mean(aspect) / mean(1 / aspect)). It is a clip's own shape when all
// share one, and between the two for a mix (1:1 for as many 9:16 as 16:9
// clips). Taken in steps of 2% so one clip's shape arriving rarely moves it
// and reflows every row.
const TYPICAL_ASPECT_STEP = Math.log(1.02);

function typicalAspectRatio(aspects, fallback) {
  if (!aspects.length) return fallback;
  let wide = 0;
  let tall = 0;
  for (const aspect of aspects) {
    wide += aspect;
    tall += 1 / aspect;
  }
  const exact = Math.sqrt(wide / tall);
  return Math.exp(Math.round(Math.log(exact) / TYPICAL_ASPECT_STEP) * TYPICAL_ASPECT_STEP);
}

/**
 * Build justified rows in the items' order, left to right, without reading
 * or writing the DOM. The target row height is the height the collection's
 * typical clip has at `targetTileWidth`, so a zoom step shows clips at about
 * the same size in either layout, and about as many: a row of portrait clips
 * is as tall as a portrait clip in a masonry column. The target is never
 * taller than a typical clip as wide as the grid.
 * Returns the same shape as computeMasonryLayout; `columns` holds one list in
 * reading order, which the virtual window searches like a column.
 */
export function computeRowLayout(items = [], options = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const containerWidth = positiveNumber(options.containerWidth, 1);
  const requestedPadding = nonNegativeNumber(options.padding, DEFAULT_PADDING);
  const padding = Math.min(requestedPadding, Math.max(0, (containerWidth - 1) / 2));
  const gap = nonNegativeNumber(options.gap, DEFAULT_GAP);
  const targetTileWidth = positiveNumber(options.targetTileWidth, DEFAULT_TILE_WIDTH);
  const minAspect = positiveNumber(options.minAspect, DEFAULT_MIN_ASPECT);
  const maxAspect = Math.max(minAspect, positiveNumber(options.maxAspect, DEFAULT_MAX_ASPECT));
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
  const seen = new Set();
  const entries = safeItems.map((item, index) => {
    const resolvedId = getId(item, index);
    const id = resolvedId == null ? index : resolvedId;
    if (seen.has(id)) {
      throw new Error(`Duplicate masonry item id: ${String(id)}`);
    }
    seen.add(id);
    const aspectRatio = normalizeAspectRatio(
      getAspectRatio(item, index),
      defaultAspect,
      minAspect,
      maxAspect
    );
    return { id, item, index, aspectRatio, width: 0 };
  });
  const typicalAspect = typicalAspectRatio(
    entries.map((entry) => entry.aspectRatio),
    defaultAspect
  );
  // A caller may set the target outright (the versions view fits its row
  // to the window); otherwise it follows the zoom.
  const rowHeight = Math.max(
    1,
    Math.round(
      positiveNumber(options.rowHeight, 0) ||
        Math.min(targetTileWidth, availableWidth) / typicalAspect
    )
  );
  // Ragged rows (the last) sit in the middle rather than at the left.
  const center = options.center === true;

  const positions = [];
  const positionsById = new Map();
  let row = [];
  let cards = 0; // the row's cards at the target height, without gaps
  let y = padding;

  const fill = (count, cardsWidth) => (availableWidth - gap * (count - 1)) / cardsWidth;

  const place = (scale) => {
    if (!row.length) return;
    const height = Math.max(1, Math.round(rowHeight * scale));
    const last = row.length - 1;
    const left = center && scale === 1
      ? padding + Math.max(0, Math.floor((availableWidth - Math.round(cards) - gap * last) / 2))
      : padding;
    let before = 0;
    row.forEach((entry, at) => {
      const x = left + Math.round(before * scale) + gap * at;
      before += entry.width;
      const right = at === last && scale !== 1
        ? padding + availableWidth
        : left + Math.round(before * scale) + gap * at;
      const width = Math.max(1, right - x);
      const style = {
        position: 'absolute',
        left: '0px',
        top: '0px',
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${x}px, ${y}px)`,
      };
      const position = {
        id: entry.id,
        item: entry.item,
        index: entry.index,
        column: 0,
        x,
        y,
        width,
        height,
        bottom: y + height,
        style,
      };
      positions.push(position);
      positionsById.set(entry.id, position);
    });
    y += height + gap;
    row = [];
    cards = 0;
  };

  entries.forEach((entry) => {
    entry.width = Math.min(availableWidth, rowHeight * entry.aspectRatio);
    if (row.length && cards + entry.width + gap * row.length > availableWidth) {
      // Break after this clip (the row shrinks) or before it (the row grows),
      // whichever keeps the row's height nearer the target.
      const shrink = fill(row.length + 1, cards + entry.width);
      const grow = fill(row.length, cards);
      if (shrink > 0 && Math.abs(Math.log(shrink)) < Math.abs(Math.log(grow))) {
        row.push(entry);
        cards += entry.width;
        place(shrink);
        return;
      }
      place(grow);
    }
    row.push(entry);
    cards += entry.width;
  });
  // The last row keeps the target height and a ragged edge.
  place(1);

  const contentBottom = positions.length ? positions[positions.length - 1].bottom : padding;
  return {
    positions,
    positionsById,
    columns: [positions],
    visualOrderIds: positions.map((position) => position.id),
    columnCount: 1,
    columnWidth: Math.round(rowHeight * typicalAspect),
    rowHeight,
    typicalAspect,
    totalHeight: contentBottom + padding,
    padding,
    gap,
  };
}

/**
 * The row height at which clips of these aspect ratios sit side by side in
 * one row that fits both the grid's width and the window's height (the
 * versions view), or null when that row would be too low to compare in
 * (`minHeight`), in which case the zoom's rows apply.
 */
export function fitComparisonRowHeight(
  aspects,
  { containerWidth, viewportHeight, padding = DEFAULT_PADDING, gap = DEFAULT_GAP, minHeight = 160 } = {}
) {
  const shapes = (Array.isArray(aspects) ? aspects : [])
    .map((aspect) => normalizeAspectRatio(aspect, DEFAULT_ASPECT_RATIO, DEFAULT_MIN_ASPECT, DEFAULT_MAX_ASPECT));
  if (!shapes.length) return null;
  const across = positiveNumber(containerWidth, 1) - padding * 2 - gap * (shapes.length - 1);
  const down = positiveNumber(viewportHeight, 0) - padding * 2;
  const total = shapes.reduce((sum, aspect) => sum + aspect, 0);
  // A pixel short of the width, so rounding never breaks the row.
  const height = Math.floor(Math.min((across - shapes.length) / total, down));
  return Number.isFinite(height) && height >= minHeight ? height : null;
}

/**
 * The arena's Place round: the first clip (the one to rate) large and centred
 * at the top, the rest side by side in a smaller row under it, all fitted to
 * the window. The feature takes about `featureShare` of the height; when it
 * is held by the width instead, the row below gets the room. Returns the
 * same shape as computeRowLayout, or null when the window is too low for two
 * rows (`minHeight` for the feature), in which case one row applies.
 */
export function computeFeatureLayout(items = [], options = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length < 2) return null;
  const containerWidth = positiveNumber(options.containerWidth, 1);
  const viewportHeight = positiveNumber(options.viewportHeight, 0);
  const padding = Math.min(nonNegativeNumber(options.padding, DEFAULT_PADDING), Math.max(0, (containerWidth - 1) / 2));
  const gap = nonNegativeNumber(options.gap, DEFAULT_GAP);
  // Between the feature and the row: wide enough to read as two tiers.
  const tierGap = Math.max(gap, nonNegativeNumber(options.tierGap, 14));
  const featureShare = Math.min(0.85, Math.max(0.4, Number(options.featureShare) || 0.66));
  const minHeight = positiveNumber(options.minHeight, 200);
  const getId = typeof options.getId === 'function' ? options.getId : defaultGetId;
  const getAspectRatio = typeof options.getAspectRatio === 'function'
    ? options.getAspectRatio
    : defaultGetAspectRatio;

  const availableWidth = Math.max(1, containerWidth - padding * 2);
  const down = viewportHeight - padding * 2 - tierGap;
  const seen = new Set();
  const entries = safeItems.map((item, index) => {
    const resolvedId = getId(item, index);
    const id = resolvedId == null ? index : resolvedId;
    if (seen.has(id)) throw new Error(`Duplicate masonry item id: ${String(id)}`);
    seen.add(id);
    const aspectRatio = normalizeAspectRatio(
      getAspectRatio(item, index),
      DEFAULT_ASPECT_RATIO,
      DEFAULT_MIN_ASPECT,
      DEFAULT_MAX_ASPECT
    );
    return { id, item, index, aspectRatio };
  });
  const [feature, ...rest] = entries;
  const restAspects = rest.reduce((sum, entry) => sum + entry.aspectRatio, 0);
  // The row's height if it filled the width (a pixel short per card, so
  // rounding never breaks it).
  const rowFit = (availableWidth - gap * (rest.length - 1) - rest.length) / restAspects;
  let featureHeight = Math.min(down * featureShare, availableWidth / feature.aspectRatio);
  let rowHeight = Math.min(rowFit, down - featureHeight);
  // A row held by its width gives its unused height back to the feature.
  featureHeight = Math.min(down - rowHeight, availableWidth / feature.aspectRatio);
  featureHeight = Math.floor(featureHeight);
  rowHeight = Math.floor(rowHeight);
  if (!(featureHeight >= minHeight) || !(rowHeight >= minHeight / 3)) return null;

  const positions = [];
  const positionsById = new Map();
  const put = (entry, x, y, width, height) => {
    const position = {
      id: entry.id,
      item: entry.item,
      index: entry.index,
      column: 0,
      x,
      y,
      width,
      height,
      bottom: y + height,
      style: {
        position: 'absolute',
        left: '0px',
        top: '0px',
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${x}px, ${y}px)`,
      },
    };
    positions.push(position);
    positionsById.set(entry.id, position);
  };

  const featureWidth = Math.max(1, Math.round(featureHeight * feature.aspectRatio));
  put(feature, padding + Math.max(0, Math.floor((availableWidth - featureWidth) / 2)), padding, featureWidth, featureHeight);
  const rowTop = padding + featureHeight + tierGap;
  const widths = rest.map((entry) => Math.max(1, Math.round(rowHeight * entry.aspectRatio)));
  const rowWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (rest.length - 1);
  let x = padding + Math.max(0, Math.floor((availableWidth - rowWidth) / 2));
  rest.forEach((entry, at) => {
    put(entry, x, rowTop, widths[at], rowHeight);
    x += widths[at] + gap;
  });

  const contentBottom = rowTop + rowHeight;
  const typicalAspect = typicalAspectRatio(entries.map((entry) => entry.aspectRatio), DEFAULT_ASPECT_RATIO);
  return {
    positions,
    positionsById,
    columns: [positions],
    visualOrderIds: positions.map((position) => position.id),
    columnCount: 1,
    columnWidth: Math.round(rowHeight * typicalAspect),
    rowHeight,
    typicalAspect,
    totalHeight: contentBottom + padding,
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
