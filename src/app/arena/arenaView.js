// The rating arena's view (docs/architecture/rating-arena.md, Sections 3 and
// 4): what each card's pill says, when a round is done by itself, and the
// arena's own keys. Pure, for tests.

import { ARENA_TAG_KEYS, ARENA_TYPE_TAG_KEYS } from "../../hotkeys/shortcutCatalog";

export const ARENA_KINDS = Object.freeze([
  { value: "mixed", label: "Mixed" },
  { value: "place", label: "Place" },
  { value: "tier", label: "Tier check" },
  { value: "border", label: "Border" },
]);

export const ARENA_KIND_LABELS = Object.freeze({
  place: "Place",
  first: "First ratings",
  tier: "Tier check",
  border: "Border",
});

// What each kind asks, under the bar.
export const ARENA_QUESTIONS = Object.freeze({
  place: "Where does New go? Rate it 1–5.",
  first: "Nothing rated to compare with yet: rate these 1–5.",
  tier: "Same rating: change any that don't belong, then Enter.",
  border: "Two neighbouring ratings: move any on the wrong side, then Enter.",
});

const stars = (rating) => `${rating}★`;

/** A card's pill: *New*, its rating, or *4★ → 5★* once changed here. */
export function arenaCardLabel(part, video) {
  if (!part) return null;
  const now = Number.isInteger(video?.rating) && video.rating > 0 ? video.rating : null;
  if (part.role === "new") return now ? `New → ${stars(now)}` : "New";
  const dealt = Number.isInteger(part.rating) ? part.rating : null;
  if (dealt == null) return now ? stars(now) : null;
  if (now === dealt) return stars(dealt);
  return `${stars(dealt)} → ${now ? stars(now) : "unrated"}`;
}

const decided = (video) =>
  video?.reviewState === "reject" || (Number.isInteger(video?.rating) && video.rating > 0);

/**
 * A Place round is done once New is rated or rejected; a first round once
 * every clip is. Tier checks and borders end with Enter.
 */
export function arenaRoundDone(round, videoForPart) {
  if (!round || (round.kind !== "place" && round.kind !== "first")) return false;
  const news = round.clips.filter((part) => part.role === "new");
  return news.length > 0 && news.every((part) => decided(videoForPart(part)));
}

/** Whether any clip of the round has a rating other than it was dealt with. */
export function arenaRoundChanged(round, videoForPart) {
  if (!round) return false;
  return round.clips.some((part) => {
    const video = videoForPart(part);
    const now = Number.isInteger(video?.rating) && video.rating > 0 ? video.rating : null;
    return now !== (part.rating ?? null) || video?.reviewState === "reject";
  });
}

/** The id to select after ← or → from `currentId` among `ids`. */
export function stepArenaSelection(ids, currentId, direction) {
  if (!ids.length) return null;
  const index = ids.indexOf(currentId);
  if (index < 0) return ids[0];
  return ids[(index + direction + ids.length) % ids.length];
}

// The arena's own keys; ratings, review states and Z are the grid's.
export { ARENA_TAG_KEYS };

/**
 * What a key does in the arena, or null to leave it to the grid:
 * `next`, `previous-clip`, `next-clip`, `close`, `type-tag`,
 * `{ tag: index }`, or `swallow` for keys that do something else in the
 * grid (Enter opens a clip, Backspace and Delete trash it).
 */
export function arenaKeyCommand(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = String(event.key || "");
  if (key === "Escape") return "close";
  if (key === "Enter") return event.repeat ? "swallow" : "next";
  if (key === "ArrowLeft") return "previous-clip";
  if (key === "ArrowRight") return "next-clip";
  if (key === "Backspace" || key === "Delete") return "swallow";
  if (event.shiftKey || event.repeat) return null;
  const lower = key.toLowerCase();
  if (ARENA_TYPE_TAG_KEYS.includes(lower)) return "type-tag";
  const tag = ARENA_TAG_KEYS.indexOf(lower);
  return tag >= 0 ? { tag } : null;
}

/** Keys typed into a field or an exempt area are never the arena's. */
export function isTypingTarget(target) {
  if (!target) return false;
  const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  return (
    Boolean(target.isContentEditable) ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    Boolean(target.closest?.("[data-hotkey-exempt]"))
  );
}

/** Place shows New first and its references low to high; others by rating. */
export function orderArenaParts(clips) {
  return (Array.isArray(clips) ? clips : [])
    .map((part, index) => ({ part, index }))
    .sort((a, b) => {
      const newA = a.part.role === "new" ? 0 : 1;
      const newB = b.part.role === "new" ? 0 : 1;
      if (newA !== newB) return newA - newB;
      const ratingA = a.part.rating ?? 0;
      const ratingB = b.part.rating ?? 0;
      return ratingA - ratingB || a.index - b.index;
    })
    .map(({ part }) => part);
}

/**
 * The round's cards in order. A clip the open collection holds is the
 * collection's own (so changes show in the grid behind); any other is the
 * record main sent, a guest. `parts` maps each card's id to its part.
 */
export function buildArenaClips(round, records, videos = []) {
  const members = [];
  const guests = [];
  const parts = new Map();
  if (!round) return { members, guests, parts };
  const byFingerprint = new Map();
  for (const video of videos) {
    if (video?.fingerprint && !byFingerprint.has(video.fingerprint)) {
      byFingerprint.set(video.fingerprint, video);
    }
  }
  const byInstance = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.instanceId != null) byInstance.set(Number(record.instanceId), record);
  }
  for (const part of orderArenaParts(round.clips)) {
    const record = byInstance.get(Number(part.instanceId));
    if (!record) continue;
    const own = record.fingerprint ? byFingerprint.get(record.fingerprint) : null;
    const member = own || record;
    if (parts.has(member.id)) continue;
    parts.set(member.id, part);
    members.push(member);
    if (!own) guests.push(record);
  }
  return { members, guests, parts };
}

export const emptyArenaStats = () => ({
  rounds: 0,
  placed: 0,
  moved: 0,
  held: 0,
  skipped: 0,
  rejected: 0,
});

/** Adds one finished round's outcomes (from main) to the session's counts. */
export function addArenaOutcomes(stats, outcomes = {}) {
  return {
    rounds: stats.rounds + 1,
    placed: stats.placed + (outcomes.placed || 0),
    moved: stats.moved + (outcomes.raised || 0) + (outcomes.lowered || 0),
    held: stats.held + (outcomes.held || 0),
    skipped: stats.skipped + (outcomes.skipped || 0),
    rejected: stats.rejected + (outcomes.rejected || 0),
  };
}

/** Rounds finished in a row, latest last, without skipping New. */
export function arenaStreak(finished) {
  let streak = 0;
  for (let index = (finished?.length || 0) - 1; index >= 0; index -= 1) {
    if (finished[index]?.outcomes?.skipped) break;
    streak += 1;
  }
  return streak;
}

/** The toast on leaving: what the session did, or null if nothing. */
export function arenaSummary(stats, tagged = 0) {
  if (!stats || (stats.rounds === 0 && !tagged)) return null;
  const parts = [];
  if (stats.placed) parts.push(`${stats.placed} placed`);
  if (stats.moved) parts.push(`${stats.moved} moved`);
  if (stats.held) parts.push(`${stats.held} held`);
  if (stats.rejected) parts.push(`${stats.rejected} rejected`);
  if (tagged) parts.push(`${tagged} tagged`);
  const rounds = `${stats.rounds} round${stats.rounds === 1 ? "" : "s"}`;
  return parts.length ? `Arena: ${rounds} · ${parts.join(" · ")}` : `Arena: ${rounds}`;
}
