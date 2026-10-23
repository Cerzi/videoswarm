// Generation versions in the renderer: which clips are versions of the same
// generation, and whether a higher-resolution version exists. Groups are
// library-wide; the collection supplies an immediate local answer and the
// main process a bounded library summary. See
// docs/architecture/generation-versions.md, Sections 5 and 6.

export const VERSION_FILTERS = Object.freeze({
  ANY: "any",
  SUPERSEDED: "superseded",
  BEST: "best",
  // A re-render or upscale of a smaller version, whatever made it.
  SUPERSEDES: "supersedes",
});

const VERSION_FILTER_VALUES = new Set(Object.values(VERSION_FILTERS));

export const normalizeVersionFilter = (value) =>
  VERSION_FILTER_VALUES.has(value) ? value : VERSION_FILTERS.ANY;

export const VERSION_FILTER_LABELS = Object.freeze({
  [VERSION_FILTERS.ANY]: "Any",
  [VERSION_FILTERS.SUPERSEDED]: "Has a higher-resolution version",
  [VERSION_FILTERS.BEST]: "Best version",
  [VERSION_FILTERS.SUPERSEDES]: "Has a lower-resolution version",
});

export const videoPixelCount = (video) => {
  const width = Number(video?.dimensions?.width);
  const height = Number(video?.dimensions?.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width * height
    : 0;
};

// Which version is best (decided with the user on 2026-10-23): ratings
// overrule size. Among the versions rated highest, and those not rated at
// all, the largest wins (then the longest, then the newest). A version rated
// below another is never best, however large; an unrated one competes on
// size, so a new upscale of a rated draft is best until rated itself.

/** A rating of 1–5, or null. */
export const versionRating = (version) => {
  const rating = Number(version?.rating);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
};

/** The highest rating among versions, or null when none is rated. */
export const topVersionRating = (versions, ratingOf = versionRating) => {
  let top = null;
  for (const version of versions || []) {
    const rating = ratingOf(version);
    if (rating !== null && (top === null || rating > top)) top = rating;
  }
  return top;
};

/** Whether a version can be best: unrated, or rated as high as any. */
export const isBestCandidate = (rating, topRating) =>
  rating === null || topRating === null || rating === topRating;

/**
 * Sorts versions best first. `facts(version)` returns `{ rating, pixels,
 * durationMs, mtimeMs, key }`. Candidates (see above) come first by size;
 * the rest by rating, then size.
 */
export function orderVersions(versions, facts) {
  const list = (versions || []).map((version) => ({ version, f: facts(version) }));
  const top = topVersionRating(list, (entry) => entry.f.rating ?? null);
  const bySize = (a, b) =>
    (b.f.pixels || 0) - (a.f.pixels || 0) ||
    (b.f.durationMs || 0) - (a.f.durationMs || 0) ||
    (b.f.mtimeMs || 0) - (a.f.mtimeMs || 0) ||
    (String(a.f.key) < String(b.f.key) ? -1 : String(a.f.key) > String(b.f.key) ? 1 : 0);
  list.sort((a, b) => {
    const aCandidate = isBestCandidate(a.f.rating ?? null, top);
    const bCandidate = isBestCandidate(b.f.rating ?? null, top);
    if (aCandidate !== bCandidate) return aCandidate ? -1 : 1;
    if (!aCandidate && a.f.rating !== b.f.rating) return (b.f.rating || 0) - (a.f.rating || 0);
    return bySize(a, b);
  });
  return list.map((entry) => entry.version);
}

export const distinctGenerationKeys = (videos) => {
  const keys = new Set();
  for (const video of videos || []) {
    if (video?.generationKey) keys.add(video.generationKey);
  }
  return [...keys].sort();
};

/**
 * Returns `Map<videoId, { generationKey, versionCount, superseded,
 * supersedes, best }>` for every keyed clip. A version is a content:
 * instances sharing a fingerprint count once. `summaries` maps a key to the
 * library-wide `{ versionCount, maxPixels, minPixels, maxRating, bestPixels,
 * unratedMaxPixels }`; either side may know more than the other while
 * indexing is in progress, so the larger answer wins. `best` follows the
 * rule above; `superseded` stays "a higher-resolution version exists".
 */
export function buildGenerationVersionIndex(videos, summaries = {}) {
  const groups = new Map();
  for (const video of videos || []) {
    const key = video?.generationKey;
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { contents: new Set(), maxPixels: 0, minPixels: 0, versions: new Map() };
      groups.set(key, group);
    }
    const content = video.fingerprint || video.id;
    group.contents.add(content);
    const pixels = videoPixelCount(video);
    group.maxPixels = Math.max(group.maxPixels, pixels);
    if (pixels > 0) group.minPixels = group.minPixels ? Math.min(group.minPixels, pixels) : pixels;
    group.versions.set(content, { rating: versionRating(video), pixels });
  }

  // Per group: the top rating, and the largest candidate's size, from the
  // collection and the library summary together.
  const bestOf = new Map();
  const bestFor = (key, group) => {
    if (bestOf.has(key)) return bestOf.get(key);
    const summary = summaries?.[key];
    const local = [...group.versions.values()];
    const localTop = topVersionRating(local, (version) => version.rating);
    const summaryTop = versionRating({ rating: summary?.maxRating });
    const top =
      localTop === null ? summaryTop : summaryTop === null ? localTop : Math.max(localTop, summaryTop);
    let bestPixels = 0;
    for (const version of local) {
      if (isBestCandidate(version.rating, top)) bestPixels = Math.max(bestPixels, version.pixels);
    }
    if (summary) {
      // A summary without the rating fields (older callers) is all unrated.
      const fromSummary =
        summaryTop === top
          ? summary.bestPixels ?? summary.maxPixels
          : summary.unratedMaxPixels;
      bestPixels = Math.max(bestPixels, Number(fromSummary) || 0);
    }
    const answer = { top, bestPixels };
    bestOf.set(key, answer);
    return answer;
  };

  const index = new Map();
  for (const video of videos || []) {
    const key = video?.generationKey;
    if (!key) continue;
    const group = groups.get(key);
    const summary = summaries?.[key];
    const versionCount = Math.max(group.contents.size, Number(summary?.versionCount) || 0);
    const maxPixels = Math.max(group.maxPixels, Number(summary?.maxPixels) || 0);
    const minPixels = [group.minPixels, Number(summary?.minPixels) || 0]
      .filter((value) => value > 0)
      .reduce((smallest, value) => Math.min(smallest, value), Infinity);
    const pixels = videoPixelCount(video);
    const { top, bestPixels } = bestFor(key, group);
    index.set(video.id, {
      generationKey: key,
      versionCount,
      superseded: maxPixels > pixels,
      // A smaller version exists: this is a re-render or upscale of it.
      supersedes: pixels > 0 && minPixels < pixels,
      best: isBestCandidate(versionRating(video), top) && pixels >= bestPixels,
    });
  }
  return index;
}

// "Best version" follows the rule above, so a smaller version rated higher
// can be best while it "has a higher-resolution version". A clip without a
// key, or whose key is still pending, is its own only version and counts as
// best.
export function matchesVersionFilter(entry, filter) {
  const normalized = normalizeVersionFilter(filter);
  if (normalized === VERSION_FILTERS.ANY) return true;
  if (normalized === VERSION_FILTERS.SUPERSEDES) return entry?.supersedes === true;
  if (normalized === VERSION_FILTERS.SUPERSEDED) return entry?.superseded === true;
  if (!entry) return true;
  return entry.best !== undefined ? entry.best === true : entry.superseded !== true;
}
