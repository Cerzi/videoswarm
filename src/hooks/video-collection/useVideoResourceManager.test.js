import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import useVideoResourceManager from './useVideoResourceManager';

const makeVideos = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1) }));

// let the hook's async memory tick settle
const flushAsync = async (times = 2) => {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

beforeEach(() => {
  // Stub Electron memory so limits are stable/deterministic
  global.window = global.window || {};
  window.appMem = {
    get: vi.fn().mockResolvedValue({
      totals: { wsMB: 512, totalMB: 8192 }, // 0.5 GB app WS, 8 GB total
      processes: [],
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useVideoResourceManager (current behavior)', () => {
  test('canLoadVideo: visible allowed under limits; non-visible requires isNear; visible can overflow loader cap slightly', async () => {
    const progressiveVideos = makeVideos(50);
    const visible = new Set(['1', '2']);
    const loaded = new Set();
    const loading = new Set();
    const playing = new Set();

    // Mark id '10' as "near" even though it's not visible
    const isNear = (id) => id === '10';

    const { result } = renderHook(() =>
      useVideoResourceManager({
        progressiveVideos,
        visibleVideos: visible,
        loadedVideos: loaded,
        loadingVideos: loading,
        playingVideos: playing,
        isNear,
        playingCap: 32, // ensures a sensible maxLoaded floor for determinism
      })
    );

    await flushAsync();

    // Under limits: visible ids allowed
    expect(result.current.canLoadVideo('1')).toBe(true);
    expect(result.current.canLoadVideo('2')).toBe(true);

    // Non-visible but near → allowed under limits
    expect(result.current.canLoadVideo('10')).toBe(true);

    // ── Consume background headroom so "far non-visible" should be blocked ──
    const { maxConcurrentLoading, maxLoaded } = result.current.limits;

    // Fill some "loaded" but keep below cap so loaded-size doesn't trip the other guard
    for (let i = 0; i < Math.max(0, maxLoaded - 5); i++) loaded.add(`L${i}`);

    // Fill loader usage to reach the 50% headroom threshold (policy blocks when >= 50%)
    const halfCap = Math.floor(maxConcurrentLoading * 0.5);
    for (let i = 0; i < halfCap; i++) loading.add(`H${i}`);

    // Non-visible and NOT near → now blocked (headroom consumed)
    expect(result.current.canLoadVideo('11')).toBe(false);

    // ── Hit loader cap and verify visible-bypass overflow ──
    for (let i = loading.size; i < maxConcurrentLoading; i++) loading.add(`X${i}`);

    // At the cap: visible can still load (overflow allowance), non-visible cannot
    expect(result.current.canLoadVideo('2')).toBe(true);   // visible allowed via overflow
    expect(result.current.canLoadVideo('10')).toBe(false); // near but non-visible → blocked at cap

    // Push beyond overflow → now visible is also blocked
    const overflow = Math.max(2, Math.floor(maxConcurrentLoading * 0.25));
    for (let i = 0; i < overflow + 1; i++) loading.add(`O${i}`);
    expect(result.current.canLoadVideo('2')).toBe(false);
  });

  test('performCleanup returns victim ids when over the limit; never evicts playing or visible', async () => {
    const progressiveVideos = makeVideos(200);
    const visible = new Set(['1', '2', '3']);
    const playing = new Set(['1']); // protect playing tiles
    const loaded = new Set();
    const loading = new Set();

    const { result } = renderHook(() =>
      useVideoResourceManager({
        progressiveVideos,
        visibleVideos: visible,
        loadedVideos: loaded,
        loadingVideos: loading,
        playingVideos: playing,
        isNear: () => false,
        playingCap: 32,
      })
    );

    await flushAsync();

    const { maxLoaded } = result.current.limits;

    // Make ourselves over the limit by ~20; include '1','2','3' in loaded
    const overBy = 20;
    for (let i = 0; i < maxLoaded + overBy; i++) {
      loaded.add(String(i + 1));
    }

    const victims = result.current.performCleanup();
    expect(Array.isArray(victims)).toBe(true);

    if (Array.isArray(victims)) {
      // should never evict playing/visible
      expect(victims.includes('1')).toBe(false); // playing
      expect(victims.includes('2')).toBe(false); // visible
      expect(victims.includes('3')).toBe(false); // visible

      // reasonable count (<= overBy) and drawn from loaded set
      const victimsInLoaded = victims.filter((id) => loaded.has(id));
      expect(victimsInLoaded.length).toBeGreaterThan(0);
      expect(victimsInLoaded.length).toBeLessThanOrEqual(overBy);
    }
  });
});
