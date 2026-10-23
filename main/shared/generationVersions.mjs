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

export const distinctGenerationKeys = (videos) => {
  const keys = new Set();
  for (const video of videos || []) {
    if (video?.generationKey) keys.add(video.generationKey);
  }
  return [...keys].sort();
};

/**
 * Returns `Map<videoId, { generationKey, versionCount, superseded }>` for
 * every keyed clip. A version is a content: instances sharing a fingerprint
 * count once. `summaries` maps a key to the library-wide
 * `{ versionCount, maxPixels }`; either side may know more than the other
 * while indexing is in progress, so the larger answer wins.
 */
export function buildGenerationVersionIndex(videos, summaries = {}) {
  const groups = new Map();
  for (const video of videos || []) {
    const key = video?.generationKey;
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { contents: new Set(), maxPixels: 0, minPixels: 0 };
      groups.set(key, group);
    }
    group.contents.add(video.fingerprint || video.id);
    const pixels = videoPixelCount(video);
    group.maxPixels = Math.max(group.maxPixels, pixels);
    if (pixels > 0) group.minPixels = group.minPixels ? Math.min(group.minPixels, pixels) : pixels;
  }

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
    index.set(video.id, {
      generationKey: key,
      versionCount,
      superseded: maxPixels > pixels,
      // A smaller version exists: this is a re-render or upscale of it.
      supersedes: pixels > 0 && minPixels < pixels,
    });
  }
  return index;
}

// "Best version" is the exact inverse of "has a higher-resolution version",
// so the two partition any collection. A clip without a key, or whose key is
// still pending, is its own only version and counts as best.
export function matchesVersionFilter(entry, filter) {
  const normalized = normalizeVersionFilter(filter);
  if (normalized === VERSION_FILTERS.ANY) return true;
  if (normalized === VERSION_FILTERS.SUPERSEDES) return entry?.supersedes === true;
  const superseded = entry?.superseded === true;
  return normalized === VERSION_FILTERS.SUPERSEDED ? superseded : !superseded;
}
