import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function toSet(value) {
  if (!value) return new Set();
  if (typeof value.has === "function") return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set(Array.from(value));
}

export default function useStuckCardAuditor({
  getCandidates,
  loadedIds,
  loadingIds,
  throttleMs = 250,
} = {}) {
  const [forcedMap, setForcedMap] = useState(() => new Map());
  const lastAuditRef = useRef(0);

  const loadedSet = useMemo(() => toSet(loadedIds), [loadedIds]);
  const loadingSet = useMemo(() => toSet(loadingIds), [loadingIds]);

  const pruneResolved = useCallback(() => {
    setForcedMap((prev) => {
      if (!prev.size) return prev;
      const next = new Map(prev);
      let changed = false;
      for (const id of prev.keys()) {
        if (loadedSet.has(id) || loadingSet.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [loadedSet, loadingSet]);

  useEffect(() => {
    pruneResolved();
  }, [pruneResolved]);

  const triggerAudit = useCallback(
    ({ force = false } = {}) => {
      const now = Date.now();
      if (!force && now - lastAuditRef.current < throttleMs) {
        return false;
      }
      lastAuditRef.current = now;

      const candidates =
        (typeof getCandidates === "function" ? getCandidates() : null) || [];

      if (!candidates.length) {
        return false;
      }

      let added = false;
      setForcedMap((prev) => {
        const next = new Map(prev);
        for (const id of candidates) {
          if (!id) continue;
          if (loadedSet.has(id) || loadingSet.has(id)) continue;
          const nextCount = (next.get(id) ?? 0) + 1;
          next.set(id, nextCount);
          added = true;
        }
        return added ? next : prev;
      });

      return added;
    },
    [getCandidates, throttleMs, loadedSet, loadingSet]
  );

  const reset = useCallback((id) => {
    if (!id) return;
    setForcedMap((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      forcedMap,
      triggerAudit,
      reset,
    }),
    [forcedMap, triggerAudit, reset]
  );
}
