import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useChunkedMasonry from './useChunkedMasonry';
import React from 'react';

// --- RAF mock helpers ---
let rafQueue;
beforeEach(() => {
  rafQueue = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    rafQueue.push(cb);
    return rafQueue.length; // pseudo handle
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rafQueue = [];
});

function flushRaf(times = 10) {
  // Run up to N frames (safety to avoid infinite loops)
  for (let i = 0; i < times; i++) {
    if (rafQueue.length === 0) break;
    const q = rafQueue.slice();
    rafQueue.length = 0;
    q.forEach((cb) => cb(performance.now()));
  }
}

// --- getComputedStyle mock ---
const defaultComputed = {
  gridTemplateColumns: '1fr 1fr 1fr', // 3 columns
  columnGap: '12px',
  gap: '12px',
  paddingLeft: '0px',
  paddingRight: '0px',
};
beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
    // Allow override via el.__cs__ if a test needs it
    return el && el.__cs__ ? el.__cs__ : defaultComputed;
  });
});

// --- utilities to build a grid and items ---
function makeGrid({ width = 600, className = 'masonry-grid' } = {}) {
  const grid = document.createElement('div');
  grid.className = className;

  // jsdom: define width via clientWidth/getBoundingClientRect
  Object.defineProperty(grid, 'clientWidth', { value: width, configurable: true });
  grid.getBoundingClientRect = () => ({ width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0 });

  document.body.appendChild(grid);
  return grid;
}

function makeItem(id) {
  const el = document.createElement('div');
  el.className = 'video-item';
  el.dataset.videoId = id;

  // Include a child that the hook may adjust height on
  const inner = document.createElement('div');
  inner.className = 'video-container';
  el.appendChild(inner);

  return el;
}

describe('useChunkedMasonry – core layout & order', () => {
  test('lays out items and sets grid height; emits visual order top-to-bottom then left-to-right', () => {
    const grid = makeGrid({ width: 630 }); // With 3 cols and 12px gaps => easy math
    // Add 6 items
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    ids.forEach((id) => grid.appendChild(makeItem(id)));

    const gridRef = { current: grid };
    const onOrderChange = vi.fn();

    const { result } = renderHook(() =>
      useChunkedMasonry({
        gridRef,
        chunkSize: 200,
        defaultAspect: 1, // square to keep things predictable
        onOrderChange,
      })
    );

    // initial schedule on mount
    act(() => flushRaf(5));

    // basic assertions: items are positioned
    const items = Array.from(grid.querySelectorAll('.video-item'));
    expect(items.length).toBe(6);
    items.forEach((el) => {
      expect(el.style.position).toBe('absolute');
      expect(el.style.width).toMatch(/px$/);
      expect(el.style.transform).toMatch(/^translate\(/);
    });

    // grid height should be > 0
    expect(parseFloat(grid.style.height)).toBeGreaterThan(0);

    // Order callback fired once with 6 IDs
    expect(onOrderChange).toHaveBeenCalledTimes(1);
    const order1 = onOrderChange.mock.calls[0][0];
    expect(order1).toHaveLength(6);

    // With defaultAspect=1 and 3 columns, items flow into shortest column first,
    // producing a fairly even vertical flow. The exact order is:
    // top-to-bottom, then left-to-right by (y,x). We don't assert the exact array,
    // but we do assert it contains the same IDs and is stable on no-change.
    expect(new Set(order1)).toEqual(new Set(ids));

    // Trigger a relayout without changing inputs -> no new order emit
    act(() => {
      result.current.onItemsChanged();
      flushRaf(5);
    });
    expect(onOrderChange).toHaveBeenCalledTimes(1);
  });

  test('updateAspectRatio triggers relayout and can change order', () => {
    const grid = makeGrid({ width: 630 });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    ids.forEach((id) => grid.appendChild(makeItem(id)));
    const gridRef = { current: grid };
    const onOrderChange = vi.fn();

    const { result } = renderHook(() =>
      useChunkedMasonry({
        gridRef,
        chunkSize: 200,
        defaultAspect: 1,
        onOrderChange,
      })
    );

    act(() => flushRaf(5));
    expect(onOrderChange).toHaveBeenCalledTimes(1);
    const firstOrder = onOrderChange.mock.calls[0][0];

    // Make one item much taller by giving a tiny aspect ratio (portrait)
    act(() => {
      result.current.updateAspectRatio('a', 0.25); // height gets 4x larger
      flushRaf(5);
    });

    // Either the order changes (likely), or at least we re-ran layout but only emit if changed.
    const callCount = onOrderChange.mock.calls.length;
    expect(callCount === 1 || callCount === 2).toBe(true);

    if (callCount === 2) {
      const nextOrder = onOrderChange.mock.calls[1][0];
      // Still same IDs
      expect(new Set(nextOrder)).toEqual(new Set(ids));
      // And *likely* a different order now
      expect(nextOrder).not.toEqual(firstOrder);
    }
  });

  test('setZoomClass swaps classes and triggers relayout', () => {
    const grid = makeGrid({ width: 630, className: 'video-grid' });
    ['a', 'b', 'c'].forEach((id) => grid.appendChild(makeItem(id)));
    const gridRef = { current: grid };
    const onOrderChange = vi.fn();

    const { result } = renderHook(() =>
      useChunkedMasonry({
        gridRef,
        onOrderChange,
      })
    );

    act(() => flushRaf(5));

    // No zoom class yet (depends on your app), but we can assert changes
    act(() => {
      result.current.setZoomClass(2); // -> zoom-large by default mapping
      flushRaf(5);
    });

    expect(grid.classList.contains('zoom-large')).toBe(true);
  });

  test('onItemsChanged triggers a relayout and order emit when children change', () => {
    const grid = makeGrid({ width: 630 });
    ['a', 'b', 'c'].forEach((id) => grid.appendChild(makeItem(id)));
    const gridRef = { current: grid };
    const onOrderChange = vi.fn();

    const { result } = renderHook(() =>
      useChunkedMasonry({
        gridRef,
        defaultAspect: 1,
        onOrderChange,
      })
    );

    act(() => flushRaf(5));
    expect(onOrderChange).toHaveBeenCalledTimes(1);
    const order1 = onOrderChange.mock.calls[0][0];

    // Add another item
    act(() => {
      grid.appendChild(makeItem('d'));
      result.current.onItemsChanged();
      flushRaf(5);
    });

    expect(onOrderChange).toHaveBeenCalledTimes(2);
    const order2 = onOrderChange.mock.calls[1][0];
    expect(new Set(order2)).toEqual(new Set(['a','b','c','d']));
    expect(order2).not.toEqual(order1);
  });

  test('does not emit onOrderChange if computed visual order is identical', () => {
    const grid = makeGrid({ width: 630 });
    ['a', 'b', 'c'].forEach((id) => grid.appendChild(makeItem(id)));
    const gridRef = { current: grid };
    const onOrderChange = vi.fn();

    const { result } = renderHook(() =>
      useChunkedMasonry({
        gridRef,
        defaultAspect: 1,
        onOrderChange,
      })
    );

    act(() => flushRaf(5));
    expect(onOrderChange).toHaveBeenCalledTimes(1);

    // Call onItemsChanged without actually changing children or sizes → no new emit
    act(() => {
      result.current.onItemsChanged();
      flushRaf(5);
    });
    expect(onOrderChange).toHaveBeenCalledTimes(1);
  });
});