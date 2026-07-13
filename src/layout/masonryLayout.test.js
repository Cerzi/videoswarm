import { describe, expect, it } from 'vitest';
import {
  computeMasonryLayout,
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
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
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
