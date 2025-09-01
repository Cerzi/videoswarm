import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import useHotkeys from '../selection/useHotkeys'; // adjust if path differs
import { ActionIds } from '../actions/actions';

describe('useHotkeys', () => {
  let run, getSelection;

  beforeEach(() => {
    run = vi.fn();
    getSelection = vi.fn(() => new Set(['x']));
  });

  test('Enter triggers OPEN_EXTERNAL only for single selection', () => {
    renderHook(() => useHotkeys(run, getSelection));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(run).toHaveBeenCalledWith(ActionIds.OPEN_EXTERNAL, new Set(['x']));

    // Now simulate multi-select; Enter should NOT call Open
    run.mockReset();
    getSelection.mockReturnValue(new Set(['x', 'y']));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(run).not.toHaveBeenCalled();
  });

  test('Ctrl/Cmd + C triggers COPY_PATH (multi allowed)', () => {
    renderHook(() => useHotkeys(run, getSelection));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
    expect(run).toHaveBeenCalledWith(ActionIds.COPY_PATH, new Set(['x']));
  });

  test('Delete triggers MOVE_TO_TRASH (multi allowed)', () => {
    renderHook(() => useHotkeys(run, getSelection));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(run).toHaveBeenCalledWith(ActionIds.MOVE_TO_TRASH, new Set(['x']));
  });
});
