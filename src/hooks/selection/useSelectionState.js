// src/hooks/selection/useSelectionState.js
import { useState, useCallback } from 'react';

// Selection units group ids that select together, such as the runs of a
// collapsed prompt stack (docs/architecture/prompt-stacks.md, Section 5).
// `units` is `{ unitOf(id) -> key | null, membersOf(key) -> ids,
// representativeOf(key) -> id }`, or null when every id stands alone.
export function expandSelectionUnits(ids, units) {
  const next = new Set();
  for (const id of ids || []) {
    const key = units ? units.unitOf(id) : null;
    if (key == null) {
      next.add(id);
      continue;
    }
    const members = units.membersOf(key);
    if (members.length === 0) next.add(id);
    else members.forEach((member) => next.add(member));
  }
  return next;
}

const setsEqual = (a, b) => {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
};

// The id that stands for `id` in an ordered list: a unit's representative.
const representativeOf = (id, units) => {
  const key = units ? units.unitOf(id) : null;
  return key == null ? id : units.representativeOf(key) ?? id;
};

export default function useSelectionState({ unitsRef = null } = {}) {
  const [selected, setSelected] = useState(() => new Set());
  const [anchorId, setAnchorId] = useState(null); // NEW

  const size = selected.size;
  // Read at event time, so the units match what the grid shows right now.
  const currentUnits = useCallback(() => unitsRef?.current || null, [unitsRef]);

  const selectOnly = useCallback((id) => {
    const units = currentUnits();
    const unit = expandSelectionUnits([id], units);
    setSelected((prev) => {
      const alreadyOnly = setsEqual(prev, unit);
      if (alreadyOnly) {
        setAnchorId(null);
        return new Set();
      }

      // If the item was part of a larger selection we collapse down to just it;
      // a subsequent click will hit the early return above and clear everything.
      setAnchorId(id); // set anchor for shift-range
      return unit;
    });
  }, [currentUnits]);

  const selectExactly = useCallback((id) => {
    if (id == null) {
      setSelected(new Set());
      setAnchorId(null);
      return;
    }
    setSelected(expandSelectionUnits([id], currentUnits()));
    setAnchorId(id);
  }, [currentUnits]);

  const setSelectedIds = useCallback((ids) => {
    const next = expandSelectionUnits(
      ids instanceof Set ? ids : ids || [],
      currentUnits()
    );
    setSelected(next);
    setAnchorId((previous) => {
      if (previous != null && next.has(previous)) return previous;
      return next.values().next().value ?? null;
    });
  }, [currentUnits]);

  // A unit toggles as a whole: off if any of it is selected, on otherwise.
  const toggle = useCallback((id) => {
    const unit = expandSelectionUnits([id], currentUnits());
    setSelected(prev => {
      const ns = new Set(prev);
      const anySelected = [...unit].some((member) => prev.has(member));
      unit.forEach((member) => (anySelected ? ns.delete(member) : ns.add(member)));
      return ns;
    });
    setAnchorId(id); // update anchor on explicit click
  }, [currentUnits]);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAnchorId(null);
  }, []);

  const remove = useCallback((id) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setAnchorId((prev) => (prev === id ? null : prev));
  }, []);

  const pruneTo = useCallback((validIds) => {
    const valid = validIds instanceof Set ? validIds : new Set(validIds || []);
    setSelected((prev) => {
      let changed = false;
      const next = new Set();
      prev.forEach((id) => {
        if (valid.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
    setAnchorId((prev) => (prev != null && !valid.has(prev) ? null : prev));
  }, []);

  // Widens the selection to whole units after the units change, so a
  // partly selected stack is never acted on partially. Keeps the same Set
  // when nothing changes.
  const expandToUnits = useCallback(() => {
    const units = currentUnits();
    if (!units) return;
    setSelected((prev) => {
      const next = expandSelectionUnits(prev, units);
      return setsEqual(prev, next) ? prev : next;
    });
  }, [currentUnits]);

  // Select a whole range, given the *ordered ids* array and the end id.
  const selectRange = useCallback((orderedIds, endId, additive = false) => {
    if (!orderedIds?.length) return;
    const units = currentUnits();
    const a = representativeOf(anchorId ?? endId, units);
    const i1 = orderedIds.indexOf(a);
    const i2 = orderedIds.indexOf(representativeOf(endId, units));
    if (i1 === -1 || i2 === -1) return;

    const [from, to] = i1 <= i2 ? [i1, i2] : [i2, i1];
    const rangeIds = expandSelectionUnits(orderedIds.slice(from, to + 1), units);

    setSelected(prev => {
      const ns = additive ? new Set(prev) : new Set();
      for (const id of rangeIds) ns.add(id);
      return ns;
    });
    setAnchorId(a); // keep the original anchor
  }, [anchorId, currentUnits]);

  return {
    selected,
    size,
    anchorId,
    setSelected,  // used by FS watcher cleanup
    selectOnly,
    selectExactly,
    setSelectedIds,
    toggle,
    clear,
    remove,
    pruneTo,
    selectRange,
    expandToUnits,
  };
}
