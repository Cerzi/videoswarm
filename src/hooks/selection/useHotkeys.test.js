import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
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

  test('Ctrl/Cmd + C copies highlighted text instead of the selection path', () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'a cinematic prompt';
    document.body.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    renderHook(() => useHotkeys(run, getSelection));
    const event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true });
    document.dispatchEvent(event);
    expect(run).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    window.getSelection().removeAllRanges();
    paragraph.remove();
  });

  test('Delete triggers MOVE_TO_TRASH (multi allowed)', () => {
    renderHook(() => useHotkeys(run, getSelection));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(run).toHaveBeenCalledWith(ActionIds.MOVE_TO_TRASH, new Set(['x']));
  });

  test('plain I opens selection details only when clips are selected', () => {
    const onOpenDetails = vi.fn();
    renderHook(() => useHotkeys(run, getSelection, { onOpenDetails }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
    expect(onOpenDetails).toHaveBeenCalledOnce();

    getSelection.mockReturnValue(new Set());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
    expect(onOpenDetails).toHaveBeenCalledOnce();
  });

  test('B adds the selection to the sequence, but not with modifiers, repeats or no selection', () => {
    const onAddToSequence = vi.fn();
    renderHook(() => useHotkeys(run, getSelection, { onAddToSequence }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    expect(onAddToSequence).toHaveBeenCalledWith(new Set(['x']));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', shiftKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', repeat: true }));
    getSelection.mockReturnValue(new Set());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    expect(onAddToSequence).toHaveBeenCalledOnce();
  });

  test('does not open selection details with modifiers or in guarded targets', () => {
    const onOpenDetails = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) =>
        useHotkeys(run, getSelection, { onOpenDetails, enabled }),
      { initialProps: { enabled: true } }
    );

    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'i', [modifier]: true })
      );
    }

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));

    const exempt = document.createElement('div');
    exempt.dataset.hotkeyExempt = '';
    const exemptChild = document.createElement('button');
    exempt.appendChild(exemptChild);
    document.body.appendChild(exempt);
    exemptChild.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'i', bubbles: true })
    );

    rerender({ enabled: false });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));

    expect(onOpenDetails).not.toHaveBeenCalled();
    input.remove();
    exempt.remove();
  });

  test.each([
    ['a', 'pick'],
    ['p', 'pick'],
    ['s', 'reviewed'],
    ['r', 'reviewed'],
    ['d', 'reject'],
    ['x', 'reject'],
    ['f', 'unreviewed'],
    ['u', 'unreviewed'],
  ])('%s applies the %s review state to the selection', (key, state) => {
    const onSetReviewState = vi.fn();
    renderHook(() =>
      useHotkeys(run, getSelection, { onSetReviewState })
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key }));
    expect(onSetReviewState).toHaveBeenCalledWith(state, new Set(['x']));
  });

  test.each([
    ['1', 1],
    ['3', 3],
    ['5', 5],
    ['0', null],
  ])('%s applies rating %s to the selection', (key, rating) => {
    const onSetRating = vi.fn();
    renderHook(() => useHotkeys(run, getSelection, { onSetRating }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key }));

    expect(onSetRating).toHaveBeenCalledWith(rating, new Set(['x']));
  });

  test('Z undoes the last workflow action even when selection is empty', () => {
    const onUndoReview = vi.fn();
    getSelection.mockReturnValue(new Set());
    renderHook(() => useHotkeys(run, getSelection, { onUndoReview }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }));

    expect(onUndoReview).toHaveBeenCalledOnce();
  });

  test('does not apply review shortcuts while typing or using modifiers', () => {
    const onSetReviewState = vi.fn();
    const onSetRating = vi.fn();
    const onUndoReview = vi.fn();
    renderHook(() =>
      useHotkeys(run, getSelection, {
        onSetReviewState,
        onSetRating,
        onUndoReview,
      })
    );
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'r', ctrlKey: true })
    );
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', altKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', shiftKey: true }));
    expect(onSetReviewState).not.toHaveBeenCalled();
    expect(onSetRating).not.toHaveBeenCalled();
    expect(onUndoReview).not.toHaveBeenCalled();
    input.remove();
  });

  test('ignores held-key repeats for review, rating, and undo actions', () => {
    const onSetReviewState = vi.fn();
    const onSetRating = vi.fn();
    const onUndoReview = vi.fn();
    renderHook(() =>
      useHotkeys(run, getSelection, {
        onSetReviewState,
        onSetRating,
        onUndoReview,
      })
    );

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '4', repeat: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', repeat: true }));

    expect(onSetReviewState).not.toHaveBeenCalled();
    expect(onSetRating).not.toHaveBeenCalled();
    expect(onUndoReview).not.toHaveBeenCalled();
  });

  test('bracket keys navigate sibling folders', () => {
    const onPreviousFolder = vi.fn();
    const onNextFolder = vi.fn();
    renderHook(() =>
      useHotkeys(run, getSelection, {
        onPreviousFolder,
        onNextFolder,
      })
    );

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '[' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ']' }));

    expect(onPreviousFolder).toHaveBeenCalledOnce();
    expect(onNextFolder).toHaveBeenCalledOnce();
  });

  test('does not navigate folders while typing or with modifiers', () => {
    const onPreviousFolder = vi.fn();
    const onNextFolder = vi.fn();
    renderHook(() =>
      useHotkeys(run, getSelection, {
        onPreviousFolder,
        onNextFolder,
      })
    );
    const input = document.createElement('input');
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true }));
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: ']', ctrlKey: true })
    );

    expect(onPreviousFolder).not.toHaveBeenCalled();
    expect(onNextFolder).not.toHaveBeenCalled();
    input.remove();
  });

  test('? opens shortcut help and disabled suspends global bindings', () => {
    const onOpenHelp = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useHotkeys(run, getSelection, { onOpenHelp, enabled }),
      { initialProps: { enabled: true } }
    );

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    expect(onOpenHelp).toHaveBeenCalledOnce();

    rerender({ enabled: false });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(onOpenHelp).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  test('plain +/- zoom the grid without intercepting modified keys', () => {
    const getZoomIndex = vi.fn(() => 1);
    const setZoomIndexSafe = vi.fn();
    renderHook(() =>
      useHotkeys(run, getSelection, {
        getZoomIndex,
        setZoomIndexSafe,
        minZoomIndex: 0,
        maxZoomIndex: 4,
      })
    );

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '=', ctrlKey: true })
    );
    expect(setZoomIndexSafe).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: '=' }));
    expect(setZoomIndexSafe).toHaveBeenCalledWith(1.5);
  });

  describe('Ctrl+wheel zoom', () => {
    let frames;
    let zoom;
    let getZoomIndex;
    let setZoomIndexSafe;

    const flushFrames = () => {
      const pending = frames.splice(0);
      pending.forEach((callback) => callback());
    };

    const wheel = (deltaY, init = {}) => {
      const event = new WheelEvent('wheel', {
        deltaY,
        ctrlKey: true,
        cancelable: true,
        ...init,
      });
      window.dispatchEvent(event);
      return event;
    };

    beforeEach(() => {
      frames = [];
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
      zoom = 2;
      getZoomIndex = vi.fn(() => zoom);
      setZoomIndexSafe = vi.fn((next) => {
        zoom = next;
      });
    });

    afterEach(() => {
      delete window.electronAPI;
      vi.restoreAllMocks();
    });

    const renderZoomHook = () =>
      renderHook(() =>
        useHotkeys(run, getSelection, {
          getZoomIndex,
          setZoomIndexSafe,
          minZoomIndex: 0,
          maxZoomIndex: 4,
        })
      );

    test('uses the Electron zoom bridge instead of a blocking wheel listener', () => {
      let emit = null;
      const unsubscribe = vi.fn();
      window.electronAPI = {
        platform: 'linux',
        onZoomWheel: vi.fn((callback) => {
          emit = callback;
          return unsubscribe;
        }),
      };
      const addListener = vi.spyOn(window, 'addEventListener');

      const { unmount } = renderZoomHook();

      expect(addListener.mock.calls.some(([type]) => type === 'wheel')).toBe(false);
      expect(wheel(-120).defaultPrevented).toBe(false);
      flushFrames();
      expect(setZoomIndexSafe).not.toHaveBeenCalled();

      emit('in');
      flushFrames();
      expect(zoom).toBe(2.5);

      emit('out');
      flushFrames();
      emit('out');
      flushFrames();
      expect(zoom).toBe(1.5);

      unmount();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    test('falls back to a wheel listener on macOS, zooming both ways', () => {
      window.electronAPI = { platform: 'darwin', onZoomWheel: vi.fn() };
      renderZoomHook();

      expect(window.electronAPI.onZoomWheel).not.toHaveBeenCalled();
      expect(wheel(-120).defaultPrevented).toBe(true);
      flushFrames();
      expect(zoom).toBe(2.5);

      // Reversing direction must zoom back out rather than repeat the last
      // direction.
      wheel(120);
      flushFrames();
      wheel(120);
      flushFrames();
      expect(zoom).toBe(1.5);

      expect(wheel(120, { ctrlKey: false }).defaultPrevented).toBe(false);
    });

    test('keeps one set of listeners while callers pass fresh closures', () => {
      const addDocumentListener = vi.spyOn(document, 'addEventListener');
      const addWindowListener = vi.spyOn(window, 'addEventListener');
      const onOpenHelp = vi.fn();
      const { rerender } = renderHook(
        ({ tick }) =>
          useHotkeys(run, () => getSelection(tick), {
            getZoomIndex: () => zoom,
            setZoomIndexSafe: (next) => setZoomIndexSafe(next),
            onOpenHelp: () => onOpenHelp(tick),
          }),
        { initialProps: { tick: 0 } }
      );
      rerender({ tick: 1 });
      rerender({ tick: 2 });

      const keydownCount = addDocumentListener.mock.calls.filter(
        ([type]) => type === 'keydown'
      ).length;
      const wheelCount = addWindowListener.mock.calls.filter(
        ([type]) => type === 'wheel'
      ).length;
      expect(keydownCount).toBe(1);
      expect(wheelCount).toBe(1);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
      expect(onOpenHelp).toHaveBeenCalledWith(2);
    });
  });
});
