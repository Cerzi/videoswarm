import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useStableViewAnchoring from './useStableViewAnchoring';

const makeRect = ({ offset, height = 100, width = 120, scrollTop }) => {
  const top = offset - scrollTop;
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    height,
  };
};

describe('useStableViewAnchoring', () => {
  let scrollEl;
  let gridEl;
  let selection;
  let orderedIds;
  let rafQueue;
  let restoreGetComputedStyle;

  const flushAllRafs = () => {
    while (rafQueue.length) {
      const queue = rafQueue.slice();
      rafQueue.length = 0;
      queue.forEach((cb) => {
        if (typeof cb === 'function') {
          cb(performance.now());
        }
      });
    }
  };

  beforeEach(() => {
    rafQueue = [];

    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    vi.stubGlobal('cancelAnimationFrame', (id) => {
      const index = id - 1;
      if (index >= 0 && index < rafQueue.length) {
        rafQueue[index] = null;
      }
    });

    scrollEl = document.createElement('div');
    document.body.appendChild(scrollEl);
    gridEl = document.createElement('div');
    scrollEl.appendChild(gridEl);

    selection = {
      selected: new Set(['a']),
      anchorId: 'a',
    };

    orderedIds = ['a'];

    Object.defineProperty(scrollEl, 'clientHeight', {
      value: 600,
      configurable: true,
    });
    scrollEl.scrollTop = 0;
    scrollEl.getBoundingClientRect = vi.fn(() => ({
      top: 0,
      bottom: 600,
      height: 600,
      left: 0,
      right: 800,
      width: 800,
    }));

    restoreGetComputedStyle = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((el) => ({
        scrollPaddingTop: el === scrollEl ? '0px' : '0px',
        scrollPaddingBottom: '0px',
      }));

    vi.stubGlobal('ResizeObserver', class {
      constructor() {}
      observe() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    restoreGetComputedStyle.mockRestore();
    vi.unstubAllGlobals();
  });

  it('compensates scroll for single selection when layout shifts', () => {
    const item = document.createElement('div');
    item.dataset.videoId = 'a';
    gridEl.appendChild(item);

    let offset = 200;
    const height = 100;

    item.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset, height, scrollTop: scrollEl.scrollTop })
    );

    const { result } = renderHook(() =>
      useStableViewAnchoring({
        enabled: true,
        scrollRef: { current: scrollEl },
        gridRef: { current: gridEl },
        selection,
        orderedIds,
      })
    );

    act(() => {
      result.current.runWithStableAnchor('zoomChange', () => {
        offset = 260;
      });
    });

    act(() => {
      flushAllRafs();
    });

    expect(scrollEl.scrollTop).toBeCloseTo(60, 1);
  });

  it('anchors to the first visible tile when using topVisible mode', () => {
    const itemA = document.createElement('div');
    const itemB = document.createElement('div');
    itemA.dataset.videoId = 'a';
    itemB.dataset.videoId = 'b';
    gridEl.append(itemA, itemB);

    selection = {
      selected: new Set(['a', 'b']),
      anchorId: 'a',
    };
    orderedIds = ['a', 'b'];

    let offsetA = -150;
    let offsetB = 200;
    const heightA = 80;
    const heightB = 100;

    itemA.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset: offsetA, height: heightA, scrollTop: scrollEl.scrollTop })
    );

    itemB.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset: offsetB, height: heightB, scrollTop: scrollEl.scrollTop })
    );

    const { result } = renderHook(() =>
      useStableViewAnchoring({
        enabled: true,
        scrollRef: { current: scrollEl },
        gridRef: { current: gridEl },
        selection,
        orderedIds,
        anchorMode: 'topVisible',
      })
    );

    act(() => {
      result.current.runWithStableAnchor('sidebarToggle', () => {
        offsetB += 60;
      });
    });

    act(() => {
      flushAllRafs();
    });

    expect(scrollEl.scrollTop).toBeCloseTo(60, 1);
    expect(itemB.getBoundingClientRect).toHaveBeenCalled();
  });

  it('uses centroid of all selected tiles when anchorMode is centroid', () => {
    const itemA = document.createElement('div');
    const itemB = document.createElement('div');
    itemA.dataset.videoId = 'a';
    itemB.dataset.videoId = 'b';
    gridEl.append(itemA, itemB);

    selection = {
      selected: new Set(['a', 'b']),
      anchorId: 'b',
    };
    orderedIds = ['a', 'b'];

    let offsetA = 100;
    let offsetB = 400;
    const heightA = 100;
    const heightB = 100;

    itemA.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset: offsetA, height: heightA, scrollTop: scrollEl.scrollTop })
    );
    itemB.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset: offsetB, height: heightB, scrollTop: scrollEl.scrollTop })
    );

    const { result } = renderHook(() =>
      useStableViewAnchoring({
        enabled: true,
        scrollRef: { current: scrollEl },
        gridRef: { current: gridEl },
        selection,
        orderedIds,
        anchorMode: 'centroid',
      })
    );

    act(() => {
      result.current.runWithStableAnchor('zoomChange', () => {
        offsetA += 50;
        offsetB += 50;
      });
    });

    act(() => {
      flushAllRafs();
    });

    expect(scrollEl.scrollTop).toBeCloseTo(50, 1);
  });

  it('nudges the viewport using scroll padding when anchor stays above the padding', () => {
    restoreGetComputedStyle.mockRestore();
    restoreGetComputedStyle = vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => ({
      scrollPaddingTop: el === scrollEl ? '100px' : '0px',
      scrollPaddingBottom: '0px',
    }));

    const item = document.createElement('div');
    item.dataset.videoId = 'a';
    gridEl.appendChild(item);

    Object.defineProperty(scrollEl, 'clientHeight', {
      value: 400,
      configurable: true,
    });

    scrollEl.scrollTop = 200;

    let offset = 320;
    let height = 80;

    item.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset, height, scrollTop: scrollEl.scrollTop })
    );

    const { result } = renderHook(() =>
      useStableViewAnchoring({
        enabled: true,
        scrollRef: { current: scrollEl },
        gridRef: { current: gridEl },
        selection,
        orderedIds,
      })
    );

    act(() => {
      result.current.runWithStableAnchor('zoomChange', () => {
        offset = 280;
        height = 160;
      });
    });

    act(() => {
      flushAllRafs();
    });

    expect(scrollEl.scrollTop).toBeCloseTo(180, 1);
  });

  it('waits for anchor measurements to stabilize across frames before compensating', () => {
    const item = document.createElement('div');
    item.dataset.videoId = 'a';
    gridEl.appendChild(item);

    let offset = 200;
    const transitions = [260, 320, 340, 340, 340];
    item.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset, height: 100, scrollTop: scrollEl.scrollTop })
    );

    const { result } = renderHook(() =>
      useStableViewAnchoring({
        enabled: true,
        scrollRef: { current: scrollEl },
        gridRef: { current: gridEl },
        selection,
        orderedIds,
        settleFrames: 0,
        stabilizeFrames: 2,
      })
    );

    act(() => {
      result.current.runWithStableAnchor('sidebarToggle', () => {});
    });

    act(() => {
      while (rafQueue.length) {
        offset = transitions.shift() ?? offset;
        const queue = rafQueue.slice();
        rafQueue.length = 0;
        queue.forEach((cb) => {
          if (typeof cb === 'function') {
            cb(performance.now());
          }
        });
      }
    });

    expect(scrollEl.scrollTop).toBeCloseTo(140, 1);
    expect(item.getBoundingClientRect.mock.calls.length).toBeGreaterThan(3);
  });

  it('focusCurrentAnchor recenters the anchor when it is outside the viewport', () => {
    const item = document.createElement('div');
    item.dataset.videoId = 'a';
    gridEl.appendChild(item);

    selection = {
      selected: new Set(['a']),
      anchorId: 'a',
    };
    orderedIds = ['a'];

    let offset = 900;
    const height = 100;

    item.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset, height, scrollTop: scrollEl.scrollTop })
    );

    const { result } = renderHook(() =>
      useStableViewAnchoring({
        enabled: true,
        scrollRef: { current: scrollEl },
        gridRef: { current: gridEl },
        selection,
        orderedIds,
      })
    );

    let focused = false;
    act(() => {
      focused = result.current.focusCurrentAnchor({ align: 'center' });
    });

    expect(focused).toBe(true);
    expect(scrollEl.scrollTop).toBeCloseTo(650, 1);
    expect(item.getBoundingClientRect).toHaveBeenCalled();
  });

  it('focusCurrentAnchor keeps the anchor visible without recentring when already in view', () => {
    const item = document.createElement('div');
    item.dataset.videoId = 'a';
    gridEl.appendChild(item);

    selection = {
      selected: new Set(['a']),
      anchorId: 'a',
    };
    orderedIds = ['a'];

    let offset = 200;
    const height = 120;

    item.getBoundingClientRect = vi.fn(() =>
      makeRect({ offset, height, scrollTop: scrollEl.scrollTop })
    );

    const { result } = renderHook(() =>
      useStableViewAnchoring({
        enabled: true,
        scrollRef: { current: scrollEl },
        gridRef: { current: gridEl },
        selection,
        orderedIds,
      })
    );

    scrollEl.scrollTop = 0;

    let focused = false;
    act(() => {
      focused = result.current.focusCurrentAnchor();
    });

    expect(focused).toBe(true);
    expect(scrollEl.scrollTop).toBeCloseTo(0, 5);
    expect(item.getBoundingClientRect).toHaveBeenCalled();
  });
});
