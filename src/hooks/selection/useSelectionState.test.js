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

  test('selectOnly on the same id clears selection', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));
    expect(result.current.selected.size).toBe(1);
    act(() => result.current.selectOnly('a'));
    expect(result.current.selected.size).toBe(0);
  });

  test('selectOnly isolates a member of a multi-selection before clearing', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('a'));
    act(() => result.current.toggle('b'));
    expect(result.current.selected).toEqual(new Set(['a', 'b']));

    act(() => result.current.selectOnly('a'));
    expect(result.current.selected).toEqual(new Set(['a']));
    expect(result.current.anchorId).toBe('a');

    act(() => result.current.selectOnly('a'));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.anchorId).toBe(null);
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

  test('selectExactly never toggles an already-selected id off', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectExactly('a'));
    act(() => result.current.selectExactly('a'));
    expect(result.current.selected).toEqual(new Set(['a']));
    expect(result.current.anchorId).toBe('a');
  });

  test('setSelectedIds restores a batch with a usable anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.setSelectedIds(['b', 'c']));
    expect(result.current.selected).toEqual(new Set(['b', 'c']));
    expect(result.current.anchorId).toBe('b');

    act(() => result.current.setSelectedIds(new Set()));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.anchorId).toBe(null);
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

  test('selectOnly toggled clears anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('c'));
    expect(result.current.anchorId).toBe('c');
    act(() => result.current.selectOnly('c'));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.anchorId).toBe(null);
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

  test('selectRange spans unmounted portions of a 5,000-id logical order', () => {
    const largeOrder = Array.from({ length: 5000 }, (_, index) => `clip-${index}`);
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('clip-100'));
    act(() => result.current.selectRange(largeOrder, 'clip-4100', false));

    expect(result.current.selected.size).toBe(4001);
    expect(result.current.selected.has('clip-100')).toBe(true);
    expect(result.current.selected.has('clip-2000')).toBe(true);
    expect(result.current.selected.has('clip-4100')).toBe(true);
    expect(result.current.selected.has('clip-99')).toBe(false);
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

  test('pruneTo removes filtered ids and clears a stale range anchor', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('b'));
    act(() => result.current.selectRange(ids, 'd', false));
    expect(result.current.selected).toEqual(new Set(['b', 'c', 'd']));

    act(() => result.current.pruneTo(new Set(['c', 'd', 'e'])));
    expect(result.current.selected).toEqual(new Set(['c', 'd']));
    expect(result.current.anchorId).toBe(null);
  });

  test('remove clears the anchor when a watched file disappears', () => {
    const { result } = renderHook(() => useSelectionState());
    act(() => result.current.selectOnly('c'));
    act(() => result.current.remove('c'));
    expect(result.current.selected.size).toBe(0);
    expect(result.current.anchorId).toBe(null);
  });
});

describe('useSelectionState with selection units', () => {
  // A collapsed stack: s1 (its cover), s2 and s3 select together.
  const stackUnits = {
    unitOf: (id) => (['s1', 's2', 's3'].includes(id) ? 'stack' : null),
    membersOf: (key) => (key === 'stack' ? ['s1', 's2', 's3'] : []),
    representativeOf: (key) => (key === 'stack' ? 's1' : null),
  };
  const renderWithUnits = (units = stackUnits) => {
    const unitsRef = { current: units };
    const hook = renderHook(() => useSelectionState({ unitsRef }));
    return { ...hook, unitsRef };
  };

  test('selecting any run of a stack selects the whole stack', () => {
    const { result } = renderWithUnits();
    act(() => result.current.selectOnly('s1'));
    expect(result.current.selected).toEqual(new Set(['s1', 's2', 's3']));
    act(() => result.current.selectExactly('s3'));
    expect(result.current.selected).toEqual(new Set(['s1', 's2', 's3']));
    act(() => result.current.setSelectedIds(['s2', 'x']));
    expect(result.current.selected).toEqual(new Set(['s1', 's2', 's3', 'x']));
  });

  test('clicking a selected stack again clears it, as for one clip', () => {
    const { result } = renderWithUnits();
    act(() => result.current.selectOnly('s1'));
    act(() => result.current.selectOnly('s1'));
    expect(result.current.selected.size).toBe(0);
  });

  test('ctrl-click toggles a stack as one item', () => {
    const { result } = renderWithUnits();
    act(() => result.current.selectOnly('x'));
    act(() => result.current.toggle('s1'));
    expect(result.current.selected).toEqual(new Set(['x', 's1', 's2', 's3']));
    act(() => result.current.toggle('s1'));
    expect(result.current.selected).toEqual(new Set(['x']));
  });

  test('a range spans stacks through their covers', () => {
    const { result } = renderWithUnits();
    act(() => result.current.selectExactly('s3'));
    act(() => result.current.selectRange(['a', 's1', 'b'], 'b'));
    expect(result.current.selected).toEqual(new Set(['s1', 's2', 's3', 'b']));
  });

  test('widens a partly selected stack after the units change', () => {
    const { result, unitsRef } = renderWithUnits(null);
    act(() => result.current.setSelectedIds(['s2', 'x']));
    expect(result.current.selected).toEqual(new Set(['s2', 'x']));
    unitsRef.current = stackUnits;
    act(() => result.current.expandToUnits());
    expect(result.current.selected).toEqual(new Set(['s1', 's2', 's3', 'x']));
    const before = result.current.selected;
    act(() => result.current.expandToUnits());
    expect(result.current.selected).toBe(before);
  });

  test('without units every id stands alone', () => {
    const { result } = renderWithUnits(null);
    act(() => result.current.selectOnly('s1'));
    expect(result.current.selected).toEqual(new Set(['s1']));
    act(() => result.current.toggle('s2'));
    expect(result.current.selected).toEqual(new Set(['s1', 's2']));
  });
});
