import { describe, expect, it, vi } from "vitest";
import {
  ARENA_LIMITS,
  RatingArenaService,
  arenaOutcomes,
  buildArenaHistory,
  dealArenaRound,
  holdScore,
} from "../rating-arena.js";

// A repeatable random source.
function seeded(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// `spec` is [fingerprint, rating | null, promptKey | null].
function library(spec) {
  const pool = spec.map(([fingerprint, , promptKey], index) => ({
    fingerprint,
    instanceId: index + 1,
    promptKey: promptKey ?? null,
  }));
  const ratings = new Map(spec.filter(([, rating]) => rating).map(([fingerprint, rating]) => [fingerprint, rating]));
  return { pool, judgements: { ratings, rejects: new Set() } };
}

const DAY = 24 * 60 * 60 * 1000;

describe("dealArenaRound", () => {
  const spread = library([
    ["new-a", null, "pk-a"],
    ["new-b", null, "pk-b"],
    ["one", 1, "pk-x"],
    ["two", 2, "pk-x"],
    ["three", 3, "pk-x"],
    ["four", 4, "pk-x"],
    ["five", 5, "pk-x"],
  ]);

  it("places an unrated clip beside a low, middle and top rating, New first", async () => {
    const round = await dealArenaRound({ ...spread, kind: "place", random: seeded(3), match: "any" });
    expect(round.kind).toBe("place");
    expect(round.clips[0]).toMatchObject({ role: "new", rating: null });
    expect(["new-a", "new-b"]).toContain(round.clips[0].fingerprint);
    expect(round.clips.slice(1).map((clip) => [clip.fingerprint, clip.role, clip.rating])).toEqual([
      ["one", "reference", 1],
      ["three", "reference", 3],
      ["five", "reference", 5],
    ]);
  });

  it("uses the nearest ratings when the scale has gaps", async () => {
    const gaps = library([["new", null], ["two", 2], ["four", 4]]);
    const round = await dealArenaRound({ ...gaps, kind: "place", random: seeded(1) });
    expect(round.clips.map((clip) => clip.rating)).toEqual([null, 2, 4]);
  });

  it("starts with unrated clips against each other when too few are rated", async () => {
    const fresh = library([["a", null], ["b", null], ["c", null], ["d", null], ["rated", 4]]);
    const round = await dealArenaRound({ ...fresh, random: seeded(2) });
    expect(round.kind).toBe("first");
    expect(round.clips).toHaveLength(3);
    expect(round.clips.every((clip) => clip.role === "new" && clip.rating === null)).toBe(true);
  });

  it("checks three or four clips of one rating", async () => {
    const tiers = library([
      ["a", 4], ["b", 4], ["c", 4], ["d", 4], ["e", 4], ["x", 2], ["y", 2],
    ]);
    const round = await dealArenaRound({ ...tiers, kind: "tier", random: seeded(5) });
    expect(round.kind).toBe("tier");
    expect(round.clips).toHaveLength(4);
    expect(new Set(round.clips.map((clip) => clip.rating))).toEqual(new Set([4]));
    expect(round.clips.every((clip) => clip.role === "check")).toBe(true);
    expect(new Set(round.clips.map((clip) => clip.fingerprint)).size).toBe(4);
  });

  it("sets two of each neighbouring rating against each other, a pinned border first", async () => {
    const border = library([
      ["l1", 4], ["l2", 4], ["l3", 4], ["h1", 5], ["h2", 5], ["m1", 2], ["m2", 2], ["n1", 3], ["n2", 3],
    ]);
    const round = await dealArenaRound({ ...border, kind: "border", border: 4, random: seeded(7) });
    expect(round.kind).toBe("border");
    expect(round.clips.map((clip) => clip.rating)).toEqual([4, 4, 5, 5]);
  });

  it("says so when the pool has nothing for the kind asked", async () => {
    const thin = library([["a", 3], ["b", 3], ["c", null]]);
    expect(await dealArenaRound({ ...thin, kind: "tier", random: seeded(1) })).toEqual({ kind: null, reason: "tier" });
    expect(await dealArenaRound({ ...library([]), random: seeded(1) })).toEqual({ kind: null, reason: "mixed" });
  });

  it("leaves rejected clips and recent rounds out while there are others", async () => {
    const pool = library([["new-a", null], ["new-b", null], ["one", 1], ["five", 5]]);
    pool.judgements.rejects.add("new-b");
    for (let seed = 1; seed < 20; seed += 1) {
      const round = await dealArenaRound({ ...pool, kind: "place", random: seeded(seed) });
      expect(round.clips[0].fingerprint).toBe("new-a");
    }
    // The only unrated clip was in a recent round: dealt again rather than nothing.
    const again = await dealArenaRound({ ...pool, kind: "place", recent: new Set(["new-a"]), random: seeded(1) });
    expect(again.clips[0].fingerprint).toBe("new-a");
  });

  it("matches the same prompt first, then the closest prompts, keys only", async () => {
    const prompts = library([
      ["new", null, "pk-new"],
      ["same", 3, "pk-new"],
      ["close", 1, "pk-close"],
      ["far", 1, "pk-far"],
      ["top", 5, "pk-far"],
    ]);
    const alike = vi.fn(async (promptKey, keys) => new Map(keys.map((key) => [key, key === "pk-close" ? 0.9 : 0.1])));
    for (let seed = 1; seed < 12; seed += 1) {
      alike.mockClear();
      const round = await dealArenaRound({ ...prompts, kind: "place", random: seeded(seed), alike, limits: { alikeTop: 1 } });
      const byRating = Object.fromEntries(round.clips.map((clip) => [clip.rating ?? "new", clip.fingerprint]));
      expect(byRating).toMatchObject({ new: "new", 1: "close", 3: "same", 5: "top" });
      for (const [promptKey, keys] of alike.mock.calls) {
        expect(promptKey).toBe("pk-new");
        expect(keys.every((key) => typeof key === "string" && key.startsWith("pk-"))).toBe(true);
      }
    }
    // With Any, the prompt service is not asked.
    alike.mockClear();
    await dealArenaRound({ ...prompts, kind: "place", random: seeded(1), alike, match: "any" });
    expect(alike).not.toHaveBeenCalled();
  });

  it("checks clips held least and checked longest ago, unless ignoring holds", async () => {
    const tiers = library([["a", 3], ["b", 3], ["c", 3], ["d", 3], ["e", 3], ["f", 3], ["g", 3], ["h", 3]]);
    const now = 1_000 * DAY;
    // Everything but "h" has held three times; "g" long ago, so its holds
    // have faded. The first quarter of eight is "h" and "g".
    const history = buildArenaHistory(
      ["a", "b", "c", "d", "e", "f", "g"].flatMap((fingerprint) =>
        [1, 2, 3].map((n) => ({
          fingerprint,
          checkedAt: now - n * DAY - (fingerprint === "g" ? 300 * DAY : 0),
          kind: "tier",
          outcome: "held",
        }))
      )
    );
    const seeds = new Map();
    for (let seed = 1; seed < 60; seed += 1) {
      const round = await dealArenaRound({
        ...tiers,
        kind: "tier",
        history,
        now,
        random: seeded(seed),
        limits: { ignoreHoldsShare: 0 },
      });
      seeds.set(round.clips[0].fingerprint, (seeds.get(round.clips[0].fingerprint) || 0) + 1);
    }
    expect([...seeds.keys()].sort()).toEqual(["g", "h"]);
  });
});

describe("history", () => {
  it("counts holds since the rating last changed, borders double, halving with age", () => {
    const now = 200 * DAY;
    const history = buildArenaHistory([
      { fingerprint: "a", checkedAt: now - 90 * DAY, kind: "tier", outcome: "held" },
      { fingerprint: "a", checkedAt: now - 80 * DAY, kind: "tier", outcome: "raised" },
      { fingerprint: "a", checkedAt: now, kind: "tier", outcome: "held" },
      { fingerprint: "a", checkedAt: now - ARENA_LIMITS.holdHalfLifeMs, kind: "border", outcome: "held" },
      { fingerprint: "b", checkedAt: now - DAY, kind: "place", outcome: "skipped" },
    ]);
    expect(holdScore(history.get("a"), now)).toBeCloseTo(1 + 2 * 0.5, 5);
    expect(history.get("a").lastCheckedAt).toBe(now);
    expect(holdScore(history.get("b"), now)).toBe(0);
    expect(history.get("b").lastCheckedAt).toBe(now - DAY);
  });
});

describe("arenaOutcomes", () => {
  const judgements = (ratings, rejects = []) => ({ ratings: new Map(Object.entries(ratings)), rejects: new Set(rejects) });

  it("says how each clip ended, against its rating when dealt", () => {
    const place = {
      kind: "place",
      clips: [
        { fingerprint: "new", role: "new", rating: null },
        { fingerprint: "low", role: "reference", rating: 1 },
        { fingerprint: "top", role: "reference", rating: 5 },
      ],
    };
    expect(arenaOutcomes(place, judgements({ new: 3, low: 1, top: 4 }))).toEqual([
      { fingerprint: "new", kind: "place", outcome: "placed", ratingBefore: null, ratingAfter: 3 },
      { fingerprint: "top", kind: "place", outcome: "lowered", ratingBefore: 5, ratingAfter: 4 },
    ]);
    expect(arenaOutcomes(place, judgements({ low: 1, top: 5 })).map((row) => row.outcome)).toEqual(["skipped"]);
    expect(arenaOutcomes(place, judgements({ low: 1, top: 5 }, ["new"]))[0].outcome).toBe("rejected");

    const tier = {
      kind: "tier",
      clips: [
        { fingerprint: "a", role: "check", rating: 3 },
        { fingerprint: "b", role: "check", rating: 3 },
        { fingerprint: "c", role: "check", rating: 3 },
        { fingerprint: "d", role: "check", rating: 3 },
      ],
    };
    expect(arenaOutcomes(tier, judgements({ a: 3, b: 4, c: 2 })).map((row) => row.outcome)).toEqual([
      "held",
      "raised",
      "lowered",
      "lowered",
    ]);
  });
});

describe("RatingArenaService", () => {
  function fakeStore(spec) {
    const { pool, judgements } = library(spec);
    const checks = [];
    let nextId = 1;
    return {
      judgements,
      checks,
      getArenaPool: vi.fn(({ instanceIds }) =>
        instanceIds ? pool.filter((clip) => instanceIds.includes(clip.instanceId)) : pool
      ),
      getArenaJudgements: vi.fn(() => ({ ratings: new Map(judgements.ratings), rejects: new Set(judgements.rejects) })),
      listArenaChecks: vi.fn(() => checks.slice()),
      recordArenaChecks: vi.fn((rows, { now, replaceIds = [] }) => {
        for (const id of replaceIds) checks.splice(checks.findIndex((row) => row.id === id), 1);
        return rows.map((row) => {
          const id = nextId++;
          checks.push({ ...row, id, checkedAt: now });
          return id;
        });
      }),
    };
  }

  it("deals rounds, records how they ended, and replaces a round that comes back", async () => {
    const store = fakeStore([
      ["new-a", null], ["new-b", null], ["one", 1], ["three", 3], ["five", 5],
    ]);
    const arena = new RatingArenaService({ random: seeded(4), now: () => 5 * DAY });
    const { session, counts } = arena.start({ store });
    expect(counts).toMatchObject({ unrated: 2, rated: 3, total: 5 });

    const first = await arena.round({ store, session, options: { kind: "place", match: "any" } });
    expect(first.round.kind).toBe("place");
    const newcomer = first.round.clips[0].fingerprint;
    store.judgements.ratings.set(newcomer, 3);
    expect(arena.finish({ store, session, round: first.round.id })).toMatchObject({ placed: 1 });
    expect(store.checks).toEqual([
      expect.objectContaining({ fingerprint: newcomer, outcome: "placed", ratingAfter: 3 }),
    ]);

    // Undo brought it back: rated 4 this time, the earlier row replaced.
    store.judgements.ratings.set(newcomer, 4);
    arena.finish({ store, session, round: first.round.id });
    expect(store.checks).toEqual([
      expect.objectContaining({ fingerprint: newcomer, outcome: "placed", ratingAfter: 4 }),
    ]);

    // The next Place round deals the other unrated clip.
    const second = await arena.round({ store, session, options: { kind: "place", match: "any" } });
    expect(second.round.clips[0].fingerprint).not.toBe(newcomer);
    expect(second.counts).toMatchObject({ unrated: 1 });
  });

  it("hands out the round prepared meanwhile only if it still fits", async () => {
    const store = fakeStore([["a", null], ["b", null], ["c", null], ["one", 1], ["five", 5]]);
    const arena = new RatingArenaService({ random: seeded(9) });
    const { session } = arena.start({ store });
    const options = { kind: "place", match: "any" };
    await arena.round({ store, session, options });
    const prepared = await arena.sessions.get(session).prepared.promise;
    // Its New was rated elsewhere meanwhile: a fresh deal instead.
    store.judgements.ratings.set(prepared.clips[0].fingerprint, 2);
    const next = await arena.round({ store, session, options });
    expect(next.round.clips[0].fingerprint).not.toBe(prepared.clips[0].fingerprint);
    expect(next.round.clips[0].role).toBe("new");
  });

  it("drops a prepared first round once the round shown rated enough to place against", async () => {
    const store = fakeStore([["a", null], ["b", null], ["c", null], ["d", null], ["e", null], ["f", null]]);
    const arena = new RatingArenaService({ random: seeded(3) });
    const { session } = arena.start({ store });
    const options = { kind: "mixed", match: "any" };
    const first = await arena.round({ store, session, options });
    expect(first.round.kind).toBe("first");
    first.round.clips.forEach((clip, index) => store.judgements.ratings.set(clip.fingerprint, [1, 3, 5][index]));
    const next = await arena.round({ store, session, options });
    expect(["place", "tier", "border"]).toContain(next.round.kind);
  });

  it("limits the pool to the clips shown, and forgets sessions on a profile switch", async () => {
    const store = fakeStore([["a", null], ["b", 3], ["c", 5]]);
    const arena = new RatingArenaService();
    const { session, counts } = arena.start({ store, instanceIds: [1, 2] });
    expect(counts.total).toBe(2);
    expect(store.getArenaPool).toHaveBeenCalledWith(expect.objectContaining({ instanceIds: [1, 2], limit: ARENA_LIMITS.maxScopeClips }));
    arena.clear();
    await expect(arena.round({ store, session })).rejects.toMatchObject({ code: "ARENA_SESSION_GONE" });
  });
});
