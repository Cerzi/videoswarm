import { describe, test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useActionDispatch from './useActionDispatch';
import { actionRegistry, ActionIds } from './actions';

describe('useActionDispatch (target resolution policy)', () => {
  test('OPEN_EXTERNAL → context-only when right-clicked item is not in selection', async () => {
    const getById = vi.fn((id) => ({ id, name: id, fullPath: `/${id}`, isElectronFile: true }));
    const deps = { electronAPI: {}, notify: vi.fn() };
    const { result } = renderHook(() => useActionDispatch(deps, getById));

    const execSpy = vi.spyOn(actionRegistry, ActionIds.OPEN_EXTERNAL).mockResolvedValue();

    const selected = new Set(['a', 'b']); // selection
    const contextId = 'c';                // right-clicked item not in selection

    await act(async () => {
      await result.current.runAction(ActionIds.OPEN_EXTERNAL, selected, contextId);
    });

    // Should act on ONLY contextId for context-only actions
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith('c');

    execSpy.mockRestore();
  });

  test('COPY_FILENAME → all-selected when context is inside selection', async () => {
    const getById = vi.fn((id) => ({ id, name: id, fullPath: `/${id}`, isElectronFile: true }));
    const deps = { electronAPI: {}, notify: vi.fn() };
    const { result } = renderHook(() => useActionDispatch(deps, getById));

    const execSpy = vi.spyOn(actionRegistry, ActionIds.COPY_FILENAME).mockResolvedValue();

    const selected = new Set(['a', 'c']); // selection contains context
    const contextId = 'a';

    await act(async () => {
      await result.current.runAction(ActionIds.COPY_FILENAME, selected, contextId);
    });

    // Should act on all selected for multi actions
    expect(getById).toHaveBeenCalledWith('a');
    expect(getById).toHaveBeenCalledWith('c');
    expect(getById).toHaveBeenCalledTimes(2);

    execSpy.mockRestore();
  });

  test('with no selection but a contextId, runs on context only', async () => {
    const getById = vi.fn((id) => ({ id, name: id, fullPath: `/${id}`, isElectronFile: true }));
    const deps = { electronAPI: {}, notify: vi.fn() };
    const { result } = renderHook(() => useActionDispatch(deps, getById));

    const execSpy = vi.spyOn(actionRegistry, ActionIds.SHOW_IN_FOLDER).mockResolvedValue();

    const selected = new Set(); // empty selection
    const contextId = 'z';

    await act(async () => {
      await result.current.runAction(ActionIds.SHOW_IN_FOLDER, selected, contextId);
    });

    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith('z');

    execSpy.mockRestore();
  });
});
