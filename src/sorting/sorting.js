export const SortKey = {
  NAME: "name",
  CREATED: "created",
  RANDOM: "random",
};

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
  if (sortKey === SortKey.RANDOM) {
    return (a, b) => {
      const ra = randomOrderMap?.[a.id] ?? 0;
      const rb = randomOrderMap?.[b.id] ?? 0;
      return (ra - rb) * dir;
    };
  }
  // default NAME
  return (a, b) =>
    a.basename.localeCompare(b.basename, undefined, {
      numeric: true,
      sensitivity: "base",
    }) * dir;
}

export function groupAndSort(items, { groupByFolders, comparator }) {
  if (!groupByFolders) {
    return [...items].sort(comparator);
  }
  const groups = new Map();
  items.forEach((item) => {
    const key = item.dirname || "";
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
