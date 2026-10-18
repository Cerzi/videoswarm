import { useMemo } from "react";
import { REVIEW_FILTERS, normalizeReviewFilter } from "../../review/reviewState";
import { VERSION_FILTERS, normalizeVersionFilter } from "./generationVersions";
import { companionFilterCount } from "../companion/companionFilters";

export const createDefaultFilters = () => ({
  includeTags: [],
  excludeTags: [],
  minRating: null,
  exactRating: null,
  reviewFilter: REVIEW_FILTERS.ANY,
  includeTagsMode: "all",
  minMegapixels: null,
  maxMegapixels: null,
  versionFilter: VERSION_FILTERS.ANY,
  // Per companion action id, a phase (src/app/companion/companionFilters.js).
  companionFilters: {},
  companionHideSent: false,
  // Words in the prompt (prompt-search-and-tag-suggestions.md).
  promptQuery: "",
  // A tag the clips might be: suggested it, not tagged with it (Section 2).
  mightBe: "",
  // Frame rate bounds, and what the embedded workflow ran
  // (docs/architecture/workflow-filters.md).
  minFrameRate: null,
  maxFrameRate: null,
  minSteps: null,
  maxSteps: null,
  workflowInclude: "",
  workflowExclude: "",
});

const MAX_FRAME_RATE = 1_000;
export const sanitizeFrameRate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.min(MAX_FRAME_RATE, Math.round(num * 100) / 100);
};

/** Frames per second, or null when the clip's timing has not been read. */
export const videoFrameRate = (video) => {
  const rate = Number(video?.dimensions?.frameRate ?? video?.frameRate);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
};

// Rates are compared to the nearest whole frame, so 23.976 counts as 24.
export const matchesFrameRate = (video, minFrameRate, maxFrameRate) => {
  const min = sanitizeFrameRate(minFrameRate);
  const max = sanitizeFrameRate(maxFrameRate);
  if (min === null && max === null) return true;
  const rate = videoFrameRate(video);
  if (rate === null) return false;
  if (min !== null && rate < min - 0.5) return false;
  if (max !== null && rate > max + 0.5) return false;
  return true;
};

const MAX_STEPS = 100_000;
export const sanitizeSteps = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const num = Math.round(Number(value));
  return Number.isFinite(num) && num > 0 ? Math.min(MAX_STEPS, num) : null;
};

const MAX_WORKFLOW_WORDS_CHARS = 200;
export const normalizeWorkflowWords = (value) =>
  typeof value === "string" ? value.slice(0, MAX_WORKFLOW_WORDS_CHARS) : "";

/**
 * The words of a workflow filter: split at spaces and commas, lower-cased,
 * at most eight. Each is matched inside node types and weight-file names.
 */
export const parseWorkflowWords = (value) =>
  [
    ...new Set(
      normalizeWorkflowWords(value)
        .split(/[\s,]+/u)
        .map((word) => word.trim().toLowerCase())
        .filter((word) => word.length > 0 && word.length <= 64)
    ),
  ].slice(0, 8);

/** The workflow part of the filters, or null when none is set. */
export const workflowFilterQuery = (filters) => {
  const include = parseWorkflowWords(filters?.workflowInclude);
  const exclude = parseWorkflowWords(filters?.workflowExclude);
  const minSteps = sanitizeSteps(filters?.minSteps);
  const maxSteps = sanitizeSteps(filters?.maxSteps);
  if (!include.length && !exclude.length && minSteps === null && maxSteps === null) return null;
  return { include, exclude, minSteps, maxSteps };
};

const MAX_PROMPT_QUERY_CHARS = 200;
export const normalizePromptQuery = (value) =>
  typeof value === "string" ? value.slice(0, MAX_PROMPT_QUERY_CHARS) : "";

const MAX_TAG_NAME_CHARS = 256;
export const normalizeMightBe = (value) =>
  typeof value === "string" ? value.trim().slice(0, MAX_TAG_NAME_CHARS) : "";

// "all" is an intersection, "any" a union. Exclusion stays separate and always
// means "none of these", so the two controls compose without a query language.
export const normalizeIncludeTagsMode = (value) =>
  value === "any" ? "any" : "all";

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
