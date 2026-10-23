"use strict";

// The rating arena (docs/architecture/rating-arena.md): rounds of two to
// four clips rated side by side. This module deals rounds from a pool of
// contents and records how each round ended. Prompts never leave main: a
// round's companions are matched by prompt keys and the prompt service's
// scores, and the renderer receives clips and their parts only.

const crypto = require("crypto");

const ARENA_LIMITS = Object.freeze({
  // The whole library, or the clips the grid showed (as a review pass takes
  // them).
  maxPoolClips: 1_000_000,
  maxScopeClips: 50_000,
  // A clip shown in this many recent rounds is not dealt again while the
  // pool has others.
  recentRounds: 20,
  // Similar prompts: at most this many of a rating's clips are compared
  // with a round's first clip, and one of the closest few is taken.
  alikeSample: 120,
  alikeTop: 3,
  // Holding decays, and one pick in five ignores it.
  holdHalfLifeMs: 60 * 24 * 60 * 60 * 1000,
  ignoreHoldsShare: 0.2,
  // Mixed rounds deal Place this often while unrated clips remain.
  placeShare: 0.6,
  maxCheckRows: 200_000,
  maxSessions: 2,
});

const ROUND_KINDS = Object.freeze(["mixed", "place", "tier", "border"]);
const RATINGS = [1, 2, 3, 4, 5];
const PLACE_TARGETS = [1, 3, 5];
const CHANGE_OUTCOMES = new Set(["placed", "raised", "lowered", "rejected"]);

// ----- History ---------------------------------------------------------------

/**
 * One content's history: its holds since its rating last changed, each with
 * its time and weight (2 when held in a border), and when it was last in a
 * finished round.
 */
function applyArenaCheck(history, row) {
  if (!row?.fingerprint) return;
  let entry = history.get(row.fingerprint);
  if (!entry) history.set(row.fingerprint, (entry = { holds: [], lastCheckedAt: 0 }));
  entry.lastCheckedAt = Math.max(entry.lastCheckedAt, Number(row.checkedAt) || 0);
  if (CHANGE_OUTCOMES.has(row.outcome)) entry.holds = [];
  else if (row.outcome === "held") {
    entry.holds.push({ at: Number(row.checkedAt) || 0, weight: row.kind === "border" ? 2 : 1 });
  }
}

function buildArenaHistory(rows) {
  const history = new Map();
  for (const row of Array.isArray(rows) ? rows : []) applyArenaCheck(history, row);
  return history;
}

/** How much a content has held, halving every `halfLifeMs`. */
function holdScore(entry, now, halfLifeMs = ARENA_LIMITS.holdHalfLifeMs) {
  if (!entry?.holds?.length) return 0;
  let score = 0;
  for (const hold of entry.holds) {
    const age = Math.max(0, now - hold.at);
    score += hold.weight * 0.5 ** (age / halfLifeMs);
  }
  return score;
}

// ----- Dealing ---------------------------------------------------------------

const pickOne = (list, random) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

function sampleOf(list, count, random) {
  if (list.length <= count) return list.slice();
  const copy = list.slice();
  for (let index = 0; index < count; index += 1) {
    const swap = index + Math.floor(random() * (copy.length - index));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy.slice(0, count);
}

/**
 * One clip of `candidates`, in the order a part prefers:
 * - `check` (tier checks and borders): held least, then checked longest
 *   ago, never-checked first; one of the first quarter.
 * - `reference` (Place): held most; one of the better half, so the same few
 *   do not repeat.
 * - `any`: at random.
 * One pick in five ignores holds, so nothing settles for good.
 */
function pickByHistory(candidates, order, context) {
  if (!candidates.length) return null;
  const { random, history, now, limits } = context;
  if (order === "any" || random() < limits.ignoreHoldsShare) return pickOne(candidates, random);
  const scored = candidates.map((clip) => {
    const entry = history.get(clip.fingerprint);
    return {
      clip,
      holds: holdScore(entry, now, limits.holdHalfLifeMs),
      checkedAt: entry?.lastCheckedAt || 0,
    };
  });
  if (order === "reference") {
    scored.sort((a, b) => b.holds - a.holds);
    return pickOne(scored.slice(0, Math.max(1, Math.ceil(scored.length / 2))), random).clip;
  }
  scored.sort((a, b) => a.holds - b.holds || a.checkedAt - b.checkedAt);
  return pickOne(scored.slice(0, Math.max(1, Math.ceil(scored.length / 4))), random).clip;
}

/**
 * A companion for `seed` among `candidates`. With similar prompts: one with
 * the same prompt key, else one of the closest prompts among a sample, else
 * by history.
 */
async function pickCompanion(seed, candidates, order, context) {
  if (!candidates.length) return null;
  const { match, alike, random, limits } = context;
  if (match === "similar" && seed?.promptKey) {
    const same = candidates.filter((clip) => clip.promptKey === seed.promptKey);
    if (same.length) return pickByHistory(same, order, context);
    const keyed = candidates.filter((clip) => clip.promptKey);
    if (keyed.length && typeof alike === "function") {
      const sample = sampleOf(keyed, limits.alikeSample, random);
      let scores = null;
      try {
        scores = await alike(seed.promptKey, [...new Set(sample.map((clip) => clip.promptKey))]);
      } catch {
        scores = null;
      }
      const scored = sample
        .map((clip) => ({ clip, score: scores?.get?.(clip.promptKey) || 0 }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length) return pickOne(scored.slice(0, limits.alikeTop), random).clip;
    }
  }
  return pickByHistory(candidates, order, context);
}

/** Who is in the pool for a round, as things stand. */
function partitionPool(pool, judgements, recent) {
  const all = { unrated: [], tiers: new Map(RATINGS.map((rating) => [rating, []])) };
  const fresh = { unrated: [], tiers: new Map(RATINGS.map((rating) => [rating, []])) };
  for (const clip of pool) {
    if (judgements.rejects.has(clip.fingerprint)) continue;
    const rating = judgements.ratings.get(clip.fingerprint) ?? null;
    const target = rating ? all.tiers.get(rating) : all.unrated;
    if (!target) continue;
    target.push(clip);
    if (!recent.has(clip.fingerprint)) (rating ? fresh.tiers.get(rating) : fresh.unrated).push(clip);
  }
  return { all, fresh };
}

function countsOf(all) {
  const byRating = {};
  let rated = 0;
  for (const rating of RATINGS) {
    byRating[rating] = all.tiers.get(rating).length;
    rated += byRating[rating];
  }
  return { unrated: all.unrated.length, rated, byRating, total: rated + all.unrated.length };
}

const ratedCount = (tiers) => RATINGS.reduce((sum, rating) => sum + tiers.get(rating).length, 0);
const tiersWith = (tiers, size) => RATINGS.filter((rating) => tiers.get(rating).length >= size);
const bordersWith = (tiers, size) =>
  RATINGS.slice(0, -1).filter(
    (rating) => tiers.get(rating).length >= size && tiers.get(rating + 1).length >= size
  );

// The fresh clips when they are enough for the round, else every clip.
function chooseSide(partition, enough) {
  return enough(partition.fresh) ? partition.fresh : enough(partition.all) ? partition.all : null;
}

const without = (list, chosen) => list.filter((clip) => !chosen.has(clip.fingerprint));

async function dealPlace(side, context) {
  const newcomer = pickOne(side.unrated, context.random);
  const chosen = new Set([newcomer.fingerprint]);
  const usedTiers = new Set();
  const references = [];
  for (const target of PLACE_TARGETS) {
    const rating = RATINGS.filter((value) => !usedTiers.has(value) && side.tiers.get(value).length)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || b - a)[0];
    if (!rating) continue;
    const reference = await pickCompanion(
      newcomer,
      without(side.tiers.get(rating), chosen),
      "reference",
      context
    );
    if (!reference) continue;
    usedTiers.add(rating);
    chosen.add(reference.fingerprint);
    references.push({ ...reference, role: "reference", rating });
  }
  references.sort((a, b) => a.rating - b.rating);
  return [{ ...newcomer, role: "new", rating: null }, ...references];
}

async function dealFirst(side, context) {
  const seed = pickOne(side.unrated, context.random);
  const clips = [seed];
  const chosen = new Set([seed.fingerprint]);
  while (clips.length < 3) {
    const next = await pickCompanion(seed, without(side.unrated, chosen), "any", context);
    if (!next) break;
    chosen.add(next.fingerprint);
    clips.push(next);
  }
  return clips.map((clip) => ({ ...clip, role: "new", rating: null }));
}

async function dealTier(side, context) {
  const ratings = tiersWith(side.tiers, 3);
  // Larger tiers come up more often.
  const total = ratings.reduce((sum, rating) => sum + side.tiers.get(rating).length, 0);
  let roll = context.random() * total;
  let rating = ratings[ratings.length - 1];
  for (const value of ratings) {
    roll -= side.tiers.get(value).length;
    if (roll < 0) {
      rating = value;
      break;
    }
  }
  const tier = side.tiers.get(rating);
  const seed = pickByHistory(tier, "check", context);
  const clips = [seed];
  const chosen = new Set([seed.fingerprint]);
  const size = tier.length >= 4 ? 4 : 3;
  while (clips.length < size) {
    const next = await pickCompanion(seed, without(tier, chosen), "check", context);
    if (!next) break;
    chosen.add(next.fingerprint);
    clips.push(next);
  }
  return clips.map((clip) => ({ ...clip, role: "check", rating }));
}

async function dealBorder(side, context, border) {
  const lower = bordersWith(side.tiers, 2).includes(border)
    ? border
    : pickOne(bordersWith(side.tiers, 2), context.random);
  const below = side.tiers.get(lower);
  const above = side.tiers.get(lower + 1);
  const seed = pickByHistory(context.random() < 0.5 ? below : above, "check", context);
  const seedRating = below.includes(seed) ? lower : lower + 1;
  const clips = [{ ...seed, rating: seedRating }];
  const chosen = new Set([seed.fingerprint]);
  for (const [tier, rating, count] of [
    [seedRating === lower ? below : above, seedRating, 1],
    [seedRating === lower ? above : below, seedRating === lower ? lower + 1 : lower, 2],
  ]) {
    for (let index = 0; index < count; index += 1) {
      const next = await pickCompanion(seed, without(tier, chosen), "check", context);
      if (!next) break;
      chosen.add(next.fingerprint);
      clips.push({ ...next, rating });
    }
  }
  clips.sort((a, b) => a.rating - b.rating);
  return clips.map((clip) => ({ ...clip, role: "check" }));
}

const ENOUGH = {
  place: (side) => side.unrated.length >= 1 && ratedCount(side.tiers) >= 2,
  first: (side) => side.unrated.length >= 1,
  tier: (side) => tiersWith(side.tiers, 3).length > 0,
  border: (side) => bordersWith(side.tiers, 2).length > 0,
};

/**
 * Deals one round from `pool` (`{ fingerprint, instanceId, promptKey }`),
 * as ratings and rejections stand (`judgements`). Returns
 * `{ kind, clips: [{ fingerprint, instanceId, promptKey, role, rating }] }`,
 * where `kind` is place, first, tier or border, or `{ kind: null, reason }`
 * when the pool has nothing for the kind asked.
 */
async function dealArenaRound(options = {}) {
  const limits = { ...ARENA_LIMITS, ...(options.limits || {}) };
  const random = typeof options.random === "function" ? options.random : Math.random;
  const context = {
    limits,
    random,
    history: options.history || new Map(),
    now: Number.isFinite(options.now) ? options.now : Date.now(),
    match: options.match === "any" ? "any" : "similar",
    alike: options.alike,
  };
  const partition = partitionPool(
    Array.isArray(options.pool) ? options.pool : [],
    options.judgements || { ratings: new Map(), rejects: new Set() },
    options.recent || new Set()
  );
  const requested = ROUND_KINDS.includes(options.kind) ? options.kind : "mixed";
  const border = Number.isInteger(options.border) ? options.border : null;

  const attempt = async (kind) => {
    // With fewer than two rated clips, Place has nothing to compare with: a
    // first round rates unrated clips against each other.
    const effective =
      kind === "place" && !ENOUGH.place(partition.all) && ENOUGH.first(partition.all) ? "first" : kind;
    const enough =
      effective === "border" && border && bordersWith(partition.all.tiers, 2).includes(border)
        ? (side) => bordersWith(side.tiers, 2).includes(border)
        : ENOUGH[effective];
    const side = chooseSide(partition, enough);
    if (!side) return null;
    const clips =
      effective === "place"
        ? await dealPlace(side, context)
        : effective === "first"
          ? await dealFirst(side, context)
          : effective === "tier"
            ? await dealTier(side, context)
            : await dealBorder(side, context, border);
    return clips.length ? { kind: effective, clips } : null;
  };

  if (requested !== "mixed") {
    return (await attempt(requested)) || { kind: null, reason: requested };
  }
  const order = [];
  if (partition.all.unrated.length) {
    if (random() < limits.placeShare) order.push("place");
    order.push(...(random() < 0.5 ? ["tier", "border"] : ["border", "tier"]), "place");
  } else {
    order.push(...(random() < 0.5 ? ["tier", "border"] : ["border", "tier"]));
  }
  for (const kind of order) {
    const round = await attempt(kind);
    if (round) return round;
  }
  return { kind: null, reason: "mixed" };
}

/**
 * How each clip of a finished round ended, from its rating when dealt and
 * now: rows for `arena_checks`. A reference clip in Place says nothing
 * unless its rating changed.
 */
function arenaOutcomes(round, judgements) {
  const rows = [];
  for (const clip of round.clips) {
    const before = clip.rating ?? null;
    const after = judgements.ratings.get(clip.fingerprint) ?? null;
    const rejected = judgements.rejects.has(clip.fingerprint);
    let outcome = null;
    if (rejected) outcome = "rejected";
    else if (clip.role === "new") outcome = after != null ? "placed" : "skipped";
    else if (after === before) outcome = clip.role === "check" ? "held" : null;
    else outcome = after != null && (before == null || after > before) ? "raised" : "lowered";
    if (!outcome) continue;
    rows.push({
      fingerprint: clip.fingerprint,
      kind: round.kind,
      outcome,
      ratingBefore: before,
      ratingAfter: after,
    });
  }
  return rows;
}

function summarizeOutcomes(rows) {
  const summary = { placed: 0, held: 0, raised: 0, lowered: 0, skipped: 0, rejected: 0 };
  for (const row of rows) summary[row.outcome] += 1;
  return summary;
}

// A dealt round still fits what it was dealt for: nothing rejected, *New*
// still unrated, every other clip still at the rating it was dealt with.
function roundStillFits(round, judgements, pool) {
  return round.clips.every((clip) => {
    if (!pool.has(clip.fingerprint) || judgements.rejects.has(clip.fingerprint)) return false;
    const rating = judgements.ratings.get(clip.fingerprint) ?? null;
    return clip.role === "new" ? rating == null : rating === clip.rating;
  });
}

// ----- Sessions ------------------------------------------------------------

/**
 * Sessions of the arena, one per opening: the pool fixed when it opened, the
 * history, recent rounds, and the next round prepared while the current one
 * is shown. Memory only; `store` writes the history.
 */
class RatingArenaService {
  constructor(options = {}) {
    this.limits = { ...ARENA_LIMITS, ...(options.limits || {}) };
    this.promptService = options.promptService || null;
    this.random = typeof options.random === "function" ? options.random : Math.random;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.sessions = new Map();
    this.epoch = 0;
  }

  start({ store, instanceIds = null, unavailableRootPaths = [], assertActive } = {}) {
    const pool = store.getArenaPool({
      instanceIds,
      unavailableRootPaths,
      limit: instanceIds ? this.limits.maxScopeClips : this.limits.maxPoolClips,
      assertActive,
    });
    const history = buildArenaHistory(store.listArenaChecks());
    const id = crypto.randomUUID();
    this.sessions.set(id, {
      id,
      epoch: this.epoch,
      pool,
      poolSet: new Map(pool.map((clip) => [clip.fingerprint, clip])),
      history,
      recent: [],
      rounds: new Map(),
      nextRoundId: 1,
      prepared: null,
    });
    while (this.sessions.size > this.limits.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    return { session: id, counts: countsOf(partitionPool(pool, store.getArenaJudgements(), new Set()).all) };
  }

  _session(id) {
    const session = this.sessions.get(id);
    if (!session || session.epoch !== this.epoch) {
      throw Object.assign(new Error("The arena was closed"), { code: "ARENA_SESSION_GONE" });
    }
    return session;
  }

  _recentSet(session) {
    return new Set(session.recent.flat());
  }

  _deal(session, store, options, judgements, recent, assertActive) {
    return dealArenaRound({
      pool: session.pool,
      judgements,
      history: session.history,
      recent,
      kind: options.kind,
      border: options.border,
      match: options.match,
      random: this.random,
      now: this.now(),
      limits: this.limits,
      alike: this.promptService
        ? (promptKey, candidateKeys) =>
            this.promptService.alikeScores({
              store,
              promptKey,
              candidateKeys,
              limit: this.limits.alikeSample,
              assertActive,
            })
        : null,
    });
  }

  /**
   * The next round for `options` (`{ kind, border, match }`): the one
   * prepared while the last was shown when it still fits, else a new deal.
   * Returns `{ round, counts, reason }`; `round` is null when the pool has
   * nothing for the kind asked.
   */
  async round({ store, session: sessionId, options = {}, assertActive } = {}) {
    const session = this._session(sessionId);
    const key = JSON.stringify([options.kind, options.border, options.match]);
    const judgements = store.getArenaJudgements();
    const standing = partitionPool(session.pool, judgements, new Set()).all;
    let dealt = null;
    const prepared = session.prepared;
    session.prepared = null;
    if (prepared?.key === key) {
      const round = await prepared.promise.catch(() => null);
      // A first round prepared before anything was rated gives way to Place
      // once the round shown has rated enough clips to compare with.
      const outgrown = round?.kind === "first" && ENOUGH.place(standing);
      if (round?.kind && !outgrown && roundStillFits(round, judgements, session.poolSet)) dealt = round;
    }
    if (!dealt) {
      dealt = await this._deal(session, store, options, judgements, this._recentSet(session), assertActive);
    }
    assertActive?.();
    this._session(sessionId);
    const counts = countsOf(standing);
    if (!dealt?.kind) return { round: null, counts, reason: dealt?.reason || "mixed" };

    const round = { id: session.nextRoundId, kind: dealt.kind, clips: dealt.clips, checkIds: [] };
    session.nextRoundId += 1;
    session.rounds.set(round.id, round);
    while (session.rounds.size > this.limits.recentRounds * 2) {
      session.rounds.delete(session.rounds.keys().next().value);
    }
    session.recent.push(round.clips.map((clip) => clip.fingerprint));
    while (session.recent.length > this.limits.recentRounds) session.recent.shift();

    // The next one, while this one is shown.
    const recent = this._recentSet(session);
    session.prepared = {
      key,
      promise: this._deal(session, store, options, judgements, recent, assertActive).catch(() => null),
    };
    return { round, counts };
  }

  /**
   * Records how round `roundId` ended, as ratings stand now. A round that
   * comes back after Undo and ends again replaces what it recorded before.
   * Returns the outcome counts.
   */
  finish({ store, session: sessionId, round: roundId } = {}) {
    const session = this._session(sessionId);
    const round = session.rounds.get(roundId);
    if (!round) throw Object.assign(new Error("That round is gone"), { code: "ARENA_ROUND_GONE" });
    const rows = arenaOutcomes(round, store.getArenaJudgements());
    const replaced = round.checkIds.length > 0;
    round.checkIds = store.recordArenaChecks(rows, {
      now: this.now(),
      replaceIds: round.checkIds,
      keep: this.limits.maxCheckRows,
    });
    if (replaced) session.history = buildArenaHistory(store.listArenaChecks());
    else for (const row of rows) applyArenaCheck(session.history, { ...row, checkedAt: this.now() });
    return summarizeOutcomes(rows);
  }

  end({ session } = {}) {
    return this.sessions.delete(session);
  }

  // Profile switches end every session.
  clear() {
    this.epoch += 1;
    this.sessions.clear();
  }
}

function createRatingArenaService(options) {
  return new RatingArenaService(options);
}

module.exports = {
  ARENA_LIMITS,
  ROUND_KINDS,
  RatingArenaService,
  applyArenaCheck,
  arenaOutcomes,
  buildArenaHistory,
  createRatingArenaService,
  dealArenaRound,
  holdScore,
  summarizeOutcomes,
};
