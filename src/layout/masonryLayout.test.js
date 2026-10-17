import { describe, expect, it } from 'vitest';
import {
  computeMasonryLayout,
  computeRowLayout,
  getAnchorScrollAdjustment,
  getScrollTopForItem,
  getVirtualMasonryWindow,
} from './masonryLayout';

const ASPECT_SEQUENCE = [16 / 9, 9 / 16, 1, 4 / 3, 2.35, 0.01, 100, NaN];

function makeItems(count, aspects = ASPECT_SEQUENCE) {
  return Array.from({ length: count }, (_, index) => ({
    id: `clip-${index}`,
    aspectRatio: aspects[index % aspects.length],
  }));
}

function makeLayout(count, overrides = {}) {
  return computeMasonryLayout(makeItems(count), {
    containerWidth: 1280,
    targetTileWidth: 180,
    padding: 16,
    gap: 4,
    minAspect: 0.25,
    maxAspect: 4,
    ...overrides,
  });
}

function geometry(position) {
  return {
    id: position.id,
    index: position.index,
    column: position.column,
    x: position.x,
    y: position.y,
    width: position.width,
    height: position.height,
    bottom: position.bottom,
    style: position.style,
  };
}

function expectVisualOrder(layout, positions) {
  const rank = new Map(layout.visualOrderIds.map((id, index) => [id, index]));
  for (let index = 1; index < positions.length; index += 1) {
    expect(rank.get(positions[index - 1].id)).toBeLessThan(
      rank.get(positions[index].id)
    );
  }
}

describe('computeMasonryLayout', () => {
  it('deterministically lays out 5,000 items with complete valid geometry', () => {
    const items = makeItems(5000);
    const options = {
      containerWidth: 1280,
      targetTileWidth: 180,
      padding: 16,
      gap: 4,
      minAspect: 0.25,
      maxAspect: 4,
    };
    const layout = computeMasonryLayout(items, options);
    const repeated = computeMasonryLayout(items, options);

    expect(layout.positions).toHaveLength(5000);
    expect(layout.positionsById.size).toBe(5000);
    expect(layout.visualOrderIds).toHaveLength(5000);
    expect(new Set(layout.visualOrderIds).size).toBe(5000);
    expect(layout.columns).toHaveLength(layout.columnCount);
    expect(layout.positions.map(geometry)).toEqual(repeated.positions.map(geometry));
    expect(layout.visualOrderIds).toEqual(repeated.visualOrderIds);

    const minimumHeight = Math.max(1, Math.round(layout.columnWidth / 4));
    const maximumHeight = Math.max(1, Math.round(layout.columnWidth / 0.25));
    let maximumBottom = layout.padding;

    layout.positions.forEach((position) => {
      expect(position.item).toBe(items[position.index]);
      expect(layout.positionsById.get(position.id)).toBe(position);
      expect(layout.columns[position.column]).toContain(position);
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(position.x).toBeGreaterThanOrEqual(layout.padding);
      expect(position.y).toBeGreaterThanOrEqual(layout.padding);
      expect(position.height).toBeGreaterThanOrEqual(minimumHeight);
      expect(position.height).toBeLessThanOrEqual(maximumHeight);
      expect(position.bottom).toBe(position.y + position.height);
      expect(position.style).toEqual({
        position: 'absolute',
        left: '0px',
        top: '0px',
        width: `${position.width}px`,
        height: `${position.height}px`,
        transform: `translate(${position.x}px, ${position.y}px)`,
      });
      maximumBottom = Math.max(maximumBottom, position.bottom);
    });

    layout.columns.forEach((column, columnIndex) => {
      column.forEach((position, index) => {
        expect(position.column).toBe(columnIndex);
        if (index === 0) {
          expect(position.y).toBe(layout.padding);
        } else {
          expect(position.y).toBe(column[index - 1].bottom + layout.gap);
        }
      });
    });

    expect(layout.totalHeight).toBe(maximumBottom + layout.padding);
    expect(layout.positions[5].height).toBe(
      Math.round(layout.columnWidth / 0.25)
    );
    expect(layout.positions[6].height).toBe(
      Math.round(layout.columnWidth / 4)
    );
    expectVisualOrder(layout, layout.positions.slice().sort((left, right) =>
      left.y - right.y || left.x - right.x || left.index - right.index
    ));
  });

  it('keeps geometry before an aspect-ratio correction stable and reports anchor movement', () => {
    const items = makeItems(500, [16 / 9]);
    const before = computeMasonryLayout(items, {
      containerWidth: 1100,
      targetTileWidth: 180,
      padding: 16,
      gap: 4,
    });
    const correctedItems = items.slice();
    correctedItems[123] = { ...correctedItems[123], aspectRatio: 0.25 };
    const after = computeMasonryLayout(correctedItems, {
      containerWidth: 1100,
      targetTileWidth: 180,
      padding: 16,
      gap: 4,
    });

    expect(after.positions.slice(0, 123).map(geometry)).toEqual(
      before.positions.slice(0, 123).map(geometry)
    );
    expect(after.positionsById.get('clip-123').height).toBeGreaterThan(
      before.positionsById.get('clip-123').height
    );
    expect(after.totalHeight).toBeGreaterThan(before.totalHeight);

    const anchorId = 'clip-450';
    expect(getAnchorScrollAdjustment(before, after, anchorId)).toBe(
      after.positionsById.get(anchorId).y - before.positionsById.get(anchorId).y
    );
    expect(getAnchorScrollAdjustment(before, after, 'missing')).toBe(0);
  });
});

describe('getVirtualMasonryWindow', () => {
  it.each([1000, 5000])(
    'keeps top, middle, and bottom windows bounded for %i items',
    (count) => {
      const layout = makeLayout(count);
      const viewportHeight = 900;
      const overscanPx = 900;
      const maximumScroll = Math.max(0, layout.totalHeight - viewportHeight);
      const minimumTileHeight = Math.max(1, Math.round(layout.columnWidth / 4));
      const maximumMounted =
        layout.columnCount *
        (Math.ceil((viewportHeight + overscanPx * 2) / minimumTileHeight) + 2);

      [0, maximumScroll / 2, maximumScroll].forEach((scrollTop) => {
        const positions = getVirtualMasonryWindow(layout, {
          scrollTop,
          viewportHeight,
          overscanPx,
        });
        const top = Math.max(0, scrollTop - overscanPx);
        const bottom = scrollTop + viewportHeight + overscanPx;

        expect(positions.length).toBeLessThanOrEqual(maximumMounted);
        expect(new Set(positions.map((position) => position.id)).size).toBe(
          positions.length
        );
        positions.forEach((position) => {
          expect(position.bottom).toBeGreaterThan(top);
          expect(position.y).toBeLessThan(bottom);
        });
        expectVisualOrder(layout, positions);
      });
    }
  );

  it('makes every item reachable while stepping through a 5,000-item layout', () => {
    const layout = makeLayout(5000);
    const viewportHeight = 800;
    const maximumScroll = Math.max(0, layout.totalHeight - viewportHeight);
    const reached = new Set();

    for (let scrollTop = 0; scrollTop < maximumScroll; scrollTop += viewportHeight) {
      getVirtualMasonryWindow(layout, {
        scrollTop,
        viewportHeight,
        overscanPx: 0,
      }).forEach((position) => reached.add(position.id));
    }
    getVirtualMasonryWindow(layout, {
      scrollTop: maximumScroll,
      viewportHeight,
      overscanPx: 0,
    }).forEach((position) => reached.add(position.id));

    expect(reached.size).toBe(5000);
    layout.visualOrderIds.forEach((id) => expect(reached.has(id)).toBe(true));
  });

  it('adds no more than the pinned cap and preserves visual order', () => {
    const layout = makeLayout(1000);
    const viewportHeight = 700;
    const base = getVirtualMasonryWindow(layout, {
      scrollTop: 0,
      viewportHeight,
      overscanPx: 0,
    });
    const pinnedIds = ['clip-999', 'clip-998', 'clip-997', 'clip-996', 'clip-995'];
    const withPinned = getVirtualMasonryWindow(layout, {
      scrollTop: 0,
      viewportHeight,
      overscanPx: 0,
      pinnedIds,
      maxPinned: 3,
    });
    const mounted = new Set(withPinned.map((position) => position.id));

    expect(withPinned).toHaveLength(base.length + 3);
    expect(mounted.has('clip-999')).toBe(true);
    expect(mounted.has('clip-998')).toBe(true);
    expect(mounted.has('clip-997')).toBe(true);
    expect(mounted.has('clip-996')).toBe(false);
    expectVisualOrder(layout, withPinned);
  });
});

describe('getScrollTopForItem', () => {
  it('calculates clamped start, center, and end targets', () => {
    const layout = makeLayout(1000);
    const viewportHeight = 800;
    const maximumScroll = layout.totalHeight - viewportHeight;
    const middle = layout.positionsById.get('clip-500');
    const deepest = layout.positions.reduce((current, position) =>
      position.bottom > current.bottom ? position : current
    );

    expect(
      getScrollTopForItem(layout, 'clip-500', { viewportHeight, align: 'start' })
    ).toBe(Math.max(0, Math.min(maximumScroll, middle.y)));
    expect(
      getScrollTopForItem(layout, 'clip-500', { viewportHeight, align: 'center' })
    ).toBe(
      Math.max(
        0,
        Math.min(
          maximumScroll,
          middle.y + middle.height / 2 - viewportHeight / 2
        )
      )
    );
    expect(
      getScrollTopForItem(layout, deepest.id, { viewportHeight, align: 'end' })
    ).toBe(
      Math.max(0, Math.min(maximumScroll, deepest.bottom - viewportHeight))
    );
    expect(getScrollTopForItem(layout, 'missing', { viewportHeight })).toBeNull();
  });
});

describe('computeRowLayout', () => {
  const rows = (items, overrides = {}) =>
    computeRowLayout(items, {
      containerWidth: 1000,
      targetTileWidth: 160,
      padding: 10,
      gap: 4,
      ...overrides,
    });
  const clips = (...aspects) => aspects.map((aspectRatio, index) => ({ id: `c${index}`, aspectRatio }));
  const rowsOf = (layout) => {
    const byTop = new Map();
    for (const position of layout.positions) {
      if (!byTop.has(position.y)) byTop.set(position.y, []);
      byTop.get(position.y).push(position);
    }
    return [...byTop.values()];
  };

  it('lays clips out left to right in rows, in their order', () => {
    const layout = rows(makeItems(40));
    expect(layout.visualOrderIds).toEqual(makeItems(40).map((item) => item.id));
    for (let index = 1; index < layout.positions.length; index += 1) {
      const previous = layout.positions[index - 1];
      const position = layout.positions[index];
      // Each clip is right of the one before, or starts the next row.
      expect(
        (position.y === previous.y && position.x === previous.x + previous.width + 4) ||
          (position.y === previous.bottom + 4 && position.x === 10)
      ).toBe(true);
      if (position.y === previous.y) expect(position.height).toBe(previous.height);
    }
    expect(layout.totalHeight).toBe(layout.positions.at(-1).bottom + 10);
  });

  it('fills the width with every row but the last, without cropping', () => {
    const layout = rows(makeItems(60));
    const all = rowsOf(layout);
    expect(all.length).toBeGreaterThan(3);
    all.slice(0, -1).forEach((row) => {
      expect(row[0].x).toBe(10);
      expect(row.at(-1).x + row.at(-1).width).toBe(990);
      // Around the target height, even with these extreme shapes.
      expect(row[0].height / layout.rowHeight).toBeGreaterThan(0.6);
      expect(row[0].height / layout.rowHeight).toBeLessThan(1.65);
    });
    for (const position of layout.positions) {
      const raw = Number(position.item.aspectRatio);
      const aspect = Number.isFinite(raw) ? Math.min(4, Math.max(0.25, raw)) : 16 / 9;
      // Each card keeps its clip's shape (within a pixel of rounding).
      expect(Math.abs(position.width - position.height * aspect)).toBeLessThanOrEqual(1 + aspect);
    }
    const last = all.at(-1);
    expect(last[0].height).toBe(layout.rowHeight);
    expect(last.at(-1).x + last.at(-1).width).toBeLessThanOrEqual(990);
  });

  it('breaks a row where its height stays nearest the target', () => {
    // 16:9 clips are 160px wide in 90px rows: six fill 980px; a seventh
    // would shrink the row to 0.85, so it waits.
    const layout = rows(clips(...Array(7).fill(16 / 9)));
    const [first, second] = rowsOf(layout);
    expect(first).toHaveLength(6);
    expect(first[0].height).toBe(90);
    expect(second).toHaveLength(1);
    // 1.85 clips are 161px wide in 87px rows: five leave 159px spare, and a
    // sixth shrinks the row less (0.99) than growing it would (1.2), so it
    // joins.
    const wide = rowsOf(rows(clips(...Array(7).fill(1.85))));
    expect(wide[0]).toHaveLength(6);
    expect(wide[0][0].height).toBe(86);
  });

  it('sizes rows by the typical clip, so portrait clips are as wide as a column', () => {
    const portrait = rows(clips(...Array(30).fill(9 / 16)));
    // A portrait clip 160px wide is 284px tall, as in a 160px column.
    expect(portrait.rowHeight).toBe(284);
    expect(portrait.positions.at(-1).width).toBe(160);
    // As many 16:9 clips as 9:16 ones: square on average.
    const mixed = rows(clips(...Array(100).fill(9 / 16), ...Array(100).fill(16 / 9)));
    expect(mixed.rowHeight).toBe(160);
    // One more clip's shape does not move the target.
    const more = rows(clips(...Array(100).fill(9 / 16), ...Array(100).fill(16 / 9), 4 / 3));
    expect(more.rowHeight).toBe(160);
  });

  it('keeps a clip wider than the grid within it', () => {
    const layout = rows(clips(4), { containerWidth: 200, targetTileWidth: 400 });
    expect(layout.positions[0].width).toBe(180);
  });

  it('stops growing rows once a typical clip fills the grid', () => {
    // 980px across: a zoom wider than that gives the 16:9 row of 980px.
    const fits = rows(clips(16 / 9), { targetTileWidth: 1900 });
    expect(fits.positions[0].height).toBe(552);
    expect(fits.positions[0].width).toBe(980);
    expect(rows(clips(16 / 9), { targetTileWidth: 640 }).positions[0].height).toBe(360);
  });

  it('serves the virtual window and scrolling like the column layout', () => {
    const layout = rows(makeItems(300));
    const visible = getVirtualMasonryWindow(layout, { scrollTop: 500, viewportHeight: 300 });
    expect(visible.length).toBeGreaterThan(0);
    for (const position of visible) {
      expect(position.bottom).toBeGreaterThan(500);
      expect(position.y).toBeLessThan(800);
    }
    expect(getScrollTopForItem(layout, 'clip-150', { viewportHeight: 300, align: 'start' })).toBe(
      layout.positionsById.get('clip-150').y
    );
  });
});
