import { describe, test, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import usePlayOrchestrator from './usePlayOrchestrator';

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

    act(() => {
      result.current.markHover('y'); // prioritizes y
      result.current.reportStarted('y');
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
});
