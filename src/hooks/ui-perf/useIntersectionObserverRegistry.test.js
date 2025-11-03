import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import useIntersectionObserverRegistry from './useIntersectionObserverRegistry';

let lastObserver = null;
let originalIntersectionObserver;
let originalRAF;
let originalCancelRAF;

class MockIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = new Set();
    lastObserver = this;
  }

  observe(el) {
    this.observed.add(el);
  }

  unobserve(el) {
    this.observed.delete(el);
  }

  disconnect() {
    this.observed.clear();
  }

  emit(entries) {
    this.callback(entries);
  }
}

beforeEach(() => {
  originalIntersectionObserver = global.IntersectionObserver;
  global.IntersectionObserver = MockIntersectionObserver;
  lastObserver = null;
  originalRAF = global.requestAnimationFrame;
  originalCancelRAF = global.cancelAnimationFrame;
  global.requestAnimationFrame = (cb) => {
    cb(0);
    return 1;
  };
  global.cancelAnimationFrame = () => {};
});

afterEach(() => {
  if (originalIntersectionObserver) {
    global.IntersectionObserver = originalIntersectionObserver;
  } else {
    delete global.IntersectionObserver;
  }
  if (originalRAF) {
    global.requestAnimationFrame = originalRAF;
  } else {
    delete global.requestAnimationFrame;
  }
  if (originalCancelRAF) {
    global.cancelAnimationFrame = originalCancelRAF;
  } else {
    delete global.cancelAnimationFrame;
  }
  vi.restoreAllMocks();
  lastObserver = null;
});

describe('useIntersectionObserverRegistry', () => {
  test('refresh recomputes visibility when layout changes outside observer events', () => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 });
    const rootRef = { current: root };

    const handler = vi.fn();
    const element = document.createElement('div');
    let rect = { top: -200, bottom: -50, left: 0, right: 100, width: 100, height: 150 };
    element.getBoundingClientRect = () => rect;

    const { result } = renderHook(() =>
      useIntersectionObserverRegistry(rootRef, { rootMargin: '0px 0px', threshold: [0], nearPx: 100 })
    );

    result.current.observe(element, 'video-1', handler);

    expect(lastObserver).not.toBeNull();

    // Immediate evaluation reflects the current (off-screen) position
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(false, expect.objectContaining({ target: element }));
    expect(result.current.isVisible('video-1')).toBe(false);

    handler.mockClear();
    rect = { top: 10, bottom: 160, left: 0, right: 120, width: 120, height: 150 };

    act(() => {
      result.current.refresh();
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(true);
    expect(result.current.isVisible('video-1')).toBe(true);
  });

  test('near detection updates when nearPx option changes', () => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 });
    const rootRef = { current: root };

    const element = document.createElement('div');
    const makeRect = () => ({ top: 650, bottom: 780, left: 0, right: 120, width: 120, height: 130 });
    element.getBoundingClientRect = makeRect;

    const { result, rerender } = renderHook(
      ({ nearPx }) => useIntersectionObserverRegistry(rootRef, { rootMargin: '0px 0px', threshold: [0], nearPx }),
      { initialProps: { nearPx: 50 } }
    );

    const handler = vi.fn();
    result.current.observe(element, 'video-2', handler);
    expect(lastObserver).not.toBeNull();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.current.isNear('video-2')).toBe(false);
    expect(result.current.getNearPx()).toBe(50);

    rerender({ nearPx: 220 });

    act(() => {
      result.current.refresh();
    });

    expect(result.current.getNearPx()).toBe(220);
    expect(result.current.isNear('video-2')).toBe(true);
  });

  test('observe immediately reports visibility for in-view elements', () => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 });
    const rootRef = { current: root };

    const handler = vi.fn();
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({ top: 20, bottom: 180, left: 0, right: 100, width: 100, height: 160 });

    const { result } = renderHook(() =>
      useIntersectionObserverRegistry(rootRef, { rootMargin: '0px 0px', threshold: [0], nearPx: 100 })
    );

    act(() => {
      result.current.observe(element, 'video-3', handler);
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toBe(true);
    expect(result.current.isVisible('video-3')).toBe(true);
  });
});
