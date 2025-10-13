import { useCallback, useEffect, useRef } from "react";
import {
  loadAspectRatioHints,
  persistAspectRatioHints,
  sanitizeAspectRatioHint,
} from "../utils/aspectRatioStorage";

const DEFAULT_MAX_ENTRIES = 4000;

export default function useAspectRatioMemory({ maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const mapRef = useRef(null);
  if (!mapRef.current) {
    mapRef.current = loadAspectRatioHints();
  }

  const persistTimerRef = useRef(null);
  const maxEntriesRef = useRef(maxEntries);

  useEffect(() => {
    maxEntriesRef.current = maxEntries;
  }, [maxEntries]);

  const flush = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    persistAspectRatioHints(mapRef.current);
  }, []);

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistAspectRatioHints(mapRef.current);
    }, 350);
  }, []);

  const rememberAspectRatio = useCallback(
    (id, ratio) => {
      if (!id) return;
      const sanitized = sanitizeAspectRatioHint(ratio);
      if (sanitized === null) return;

      const store = mapRef.current;
      const existing = store.get(id);
      if (existing === sanitized) return;

      if (!store.has(id) && store.size >= maxEntriesRef.current) {
        const firstKey = store.keys().next().value;
        if (firstKey) {
          store.delete(firstKey);
        }
      }

      store.set(id, sanitized);
      schedulePersist();
    },
    [schedulePersist]
  );

  const getAspectRatioHint = useCallback((id) => {
    if (!id) return null;
    const value = mapRef.current.get(id);
    return typeof value === "number" ? value : null;
  }, []);

  useEffect(() => () => {
    flush();
  }, [flush]);

  return {
    aspectRatioMapRef: mapRef,
    rememberAspectRatio,
    getAspectRatioHint,
  };
}

export { sanitizeAspectRatioHint as __sanitizeAspectRatioForTests };
