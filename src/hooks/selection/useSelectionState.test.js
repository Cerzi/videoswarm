import { describe, test, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSelectionState from './useSelectionState';

describe('useSelectionState', () => {
  test('selectOnly sets exactly one id and anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));
    expect(result.current.selected).toEqual(new Set(['a']));
    expect(result.current.anchorId).toBe('a');
  });

  test('selectOnly on the same id keeps anchor and selection', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));
    expect(result.current.selected.size).toBe(1);
    act(() => result.current.selectOnly('a'));
    expect(result.current.selected).toEqual(new Set(['a']));
    expect(result.current.anchorId).toBe('a');
  });

  test('toggle modifies selection without changing anchor from last single click', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));
    expect(result.current.anchorId).toBe('a');

    act(() => result.current.toggle('b'));
    expect(result.current.selected).toEqual(new Set(['a', 'b']));
    expect(result.current.anchorId).toBe('a');

    act(() => result.current.toggle('b'));
    expect(result.current.selected).toEqual(new Set(['a']));
    expect(result.current.anchorId).toBe('a');
  });

  test('toggle without prior anchor leaves anchor unset', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.toggle('a'));
    expect(result.current.selected).toEqual(new Set(['a']));
    expect(result.current.anchorId).toBe(null);
  });

  test('resetAnchor clears anchor without altering selection', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));
    expect(result.current.anchorId).toBe('a');
    act(() => result.current.resetAnchor());
    expect(result.current.anchorId).toBe(null);
    expect(result.current.selected).toEqual(new Set(['a']));
  });

  test('clear empties selection and anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('x'));
    act(() => result.current.clear());
    expect(result.current.selected.size).toBe(0);
    expect(result.current.anchorId).toBe(null);
  });
});

const ids = ['a', 'b', 'c', 'd', 'e'];

describe('useSelectionState (range + anchor)', () => {
  test('selectRange uses anchor → end (forward) and updates anchor to clicked id', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('b'));
    act(() => result.current.selectRange(ids, 'd', false));
    expect(result.current.selected).toEqual(new Set(['b', 'c', 'd']));
    expect(result.current.anchorId).toBe('d');
  });

  test('selectRange handles reverse order and updates anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('d'));
    act(() => result.current.selectRange(ids, 'b', false));
    expect(result.current.selected).toEqual(new Set(['b', 'c', 'd']));
    expect(result.current.anchorId).toBe('b');
  });

  test('selectRange additive=true merges with existing selection and updates anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));
    act(() => result.current.selectRange(ids, 'c', true));
    expect(result.current.selected).toEqual(new Set(['a', 'b', 'c']));
    expect(result.current.anchorId).toBe('c');

    act(() => result.current.selectOnly('e'));
    act(() => result.current.selectRange(ids, 'c', true));
    expect(result.current.selected).toEqual(new Set(['c', 'd', 'e']));
    expect(result.current.anchorId).toBe('c');
  });

  test('selectRange with no anchor behaves like single select', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectRange(ids, 'c', false));
    expect(result.current.selected).toEqual(new Set(['c']));
    expect(result.current.anchorId).toBe('c');
  });

  test('selectRange falls back to earliest selected id when anchor is missing', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('c'));
    act(() => result.current.setAnchor('z'));
    act(() => result.current.selectRange(ids, 'e', false));
    expect(result.current.selected).toEqual(new Set(['c', 'd', 'e']));
    expect(result.current.anchorId).toBe('e');
  });

  test('anchor reassigns when anchor item is removed from selection', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('b'));
    act(() =>
      result.current.setSelected((prev) => {
        const ns = new Set(prev);
        ns.delete('b');
        ns.add('d');
        return ns;
      })
    );
    expect(result.current.selected).toEqual(new Set(['d']));
    expect(result.current.anchorId).toBe('d');
  });
});
