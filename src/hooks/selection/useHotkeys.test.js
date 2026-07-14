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

  test('plain I opens selection details only when clips are selected', () => {
    const onOpenDetails = vi.fn();
    renderHook(() => useHotkeys(run, getSelection, { onOpenDetails }));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
    expect(onOpenDetails).toHaveBeenCalledOnce();

    getSelection.mockReturnValue(new Set());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }));
    expect(onOpenDetails).toHaveBeenCalledOnce();
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
    expect(setZoomIndexSafe).toHaveBeenCalledWith(2);
  });
});
