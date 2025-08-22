import { describe, test, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useVideoCollection from './useVideoCollection';

const vids = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i+1) }));

describe('useVideoCollection (composite)', () => {
  test('progressive render count + playing state + stats', () => {
    const videos = vids(120);
    const visible = new Set(['1','2','3','4','5']);
    const loaded = new Set(['1','2','3','4','5']);
    const loading = new Set();
    const playingActual = new Set(); // external tracking, not used directly for desired state

    const { result } = renderHook(() =>
      useVideoCollection({
        videos,
        visibleVideos: visible,
        loadedVideos: loaded,
        loadingVideos: loading,
        actualPlaying: playingActual,
        maxConcurrentPlaying: 3,
        progressiveOptions: { initial: 20, batchSize: 20 },
      })
    );

    // Initial progressive list length
    expect(result.current.videosToRender.length).toBe(20);
    expect(result.current.stats.total).toBe(120);
    expect(result.current.stats.rendered).toBe(20);
    expect(result.current.stats.loaded).toBe(loaded.size);

    // Report a start - should reflect in isVideoPlaying and stats.playing
    act(() => result.current.reportStarted('1'));
    expect(result.current.isVideoPlaying('1')).toBe(true);
    expect(result.current.stats.playing).toBeGreaterThanOrEqual(1);

    // Mark hover and start a second item; shouldn’t exceed cap drastically
    act(() => {
      result.current.markHover('2');
      result.current.reportStarted('2');
    });
    expect(result.current.isVideoPlaying('2')).toBe(true);
  });
});
