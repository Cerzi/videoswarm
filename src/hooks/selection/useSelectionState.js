import { useState, useCallback } from 'react';

/**
 * Source of truth for which video ids are selected.
 * No knowledge of how actions or menus work.
 */
export default function useSelectionState() {
  const [selected, setSelected] = useState(() => new Set());

  const selectOnly = useCallback((id) => {
    setSelected(new Set([id]));
  }, []);

  const toggle = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  return {
    selected,
    size: selected.size,
    selectOnly,
    toggle,
    clear,
    setSelected, // expose for advanced cases (e.g., range select)
  };
}
