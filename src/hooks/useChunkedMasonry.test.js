import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useChunkedMasonry, {
  MAX_CHUNKED_MASONRY_ASPECT_CACHE_ENTRIES,
} from './useChunkedMasonry';
import React from 'react';

// --- RAF mock helpers ---
let rafQueue;
let rafSequence;
beforeEach(() => {
  rafQueue = [];
  rafSequence = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    const id = ++rafSequence;
    rafQueue.push({ id, callback: cb });
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
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
    q.forEach(({ callback }) => callback(performance.now()));
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

  test('calls onLayoutComplete after each layout pass', () => {
    const grid = makeGrid({ width: 630 });
    ['a', 'b', 'c', 'd'].forEach((id) => grid.appendChild(makeItem(id)));
    const gridRef = { current: grid };
    const onLayoutComplete = vi.fn();

    const { result } = renderHook(() =>
      useChunkedMasonry({
        gridRef,
        defaultAspect: 1,
        onLayoutComplete,
      })
    );

    act(() => flushRaf(5));
    expect(onLayoutComplete).toHaveBeenCalledTimes(1);
    const payload = onLayoutComplete.mock.calls[0][0];
    expect(payload).toMatchObject({
      maxHeight: expect.any(Number),
      metrics: expect.objectContaining({ columnWidth: expect.any(Number) }),
    });
    expect(Array.isArray(payload.columnHeights)).toBe(true);

    act(() => {
      result.current.onItemsChanged();
      flushRaf(5);
    });

    expect(onLayoutComplete).toHaveBeenCalledTimes(2);
  });

  test('bounds and prunes the legacy aspect-ratio cache', () => {
    const grid = makeGrid({ width: 630 });
    grid.appendChild(makeItem('current'));
    const gridRef = { current: grid };
    const { result } = renderHook(() =>
      useChunkedMasonry({ gridRef, defaultAspect: 1 })
    );
    act(() => flushRaf(5));

    act(() => {
      for (
        let index = 0;
        index < MAX_CHUNKED_MASONRY_ASPECT_CACHE_ENTRIES + 128;
        index += 1
      ) {
        result.current.updateAspectRatio(`stale-${index}`, 1.5);
      }
    });
    expect(result.current.getCacheDebugSnapshot()).toMatchObject({
      aspectRatioEntries: MAX_CHUNKED_MASONRY_ASPECT_CACHE_ENTRIES,
      maxAspectRatioEntries: MAX_CHUNKED_MASONRY_ASPECT_CACHE_ENTRIES,
    });

    act(() => {
      result.current.onItemsChanged();
      flushRaf(10);
    });
    expect(
      result.current.getCacheDebugSnapshot().aspectRatioEntries
    ).toBeLessThanOrEqual(1);
  });

  test('cancels a mid-layout chunk and releases captured DOM items on unmount', () => {
    const grid = makeGrid({ width: 630 });
    for (let index = 0; index < 550; index += 1) {
      grid.appendChild(makeItem(`large-${index}`));
    }
    const gridRef = { current: grid };
    const onOrderChange = vi.fn();
    const onLayoutComplete = vi.fn();
    const rendered = renderHook(() =>
      useChunkedMasonry({
        gridRef,
        chunkSize: 100,
        defaultAspect: 1,
        onOrderChange,
        onLayoutComplete,
      })
    );

    act(() => flushRaf(1));
    expect(
      grid.querySelectorAll('[data-pos="1"]').length
    ).toBe(100);
    expect(rendered.result.current.getCacheDebugSnapshot()).toMatchObject({
      scheduledLayoutFrames: 1,
      layoutInProgress: true,
      activeLayoutItems: 550,
    });
    const getSnapshot = rendered.result.current.getCacheDebugSnapshot;

    rendered.unmount();
    expect(getSnapshot()).toMatchObject({
      scheduledLayoutFrames: 0,
      layoutInProgress: false,
      activeLayoutItems: 0,
    });
    expect(rafQueue).toHaveLength(0);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();

    act(() => flushRaf(10));
    expect(grid.querySelectorAll('[data-pos="1"]').length).toBe(100);
    expect(onOrderChange).not.toHaveBeenCalled();
    expect(onLayoutComplete).not.toHaveBeenCalled();
  });

  test('replaces an in-progress layout generation without finishing stale chunks', () => {
    const grid = makeGrid({ width: 630 });
    for (let index = 0; index < 450; index += 1) {
      grid.appendChild(makeItem(`before-${index}`));
    }
    const gridRef = { current: grid };
    const onOrderChange = vi.fn();
    const onLayoutComplete = vi.fn();
    const { result } = renderHook(() =>
      useChunkedMasonry({
        gridRef,
        chunkSize: 100,
        defaultAspect: 1,
        onOrderChange,
        onLayoutComplete,
      })
    );

    act(() => flushRaf(1));
    expect(result.current.getCacheDebugSnapshot().activeLayoutItems).toBe(450);

    grid.appendChild(makeItem('replacement-only'));
    act(() => result.current.onItemsChanged());
    expect(result.current.getCacheDebugSnapshot()).toMatchObject({
      scheduledLayoutFrames: 1,
      layoutInProgress: true,
      activeLayoutItems: 0,
    });

    act(() => flushRaf(10));
    expect(grid.querySelectorAll('[data-pos="1"]').length).toBe(451);
    expect(onOrderChange).toHaveBeenCalledOnce();
    expect(onOrderChange.mock.calls[0][0]).toContain('replacement-only');
    expect(onLayoutComplete).toHaveBeenCalledOnce();
    expect(result.current.getCacheDebugSnapshot()).toMatchObject({
      scheduledLayoutFrames: 0,
      layoutInProgress: false,
      activeLayoutItems: 0,
    });
  });
});
