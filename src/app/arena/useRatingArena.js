import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeVideoFromMain } from "../videoNormalization";
import { emptyArenaStats, addArenaOutcomes } from "./arenaView";

// The rating arena's session in the renderer (docs/architecture/rating-arena.md):
// main deals rounds from its pool and records how they ended; this keeps the
// round on screen, the one before it (so Undo can bring it back), and the
// session's counts.
//
// `arena` is null while closed, else:
// `{ session, status, scope, kind, border, match, round, records, counts,
//    reason, roundNumber, previous, restored, finished }`
// - status: starting | dealing | ready | empty | failed
// - round: `{ id, kind, clips: [{ instanceId, role, rating }] }`
// - previous: the round before, `{ round, records, roundNumber, counts }`
// - restored: the round on screen was finished once and came back by Undo
// - finished: `[{ id, outcomes }]` in order, for the counts and the streak

const arenaApi = () => window.electronAPI?.arena || null;

const normalizeRecords = (records) => {
  const seen = new Set();
  const list = [];
  for (const record of Array.isArray(records) ? records : []) {
    const video = normalizeVideoFromMain(record);
    if (video?.id == null || seen.has(video.id)) continue;
    seen.add(video.id);
    list.push(video);
  }
  return list;
};

export default function useRatingArena({ notify } = {}) {
  const [arena, setArena] = useState(null);
  const arenaRef = useRef(null);
  arenaRef.current = arena;
  // Every open, deal and close bumps this; late answers are dropped.
  const requestRef = useRef(0);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const deal = useCallback(async (base) => {
    const api = arenaApi();
    const request = ++requestRef.current;
    setArena((previous) =>
      previous?.session === base.session ? { ...previous, status: "dealing" } : previous
    );
    let result = null;
    try {
      result = await api.round({
        session: base.session,
        kind: base.kind,
        border: base.border,
        match: base.match,
      });
    } catch (error) {
      result = { success: false, error: error?.message || String(error) };
    }
    if (request !== requestRef.current) return;
    if (!result || result.success === false) {
      notifyRef.current?.("The arena could not deal a round", "error");
      setArena((previous) =>
        previous?.session === base.session ? { ...previous, status: "failed" } : previous
      );
      return;
    }
    setArena((previous) => {
      if (previous?.session !== base.session) return previous;
      if (!result.round) {
        return {
          ...previous,
          status: "empty",
          round: null,
          records: [],
          restored: false,
          counts: result.counts || previous.counts,
          reason: result.reason || null,
        };
      }
      return {
        ...previous,
        status: "ready",
        round: result.round,
        records: normalizeRecords(result.records),
        restored: false,
        counts: result.counts || previous.counts,
        reason: null,
        roundNumber: previous.roundNumber + 1,
      };
    });
  }, []);

  const open = useCallback(
    async ({ scope = "library", instanceIds = null, kind, border, match } = {}) => {
      const api = arenaApi();
      if (typeof api?.start !== "function") return false;
      const before = arenaRef.current;
      if (before?.session) void api.end?.(before.session);
      const request = ++requestRef.current;
      const settings = {
        kind: kind || before?.kind || "mixed",
        border: border !== undefined ? border : before?.border ?? null,
        match: match || before?.match || "similar",
      };
      setArena({
        session: null,
        status: "starting",
        scope,
        ...settings,
        round: null,
        records: [],
        counts: null,
        reason: null,
        roundNumber: 0,
        previous: null,
        restored: false,
        finished: before?.finished || [],
      });
      let result = null;
      try {
        result = await api.start(
          scope === "clips" ? { scope, instanceIds: instanceIds || [] } : { scope: "library" }
        );
      } catch (error) {
        result = { success: false, error: error?.message || String(error) };
      }
      if (request !== requestRef.current) return true;
      if (!result || result.success === false || !result.session) {
        notifyRef.current?.("The arena could not open", "error");
        setArena(null);
        return true;
      }
      const base = { session: result.session, ...settings };
      setArena((previous) =>
        previous ? { ...previous, session: result.session, counts: result.counts || null } : previous
      );
      await deal(base);
      return true;
    },
    [deal]
  );

  // Records how the round on screen ended, then deals the next one.
  // `finish: false` drops an untouched round instead (a new kind or match).
  const next = useCallback(
    async ({ finish = true } = {}) => {
      const current = arenaRef.current;
      const api = arenaApi();
      if (!current?.session || current.status === "dealing" || current.status === "starting") return;
      let outcomes = null;
      if (finish && current.round) {
        try {
          const result = await api.finish({ session: current.session, round: current.round.id });
          if (result?.success) outcomes = result.outcomes || null;
        } catch {
          outcomes = null;
        }
        if (arenaRef.current?.session !== current.session) return;
      }
      setArena((previous) => {
        if (previous?.session !== current.session) return previous;
        const roundId = current.round?.id;
        const finished =
          outcomes && roundId != null
            ? [...previous.finished.filter((entry) => entry.id !== roundId), { id: roundId, outcomes }]
            : previous.finished;
        return {
          ...previous,
          finished,
          previous:
            finish && current.round
              ? {
                  round: current.round,
                  records: previous.records,
                  roundNumber: previous.roundNumber,
                  counts: previous.counts,
                }
              : previous.previous,
        };
      });
      await deal(current);
    },
    [deal]
  );

  // Undo of the change that ended the last round: that round comes back on
  // screen, to be finished again (its rows in main are replaced then).
  const restorePrevious = useCallback(() => {
    const current = arenaRef.current;
    if (!current?.previous) return false;
    requestRef.current += 1;
    setArena((previous) => {
      if (!previous?.previous) return previous;
      const back = previous.previous;
      return {
        ...previous,
        status: "ready",
        round: back.round,
        records: back.records,
        roundNumber: back.roundNumber,
        // As things stood when it was dealt, which Undo returns to.
        counts: back.counts || previous.counts,
        previous: null,
        restored: true,
        reason: null,
        finished: previous.finished.filter((entry) => entry.id !== back.round.id),
      };
    });
    return true;
  }, []);

  const setOptions = useCallback(
    async (options, { finishCurrent = false } = {}) => {
      const current = arenaRef.current;
      if (!current?.session) return;
      const updated = { ...current, ...options };
      arenaRef.current = updated;
      setArena((previous) => (previous?.session === current.session ? { ...previous, ...options } : previous));
      await next({ finish: finishCurrent });
    },
    [next]
  );

  /** Leaves the arena; resolves to the session's counts for the toast. */
  const close = useCallback(async ({ finishCurrent = false } = {}) => {
    const current = arenaRef.current;
    if (!current) return null;
    requestRef.current += 1;
    arenaRef.current = null;
    setArena(null);
    const api = arenaApi();
    let finished = current.finished;
    if (current.session && current.round && finishCurrent) {
      try {
        const result = await api.finish({ session: current.session, round: current.round.id });
        if (result?.success && result.outcomes) {
          finished = [
            ...finished.filter((entry) => entry.id !== current.round.id),
            { id: current.round.id, outcomes: result.outcomes },
          ];
        }
      } catch {
        // The counts leave this round out.
      }
    }
    if (current.session) {
      try {
        await api.end?.(current.session);
      } catch {
        // Main lets the session go with the profile anyway.
      }
    }
    return finished.reduce((stats, entry) => addArenaOutcomes(stats, entry.outcomes), emptyArenaStats());
  }, []);

  // Edits made anywhere reach the round's clips from other folders too.
  const updateRecords = useCallback((update) => {
    if (typeof update !== "function") return;
    setArena((previous) => {
      if (!previous) return previous;
      const records = previous.records.length ? update(previous.records) : previous.records;
      const back = previous.previous;
      const backRecords = back?.records.length ? update(back.records) : back?.records;
      if (records === previous.records && backRecords === back?.records) return previous;
      return {
        ...previous,
        records,
        previous: back ? { ...back, records: backRecords } : back,
      };
    });
  }, []);

  // Tags given in the arena, for the session's counts.
  const [tagged, setTagged] = useState(0);
  const noteTagged = useCallback(() => setTagged((count) => count + 1), []);
  useEffect(() => {
    if (!arena) setTagged(0);
  }, [arena]);

  // A session left open when the app closes this view goes with it.
  useEffect(
    () => () => {
      const current = arenaRef.current;
      if (current?.session) void arenaApi()?.end?.(current.session);
    },
    []
  );

  return {
    arena,
    tagged,
    open,
    next,
    close,
    restorePrevious,
    setOptions,
    updateRecords,
    noteTagged,
  };
}
