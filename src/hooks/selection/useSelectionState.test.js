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
