import { useCallback, useEffect, useState } from "react";

// Background work for the status line (docs/architecture/background-activity.md).
// Main sends kinds and counts; work shows once it has run this long, so a
// blip never flickers a line in and out. While paused, everything shows.
export const ACTIVITY_SHOW_AFTER_MS = 1500;

const EMPTY = Object.freeze({ paused: false, activities: Object.freeze([]) });

function count(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function normalizeActivitySnapshot(value) {
  if (!value || typeof value !== "object") return EMPTY;
  const activities = Array.isArray(value.activities)
    ? value.activities
        .filter((entry) => entry && typeof entry.kind === "string")
        .map((entry) => ({
          kind: entry.kind,
          pausable: entry.pausable !== false,
          done: count(entry.done),
          total: count(entry.total),
          startedAt: Number(entry.startedAt) || 0,
        }))
    : [];
  return { paused: value.paused === true, activities };
}

export function useBackgroundActivity({ api, now = Date.now } = {}) {
  const bridge = api === undefined ? globalThis.window?.electronAPI?.activity : api;
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [clock, setClock] = useState(() => now());

  useEffect(() => {
    if (typeof bridge?.get !== "function") return undefined;
    let live = true;
    bridge
      .get()
      .then((value) => {
        if (live) setSnapshot(normalizeActivitySnapshot(value));
      })
      .catch(() => {});
    const unsubscribe = bridge.onChange?.((value) => {
      if (live) setSnapshot(normalizeActivitySnapshot(value));
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [bridge]);

  // Come back when the next piece of work has run long enough to show.
  useEffect(() => {
    const current = now();
    const waits = snapshot.activities
      .map((entry) => entry.startedAt + ACTIVITY_SHOW_AFTER_MS - current)
      .filter((wait) => wait > 0);
    if (waits.length === 0) {
      setClock(current);
      return undefined;
    }
    const timer = setTimeout(() => setClock(now()), Math.min(...waits) + 10);
    return () => clearTimeout(timer);
  }, [now, snapshot]);

  const setPaused = useCallback(
    (paused) => {
      if (typeof bridge?.setPaused !== "function") return;
      setSnapshot((previous) => ({ ...previous, paused: paused === true }));
      bridge
        .setPaused(paused === true)
        .then((value) => setSnapshot(normalizeActivitySnapshot(value)))
        .catch(() => {});
    },
    [bridge]
  );

  const activities = snapshot.paused
    ? snapshot.activities
    : snapshot.activities.filter(
        (entry) => entry.startedAt + ACTIVITY_SHOW_AFTER_MS <= clock
      );
  return {
    available: typeof bridge?.get === "function",
    paused: snapshot.paused,
    activities,
    setPaused,
  };
}
