import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useCardSelection from './useCardSelection';

// minimal gridRef (used by useMasonryBoxSelection inside useCardSelection)
const gridRef = { current: document.createElement('div') };

describe('useCardSelection', () => {
  let selection;
  let getById;
  let openFullScreen;
  let showOnItem;
  let showOnEmpty;
  let getLinearOrder;

  beforeEach(() => {
    // Selection stub
    selection = {
      selected: new Set(),
      anchorId: null,
      selectOnly: vi.fn((id) => {
        selection.selected = new Set([id]);
        selection.anchorId = id;
      }),
      toggle: vi.fn((id) => {
        if (selection.selected.has(id)) selection.selected.delete(id);
        else selection.selected.add(id);
      }),
      selectRange: vi.fn(),
      clear: vi.fn(() => {
        selection.selected = new Set();
        selection.anchorId = null;
      }),
      setSelected: vi.fn((updater) => {
        const next = typeof updater === 'function' ? updater(selection.selected) : updater;
        selection.selected = next;
      })
    };

    getById = vi.fn((id) => ({ id })); // pretend it exists
    openFullScreen = vi.fn();
    showOnItem = vi.fn();
    showOnEmpty = vi.fn();
    getLinearOrder = vi.fn(() => ['a', 'b', 'c', 'd']);

    // jsdom root for querySelectorAll in inner hook (no actual items needed here for most tests)
    gridRef.current.innerHTML = '';
  });

  const render = () =>
    renderHook(() =>
      useCardSelection({
        gridRef,
        selection,
        getById,
        openFullScreen,
        playingVideos: new Set(),
        getLinearOrder,
        showOnItem,
        showOnEmpty,
      })
    );

  test('double-click triggers fullscreen when video exists', () => {
    const { result } = render();
    act(() => {
      result.current.handleVideoSelect('vid1', false, false, true);
    });
    expect(openFullScreen).toHaveBeenCalledWith({ id: 'vid1' }, new Set());
  });

  test('ctrl-click toggles selection; plain click selects only', () => {
    const { result } = render();

    act(() => result.current.handleVideoSelect('a', true, false, false));
    expect(selection.toggle).toHaveBeenCalledWith('a');

    act(() => result.current.handleVideoSelect('b', false, false, false));
    expect(selection.selectOnly).toHaveBeenCalledWith('b');
  });

  test('shift-click without anchor behaves like single select', () => {
    const { result } = render();
    selection.anchorId = null;

    act(() => result.current.handleVideoSelect('x', false, true, false));
    expect(selection.selectRange).toHaveBeenCalledWith(
      ['a', 'b', 'c', 'd'],
      'x',
      false
    );
    expect(selection.selectOnly).not.toHaveBeenCalledWith('x');
  });

  test('shift-click falls back to single select when no linear order is provided', () => {
    getLinearOrder = vi.fn(() => []);
    const { result } = renderHook(() =>
      useCardSelection({
        gridRef,
        selection,
        getById,
        openFullScreen,
        playingVideos: new Set(),
        getLinearOrder,
        showOnItem,
        showOnEmpty,
      })
    );

    act(() => result.current.handleVideoSelect('x', false, true, false));
    expect(selection.selectOnly).toHaveBeenCalledWith('x');
  });

  test('card context menu forwards event without mutating selection', () => {
    const { result } = render();
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn(), ctrlKey: false, metaKey: false };

    act(() => result.current.handleCardContextMenu(e, { id: 'v1' }));
    expect(showOnItem).toHaveBeenCalled();
    const [eventArg, id] = showOnItem.mock.calls[0];
    expect(eventArg).toBe(e);
    expect(id).toBe('v1');
    expect(selection.selectOnly).not.toHaveBeenCalled();
    expect(selection.toggle).not.toHaveBeenCalled();
  });

  test('background context menu delegates without clearing selection', () => {
    const { result } = render();
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    act(() => result.current.handleBackgroundContextMenu(e));
    expect(showOnEmpty).toHaveBeenCalled();
    expect(selection.clear).not.toHaveBeenCalled();
  });

  test('shift-click forwards linear order to selectRange', () => {
    const { result } = render();
    selection.anchorId = 'a';

    act(() => {
      result.current.handleVideoSelect('c', false, true, false);
    });

    expect(selection.selectRange).toHaveBeenCalledWith(
      ['a', 'b', 'c', 'd'],
      'c',
      false
    );
  });
});
