import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useActionDispatch from './useActionDispatch';
import { actionRegistry, ActionIds } from './actions';

describe('useActionDispatch', () => {
  test('uses contextId when it is not in selection', async () => {
    const electronAPI = {};
    const notify = vi.fn();
    const getById = vi.fn((id) => ({ id, name: id, fullPath: `/${id}`, isElectronFile: true }));
    const { result } = renderHook(() => useActionDispatch({ electronAPI, notify }, getById));

    const spy = vi.spyOn(actionRegistry, ActionIds.OPEN_EXTERNAL);
    spy.mockResolvedValue();

    const selected = new Set(['a', 'b']); // selection
    const contextId = 'c';                // right-clicked item not in selection

    await act(async () => {
      await result.current.runAction(ActionIds.OPEN_EXTERNAL, selected, contextId);
    });

    // Should act on ONLY contextId in this case
    expect(getById).toHaveBeenCalledWith('c');
    expect(getById).not.toHaveBeenCalledWith('a');
    expect(getById).not.toHaveBeenCalledWith('b');

    spy.mockRestore();
  });

  test('uses selection when contextId is in selection', async () => {
    const electronAPI = {};
    const notify = vi.fn();
    const getById = vi.fn((id) => ({ id, name: id, fullPath: `/${id}`, isElectronFile: true }));
    const { result } = renderHook(() => useActionDispatch({ electronAPI, notify }, getById));

    const spy = vi.spyOn(actionRegistry, ActionIds.COPY_FILENAME);
    spy.mockResolvedValue();

    const selected = new Set(['a', 'c']); // contextId within selection
    const contextId = 'a';

    await act(async () => {
      await result.current.runAction(ActionIds.COPY_FILENAME, selected, contextId);
    });

    // Should act on selection
    expect(getById).toHaveBeenCalledWith('a');
    expect(getById).toHaveBeenCalledWith('c');

    spy.mockRestore();
  });
});
