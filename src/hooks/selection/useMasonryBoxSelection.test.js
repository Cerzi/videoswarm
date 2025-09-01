import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import useMasonryBoxSelection from './useMasonryBoxSelection';

function makeRect(l, t, r, b) {
  return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
}

describe('useMasonryBoxSelection', () => {
  let gridRef;
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    gridRef = { current: container };
    container.innerHTML = '';

    // helper to add a .video-item with a fixed rect
    const addItem = (id, rect) => {
      const el = document.createElement('div');
      el.className = 'video-item';
      el.dataset.videoId = id;
      el.getBoundingClientRect = vi.fn(() => rect);
      container.appendChild(el);
      return el;
    };

    // Layout (masonry-like):
    // a: (0,0)-(100,80)
    // b: (110,0)-(210,60)
    // c: (220,0)-(320,120)   <-- taller column
    // d: (0,90)-(100,170)
    // e: (110,70)-(210,130)
    addItem('a', makeRect(0,    0, 100,  80));
    addItem('b', makeRect(110,  0, 210,  60));
    addItem('c', makeRect(220,  0, 320, 120));
    addItem('d', makeRect(0,   90, 100, 170));
    addItem('e', makeRect(110, 70, 210, 130));
  });

  test('getBoxSelectionIds selects items within bounding box between anchor and end', () => {
    const { result } = renderHook(() => useMasonryBoxSelection(gridRef));
    const { getBoxSelectionIds } = result.current;

    // anchor = 'a' (top-left), end = 'e' (middle-bottom-ish)
    const ids = getBoxSelectionIds('a', 'e');
    // Box should cover columns a..e rows overlapping vertically → a, b, d, e (c is outside if box ends before 220px)
    expect(ids instanceof Set).toBe(true);

    // Check content (order unspecified)
    const arr = Array.from(ids).sort();
    expect(arr).toEqual(['a', 'b', 'd', 'e']);
  });

  test('getBoxSelectionIds returns empty Set if anchor or end not found', () => {
    const { result } = renderHook(() => useMasonryBoxSelection(gridRef));
    const { getBoxSelectionIds } = result.current;

    expect(getBoxSelectionIds('missing', 'a').size).toBe(0);
    expect(getBoxSelectionIds('a', 'missing').size).toBe(0);
  });

  test('selectRangeByBox replaces or merges selection', () => {
    const { result } = renderHook(() => useMasonryBoxSelection(gridRef));
    const { selectRangeByBox } = result.current;

    // fake selection API
    let current = new Set(['z']); // pre-existing selection
    const selection = {
      setSelected: (updater) => {
        current = typeof updater === 'function' ? updater(current) : updater;
      }
    };

    // replace
    selectRangeByBox(selection, 'a', 'e', /*additive*/ false);
    expect(current instanceof Set).toBe(true);
    expect(Array.from(current).sort()).toEqual(['a', 'b', 'd', 'e']);

    // additive (merge in anchor=end of a smaller box)
    selectRangeByBox(selection, 'b', 'b', /*additive*/ true);
    expect(Array.from(current).sort()).toEqual(['a', 'b', 'd', 'e']); // unchanged; 'b' already present
  });
});
