import { describe, test, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSelectionState from './useSelectionState';

describe('useSelectionState', () => {
  test('selectOnly sets exactly one id', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));
    expect(result.current.selected.has('a')).toBe(true);
    expect(result.current.selected.size).toBe(1);
  });

  test('toggle adds/removes', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.toggle('a'));
    expect(result.current.selected.has('a')).toBe(true);
    act(() => result.current.toggle('a'));
    expect(result.current.selected.has('a')).toBe(false);
  });

  test('clear empties selection', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('x'));
    act(() => result.current.clear());
    expect(result.current.selected.size).toBe(0);
  });
});

const ids = ['a', 'b', 'c', 'd', 'e'];

describe('useSelectionState (range + anchor)', () => {
  test('selectOnly sets exactly one id and anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('c'));
    expect(result.current.selected.size).toBe(1);
    expect(result.current.selected.has('c')).toBe(true);
    expect(result.current.anchorId).toBe('c');
  });

  test('toggle adds/removes and updates anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.toggle('a'));
    expect(result.current.selected.has('a')).toBe(true);
    expect(result.current.anchorId).toBe('a');
    act(() => result.current.toggle('a'));
    expect(result.current.selected.has('a')).toBe(false);
    // we keep last anchor (this is a policy choice; adjust if your hook resets it)
    expect(result.current.anchorId).toBe('a');
  });

  test('selectRange uses anchor → end (forward)', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('b')); // anchor = b
    act(() => result.current.selectRange(ids, 'd', false));
    expect(result.current.selected).toEqual(new Set(['b', 'c', 'd']));
  });

  test('selectRange handles reverse (end before anchor)', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('d')); // anchor = d
    act(() => result.current.selectRange(ids, 'b', false));
    expect(result.current.selected).toEqual(new Set(['b', 'c', 'd']));
  });

  test('selectRange additive=true merges with existing selection', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));          // anchor = a ; selected={a}
    act(() => result.current.selectRange(ids, 'c', true)); // add {a,b,c}
    expect(result.current.selected).toEqual(new Set(['a', 'b', 'c']));
    // Now set a new anchor and add another range
    act(() => result.current.selectOnly('e'));          // anchor=e; selected={e}
    act(() => result.current.selectRange(ids, 'c', true)); // add {c,d,e}
    expect(result.current.selected).toEqual(new Set(['c', 'd', 'e']));
  });

  test('selectRange with no anchor behaves like single select', () => {
    const { result } = renderHook(() => useSelectionState());
    // anchorId starts null; hook should default to endId -> single select
    act(() => result.current.selectRange(ids, 'c', false));
    expect(result.current.selected).toEqual(new Set(['c']));
    expect(result.current.anchorId).toBe('c');
  });

  test('clear empties selection and resets anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('x'));
    act(() => result.current.clear());
    expect(result.current.selected.size).toBe(0);
    expect(result.current.anchorId).toBe(null);
  });
});
