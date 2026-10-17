import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Similar-prompt stacks (docs/architecture/prompt-stacks.md, Section 7). The
// renderer sends main the collection's prompt keys with their clip counts and
// gets back which keys stack with a similar prompt's key. Prompt text stays in
// main. Until an answer arrives, and whenever main cannot answer, prompts
// stack exactly.

// 1 stacks only the exact prompt; the others are the share of words two
// prompts must have in common.
export const STACK_SIMILARITY_LEVELS = Object.freeze([1, 0.9, 0.8, 0.7]);
export const DEFAULT_STACK_SIMILARITY = 0.8;
const REQUEST_DELAY_MS = 250;
const NO_GROUPS = new Map();

export function normalizeStackSimilarity(value) {
  const level = Number(value);
  return STACK_SIMILARITY_LEVELS.includes(level) ? level : DEFAULT_STACK_SIMILARITY;
}

/** `[{ promptKey, count }]` for the clips in `videos`, in key order. */
export function promptKeyCounts(videos) {
  const counts = new Map();
  for (const video of videos || []) {
    const key = video?.promptKey;
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.keys()].sort().map((promptKey) => ({
    promptKey,
    count: counts.get(promptKey),
  }));
}

function sameEntries(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].promptKey !== b[index].promptKey || a[index].count !== b[index].count) {
      return false;
    }
  }
  return true;
}

/**
 * Returns `groupOf(promptKey)`: the prompt key a clip's prompt stacks under
 * when it is not its own, or undefined.
 */
export function useSimilarPromptGroups({ videos, enabled, similarity }) {
  const threshold = normalizeStackSimilarity(similarity);
  const active = Boolean(enabled) && threshold < 1;
  const entries = useMemo(
    () => (active ? promptKeyCounts(videos) : null),
    [active, videos]
  );
  const [groups, setGroups] = useState(NO_GROUPS);
  const requestRef = useRef({ id: 0, entries: null, threshold: null });

  useEffect(() => {
    const request = requestRef.current;
    if (!active || !entries || entries.length < 2) {
      request.id += 1;
      request.entries = null;
      request.threshold = null;
      setGroups(NO_GROUPS);
      return undefined;
    }
    if (request.threshold === threshold && sameEntries(request.entries, entries)) {
      return undefined;
    }
    const similarGroups = window.electronAPI?.stacks?.similarGroups;
    if (typeof similarGroups !== "function") return undefined;
    // Earlier groups stay until the answer arrives, so the grid changes once.
    const timer = setTimeout(() => {
      const id = ++request.id;
      request.entries = entries;
      request.threshold = threshold;
      Promise.resolve(similarGroups({ entries, threshold }))
        .then((result) => {
          if (id !== request.id || result?.superseded) return;
          const next = result?.success ? new Map(Object.entries(result.groups || {})) : null;
          setGroups(next?.size ? next : NO_GROUPS);
        })
        .catch(() => {
          if (id === request.id) setGroups(NO_GROUPS);
        });
    }, REQUEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, entries, threshold]);

  return useCallback((promptKey) => groups.get(promptKey), [groups]);
}
