import { useEffect, useMemo, useRef, useState } from "react";

// Prompt search in the open collection (prompt-search-and-tag-suggestions.md).
// Main reads the prompts and answers which of the collection's prompt keys
// match; the answer stays until a newer one arrives, so typing never empties
// the grid on its way to a result.

const SEARCH_DELAY_MS = 300;

/**
 * Returns `{ matches, pending, unread }`: the Set of matching prompt keys
 * (null while there is no query or no answer yet), whether an answer is on
 * its way, and how many of the collection's prompts could not be read.
 */
export function usePromptSearch({ videos, query }) {
  const text = typeof query === "string" ? query.trim() : "";
  const promptKeys = useMemo(() => {
    if (!text) return null;
    const keys = new Set();
    for (const video of videos || []) if (video?.promptKey) keys.add(video.promptKey);
    return [...keys].sort();
  }, [text, videos]);
  const keysSignature = promptKeys ? promptKeys.join(",") : "";
  const [result, setResult] = useState({ matches: null, unread: 0, query: "" });
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!text) {
      requestRef.current += 1;
      setResult({ matches: null, unread: 0, query: "" });
      setPending(false);
      return undefined;
    }
    const search = window.electronAPI?.prompts?.search;
    if (typeof search !== "function") return undefined;
    setPending(true);
    const timer = setTimeout(() => {
      const id = ++requestRef.current;
      Promise.resolve(search(promptKeys, text))
        .then((answer) => {
          if (id !== requestRef.current || answer?.superseded) return;
          setResult({
            matches: new Set(answer?.success ? answer.matches || [] : []),
            unread: Number(answer?.unread) || 0,
            query: text,
          });
          setPending(false);
        })
        .catch(() => {
          if (id !== requestRef.current) return;
          setResult({ matches: new Set(), unread: 0, query: text });
          setPending(false);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      // An answer to an older query must not land after a newer one starts.
      requestRef.current += 1;
    };
    // keysSignature stands for promptKeys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysSignature, text]);

  return { matches: text ? result.matches : null, pending: Boolean(text) && pending, unread: result.unread };
}
