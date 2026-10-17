import { chooseStackCover } from "./promptStacks";

// Which clips a stack card shows (docs/architecture/prompt-stacks.md,
// Section 8): a header that plays, and a strip of a few stills.
//
// - Once anything in the stack is picked or rated, the header is the best of
//   it, as a culling tool should show. Otherwise it is the most typical clip:
//   the one whose first frame differs least from all the others.
// - The strip shows how much the stack varies: each still is the clip whose
//   first frame differs most from those already shown.
//
// Frames are compared by 64-bit fingerprints (prompt-stacks.md, Section 8).
// Until a stack's fingerprints arrive, the header follows the review rule and
// the strip is spread evenly across the run.

export const STACK_STRIP_SIZE = 3;
const MAX_COMPARED = 64;

function popcount32(value) {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Bits that differ between two 16-hex-digit fingerprints. */
export function frameDistance(a, b) {
  const high = (parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0;
  const low = (parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0;
  return popcount32(high) + popcount32(low);
}

const isReviewed = (video) =>
  video?.reviewState === "pick" ||
  (video?.rating != null && Number.isFinite(Number(video.rating)));

function evenly(items, count) {
  if (items.length <= count) return items.slice();
  return Array.from({ length: count }, (_, at) =>
    items[Math.min(items.length - 1, Math.floor(((at + 0.5) * items.length) / count))]
  );
}

/**
 * `{ cover, strip }` for a stack's members (in run order). `hashOf(video)`
 * returns a clip's frame fingerprint, or nothing yet.
 */
export function chooseStackFaces(members, hashOf = () => null, { stripSize = STACK_STRIP_SIZE } = {}) {
  const list = Array.isArray(members) ? members : [];
  const hashed = list
    .filter((video) => video?.reviewState !== "reject")
    .map((video) => ({ video, hash: hashOf(video) }))
    .filter((entry) => typeof entry.hash === "string" && entry.hash.length === 16);

  let cover = chooseStackCover(list);
  if (!list.some(isReviewed) && hashed.length >= 3) {
    const compared = evenly(hashed, MAX_COMPARED);
    let best = null;
    for (const entry of compared) {
      let total = 0;
      for (const other of compared) total += frameDistance(entry.hash, other.hash);
      if (!best || total < best.total) best = { video: entry.video, total };
    }
    cover = best.video;
  }

  const rest = list.filter((video) => video !== cover);
  const coverHash = hashOf(cover);
  const restHashed = hashed.filter((entry) => entry.video !== cover);
  let strip;
  if (typeof coverHash === "string" && restHashed.length >= Math.min(stripSize, rest.length)) {
    const chosen = [coverHash];
    const picked = new Set();
    while (picked.size < Math.min(stripSize, restHashed.length)) {
      let best = null;
      for (const entry of restHashed) {
        if (picked.has(entry.video)) continue;
        const nearest = Math.min(...chosen.map((hash) => frameDistance(hash, entry.hash)));
        if (!best || nearest > best.nearest) best = { entry, nearest };
      }
      picked.add(best.entry.video);
      chosen.push(best.entry.hash);
    }
    strip = rest.filter((video) => picked.has(video));
  } else {
    strip = evenly(rest, stripSize);
  }
  return { cover, strip };
}

/**
 * Built stacks (promptStacks.js) with each card's cover and strip chosen by
 * `chooseStackFaces`. Membership is unchanged, so `keyById` is shared.
 */
export function applyStackFaces(built, hashOf, options) {
  if (!built?.stacks || built.stacks.size === 0) return built;
  const stacks = new Map();
  for (const [key, stack] of built.stacks) {
    const { cover, strip } = chooseStackFaces(stack.members, hashOf, options);
    stacks.set(key, { ...stack, cover, strip });
  }
  return { stacks, keyById: built.keyById };
}
