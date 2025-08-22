import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useContextMenu } from './useContextMenu';

describe('useContextMenu', () => {
  test('showOnItem selects when item not selected', () => {
    const { result } = renderHook(() => useContextMenu());
    const selectOnly = vi.fn();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 10, clientY: 20 };
    act(() => result.current.showOnItem(event, 'vid1', false, selectOnly));
    expect(selectOnly).toHaveBeenCalledWith('vid1');
    expect(result.current.contextMenu.visible).toBe(true);
    expect(result.current.contextMenu.contextId).toBe('vid1');
  });

  test('showOnEmpty clears selection', () => {
    const { result } = renderHook(() => useContextMenu());
    const clear = vi.fn();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 5, clientY: 8 };
    act(() => result.current.showOnEmpty(event, clear));
    expect(clear).toHaveBeenCalled();
    expect(result.current.contextMenu.visible).toBe(true);
    expect(result.current.contextMenu.contextId).toBeUndefined();
  });

  test('hide sets visible=false', () => {
    const { result } = renderHook(() => useContextMenu());
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 1, clientY: 1 };
    act(() => result.current.showOnEmpty(event, () => {}));
    act(() => result.current.hide());
    expect(result.current.contextMenu.visible).toBe(false);
  });
});
