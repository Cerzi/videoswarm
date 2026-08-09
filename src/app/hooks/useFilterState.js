import { useState, useMemo, useCallback, useEffect } from "react";
import {
  createDefaultFilters,
  normalizeTagList,
  sanitizeMinRating,
  sanitizeExactRating,
  sanitizeMegapixels,
  videoMegapixels,
  formatRatingLabel,
  useFiltersActiveCount,
} from "../filters/filtersUtils";
import {
  REVIEW_FILTERS,
  matchesReviewFilter,
  normalizeReviewFilter,
} from "../../review/reviewState";

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
    minMegapixels: sanitizeMegapixels(minMegapixelsRaw),
    maxMegapixels: sanitizeMegapixels(maxMegapixelsRaw),
  };
};

export function useFilterState({ videos, filtersButtonRef, filtersPopoverRef }) {
  const [filters, setFilters] = useState(() => createDefaultFilters());
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

  const filteredVideos = useMemo(() => {
    const includeTags = filters.includeTags ?? [];
    const excludeTags = filters.excludeTags ?? [];
    const minRating = sanitizeMinRating(filters.minRating);
    const exactRating = sanitizeExactRating(filters.exactRating);
    const reviewFilter = normalizeReviewFilter(filters.reviewFilter);
    const minMegapixels = sanitizeMegapixels(filters.minMegapixels);
    const maxMegapixels = sanitizeMegapixels(filters.maxMegapixels);

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
      reviewFilter === REVIEW_FILTERS.ANY
    ) {
      return videos;
    }

    return videos.filter((video) => {
      const tagList = Array.isArray(video.tags)
        ? video.tags.map((tag) => (tag ?? "").toString().trim().toLowerCase()).filter(Boolean)
        : [];

      if (includeSet) {
        for (const tag of includeSet) {
          if (!tagList.includes(tag)) {
            return false;
          }
        }
      }

      if (excludeSet) {
        for (const tag of excludeSet) {
          if (tagList.includes(tag)) {
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

      const ratingValue = Number.isFinite(video.rating) ? Math.round(video.rating) : null;

      if (exactRating !== null) {
        return (ratingValue ?? null) === exactRating;
      }

      if (minRating !== null) {
        return (ratingValue ?? 0) >= minRating;
      }

      return true;
    });
  }, [videos, filters]);

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
    setFiltersOpen,
    isFiltersOpen,
    updateFilters,
    resetFilters,
    filteredVideos,
    filteredVideoIds,
    filtersActiveCount,
    ratingSummary,
    handleRemoveIncludeFilter,
    handleRemoveExcludeFilter,
    clearMinRatingFilter,
    clearExactRatingFilter,
    clearReviewFilter,
  };
}
