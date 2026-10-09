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

// One shared collator: localeCompare with an options object builds a new
// collator on every call, which dominated name sorts of large folders.
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Digit runs, with an optional decimal part, so "0.64" is one segment.
const NUMBER_RUN = /(\d+(?:\.\d+)?)/;

const isDigitRun = (token) => {
  const code = token.charCodeAt(0);
  return code >= 48 && code <= 57;
};

// Compares two digit runs by exact decimal value. Converting to floats would
// make long runs, such as 64-bit generation seeds, compare as equal.
function compareDigitRuns(a, b) {
  const [intA, fracA = ""] = a.split(".");
  const [intB, fracB = ""] = b.split(".");
  const wholeA = intA.replace(/^0+(?=\d)/, "");
  const wholeB = intB.replace(/^0+(?=\d)/, "");
  if (wholeA.length !== wholeB.length) return wholeA.length - wholeB.length;
  if (wholeA !== wholeB) return wholeA < wholeB ? -1 : 1;
  const fractionA = fracA.replace(/0+$/, "");
  const fractionB = fracB.replace(/0+$/, "");
  if (fractionA === fractionB) return 0;
  return fractionA < fractionB ? -1 : 1;
}

// Natural order that reads numbers as decimals: "0.64" < "0.7" < "0.72", and
// "clip_1.10" < "clip_1.2" because 1.1 < 1.2. Names split into alternating
// text and digit runs that are compared pairwise.
function compareNamesNatural(nameA, nameB) {
  const tokensA = nameA ? nameA.split(NUMBER_RUN).filter(Boolean) : [];
  const tokensB = nameB ? nameB.split(NUMBER_RUN).filter(Boolean) : [];
  const shared = Math.min(tokensA.length, tokensB.length);
  for (let i = 0; i < shared; i++) {
    const tA = tokensA[i];
    const tB = tokensB[i];
    // A text segment never contains digits, so a digit run on only one side
    // means one name starts with a number where the other has text.
    const cmp = isDigitRun(tA) && isDigitRun(tB)
      ? compareDigitRuns(tA, tB)
      : nameCollator.compare(tA, tB);
    if (cmp !== 0) return cmp;
  }
  return tokensA.length - tokensB.length;
}

const compareNameAsc = (a, b) =>
  compareNamesNatural(a.basename || a.name || "", b.basename || b.name || "");

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
  // default NAME
  return (a, b) => compareNamesNatural(a.basename, b.basename) * dir;
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
