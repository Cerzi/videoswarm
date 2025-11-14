// src/hooks/selection/useSelectionState.js
import { useState, useCallback, useEffect } from 'react';

export default function useSelectionState() {
  const [selected, setSelected] = useState(() => new Set());
  const [anchorId, setAnchorId] = useState(null);

  const size = selected.size;

  const selectOnly = useCallback((id) => {
    setSelected(() => new Set(id ? [id] : []));
    setAnchorId(id ?? null);
  }, []);

  const toggle = useCallback((id) => {
    setSelected(prev => {
      const ns = new Set(prev);
      if (ns.has(id)) ns.delete(id);
      else ns.add(id);
      return ns;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchorId(null);
  }, []);

  // Select a whole range, given the *ordered ids* array and the end id.
  const selectRange = useCallback((orderedIds, endId, additive = false) => {
    if (!orderedIds?.length || !endId) return;

    setSelected((prev) => {
      const ids = Array.isArray(orderedIds) ? orderedIds : [];
      if (!ids.length) return prev;

      let effectiveAnchor = anchorId;
      if (effectiveAnchor && !ids.includes(effectiveAnchor)) {
        const fallback = ids.find((id) => prev.has(id));
        effectiveAnchor = fallback ?? null;
      }

      if (!effectiveAnchor) {
        effectiveAnchor = endId;
      }

      const endIndex = ids.indexOf(endId);
      if (endIndex === -1) return prev;

      const anchorIndex = ids.indexOf(effectiveAnchor);
      const safeAnchorIndex = anchorIndex === -1 ? endIndex : anchorIndex;
      const from = Math.min(safeAnchorIndex, endIndex);
      const to = Math.max(safeAnchorIndex, endIndex);

      const next = additive ? new Set(prev) : new Set();
      for (let i = from; i <= to; i += 1) {
        next.add(ids[i]);
      }

      setAnchorId(endId);
      return next;
    });
  }, [anchorId]);

  const resetAnchor = useCallback(() => {
    setAnchorId(null);
  }, []);

  const setAnchor = useCallback((id) => {
    setAnchorId(id ?? null);
  }, []);

  useEffect(() => {
    if (anchorId && !selected.has(anchorId)) {
      const iterator = selected.values();
      const next = iterator.next();
      const fallback = next?.value ?? null;
      if (fallback !== anchorId) {
        setAnchorId(fallback ?? null);
      }
    }
  }, [anchorId, selected]);

  return {
    selected,
    size,
    anchorId,
    setSelected,  // used by FS watcher cleanup
    selectOnly,
    toggle,
    clear,
    selectRange,
    resetAnchor,
    setAnchor,
  };
}
