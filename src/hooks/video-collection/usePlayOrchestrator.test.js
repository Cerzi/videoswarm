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
    // Both may momentarily be allowed, but after reconcile the hovered stays
    // Trigger reconcile by simulating set size changes (effect depends on sizes)
    const rerenderVisible = setOf(['x', 'y', 'z']); // increase size to trigger effect
    const rerenderLoaded = setOf(['x', 'y', 'z']);
    // Re-render to trigger reconcile
    const { rerender } = renderHook(
      (props) => usePlayOrchestrator(props),
      { initialProps: { visibleIds: visible, loadedIds: loaded, maxPlaying: 1 } }
    );
    rerender({ visibleIds: rerenderVisible, loadedIds: rerenderLoaded, maxPlaying: 1 });

    // Expect 'y' (hovered) to be in desired set
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
});
