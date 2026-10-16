// Prompt stacks in the renderer: every run of one prompt, collapsed into one
// card. Stacks are formed from the clips the grid would show (after filters
// and folder scope), so a stack only ever stands for clips the user can see.
// See docs/architecture/prompt-stacks.md, Sections 3 to 5.

const REVIEW_RANK = Object.freeze({ pick: 2, reject: 0 });

const pixelCount = (video) => {
  const width = Number(video?.dimensions?.width);
  const height = Number(video?.dimensions?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width * height
    : 0;
};

const timeOf = (video) => {
  const created = Number(video?.createdMs);
  if (Number.isFinite(created) && created > 0) return created;
  const modified = video?.dateModified;
  const value = modified instanceof Date ? modified.getTime() : Number(modified);
  if (Number.isFinite(value)) return value;
  const parsed = Date.parse(modified);
  return Number.isFinite(parsed) ? parsed : 0;
};

const ratingOf = (video) => {
  const rating = Number(video?.rating);
  return video?.rating != null && Number.isFinite(rating) ? rating : -1;
};

// The run a stack shows: a pick over an undecided run over a reject, then the
// highest rating, the highest resolution and the newest. Ties keep the first
// run in grid order, so the cover only moves when one of these changes.
export function chooseStackCover(members) {
  let best = null;
  let bestRank = null;
  for (const video of members || []) {
    const rank = [
      REVIEW_RANK[video?.reviewState] ?? 1,
      ratingOf(video),
      pixelCount(video),
      timeOf(video),
    ];
    if (!best || compareRanks(rank, bestRank) > 0) {
      best = video;
      bestRank = rank;
    }
  }
  return best;
}

function compareRanks(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/**
 * Groups `videos` (in grid order) by prompt key. Only groups of two or more
 * clips are stacks; a clip alone in its group, or without a key, is not.
 * `allVideos` is the whole collection, for the "5 of 20" total when filters
 * hide some runs.
 *
 * Returns `{ stacks: Map<key, { key, members, cover, total }>,
 * keyById: Map<videoId, key> }`.
 */
export function buildPromptStacks(videos, allVideos = videos) {
  const groups = new Map();
  for (const video of videos || []) {
    const key = video?.promptKey;
    if (!key || video.id == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(video);
  }
  const totals = new Map();
  for (const video of allVideos || []) {
    const key = video?.promptKey;
    if (key && groups.has(key)) totals.set(key, (totals.get(key) || 0) + 1);
  }

  const stacks = new Map();
  const keyById = new Map();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    stacks.set(key, {
      key,
      members,
      cover: chooseStackCover(members),
      total: Math.max(members.length, totals.get(key) || 0),
    });
    for (const member of members) keyById.set(member.id, key);
  }
  return { stacks, keyById };
}

const EMPTY_STACKS = Object.freeze({ stacks: new Map(), keyById: new Map() });
export const emptyPromptStacks = () => EMPTY_STACKS;

// The grid with each stack reduced to its cover, order otherwise unchanged.
export function collapsePromptStacks(videos, { stacks, keyById }) {
  if (!stacks || stacks.size === 0) return videos;
  return (videos || []).filter((video) => {
    const key = keyById.get(video?.id);
    return key === undefined || stacks.get(key)?.cover?.id === video.id;
  });
}

/**
 * Selection units for `useSelectionState`: every clip of a collapsed stack
 * selects together, and its cover stands for the stack in range selection.
 */
export function createStackSelectionUnits({ stacks, keyById }) {
  if (!stacks || stacks.size === 0) return null;
  const memberIds = new Map();
  for (const [key, stack] of stacks) {
    memberIds.set(
      key,
      stack.members.map((member) => member.id)
    );
  }
  return {
    unitOf: (id) => keyById.get(id) ?? null,
    membersOf: (key) => memberIds.get(key) || [],
    representativeOf: (key) => stacks.get(key)?.cover?.id ?? null,
  };
}

// The stack keys in the order their covers appear in the collapsed grid.
export function stackOrderOf(orderedVideos, { keyById }) {
  const order = [];
  for (const video of orderedVideos || []) {
    const key = keyById?.get(video?.id);
    if (key !== undefined) order.push(key);
  }
  return order;
}

// The neighbouring stack of `key` in `order`, skipping stacks that no longer
// exist; null at either end.
export function neighbouringStack(order, key, direction, stacks) {
  const index = (order || []).indexOf(key);
  if (index < 0) return null;
  const step = direction < 0 ? -1 : 1;
  for (let next = index + step; next >= 0 && next < order.length; next += step) {
    if (stacks?.has(order[next])) return order[next];
  }
  return null;
}

// Fingerprints of the runs in a stack still waiting for a decision.
export function unreviewedStackFingerprints(stack) {
  const fingerprints = new Set();
  for (const member of stack?.members || []) {
    const state = member?.reviewState || "unreviewed";
    if (state === "unreviewed" && member.fingerprint) fingerprints.add(member.fingerprint);
  }
  return [...fingerprints];
}
