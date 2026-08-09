import { useMemo } from "react";
import { REVIEW_FILTERS, normalizeReviewFilter } from "../../review/reviewState";

export const createDefaultFilters = () => ({
  includeTags: [],
  excludeTags: [],
  minRating: null,
  exactRating: null,
  reviewFilter: REVIEW_FILTERS.ANY,
  minMegapixels: null,
  maxMegapixels: null,
});

// Thresholds rather than a free number: the useful question is "which of these
// came out at draft settings", and a short list of round values answers it
// without turning a filter into a form.
export const MEGAPIXEL_STEPS = Object.freeze([0.25, 0.5, 1, 1.5, 2, 4, 8]);
const MAX_MEGAPIXELS = 1_000;

export const sanitizeMegapixels = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.min(MAX_MEGAPIXELS, Math.round(num * 100) / 100);
};

/**
 * Pixel count in megapixels, or null when the clip has never been measured.
 * A clip of unknown size cannot satisfy a resolution filter, so callers treat
 * null as "does not match" rather than guessing.
 */
export const videoMegapixels = (video) => {
  const width = Number(video?.dimensions?.width ?? video?.width);
  const height = Number(video?.dimensions?.height ?? video?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return (width * height) / 1_000_000;
};

export const formatMegapixels = (value) => {
  const safe = sanitizeMegapixels(value);
  if (safe === null) return null;
  return Number.isInteger(safe) ? `${safe} MP` : `${safe} MP`;
};

export const formatMegapixelLabel = (value, mode) => {
  const formatted = formatMegapixels(value);
  if (!formatted) return null;
  return mode === "min" ? `≥ ${formatted}` : `≤ ${formatted}`;
};

export const normalizeTagList = (tags) =>
  Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => (tag ?? "").toString().trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));

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
    const ratingCount =
      filters.exactRating !== null && filters.exactRating !== undefined
        ? 1
        : filters.minRating !== null && filters.minRating !== undefined
        ? 1
        : 0;
    const reviewCount =
      normalizeReviewFilter(filters.reviewFilter) === REVIEW_FILTERS.ANY ? 0 : 1;
    const resolutionCount =
      (sanitizeMegapixels(filters.minMegapixels) !== null ? 1 : 0) +
      (sanitizeMegapixels(filters.maxMegapixels) !== null ? 1 : 0);
    return (
      includeCount + excludeCount + ratingCount + reviewCount + resolutionCount
    );
  }, [filters]);
