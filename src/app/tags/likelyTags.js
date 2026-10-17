import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

// Tag suggestions in the renderer (prompt-search-and-tag-suggestions.md,
// Section 2). Main learns from the library's tags and prompts and answers by
// catalog row with tag names; nothing here sees a prompt.
//
// Turned-down suggestions are stored by main. They are also kept here for the
// session, so a clip leaves Details' suggestions and the "Might be" filter the
// moment it is turned down, without waiting for a new answer.

const MAX_SUGGESTION_ROWS = 2_000;
const MAX_MIGHT_BE_ROWS = 20_000;
const SUGGESTION_DELAY_MS = 200;
const MIGHT_BE_DELAY_MS = 300;

const turnedDown = new Set();
const listeners = new Set();
let turnedDownVersion = 0;

const dismissalKey = (fingerprint, tag) =>
  `${fingerprint}\u0000${String(tag || "").trim().toLowerCase()}`;

function publish() {
  turnedDownVersion += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether this clip turned the tag down during the session. */
export function isLikelyTagTurnedDown(fingerprint, tag) {
  return Boolean(fingerprint) && turnedDown.has(dismissalKey(fingerprint, tag));
}

/** Changes whenever a suggestion is turned down, for memo dependencies. */
export function useTurnedDownVersion() {
  return useSyncExternalStore(subscribe, () => turnedDownVersion);
}

/** Forgets the session's turned-down suggestions (a profile switch). */
export function resetTurnedDownTags() {
  if (turnedDown.size === 0) return;
  turnedDown.clear();
  publish();
}

/**
 * Tells main these clips are not `tag`, so it is not suggested for them again.
 * Resolves to `{ success, dismissed }`.
 */
export async function turnDownLikelyTag(fingerprints, tag) {
  const api = window.electronAPI?.tagSuggestions;
  const list = [...new Set((fingerprints || []).filter(Boolean))];
  const name = String(tag || "").trim();
  if (!api?.dismiss || list.length === 0 || !name) {
    return { success: false, dismissed: 0 };
  }
  try {
    const result = await api.dismiss(list, name);
    if (!result?.success) return { success: false, dismissed: 0, error: result?.error };
    list.forEach((fingerprint) => turnedDown.add(dismissalKey(fingerprint, name)));
    publish();
    return { success: true, dismissed: Number(result.dismissed) || 0 };
  } catch (error) {
    return { success: false, dismissed: 0, error: error?.message || String(error) };
  }
}

const instanceIdOf = (video) => {
  const id = Number(video?.instanceId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/**
 * Suggested tags for the selected clips: `[{ tag, precision, fingerprints }]`,
 * each with the clips it is suggested for, most widely suggested first.
 */
export function useLikelyTags(selectedVideos, { active = true } = {}) {
  const rows = useMemo(() => {
    const list = [];
    for (const video of Array.isArray(selectedVideos) ? selectedVideos : []) {
      const instanceId = instanceIdOf(video);
      if (instanceId === null || !video.fingerprint || !video.promptKey) continue;
      list.push({ instanceId, fingerprint: video.fingerprint, tags: video.tags || [] });
      if (list.length >= MAX_SUGGESTION_ROWS) break;
    }
    return list;
  }, [selectedVideos]);
  // A clip's tags are part of the question: tagging it changes the answer.
  const signature = active
    ? rows.map((row) => `${row.instanceId}:${[...row.tags].sort().join("|")}`).join(",")
    : "";
  const [answer, setAnswer] = useState({ signature: "", byRow: {} });
  const requestRef = useRef(0);
  const version = useTurnedDownVersion();

  useEffect(() => {
    const ask = window.electronAPI?.tagSuggestions?.forClips;
    if (!signature || typeof ask !== "function") return undefined;
    const id = ++requestRef.current;
    const timer = setTimeout(() => {
      Promise.resolve(ask(rows.map((row) => row.instanceId)))
        .then((result) => {
          if (id !== requestRef.current || !result?.success || result.superseded) return;
          setAnswer({ signature, byRow: result.suggestions || {} });
        })
        .catch(() => {});
    }, SUGGESTION_DELAY_MS);
    return () => {
      clearTimeout(timer);
      requestRef.current += 1;
    };
    // signature stands for rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return useMemo(() => {
    if (!signature || answer.signature !== signature) return [];
    const byTag = new Map();
    for (const row of rows) {
      for (const entry of answer.byRow[row.instanceId] || []) {
        if (isLikelyTagTurnedDown(row.fingerprint, entry.tag)) continue;
        const key = entry.tag.toLowerCase();
        if (!byTag.has(key)) byTag.set(key, { tag: entry.tag, precision: entry.precision, fingerprints: [] });
        byTag.get(key).fingerprints.push(row.fingerprint);
      }
    }
    return [...byTag.values()].sort(
      (a, b) => b.fingerprints.length - a.fingerprints.length || a.tag.localeCompare(b.tag)
    );
    // version: a turned-down suggestion leaves at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, rows, signature, version]);
}

/**
 * The collection's catalog rows that might be `tag`: `{ matches, pending,
 * usable }`, where matches is a Set of instance ids, or null until the first
 * answer. Main leaves out clips already under the tag or that turned it down
 * when it answers; the filter also drops ones tagged or turned down since.
 */
export function useMightBe({ videos, tag }) {
  const name = typeof tag === "string" ? tag.trim() : "";
  const instanceIds = useMemo(() => {
    if (!name) return null;
    const ids = new Set();
    for (const video of videos || []) {
      const id = instanceIdOf(video);
      if (id !== null && video.promptKey) ids.add(id);
      if (ids.size >= MAX_MIGHT_BE_ROWS) break;
    }
    return [...ids].sort((a, b) => a - b);
  }, [name, videos]);
  const signature = instanceIds ? instanceIds.join(",") : "";
  const [result, setResult] = useState({ matches: null, usable: true, tag: "" });
  const [pending, setPending] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!name) {
      requestRef.current += 1;
      setResult({ matches: null, usable: true, tag: "" });
      setPending(false);
      return undefined;
    }
    const ask = window.electronAPI?.tagSuggestions?.mightBe;
    if (typeof ask !== "function") return undefined;
    setPending(true);
    // A different tag is a different question: its old answer must not show.
    setResult((previous) =>
      previous.tag.toLowerCase() === name.toLowerCase()
        ? previous
        : { matches: null, usable: true, tag: name }
    );
    const timer = setTimeout(() => {
      const id = ++requestRef.current;
      Promise.resolve(ask(instanceIds, name))
        .then((answer) => {
          if (id !== requestRef.current || answer?.superseded) return;
          setResult({
            matches: new Set(answer?.success ? answer.matches || [] : []),
            usable: answer?.success ? answer.usable !== false : false,
            tag: name,
          });
          setPending(false);
        })
        .catch(() => {
          if (id !== requestRef.current) return;
          setResult({ matches: new Set(), usable: false, tag: name });
          setPending(false);
        });
    }, MIGHT_BE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      requestRef.current += 1;
    };
    // signature stands for instanceIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, name]);

  return {
    matches: name ? result.matches : null,
    pending: Boolean(name) && pending,
    usable: !name || result.usable,
  };
}

/**
 * Which tags can be suggested: `{ tags, pending }`, with tags as main lists
 * them (`{ name, examples, usable, precision, recall }`). Asked while
 * `enabled` and again after `revision` changes; the first ask can take a
 * while, as main reads the tagged clips' prompts.
 */
export function useLikelyTagStatus({ enabled, revision = 0 }) {
  const [state, setState] = useState({ tags: null, pending: false });
  useEffect(() => {
    const ask = window.electronAPI?.tagSuggestions?.status;
    if (!enabled || typeof ask !== "function") return undefined;
    let cancelled = false;
    setState((previous) => ({ ...previous, pending: true }));
    Promise.resolve(ask())
      .then((result) => {
        if (cancelled) return;
        setState({ tags: result?.success ? result.tags || [] : [], pending: false });
      })
      .catch(() => {
        if (!cancelled) setState({ tags: [], pending: false });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, revision]);
  return state;
}
