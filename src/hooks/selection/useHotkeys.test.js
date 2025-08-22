import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import useHotkeys from './useHotkeys';
import { ActionIds } from '../actions/actions';

describe('useHotkeys', () => {
  let run, getSelection;

  beforeEach(() => {
    run = vi.fn();
    getSelection = vi.fn(() => new Set(['x']));
  });

  afterEach(() => {
    run.mockReset();
  });

  test('Enter triggers OPEN_EXTERNAL', () => {
    renderHook(() => useHotkeys(run, getSelection));
    const ev = new KeyboardEvent('keydown', { key: 'Enter' });
    document.dispatchEvent(ev);
    expect(run).toHaveBeenCalledWith(ActionIds.OPEN_EXTERNAL, new Set(['x']));
  });

  test('Ctrl/Cmd + C triggers COPY_PATH', () => {
    renderHook(() => useHotkeys(run, getSelection));
    const ev = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true });
    document.dispatchEvent(ev);
    expect(run).toHaveBeenCalledWith(ActionIds.COPY_PATH, new Set(['x']));
  });

  test('Delete triggers MOVE_TO_TRASH', () => {
    renderHook(() => useHotkeys(run, getSelection));
    const ev = new KeyboardEvent('keydown', { key: 'Delete' });
    document.dispatchEvent(ev);
    expect(run).toHaveBeenCalledWith(ActionIds.MOVE_TO_TRASH, new Set(['x']));
  });
});
