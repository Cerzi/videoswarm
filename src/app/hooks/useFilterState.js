import { useState, useMemo, useCallback, useEffect } from "react";
import {
  createDefaultFilters,
  normalizeTagList,
  sanitizeMinRating,
  sanitizeExactRating,
  sanitizeMegapixels,
  videoMegapixels,
  normalizeIncludeTagsMode,
  formatRatingLabel,
  useFiltersActiveCount,
  normalizeMightBe,
  normalizePromptQuery,
  sanitizeFrameRate,
  sanitizeSteps,
  normalizeWorkflowWords,
  matchesFrameRate,
  workflowFilterQuery,
} from "../filters/filtersUtils";
import {
  REVIEW_FILTERS,
  matchesReviewFilter,
  normalizeReviewFilter,
} from "../../review/reviewState";
import {
  VERSION_FILTERS,
  matchesVersionFilter,
  normalizeVersionFilter,
} from "../filters/generationVersions";
import {
  companionFilterVerdict,
  companionTagsSearch,
  normalizeCompanionHideSent,
  normalizeCompanionTagFilters,
  parseTagQuery,
  normalizeCompanionFilters,
} from "../companion/companionFilters";
import { usePromptSearch } from "./usePromptSearch";
import { useWorkflowSearch } from "./useWorkflowSearch";
import {
  isLikelyTagTurnedDown,
  useMightBe,
  useTurnedDownVersion,
} from "../tags/likelyTags";
import { EMPTY_TAG_HIERARCHY, tagsMatch } from "../filters/tagHierarchy";

// Companion id -> clips waiting on its answer under a phase filter.
const NO_UNCHECKED = new Map();

const resolveValue = (value, fallback) =>
  value === undefined ? fallback : value;

const normalizeFiltersDraft = (draft, prev) => {
  const includeTagsRaw = resolveValue(draft?.includeTags, prev.includeTags);
  const excludeTagsRaw = resolveValue(draft?.excludeTags, prev.excludeTags);
  const minRatingRaw = resolveValue(draft?.minRating, prev.minRating);
  const exactRatingRaw = resolveValue(draft?.exactRating, prev.exactRating);
  const reviewFilterRaw = resolveValue(draft?.reviewFilter, prev.reviewFilter);
  const minMegapixelsRaw = resolveValue(draft?.minMegapixels, prev.minMegapixels);
  const maxMegapixelsRaw = resolveValue(draft?.maxMegapixels, prev.maxMegapixels);

  return {
    includeTags: normalizeTagList(includeTagsRaw),
    excludeTags: normalizeTagList(excludeTagsRaw),
    minRating: sanitizeMinRating(minRatingRaw),
    exactRating: sanitizeExactRating(exactRatingRaw),
    reviewFilter: normalizeReviewFilter(reviewFilterRaw),
    includeTagsMode: normalizeIncludeTagsMode(
      resolveValue(draft?.includeTagsMode, prev.includeTagsMode)
    ),
    minMegapixels: sanitizeMegapixels(minMegapixelsRaw),
    maxMegapixels: sanitizeMegapixels(maxMegapixelsRaw),
    versionFilter: normalizeVersionFilter(
      resolveValue(draft?.versionFilter, prev.versionFilter)
    ),
    companionFilters: normalizeCompanionFilters(
      resolveValue(draft?.companionFilters, prev.companionFilters)
    ),
    companionHideSent: normalizeCompanionHideSent(
      resolveValue(draft?.companionHideSent, prev.companionHideSent)
    ),
    companionTags: normalizeCompanionTagFilters(resolveValue(draft?.companionTags, prev.companionTags)),
    promptQuery: normalizePromptQuery(resolveValue(draft?.promptQuery, prev.promptQuery)),
    mightBe: normalizeMightBe(resolveValue(draft?.mightBe, prev.mightBe)),
    minFrameRate: sanitizeFrameRate(resolveValue(draft?.minFrameRate, prev.minFrameRate)),
    maxFrameRate: sanitizeFrameRate(resolveValue(draft?.maxFrameRate, prev.maxFrameRate)),
    minSteps: sanitizeSteps(resolveValue(draft?.minSteps, prev.minSteps)),
    maxSteps: sanitizeSteps(resolveValue(draft?.maxSteps, prev.maxSteps)),
    workflowInclude: normalizeWorkflowWords(
      resolveValue(draft?.workflowInclude, prev.workflowInclude)
    ),
    workflowExclude: normalizeWorkflowWords(
      resolveValue(draft?.workflowExclude, prev.workflowExclude)
    ),
  };
};

export function useFilterState({
  videos,
  filtersButtonRef,
  filtersPopoverRef,
  generationVersionIndex = null,
  // Filtering by a tag also matches the tags under it.
  tagHierarchy = EMPTY_TAG_HIERARCHY,
  // Connected companion apps' sessions, each with what it says about each
  // clip by catalog row (src/app/companion/useCompanion.js).
  companions = null,
  // Changes as workflows are read in the background, so a workflow filter
  // asks again (docs/architecture/workflow-filters.md).
  workflowRefreshKey = 0,
}) {
  const [filters, setFilters] = useState(() => createDefaultFilters());
  // Words in the prompt: main answers which of the collection's prompt keys
  // match (prompt-search-and-tag-suggestions.md).
  const promptSearch = usePromptSearch({ videos, query: filters.promptQuery });
  const promptMatches = promptSearch.matches;
  // Clips that might be a tag: main answers which catalog rows its learned
  // suggestions pick out (Section 2 there).
  const mightBe = useMightBe({ videos, tag: filters.mightBe });
  const mightBeMatches = mightBe.matches;
  // Steps and words in the embedded workflow: main answers which of the
  // collection's clips match.
  const workflowQuery = useMemo(
    () => workflowFilterQuery(filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      filters.workflowInclude,
      filters.workflowExclude,
      filters.minSteps,
      filters.maxSteps,
    ]
  );
  const workflowSearch = useWorkflowSearch({
    videos,
    query: workflowQuery,
    refreshKey: workflowRefreshKey,
  });
  const workflowMatches = workflowSearch.matches;
  const turnedDownVersion = useTurnedDownVersion();
  const [isFiltersOpen, setFiltersOpen] = useState(false);

  const updateFilters = useCallback((updater) => {
    setFilters((prev) => {
      const nextDraft =
        typeof updater === "function" ? updater(prev) ?? prev : { ...prev, ...updater };
      return normalizeFiltersDraft(nextDraft, prev);
    });
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(createDefaultFilters());
  }, []);

  // The filtered list, and per companion the clips hidden only because it
  // has not answered for them yet (counted for the status line).
  const { list: filteredVideos, unchecked: companionUnchecked } = useMemo(() => {
    const includeTags = filters.includeTags ?? [];
    const excludeTags = filters.excludeTags ?? [];
    const minRating = sanitizeMinRating(filters.minRating);
    const exactRating = sanitizeExactRating(filters.exactRating);
    const reviewFilter = normalizeReviewFilter(filters.reviewFilter);
    const includeTagsMode = normalizeIncludeTagsMode(filters.includeTagsMode);
    const minMegapixels = sanitizeMegapixels(filters.minMegapixels);
    const maxMegapixels = sanitizeMegapixels(filters.maxMegapixels);
    const versionFilter = normalizeVersionFilter(filters.versionFilter);
    const companionFilters = normalizeCompanionFilters(filters.companionFilters);
    const companionHideSent = normalizeCompanionHideSent(filters.companionHideSent);
    const companionTags = normalizeCompanionTagFilters(filters.companionTags);
    const companionList = Array.isArray(companions) ? companions : [];
    const companionActive =
      companionList.length > 0 &&
      (companionHideSent.length > 0 ||
        Object.keys(companionFilters).length > 0 ||
        Object.keys(companionTags).length > 0);
    const companionById = new Map(companionList.map((companion) => [companion.id, companion]));
    const promptActive =
      normalizePromptQuery(filters.promptQuery).trim() !== "" && promptMatches instanceof Set;
    // Companion tags searched alongside prompts, when any app has tags.
    const taggingCompanions = companionList.filter((companion) => companion.tags);
    const promptTagTerms =
      promptActive && taggingCompanions.length ? parseTagQuery(filters.promptQuery) : null;
    const companionTagSearchFor = (video) => {
      const tags = [];
      for (const companion of taggingCompanions) {
        const found = companion.entries?.get(video.instanceId)?.tags;
        if (found) tags.push(...found);
      }
      return companionTagsSearch(tags, promptTagTerms);
    };
    const workflowActive = workflowFilterQuery(filters) !== null && workflowMatches instanceof Set;
    const frameRateActive =
      sanitizeFrameRate(filters.minFrameRate) !== null ||
      sanitizeFrameRate(filters.maxFrameRate) !== null;
    // Until the first answer arrives nothing is known to match, so nothing
    // shows: the whole collection would read as "might be" the tag.
    const mightBeTag = normalizeMightBe(filters.mightBe);

    const includeSet = includeTags.length
      ? new Set(includeTags.map((tag) => tag.toLowerCase()))
      : null;
    const excludeSet = excludeTags.length
      ? new Set(excludeTags.map((tag) => tag.toLowerCase()))
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
      !companionActive &&
      !promptActive &&
      !mightBeTag &&
      !workflowActive &&
      !frameRateActive
    ) {
      return { list: videos, unchecked: NO_UNCHECKED };
    }

    const unchecked = new Map();
    const list = videos.filter((video) => {
      const tagList = Array.isArray(video.tags)
        ? video.tags.map((tag) => (tag ?? "").toString().trim().toLowerCase()).filter(Boolean)
        : [];

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
            if (!tagsMatch(tagList, tag, tagHierarchy)) {
              return false;
            }
          }
        }
      }

      if (excludeSet) {
        for (const tag of excludeSet) {
          if (tagsMatch(tagList, tag, tagHierarchy)) {
            return false;
          }
        }
      }

      if (!matchesReviewFilter(video.reviewState, reviewFilter)) {
        return false;
      }

      if (minMegapixels !== null || maxMegapixels !== null) {
        // A clip that has never been measured cannot be shown to satisfy a
        // resolution bound, so it is excluded rather than assumed to pass.
        const megapixels = videoMegapixels(video);
        if (megapixels === null) return false;
        if (minMegapixels !== null && megapixels < minMegapixels) return false;
        if (maxMegapixels !== null && megapixels > maxMegapixels) return false;
      }

      if (
        versionFilter !== VERSION_FILTERS.ANY &&
        !matchesVersionFilter(generationVersionIndex?.get(video.id), versionFilter)
      ) {
        return false;
      }

      // Prompt words also find a companion's tags for the clip; a word to
      // rule out that a tag holds rules the clip out.
      if (promptActive) {
        const inPrompt = Boolean(video.promptKey && promptMatches.has(video.promptKey));
        const tagSearch = promptTagTerms ? companionTagSearchFor(video) : null;
        if (tagSearch?.ruledOut || (!inPrompt && !tagSearch?.found)) return false;
      }

      // A clip whose timing or workflow has not been read cannot be shown to
      // match, so it is hidden rather than assumed to.
      if (
        frameRateActive &&
        !matchesFrameRate(video, filters.minFrameRate, filters.maxFrameRate)
      ) {
        return false;
      }
      if (workflowActive && !(video.fingerprint && workflowMatches.has(video.fingerprint))) {
        return false;
      }

      // Tagged or turned down since main answered: done with, so gone.
      if (
        mightBeTag &&
        (!(mightBeMatches instanceof Set) ||
          !mightBeMatches.has(Number(video.instanceId)) ||
          tagsMatch(tagList, mightBeTag, tagHierarchy) ||
          isLikelyTagTurnedDown(video.fingerprint, mightBeTag))
      ) {
        return false;
      }

      const ratingValue = Number.isFinite(video.rating) ? Math.round(video.rating) : null;

      if (exactRating !== null) {
        if ((ratingValue ?? null) !== exactRating) return false;
      } else if (minRating !== null && (ratingValue ?? 0) < minRating) {
        return false;
      }

      // Last, so a clip counted as waiting on a companion matches the rest.
      if (companionActive) {
        const verdict = companionFilterVerdict(
          (id) => companionById.get(id)?.entries?.get(video.instanceId),
          companionFilters,
          companionHideSent,
          companionTags
        );
        if (!verdict.pass) {
          // A missing clip is never asked about, so it is not waiting.
          if (verdict.unansweredBy && video.present !== false) {
            unchecked.set(verdict.unansweredBy, (unchecked.get(verdict.unansweredBy) || 0) + 1);
          }
          return false;
        }
      }

      return true;
    });
    return { list, unchecked: unchecked.size ? unchecked : NO_UNCHECKED };
    // turnedDownVersion: a clip turned down leaves at once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    videos,
    filters,
    generationVersionIndex,
    tagHierarchy,
    companions,
    promptMatches,
    mightBeMatches,
    workflowMatches,
    turnedDownVersion,
  ]);

  const filteredVideoIds = useMemo(
    () => new Set(filteredVideos.map((video) => video.id)),
    [filteredVideos]
  );

  const handleRemoveIncludeFilter = useCallback(
    (tag) => {
      if (!tag) return;
      updateFilters((prev) => ({
        ...prev,
        includeTags: (prev.includeTags ?? []).filter((entry) => entry !== tag),
      }));
    },
    [updateFilters]
  );

  const handleRemoveExcludeFilter = useCallback(
    (tag) => {
      if (!tag) return;
      updateFilters((prev) => ({
        ...prev,
        excludeTags: (prev.excludeTags ?? []).filter((entry) => entry !== tag),
      }));
    },
    [updateFilters]
  );

  const clearMinRatingFilter = useCallback(() => {
    updateFilters((prev) => ({ ...prev, minRating: null }));
  }, [updateFilters]);

  const clearExactRatingFilter = useCallback(() => {
    updateFilters((prev) => ({ ...prev, exactRating: null }));
  }, [updateFilters]);

  const clearReviewFilter = useCallback(() => {
    updateFilters((prev) => ({ ...prev, reviewFilter: REVIEW_FILTERS.ANY }));
  }, [updateFilters]);

  const clearVersionFilter = useCallback(() => {
    updateFilters((prev) => ({ ...prev, versionFilter: VERSION_FILTERS.ANY }));
  }, [updateFilters]);

  // One chip per resolution bound, as the Filters badge counts them.
  const resolutionSummary = useMemo(() => {
    const chips = [];
    const min = sanitizeMegapixels(filters.minMegapixels);
    const max = sanitizeMegapixels(filters.maxMegapixels);
    if (min !== null) {
      chips.push({
        key: "min",
        label: `≥ ${min} MP`,
        onClear: () => updateFilters((prev) => ({ ...prev, minMegapixels: null })),
      });
    }
    if (max !== null) {
      chips.push({
        key: "max",
        label: `≤ ${max} MP`,
        onClear: () => updateFilters((prev) => ({ ...prev, maxMegapixels: null })),
      });
    }
    return chips;
  }, [filters.minMegapixels, filters.maxMegapixels, updateFilters]);

  const ratingSummary = useMemo(() => {
    if (filters.exactRating !== null && filters.exactRating !== undefined) {
      const label = formatRatingLabel(filters.exactRating, "exact");
      return label
        ? {
            key: "exact",
            label,
            onClear: clearExactRatingFilter,
          }
        : null;
    }

    if (filters.minRating !== null && filters.minRating !== undefined) {
      const label = formatRatingLabel(filters.minRating, "min");
      return label
        ? {
            key: "min",
            label,
            onClear: clearMinRatingFilter,
          }
        : null;
    }

    return null;
  }, [filters.exactRating, filters.minRating, clearExactRatingFilter, clearMinRatingFilter]);

  useEffect(() => {
    if (!isFiltersOpen) return undefined;

    const handlePointerDown = (event) => {
      const anchor = filtersButtonRef?.current;
      const panel = filtersPopoverRef?.current;
      if (panel?.contains(event.target) || anchor?.contains(event.target)) {
        return;
      }
      setFiltersOpen(false);
    };

    const handleKeydown = (event) => {
      if (event.key === "Escape") {
        setFiltersOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    window.addEventListener("keydown", handleKeydown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [isFiltersOpen, filtersButtonRef, filtersPopoverRef]);

  const filtersActiveCount = useFiltersActiveCount(filters);

  return {
    filters,
    promptSearch,
    mightBe,
    workflowSearch,
    setFiltersOpen,
    isFiltersOpen,
    updateFilters,
    resetFilters,
    filteredVideos,
    filteredVideoIds,
    companionUnchecked,
    filtersActiveCount,
    ratingSummary,
    resolutionSummary,
    handleRemoveIncludeFilter,
    handleRemoveExcludeFilter,
    clearMinRatingFilter,
    clearExactRatingFilter,
    clearReviewFilter,
    clearVersionFilter,
  };
}
