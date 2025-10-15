import { useCallback, useEffect, useRef } from "react";

const DEFAULT_KEY = "";

const buildKey = (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    return DEFAULT_KEY;
  }
  return ids.join("\u0001");
};

export default function useSelectionScrollCycler(selectionIds, ensureVisible) {
  const ids = Array.isArray(selectionIds) ? selectionIds : [];
  const ensureFn = typeof ensureVisible === "function" ? ensureVisible : null;

  const stateRef = useRef({ key: DEFAULT_KEY, index: 0 });

  useEffect(() => {
    const key = buildKey(ids);
    const state = stateRef.current;
    if (state.key !== key) {
      state.key = key;
      state.index = 0;
    } else if (state.index >= ids.length && ids.length > 0) {
      state.index = 0;
    }
  }, [ids]);

  return useCallback(() => {
    if (!ids.length || !ensureFn) {
      return false;
    }
    const state = stateRef.current;
    if (state.index >= ids.length) {
      state.index = 0;
    }
    const targetId = ids[state.index];
    state.index = (state.index + 1) % ids.length;
    return ensureFn(targetId);
  }, [ids, ensureFn]);
}
