import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { distinctGenerationKeys } from "../filters/generationVersions";

// Library-wide version counts for the keys present in the collection. Read
// in bounded chunks, debounced, and refreshed when the key set changes or
// when indexing publishes new keys.

export const GENERATION_SUMMARY_CHUNK = 4096;
export const GENERATION_SUMMARY_DEBOUNCE_MS = 300;

const getApi = () =>
  typeof window === "undefined" ? null : window.electronAPI?.generationVersions || null;

export default function useGenerationVersionSummaries(videos) {
  const [summaries, setSummaries] = useState({});
  const [refreshToken, setRefreshToken] = useState(0);
  const requestRef = useRef(0);

  const keys = useMemo(() => distinctGenerationKeys(videos), [videos]);
  // A stable identity for the key set, so unrelated record changes (tags,
  // ratings) do not re-query.
  const keySignature = useMemo(() => keys.join(","), [keys]);

  useEffect(() => {
    const api = getApi();
    if (typeof api?.summaries !== "function" || keys.length === 0) {
      setSummaries((previous) => (Object.keys(previous).length ? {} : previous));
      return undefined;
    }
    const requestId = ++requestRef.current;
    const timer = setTimeout(async () => {
      const next = {};
      try {
        for (let offset = 0; offset < keys.length; offset += GENERATION_SUMMARY_CHUNK) {
          const result = await api.summaries(keys.slice(offset, offset + GENERATION_SUMMARY_CHUNK));
          if (requestRef.current !== requestId) return;
          if (result?.success === false) return;
          Object.assign(next, result?.summaries || {});
        }
      } catch {
        return;
      }
      if (requestRef.current === requestId) setSummaries(next);
    }, GENERATION_SUMMARY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // keySignature stands in for keys.
  }, [keySignature, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  return { summaries, refresh };
}
