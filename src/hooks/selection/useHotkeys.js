import { useEffect } from 'react';
import { ActionIds } from '../actions/actions';

/**
 * Global hotkeys → calls runAction with current selection.
 * Keep it tiny so it's easy to disable or scope later.
 *
 * @param {(actionId: string, selected: Set<string>) => void} run
 * @param {() => Set<string>} getSelection
 */
export default function useHotkeys(run, getSelection) {
  useEffect(() => {
    const onKey = (e) => {
      const sel = getSelection();
      if (!sel?.size) return;

      if (e.key === 'Enter') {
        e.preventDefault();
        run(ActionIds.OPEN_EXTERNAL, sel);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        run(ActionIds.COPY_PATH, sel);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        run(ActionIds.MOVE_TO_TRASH, sel);
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [run, getSelection]);
}
