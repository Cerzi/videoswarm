import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Similar-prompt stacks (docs/architecture/prompt-stacks.md, Section 7). The
// renderer sends main the collection's prompt keys and gets back, per key,
// the keys whose prompts are alike. Prompt text stays in main. Which clips
// stack is decided here, from neighbours in the grid's order, so a new sort
// regroups at once without asking main again. Until an answer arrives, and
// whenever main cannot answer, prompts stack exactly.

// 1 stacks only the exact prompt; the others are the share of words two
// prompts must have in common.
export const STACK_SIMILARITY_LEVELS = Object.freeze([1, 0.9, 0.8, 0.7]);
export const DEFAULT_STACK_SIMILARITY = 0.8;
const REQUEST_DELAY_MS = 250;
const NOTHING_ALIKE = new Map();

export function normalizeStackSimilarity(value) {
  const level = Number(value);
  return STACK_SIMILARITY_LEVELS.includes(level) ? level : DEFAULT_STACK_SIMILARITY;
}

/** The distinct prompt keys of `videos`, in key order. */
export function promptKeysOf(videos) {
  const keys = new Set();
  for (const video of videos || []) {
    if (video?.promptKey) keys.add(video.promptKey);
  }
  return [...keys].sort();
}

function sameKeys(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Returns `alike(a, b)`: whether two prompt keys' prompts are alike. */
export function useSimilarPrompts({ videos, enabled, similarity }) {
  const threshold = normalizeStackSimilarity(similarity);
  const active = Boolean(enabled) && threshold < 1;
  const keys = useMemo(() => (active ? promptKeysOf(videos) : null), [active, videos]);
  const [alikeByKey, setAlikeByKey] = useState(NOTHING_ALIKE);
  const requestRef = useRef({ id: 0, keys: null, threshold: null });

  useEffect(() => {
    const request = requestRef.current;
    if (!active || !keys || keys.length < 2) {
      request.id += 1;
      request.keys = null;
      request.threshold = null;
      setAlikeByKey(NOTHING_ALIKE);
      return undefined;
    }
    if (request.threshold === threshold && sameKeys(request.keys, keys)) {
      return undefined;
    }
    const similarPrompts = window.electronAPI?.stacks?.similarPrompts;
    if (typeof similarPrompts !== "function") return undefined;
    // Earlier answers stay until the new one arrives, so the grid changes once.
    const timer = setTimeout(() => {
      const id = ++request.id;
      request.keys = keys;
      request.threshold = threshold;
      Promise.resolve(similarPrompts({ promptKeys: keys, threshold }))
        .then((result) => {
          if (id !== request.id || result?.superseded) return;
          const next = new Map();
          if (result?.success) {
            for (const [key, others] of Object.entries(result.alike || {})) {
              if (Array.isArray(others) && others.length) next.set(key, new Set(others));
            }
          }
          setAlikeByKey(next.size ? next : NOTHING_ALIKE);
        })
        .catch(() => {
          if (id === request.id) setAlikeByKey(NOTHING_ALIKE);
        });
    }, REQUEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, keys, threshold]);

  return useCallback(
    (a, b) => a === b || Boolean(alikeByKey.get(a)?.has(b)),
    [alikeByKey]
  );
}
