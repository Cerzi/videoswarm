// src/hooks/selection/useSelectionState.js
import { useMemo, useState, useCallback } from 'react';

export default function useSelectionState() {
  const [selected, setSelected] = useState(() => new Set());
  const [anchorId, setAnchorId] = useState(null); // NEW

  const size = selected.size;

  const selectOnly = useCallback((id) => {
    setSelected((prev) => {
      const alreadyOnly = prev.size === 1 && prev.has(id);
      if (alreadyOnly) {
        setAnchorId(null);
        return new Set();
      }

      // If the item was part of a larger selection we collapse down to just it;
      // a subsequent click will hit the early return above and clear everything.
      const next = new Set([id]);
      setAnchorId(id); // set anchor for shift-range
      return next;
    });
  }, []);

  const toggle = useCallback((id) => {
    setSelected(prev => {
      const ns = new Set(prev);
      if (ns.has(id)) ns.delete(id);
      else ns.add(id);
      return ns;
    });
    setAnchorId(id); // update anchor on explicit click
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchorId(null);
  }, []);

  // Select a whole range, given the *ordered ids* array and the end id.
  const selectRange = useCallback((orderedIds, endId, additive = false) => {
    if (!orderedIds?.length) return;
    const a = anchorId ?? endId;
    const i1 = orderedIds.indexOf(a);
    const i2 = orderedIds.indexOf(endId);
    if (i1 === -1 || i2 === -1) return;

    const [from, to] = i1 <= i2 ? [i1, i2] : [i2, i1];
    const rangeIds = orderedIds.slice(from, to + 1);

    setSelected(prev => {
      const ns = additive ? new Set(prev) : new Set();
      for (const id of rangeIds) ns.add(id);
      return ns;
    });
    setAnchorId(a); // keep the original anchor
  }, [anchorId]);

  return {
    selected,
    size,
    anchorId,
    setSelected,  // used by FS watcher cleanup
    selectOnly,
    toggle,
    clear,
    selectRange,
  };
}
