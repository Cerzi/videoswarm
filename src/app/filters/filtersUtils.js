import { useMemo } from "react";
import { REVIEW_FILTERS, normalizeReviewFilter } from "../../review/reviewState";
import { VERSION_FILTERS, normalizeVersionFilter } from "./generationVersions";
import { companionFilterCount } from "../companion/companionFilters";
import {
  createDefaultFilters,
  sanitizeFrameRate,
  videoFrameRate,
  matchesFrameRate,
  sanitizeSteps,
  normalizeWorkflowWords,
  parseWorkflowWords,
  workflowFilterQuery,
  normalizePromptQuery,
  normalizeMightBe,
  normalizeIncludeTagsMode,
  MEGAPIXEL_STEPS,
  sanitizeMegapixels,
  videoMegapixels,
  normalizeTagList,
  clampRatingValue,
  sanitizeMinRating,
  sanitizeExactRating,
} from "../../../main/shared/filterValues.mjs";

export {
  createDefaultFilters,
  sanitizeFrameRate,
  videoFrameRate,
  matchesFrameRate,
  sanitizeSteps,
  normalizeWorkflowWords,
  parseWorkflowWords,
  workflowFilterQuery,
  normalizePromptQuery,
  normalizeMightBe,
  normalizeIncludeTagsMode,
  MEGAPIXEL_STEPS,
  sanitizeMegapixels,
  videoMegapixels,
  normalizeTagList,
  clampRatingValue,
  sanitizeMinRating,
  sanitizeExactRating,
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
    const versionCount =
      normalizeVersionFilter(filters.versionFilter) === VERSION_FILTERS.ANY ? 0 : 1;
    return (
      includeCount +
      excludeCount +
      ratingCount +
      reviewCount +
      resolutionCount +
      versionCount +
      companionFilterCount(filters) +
      (normalizePromptQuery(filters.promptQuery).trim() ? 1 : 0) +
      (normalizeMightBe(filters.mightBe) ? 1 : 0) +
      (sanitizeFrameRate(filters.minFrameRate) !== null ? 1 : 0) +
      (sanitizeFrameRate(filters.maxFrameRate) !== null ? 1 : 0) +
      (sanitizeSteps(filters.minSteps) !== null ? 1 : 0) +
      (sanitizeSteps(filters.maxSteps) !== null ? 1 : 0) +
      (parseWorkflowWords(filters.workflowInclude).length ? 1 : 0) +
      (parseWorkflowWords(filters.workflowExclude).length ? 1 : 0)
    );
  }, [filters]);
