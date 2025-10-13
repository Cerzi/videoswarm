import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useAspectRatioMemory from './useAspectRatioMemory';
import { __ASPECT_RATIO_STORAGE_KEY } from '../utils/aspectRatioStorage';

describe('useAspectRatioMemory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads persisted hints from localStorage', () => {
    localStorage.setItem(
      __ASPECT_RATIO_STORAGE_KEY,
      JSON.stringify({ foo: 0.5, bar: 1.75 })
    );

    const { result } = renderHook(() => useAspectRatioMemory());

    expect(result.current.aspectRatioMapRef.current.get('foo')).toBeCloseTo(0.5, 3);
    expect(result.current.getAspectRatioHint('foo')).toBeCloseTo(0.5, 3);
    expect(result.current.getAspectRatioHint('missing')).toBeNull();
  });

  it('remembers ratios and debounces persistence', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useAspectRatioMemory());

    act(() => {
      result.current.rememberAspectRatio('clip', 1.23456);
    });

    expect(result.current.getAspectRatioHint('clip')).toBeCloseTo(1.235, 3);
    // Not yet persisted
    expect(localStorage.getItem(__ASPECT_RATIO_STORAGE_KEY)).toBeNull();

    act(() => {
      vi.runOnlyPendingTimers();
    });

    const stored = JSON.parse(localStorage.getItem(__ASPECT_RATIO_STORAGE_KEY));
    expect(stored.clip).toBeCloseTo(1.235, 3);

    unmount();
  });

  it('drops oldest entries when exceeding maxEntries', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAspectRatioMemory({ maxEntries: 2 }));

    act(() => {
      result.current.rememberAspectRatio('a', 1);
      result.current.rememberAspectRatio('b', 1.5);
    });

    act(() => {
      result.current.rememberAspectRatio('c', 0.8);
    });

    act(() => {
      vi.runAllTimers();
    });

    const store = result.current.aspectRatioMapRef.current;
    expect(store.size).toBe(2);
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(true);
    expect(store.has('c')).toBe(true);
  });
});
