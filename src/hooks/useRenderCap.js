import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MIN_RENDER_CAP = 100;

function normalizeCap(value) {
  if (!Number.isFinite(value)) return MIN_RENDER_CAP;
  return Math.max(MIN_RENDER_CAP, Math.floor(value));
}

export function useRenderCap({ datasetCount = 0 } = {}) {
  const [cap, setCapState] = useState(MIN_RENDER_CAP);
  const [loadedInitial, setLoadedInitial] = useState(() => {
    const api = typeof window !== "undefined" ? window?.electronAPI : undefined;
    return !api?.getSettings;
  });
  const pendingSaveRef = useRef(null);

  const safeDatasetCount = Number.isFinite(datasetCount)
    ? Math.max(0, Math.floor(datasetCount))
    : 0;

  const max = Math.max(MIN_RENDER_CAP, safeDatasetCount);
  const clampedCap =
    safeDatasetCount === 0 ? 0 : Math.min(cap, safeDatasetCount);

  useEffect(() => {
    let cancelled = false;

    async function loadPersisted() {
      const api = window?.electronAPI;
      if (!api?.getSettings) {
        setLoadedInitial(true);
        return;
      }

      try {
        const settings = await api.getSettings();
        if (cancelled) return;
        const persisted = settings?.renderCap;
        if (Number.isFinite(persisted)) {
          setCapState(normalizeCap(persisted));
        }
      } catch (error) {
        console.warn("Failed to load renderCap from settings", error);
      } finally {
        if (!cancelled) {
          setLoadedInitial(true);
        }
      }
    }

    loadPersisted();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loadedInitial) return;
    const api = window?.electronAPI;
    if (!api?.saveSettingsPartial) return;
    if (!pendingSaveRef.current) return;

    const value = pendingSaveRef.current;
    pendingSaveRef.current = null;

    api.saveSettingsPartial({ renderCap: value }).catch((error) => {
      console.error("Failed to persist renderCap", error);
    });
  }, [loadedInitial, cap]);

  const setCap = useCallback((next) => {
    const normalized = normalizeCap(next);
    setCapState((prev) => {
      if (prev === normalized) return prev;
      pendingSaveRef.current = normalized;
      return normalized;
    });
  }, []);

  return useMemo(
    () => ({
      cap,
      min: MIN_RENDER_CAP,
      max,
      clampedCap,
      setCap,
    }),
    [cap, clampedCap, max, setCap]
  );
}

export const __TESTING__ = { MIN_RENDER_CAP, normalizeCap };

export default useRenderCap;
