import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// First frames for stack cards (docs/architecture/prompt-stacks.md,
// Section 8). Fingerprints are asked for every clip in a stack, never clips
// that stand alone; main answers the stored ones at once and sends the rest
// as it grabs them. Stills are asked for only the strips of cards on screen.

const REQUEST_DELAY_MS = 300;
const FINGERPRINT_CHUNK = 5000;
const STILL_CHUNK = 32;
const MAX_STILLS = 800;
const EMPTY = new Map();

const instanceIdOf = (video) => {
  const id = Number(video?.instanceId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

/**
 * `stacks` is the current Map of stacks; `stillIds` the catalog rows whose
 * stills are wanted now; `resetKey` changes with the collection or profile.
 * Returns `{ hashOf(video), stillOf(video) }`.
 */
export function useStackFrames({ stacks, enabled, stillIds = [], resetKey = "" }) {
  const api = typeof window !== "undefined" ? window.electronAPI?.stacks : null;
  const [hashes, setHashes] = useState(EMPTY);
  const [stills, setStills] = useState(EMPTY);
  const askedRef = useRef({ key: null, hashes: new Set(), stills: new Set() });
  if (askedRef.current.key !== resetKey) {
    askedRef.current = { key: resetKey, hashes: new Set(), stills: new Set() };
  }

  useEffect(() => {
    setHashes(EMPTY);
    setStills(EMPTY);
  }, [resetKey]);

  const mergeHashes = useCallback((found) => {
    const entries = Object.entries(found || {}).filter(([, hash]) => typeof hash === "string");
    if (!entries.length) return;
    setHashes((previous) => {
      const next = new Map(previous);
      for (const [id, hash] of entries) next.set(Number(id), hash);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!api?.onFrameFingerprints) return undefined;
    return api.onFrameFingerprints((payload) => mergeHashes(payload?.hashes));
  }, [api, mergeHashes]);

  const memberIds = useMemo(() => {
    if (!enabled || !stacks) return [];
    const ids = [];
    for (const stack of stacks.values()) {
      for (const member of stack.members) {
        const id = instanceIdOf(member);
        if (id !== null) ids.push(id);
      }
    }
    return ids;
  }, [enabled, stacks]);

  useEffect(() => {
    if (!api?.frameFingerprints || memberIds.length === 0) return undefined;
    const timer = setTimeout(() => {
      const asked = askedRef.current.hashes;
      const fresh = memberIds.filter((id) => !asked.has(id));
      fresh.forEach((id) => asked.add(id));
      for (let start = 0; start < fresh.length; start += FINGERPRINT_CHUNK) {
        Promise.resolve(api.frameFingerprints(fresh.slice(start, start + FINGERPRINT_CHUNK)))
          .then((result) => {
            if (result?.success) mergeHashes(result.hashes);
          })
          .catch(() => {});
      }
    }, REQUEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [api, memberIds, mergeHashes]);

  const stillKey = enabled ? stillIds.join(",") : "";
  useEffect(() => {
    if (!api?.frameStills || !stillKey) return undefined;
    const timer = setTimeout(() => {
      const asked = askedRef.current.stills;
      const fresh = stillIds.filter((id) => !asked.has(id));
      fresh.forEach((id) => asked.add(id));
      for (let start = 0; start < fresh.length; start += STILL_CHUNK) {
        Promise.resolve(api.frameStills(fresh.slice(start, start + STILL_CHUNK)))
          .then((result) => {
            const entries = Object.entries(result?.success ? result.stills || {} : {});
            if (!entries.length) return;
            setStills((previous) => {
              const next = new Map(previous);
              for (const [id, src] of entries) next.set(Number(id), src);
              while (next.size > MAX_STILLS) {
                const oldest = next.keys().next().value;
                next.delete(oldest);
                askedRef.current.stills.delete(oldest);
              }
              return next;
            });
          })
          .catch(() => {});
      }
    }, REQUEST_DELAY_MS);
    return () => clearTimeout(timer);
    // stillKey stands for stillIds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, stillKey]);

  const hashOf = useCallback((video) => hashes.get(instanceIdOf(video)) || null, [hashes]);
  const stillOf = useCallback((video) => stills.get(instanceIdOf(video)) || null, [stills]);
  return { hashOf, stillOf };
}
