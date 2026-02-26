import { useMemo } from "react";

export const createDefaultFilters = () => ({
  includeTags: [],
  excludeTags: [],
  scope: "ALL",
  sourceIds: [],
  searchQuery: "",
  minRating: null,
  exactRating: null,
});

export const normalizeTagList = (tags) =>
  Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => (tag ?? "").toString().trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

export const normalizeSourceIds = (sourceIds) =>
  Array.from(
    new Set(
      (Array.isArray(sourceIds) ? sourceIds : [])
        .map((sourceId) => (sourceId ?? "").toString().trim())
        .filter(Boolean)
    )
  );

const clampRatingValue = (value, min, max) => {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.round(num);
  if (Number.isNaN(rounded)) return null;
  return Math.min(max, Math.max(min, rounded));
};

export const sanitizeMinRating = (value) => clampRatingValue(value, 1, 5);
export const sanitizeExactRating = (value) => clampRatingValue(value, 0, 5);

export const formatStars = (value) => {
  const safe = clampRatingValue(value, 0, 5);
  const filled = Math.max(0, safe ?? 0);
  const empty = Math.max(0, 5 - filled);
  return `${"★".repeat(filled)}${"☆".repeat(empty)}`;
};

export const formatRatingLabel = (value, mode) => {
  if (value === null || value === undefined) return null;
  const stars = formatStars(value);
  return mode === "min" ? `≥ ${stars}` : `= ${stars}`;
};

export const useFiltersActiveCount = (filters) =>
  useMemo(() => {
    const includeCount = filters.includeTags?.length ?? 0;
    const excludeCount = filters.excludeTags?.length ?? 0;
    const scopeCount = filters.scope && filters.scope !== "ALL" ? 1 : 0;
    const sourceCount = filters.sourceIds?.length ?? 0;
    const searchCount = filters.searchQuery?.trim() ? 1 : 0;
    const ratingCount =
      filters.exactRating !== null && filters.exactRating !== undefined
        ? 1
        : filters.minRating !== null && filters.minRating !== undefined
        ? 1
        : 0;
    return includeCount + excludeCount + scopeCount + sourceCount + searchCount + ratingCount;
  }, [filters]);
