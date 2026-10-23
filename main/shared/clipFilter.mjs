// Whether a clip passes a view's filters: the one test the grid and the main
// process both use, so a view followed by another app answers exactly what
// the grid shows for it (docs/architecture/view-feeds.md, Section 3).
//
// Companion filters are not here: they depend on companion apps answering
// the window, so the grid applies them after this test and main leaves them
// out. Answers from main (prompt words, workflow facts, "might be") come in
// as sets; a part whose answer has not arrived is treated as the grid always
// has: prompt and workflow parts wait (pass), "might be" shows nothing.

import { matchesReviewFilter, normalizeReviewFilter, REVIEW_FILTERS } from "./reviewState.mjs";
import { EMPTY_TAG_HIERARCHY, tagsMatch } from "./tagHierarchy.mjs";
import {
  VERSION_FILTERS,
  matchesVersionFilter,
  normalizeVersionFilter,
} from "./generationVersions.mjs";
import {
  matchesFrameRate,
  normalizeIncludeTagsMode,
  normalizeMightBe,
  normalizePromptQuery,
  sanitizeExactRating,
  sanitizeFrameRate,
  sanitizeMegapixels,
  sanitizeMinRating,
  videoMegapixels,
  workflowFilterQuery,
} from "./filterValues.mjs";

const PASS_ALL = Object.freeze({ active: false, test: () => true });

const lowerTags = (tags) =>
  Array.isArray(tags)
    ? tags.map((tag) => (tag ?? "").toString().trim().toLowerCase()).filter(Boolean)
    : [];

/**
 * Compiles `filters` (a view's filters, as the grid keeps them) into
 * `{ active, test(clip) }`. A clip has the grid's shape: `tags`, `rating`,
 * `reviewState`, `dimensions`, `promptKey`, `fingerprint`, `instanceId`.
 *
 * - `tagHierarchy`: a tag also matches the tags under it.
 * - `versionOf(clip)`: its generation-version entry, for the version filter.
 * - `promptMatches`: the prompt keys matching the prompt words, or null
 *   until known. `promptExtra(clip)` may add `{ found, ruledOut }` from
 *   elsewhere (the grid's companion tags).
 * - `workflowMatches`: the fingerprints matching the workflow part.
 * - `mightBe`: `{ matches: Set<instanceId> | null, turnedDown(fp, tag) }`.
 */
export function compileClipFilter(filters = {}, context = {}) {
  const {
    tagHierarchy = EMPTY_TAG_HIERARCHY,
    versionOf = null,
    promptMatches = null,
    promptExtra = null,
    workflowMatches = null,
    mightBe = null,
  } = context;
  const includeTags = Array.isArray(filters.includeTags) ? filters.includeTags : [];
  const excludeTags = Array.isArray(filters.excludeTags) ? filters.excludeTags : [];
  const minRating = sanitizeMinRating(filters.minRating);
  const exactRating = sanitizeExactRating(filters.exactRating);
  const reviewFilter = normalizeReviewFilter(filters.reviewFilter);
  const includeTagsMode = normalizeIncludeTagsMode(filters.includeTagsMode);
  const minMegapixels = sanitizeMegapixels(filters.minMegapixels);
  const maxMegapixels = sanitizeMegapixels(filters.maxMegapixels);
  const versionFilter = normalizeVersionFilter(filters.versionFilter);
  const promptActive =
    normalizePromptQuery(filters.promptQuery).trim() !== "" && promptMatches instanceof Set;
  const workflowActive = workflowFilterQuery(filters) !== null && workflowMatches instanceof Set;
  const frameRateActive =
    sanitizeFrameRate(filters.minFrameRate) !== null ||
    sanitizeFrameRate(filters.maxFrameRate) !== null;
  const mightBeTag = normalizeMightBe(filters.mightBe);

  const includeSet = includeTags.length
    ? new Set(includeTags.map((tag) => String(tag).toLowerCase()))
    : null;
  const excludeSet = excludeTags.length
    ? new Set(excludeTags.map((tag) => String(tag).toLowerCase()))
    : null;

  if (
    !includeSet &&
    !excludeSet &&
    minRating === null &&
    exactRating === null &&
    minMegapixels === null &&
    maxMegapixels === null &&
    reviewFilter === REVIEW_FILTERS.ANY &&
    versionFilter === VERSION_FILTERS.ANY &&
    !promptActive &&
    !mightBeTag &&
    !workflowActive &&
    !frameRateActive
  ) {
    return PASS_ALL;
  }

  const test = (clip) => {
    const tagList = lowerTags(clip.tags);

    if (includeSet) {
      if (includeTagsMode === "any") {
        let matched = false;
        for (const tag of includeSet) {
          if (tagsMatch(tagList, tag, tagHierarchy)) {
            matched = true;
            break;
          }
        }
        if (!matched) return false;
      } else {
        for (const tag of includeSet) {
          if (!tagsMatch(tagList, tag, tagHierarchy)) return false;
        }
      }
    }

    if (excludeSet) {
      for (const tag of excludeSet) {
        if (tagsMatch(tagList, tag, tagHierarchy)) return false;
      }
    }

    if (!matchesReviewFilter(clip.reviewState, reviewFilter)) return false;

    if (minMegapixels !== null || maxMegapixels !== null) {
      // A clip never measured cannot be shown to satisfy a resolution bound.
      const megapixels = videoMegapixels(clip);
      if (megapixels === null) return false;
      if (minMegapixels !== null && megapixels < minMegapixels) return false;
      if (maxMegapixels !== null && megapixels > maxMegapixels) return false;
    }

    if (versionFilter !== VERSION_FILTERS.ANY && !matchesVersionFilter(versionOf?.(clip), versionFilter)) {
      return false;
    }

    // Prompt words; `promptExtra` may also find them elsewhere, or rule the
    // clip out.
    if (promptActive) {
      const inPrompt = Boolean(clip.promptKey && promptMatches.has(clip.promptKey));
      const extra = promptExtra ? promptExtra(clip) : null;
      if (extra?.ruledOut || (!inPrompt && !extra?.found)) return false;
    }

    // A clip whose timing or workflow has not been read cannot be shown to
    // match, so it is left out rather than assumed to.
    if (frameRateActive && !matchesFrameRate(clip, filters.minFrameRate, filters.maxFrameRate)) {
      return false;
    }
    if (workflowActive && !(clip.fingerprint && workflowMatches.has(clip.fingerprint))) {
      return false;
    }

    // Tagged or turned down since main answered: done with, so gone.
    if (
      mightBeTag &&
      (!(mightBe?.matches instanceof Set) ||
        !mightBe.matches.has(Number(clip.instanceId)) ||
        tagsMatch(tagList, mightBeTag, tagHierarchy) ||
        mightBe.turnedDown?.(clip.fingerprint, mightBeTag))
    ) {
      return false;
    }

    const ratingValue = Number.isFinite(clip.rating) ? Math.round(clip.rating) : null;
    if (exactRating !== null) {
      if ((ratingValue ?? null) !== exactRating) return false;
    } else if (minRating !== null && (ratingValue ?? 0) < minRating) {
      return false;
    }
    return true;
  };

  return { active: true, test };
}
