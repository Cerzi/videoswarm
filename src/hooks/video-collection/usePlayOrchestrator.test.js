import { describe, test, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import usePlayOrchestrator from './usePlayOrchestrator';
import { createMediaSlotScheduler } from '../../services/mediaSlotScheduler';

const setOf = (arr) => new Set(arr);

describe('usePlayOrchestrator', () => {
  test('reportStarted adds to playingSet', () => {
    const visible = setOf(['a', 'b', 'c']);
    const loaded = setOf(['a', 'b', 'c']);
    const { result } = renderHook(() =>
      usePlayOrchestrator({ visibleIds: visible, loadedIds: loaded, maxPlaying: 2 })
    );

    act(() => {
      result.current.reportStarted('a');
      result.current.reportStarted('b');
    });
    expect(result.current.playingSet.has('a')).toBe(true);
    expect(result.current.playingSet.has('b')).toBe(true);
  });

  test('hovered item is prioritized', () => {
    const visible = setOf(['x', 'y']);
    const loaded = setOf(['x', 'y']);
    const { result } = renderHook(() =>
      usePlayOrchestrator({ visibleIds: visible, loadedIds: loaded, maxPlaying: 1 })
    );

    act(() => {
      result.current.reportStarted('x');
    });
    expect(result.current.playingSet.has('x')).toBe(true);
    const xLease = result.current.getDecoderLease('x');

    act(() => {
      result.current.markHover('y'); // requests x -> y handoff
    });
    expect(result.current.playingSet.size).toBe(0);

    act(() => {
      result.current.reportPaused('x', xLease);
    });
    expect(result.current.playingSet.has('y')).toBe(true);
  });

  test('eviction only kicks in when > 110% of cap', () => {
    const visible = setOf(['1','2','3','4']);
    const loaded = setOf(['1','2','3','4']);
    const { result, rerender } = renderHook(
      (props) => usePlayOrchestrator(props),
      { initialProps: { visibleIds: visible, loadedIds: loaded, maxPlaying: 2 } }
    );

    // Below 110%: allow overrun without eviction
    act(() => {
      result.current.reportStarted('1');
      result.current.reportStarted('2');
      result.current.reportStarted('3'); // now size = 3 (>2 but <= 2*1.1=2.2? 3 is >2.2)
    });

    // Trigger reconcile via size change to enforce eviction
    const biggerVisible = setOf(['1','2','3','4','5']);
    const biggerLoaded = setOf(['1','2','3','4','5']);
    rerender({ visibleIds: biggerVisible, loadedIds: biggerLoaded, maxPlaying: 2 });

    // Expect eviction back toward cap (2)
    expect(result.current.playingSet.size).toBeLessThanOrEqual(2);
  });

  test('reconcile reacts when visible ids swap without size change', () => {
    const visible = setOf(['a', 'b']);
    const loaded = setOf(['a', 'b']);
    const { result, rerender } = renderHook((props) => usePlayOrchestrator(props), {
      initialProps: { visibleIds: visible, loadedIds: loaded, maxPlaying: 2 },
    });

    act(() => {
      result.current.reportStarted('a');
    });
    expect(result.current.playingSet.has('a')).toBe(true);

    const nextVisible = setOf(['b', 'c']);
    const nextLoaded = setOf(['b', 'c']);

    act(() => {
      rerender({ visibleIds: nextVisible, loadedIds: nextLoaded, maxPlaying: 2 });
    });

    expect(result.current.playingSet.has('a')).toBe(false);
    expect(result.current.playingSet.has('b')).toBe(true);
    expect(result.current.playingSet.has('c')).toBe(true);
  });

  test('drops tiles from playing set when they lose their loaded state', () => {
    const visible = setOf(['keep', 'reload']);
    const loaded = setOf(['keep', 'reload']);
    const { result, rerender } = renderHook(
      (props) => usePlayOrchestrator(props),
      { initialProps: { visibleIds: visible, loadedIds: loaded, maxPlaying: 3 } }
    );

    act(() => {
      result.current.reportStarted('keep');
      result.current.reportStarted('reload');
    });

    expect(result.current.playingSet.has('keep')).toBe(true);
    expect(result.current.playingSet.has('reload')).toBe(true);

    const nextLoaded = setOf(['keep']);
    rerender({ visibleIds: visible, loadedIds: nextLoaded, maxPlaying: 3 });

    expect(result.current.playingSet.has('keep')).toBe(true);
    expect(result.current.playingSet.has('reload')).toBe(false);
  });

  test('hover audio start/end tracks active card and switches cleanly', () => {
    const visible = setOf(['a', 'b']);
    const loaded = setOf(['a', 'b']);
    const { result } = renderHook(() =>
      usePlayOrchestrator({
        visibleIds: visible,
        loadedIds: loaded,
        maxPlaying: 2,
        hoverAudioEnabled: true,
      })
    );

    act(() => {
      result.current.onCardHoverAudioStart('a');
    });
    expect(result.current.activeHoverAudioId).toBe('a');

    act(() => {
      result.current.onCardHoverAudioStart('b');
    });
    expect(result.current.activeHoverAudioId).toBe('b');

    act(() => {
      result.current.onCardHoverAudioEnd('a');
    });
    expect(result.current.activeHoverAudioId).toBe('b');

    act(() => {
      result.current.onCardHoverAudioEnd('b');
    });
    expect(result.current.activeHoverAudioId).toBe(null);
  });

  test('disabling hover audio clears active hover-audio state', () => {
    const visible = setOf(['a']);
    const loaded = setOf(['a']);
    const { result, rerender } = renderHook((props) => usePlayOrchestrator(props), {
      initialProps: {
        visibleIds: visible,
        loadedIds: loaded,
        maxPlaying: 2,
        hoverAudioEnabled: true,
      },
    });

    act(() => {
      result.current.onCardHoverAudioStart('a');
    });
    expect(result.current.activeHoverAudioId).toBe('a');

    rerender({
      visibleIds: visible,
      loadedIds: loaded,
      maxPlaying: 2,
      hoverAudioEnabled: false,
    });
    expect(result.current.activeHoverAudioId).toBe(null);
  });

  test('uses exact injected leases and ignores stale pause acknowledgements', () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 2,
      maxLoaders: 2,
      maxDecoders: 1,
    });
    for (const id of ['a', 'b']) {
      const loader = scheduler.reserveLoader(id);
      scheduler.markLoaderReady(loader);
    }
    const visible = setOf(['a', 'b']);
    const loaded = setOf(['a', 'b']);
    const { result } = renderHook(() =>
      usePlayOrchestrator({
        visibleIds: visible,
        loadedIds: loaded,
        maxPlaying: 1,
        mediaScheduler: scheduler,
      })
    );
    const firstId = Array.from(result.current.playingSet)[0];
    const nextId = firstId === 'a' ? 'b' : 'a';
    const firstLease = result.current.getDecoderLease(firstId);

    act(() => result.current.markHover(nextId));
    expect(result.current.playingSet.size).toBe(0);
    expect(scheduler.getSnapshot()).toMatchObject({
      decoders: 1,
      stoppingDecoders: 1,
    });

    act(() => {
      expect(result.current.reportPaused(firstId, firstLease)).toBe(true);
    });
    const nextLease = result.current.getDecoderLease(nextId);
    expect(nextLease).toBeTruthy();
    expect(nextLease).not.toBe(firstLease);
    expect(result.current.playingSet).toEqual(new Set([nextId]));

    act(() => {
      expect(result.current.reportPaused(firstId, firstLease)).toBe(false);
    });
    expect(result.current.getDecoderLease(nextId)).toBe(nextLease);
  });
});
