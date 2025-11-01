import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useContextMenu } from './useContextMenu';

describe('useContextMenu', () => {
  test('showOnItem opens the menu without requiring selection mutation', () => {
    const { result } = renderHook(() => useContextMenu());
    const selectOnly = vi.fn();
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 10,
      clientY: 20,
    };

    act(() => result.current.showOnItem(event, 'vid1', false, selectOnly));

    expect(selectOnly).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(result.current.contextMenu.visible).toBe(true);
    expect(result.current.contextMenu.contextId).toBe('vid1');
    expect(result.current.contextMenu.position).toEqual({ x: 10, y: 20 });
  });

  test('showOnEmpty hides the custom menu without clearing selection', () => {
    const { result } = renderHook(() => useContextMenu());
    const clear = vi.fn();
    const openEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 5,
      clientY: 8,
    };

    act(() => result.current.showOnItem(openEvent, 'vid2'));
    expect(result.current.contextMenu.visible).toBe(true);

    const emptyEvent = { stopPropagation: vi.fn() };
    act(() => result.current.showOnEmpty(emptyEvent, clear));

    expect(clear).not.toHaveBeenCalled();
    expect(emptyEvent.stopPropagation).toHaveBeenCalled();
    expect(result.current.contextMenu.visible).toBe(false);
    expect(result.current.contextMenu.contextId).toBeUndefined();
  });

  test('hide sets visible=false', () => {
    const { result } = renderHook(() => useContextMenu());
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      clientX: 1,
      clientY: 1,
    };

    act(() => result.current.showOnItem(event, 'vid3'));
    act(() => result.current.hide());
    expect(result.current.contextMenu.visible).toBe(false);
  });
});
