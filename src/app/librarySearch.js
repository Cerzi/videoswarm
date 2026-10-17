import { sanitizeExactRating, sanitizeMinRating } from "./filters/filtersUtils";

// What a library search asks main for (docs/architecture/library-tag-views.md):
// tags, a rating, or both. "4 stars or more" alone is a search; no tags and
// no rating is not, because it would read the whole library into the grid.

const searchRating = (value) => (Number.isInteger(value) && value >= 1 && value <= 5 ? value : null);

export function librarySearchCriteria(filters = {}) {
  const tags = (Array.isArray(filters.includeTags) ? filters.includeTags : [])
    .map((tag) => (tag ?? "").toString().trim())
    .filter(Boolean);
  const exactRating = searchRating(sanitizeExactRating(filters.exactRating));
  return {
    tags,
    matchMode: filters.includeTagsMode === "any" ? "any" : "all",
    // An exact rating wins over a minimum, as it does in the filters.
    minRating: exactRating === null ? searchRating(sanitizeMinRating(filters.minRating)) : null,
    exactRating,
  };
}

export const hasLibrarySearchCriteria = (criteria) =>
  Boolean(criteria) &&
  (criteria.tags?.length > 0 || criteria.minRating != null || criteria.exactRating != null);

export const librarySearchKey = (criteria) =>
  [
    criteria.matchMode,
    criteria.minRating ?? "",
    criteria.exactRating ?? "",
    ...criteria.tags,
  ].join("\u0000");
