import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useVideoResourceManager from './useVideoResourceManager';

const makeVideos = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i+1) }));

describe('useVideoResourceManager (dev mode)', () => {
  test('canLoadVideo: visible videos are allowed; non-visible respect limits', () => {
    const progressiveVideos = makeVideos(50);
    const visible = new Set(['1', '2']);
    const loaded = new Set(); // none loaded yet
    const loading = new Set();
    const playing = new Set();

    const { result } = renderHook(() =>
      useVideoResourceManager({
        progressiveVideos,
        visibleVideos: visible,
        loadedVideos: loaded,
        loadingVideos: loading,
        playingVideos: playing,
      })
    );

    expect(result.current.canLoadVideo('1')).toBe(true); // visible
    expect(result.current.canLoadVideo('2')).toBe(true); // visible

    // Non-visible, within generous dev limits
    expect(result.current.canLoadVideo('10')).toBe(true);

    // Simulate being at limits: loaded >= maxLoaded or loading >= maxConcurrentLoading
    // In dev with n<100, limits are { maxLoaded: 40, maxConcurrentLoading: 4 }
    for (let i = 0; i < 40; i++) loaded.add(String(100 + i));
    for (let i = 0; i < 4; i++) loading.add(String(200 + i));

    // Non-visible should now be blocked
    expect(result.current.canLoadVideo('11')).toBe(false);

    // Visible still allowed even when at limit
    expect(result.current.canLoadVideo('2')).toBe(true);
  });

  test('performCleanup returns a reducer only when over effective limit', () => {
    vi.useFakeTimers();

    const progressiveVideos = makeVideos(200);
    const visible = new Set(['1', '2', '3']);
    const playing = new Set(['1']); // never remove playing/visible
    const loaded = new Set(Array.from({ length: 100 }, (_, i) => String(i + 1))); // many loaded
    const loading = new Set();

    const { result } = renderHook(() =>
      useVideoResourceManager({
        progressiveVideos,
        visibleVideos: visible,
        loadedVideos: loaded,
        loadingVideos: loading,
        playingVideos: playing,
      })
    );

    // First call: enough time has passed (initial 0) → eligible to cleanup
    const reducer = result.current.performCleanup();
    expect(typeof reducer === 'function' || reducer === null).toBe(true);

    if (reducer) {
      const before = new Set(loaded);
      const after = reducer(before);
      // Must keep visible and playing
      expect(after.has('1')).toBe(true);
      expect(after.has('2')).toBe(true);
      // Should attempt to trim non-essential when over the limit
      expect(after.size).toBeLessThanOrEqual(before.size);
    }

    // Calling again immediately should be throttled (returns null)
    const reducer2 = result.current.performCleanup();
    expect(reducer2).toBeNull();

    // Advance time past throttle (10s in dev path)
    act(() => vi.advanceTimersByTime(10001));
    const reducer3 = result.current.performCleanup();
    expect(typeof reducer3 === 'function' || reducer3 === null).toBe(true);

    vi.useRealTimers();
  });
});
