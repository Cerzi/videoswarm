// Prompt stacks in the renderer: a run of neighbouring clips of one prompt, or
// of alike prompts, collapsed into one card. A stack only ever stands for
// clips the user can see. See docs/architecture/prompt-stacks.md, Sections 3
// to 5 and 7.

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

const exactMatch = (a, b) => a === b;

/**
 * Stacks are runs of neighbours: walking `ordered` (the folder scope, in the
 * grid's sort order, before filters), a clip joins the run before it when its
 * prompt is the previous clip's prompt or alike to it (`alike(a, b)`), and
 * when `folderOf` puts it in the same folder group. Each neighbour is judged
 * against the one before it, so a batch whose prompt changed a little at a
 * time stays one stack. A clip without a prompt key ends a run. Clips far
 * apart in the sort never stack: that would be grouping, not stacking.
 *
 * `visible` (a Set of ids, or null for all) is what passes the filters. A run
 * with two or more visible clips is a stack of those clips; its total is the
 * whole run, for the "5 of 20" when filters hide some. Runs are formed before
 * filtering, so filters never regroup stacks.
 *
 * Returns `{ stacks: Map<key, { key, members, cover, total, similar }>,
 * keyById: Map<videoId, key> }`, where `similar` says the members' prompts
 * differ.
 */
export function buildPromptStacks(
  ordered,
  { visible = null, alike = exactMatch, folderOf = null } = {}
) {
  const stacks = new Map();
  const keyById = new Map();
  let run = [];

  const close = () => {
    if (run.length >= 2) {
      const members = visible ? run.filter((video) => visible.has(video.id)) : run;
      if (members.length >= 2) {
        const key = `${run[0].promptKey}\u0000${run[0].id}`;
        stacks.set(key, {
          key,
          members,
          cover: chooseStackCover(members),
          total: run.length,
          similar: members.some((member) => member.promptKey !== members[0].promptKey),
        });
        for (const member of members) keyById.set(member.id, key);
      }
    }
    run = [];
  };

  for (const video of ordered || []) {
    const promptKey = video?.promptKey;
    if (!promptKey || video.id == null) {
      close();
      continue;
    }
    if (run.length) {
      const previous = run[run.length - 1];
      const sameFolder = !folderOf || folderOf(previous) === folderOf(video);
      if (
        sameFolder &&
        (promptKey === previous.promptKey || alike(previous.promptKey, promptKey))
      ) {
        run.push(video);
        continue;
      }
      close();
    }
    run.push(video);
  }
  close();
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
