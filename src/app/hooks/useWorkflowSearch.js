import { useEffect, useMemo, useRef, useState } from "react";

// Workflow filters in the open collection (docs/architecture/workflow-filters.md).
// Main answers which of the collection's clips ran a workflow matching the
// words and steps bounds; node types and file names never reach the window.
// As with prompt search, an answer stays until a newer one arrives.

const SEARCH_DELAY_MS = 300;

/**
 * Returns `{ matches, pending, unread }`: the Set of matching fingerprints
 * (null while no workflow filter is set or no answer has come), whether an
 * answer is on its way, and how many clips' workflows have not been read yet.
 * `refreshKey` asks again as background reading makes progress.
 */
export function useWorkflowSearch({ videos, query, refreshKey = 0 }) {
  const active = Boolean(query);
  const querySignature = active ? JSON.stringify(query) : "";
  const fingerprints = useMemo(() => {
    if (!active) return null;
    const unique = new Set();
    for (const video of videos || []) if (video?.fingerprint) unique.add(video.fingerprint);
    return [...unique].sort();
  }, [active, videos]);
  const fingerprintSignature = fingerprints ? `${fingerprints.length}:${fingerprints.join(",")}` : "";
  const [result, setResult] = useState({ matches: null, unread: 0 });
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!active) {
      requestRef.current += 1;
      setResult({ matches: null, unread: 0 });
      setPending(false);
      return undefined;
    }
    const match = window.electronAPI?.workflow?.match;
    if (typeof match !== "function") return undefined;
    setPending(true);
    const timer = setTimeout(() => {
      const id = ++requestRef.current;
      Promise.resolve(match({ fingerprints, ...query }))
        .then((answer) => {
          if (id !== requestRef.current) return;
          setResult({
            matches: new Set(answer?.success ? answer.matches || [] : []),
            unread: Number(answer?.unread) || 0,
          });
          setPending(false);
        })
        .catch(() => {
          if (id !== requestRef.current) return;
          setResult({ matches: new Set(), unread: 0 });
          setPending(false);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      // An answer to an older question must not land after a newer one starts.
      requestRef.current += 1;
    };
    // The signatures stand for fingerprints and query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fingerprintSignature, querySignature, refreshKey]);

  return {
    matches: active ? result.matches : null,
    pending: active && pending,
    unread: active ? result.unread : 0,
  };
}
