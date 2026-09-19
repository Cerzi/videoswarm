export const SortKey = {
  NAME: "name",
  CREATED: "created",
  RESOLUTION: "resolution",
  RATING: "rating",
  RANDOM: "random",
};

// Unmeasured clips sort as zero so they gather at one end rather than
// interleaving unpredictably with real values.
const pixelCount = (video) => {
  const width = Number(video?.dimensions?.width ?? video?.width);
  const height = Number(video?.dimensions?.height ?? video?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
  if (width <= 0 || height <= 0) return 0;
  return width * height;
};

const compareNameAsc = (a, b) =>
  (a.basename || a.name || "").localeCompare(b.basename || b.name || "", undefined, {
    numeric: true,
    sensitivity: "base",
  });

const compareCreatedDesc = (a, b) =>
  (b.createdMs || 0) - (a.createdMs || 0);

export function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h >>> 0;
}

export function buildRandomOrderMap(paths, seed) {
  const prng = mulberry32(seed >>> 0);
  const map = {};
  paths.forEach((p) => {
    map[p] = prng();
  });
  return map;
}

export function buildComparator({ sortKey, sortDir, randomOrderMap }) {
  const dir = sortDir === "desc" ? -1 : 1;
  if (sortKey === SortKey.CREATED) {
    return (a, b) => ((a.createdMs || 0) - (b.createdMs || 0)) * dir;
  }
  if (sortKey === SortKey.RESOLUTION) {
    return (a, b) => {
      const delta = pixelCount(a) - pixelCount(b);
      if (delta !== 0) return delta * dir;
      // Equal-resolution clips keep a stable, meaningful order.
      return (a.name || "").localeCompare(b.name || "") * dir;
    };
  }
  if (sortKey === SortKey.RATING) {
    return (a, b) => {
      const ra = Number(a.rating ?? -1);
      const rb = Number(b.rating ?? -1);
      const ratingDelta = (ra - rb) * dir;
      if (ratingDelta !== 0) return ratingDelta;
      const createdDelta = compareCreatedDesc(a, b);
      if (createdDelta !== 0) return createdDelta;
      return compareNameAsc(a, b);
    };
  }
  if (sortKey === SortKey.RANDOM) {
    return (a, b) => {
      const ra = randomOrderMap?.[a.id] ?? 0;
      const rb = randomOrderMap?.[b.id] ?? 0;
      return (ra - rb) * dir;
    };
  }
  // default NAME — true multi-key alphanumeric sort.
  // Splits each name into alternating text/number segments and compares them
  // pairwise, so "clip_1.2_pass3" < "clip_1.10_pass1" (segment 2: 2 < 10).
  return (a, b) => {
    const tokensA = tokenize(a.basename);
    const tokensB = tokenize(b.basename);
    const len = Math.max(tokensA.length, tokensB.length);
    for (let i = 0; i < len; i++) {
      const tA = tokensA[i];
      const tB = tokensB[i];
      // One string exhausted → shorter name sorts first.
      if (tA === undefined) return -dir;
      if (tB === undefined) return dir;
      // Both numbers → compare as floats.
      if (typeof tA === "number" && typeof tB === "number") {
        const diff = tA - tB;
        if (diff !== 0) return diff * dir;
      } else {
        // Both text or mixed → use localeCompare+numeric. Mixed values can
        // happen when one filename starts with digits and the other starts with
        // text, so coerce before using the string API.
        const cmp = String(tA).localeCompare(String(tB), undefined, {
          numeric: true,
          sensitivity: "base",
        });
        if (cmp !== 0) return cmp * dir;
      }
    }
    return 0;
  };
}

export function tokenize(str) {
  // Split into alternating text/number segments for multi-key comparison.
  // ["clip", 1.2, "_pass", 3] → compare pairwise: text vs text, number vs number.
  if (!str) return [];
  const tokens = [];
  const parts = str.split(/(\d+(?:\.\d+)?)/);
  for (const part of parts) {
    if (part === "") continue;
    // Try parsing as a number (int or float).
    const num = Number(part);
    tokens.push(Number.isFinite(num) && part !== "" ? num : part);
  }
  return tokens;
}

// A folder view has one root, so a relative dirname identifies a folder on its
// own. A library-wide tag view spans roots, where two roots can each hold a
// "2026-08-09" folder that is not the same folder, so the owning root joins the
// key. Records from a single root carry no rootPath and keep their old
// grouping exactly. NUL joins the parts because it is the one byte a path
// cannot contain, so no pair can spell another pair's key.
function folderGroupKey(item) {
  return `${item?.rootPath || ""}\u0000${item?.dirname || ""}`;
}

export function groupAndSort(items, { groupByFolders, comparator }) {
  if (!groupByFolders) {
    return [...items].sort(comparator);
  }
  const groups = new Map();
  items.forEach((item) => {
    const key = folderGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const sortedGroupKeys = Array.from(groups.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
  const result = [];
  sortedGroupKeys.forEach((key) => {
    const groupItems = groups.get(key).sort(comparator);
    result.push(...groupItems);
  });
  return result;
}
