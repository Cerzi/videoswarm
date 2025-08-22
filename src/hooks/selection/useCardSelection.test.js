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
        selection.anchorId = id;
      }),
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
    expect(selection.selectOnly).toHaveBeenCalledWith('x');
  });

  test('card context menu selects if not selected and calls showOnItem', () => {
    const { result } = render();
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn(), ctrlKey: false, metaKey: false };

    // not selected → selectOnly
    act(() => result.current.handleCardContextMenu(e, { id: 'v1' }));
    expect(showOnItem).toHaveBeenCalled();
    const [_ev, id, already, selectOnly] = showOnItem.mock.calls[0];
    expect(id).toBe('v1');
    expect(already).toBe(false);
    expect(typeof selectOnly).toBe('function');
  });

  test('background context menu clears selection and calls showOnEmpty', () => {
    const { result } = render();
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    act(() => result.current.handleBackgroundContextMenu(e));
    expect(showOnEmpty).toHaveBeenCalled();
  });

  test('shift-click with anchor uses bounding box (via setSelected)', () => {
    // Build a tiny DOM so inner box-selection can work
    const makeRect = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b, width: r-l, height: b-t });
    gridRef.current.innerHTML = '';
    const addItem = (id, rect) => {
      const el = document.createElement('div');
      el.className = 'video-item';
      el.dataset.videoId = id;
      el.getBoundingClientRect = vi.fn(() => rect);
      gridRef.current.appendChild(el);
    };
    // anchor=a (0,0)-(100,80), end=b (110,0)-(210,60) → expect [a,b]
    addItem('a', makeRect(0, 0, 100, 80));
    addItem('b', makeRect(110, 0, 210, 60));
    addItem('c', makeRect(220, 0, 320, 120)); // outside the box for this test

    const { result } = render();
    selection.anchorId = 'a';

    act(() => {
      result.current.handleVideoSelect('b', /*ctrl*/ false, /*shift*/ true, /*dbl*/ false);
    });

    // setSelected was called with a Set containing a & b (order not guaranteed)
    expect(selection.setSelected).toHaveBeenCalled();
    const arg = selection.setSelected.mock.calls.at(-1)[0];
    const nextSet = typeof arg === 'function' ? arg(new Set()) : arg;
    expect(nextSet instanceof Set).toBe(true);
    expect(Array.from(nextSet).sort()).toEqual(['a', 'b']);
  });
});
