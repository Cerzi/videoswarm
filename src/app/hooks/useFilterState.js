import { useState, useMemo, useCallback, useEffect } from "react";
import {
  createDefaultFilters,
  normalizeTagList,
  sanitizeMinRating,
  sanitizeExactRating,
  formatRatingLabel,
  useFiltersActiveCount,
} from "../filters/filtersUtils";

const resolveValue = (value, fallback) => (value === undefined ? fallback : value);

const normalizePath = (value) => (value ?? "").toString().replace(/\\+/g, "/").replace(/\/+$/, "");

const normalizeSearchIn = (value) => (value === "FOLDER" ? "FOLDER" : "ALL");

const isDirectChild = (filePath, folderPath) => {
  const fileNorm = normalizePath(filePath);
  const folderNorm = normalizePath(folderPath);
  if (!folderNorm || !fileNorm.startsWith(`${folderNorm}/`)) return false;
  const remainder = fileNorm.slice(folderNorm.length + 1);
  return !remainder.includes("/");
};

const normalizeFiltersDraft = (draft, prev) => {
  const includeTagsRaw = resolveValue(draft?.includeTags, prev.includeTags);
  const excludeTagsRaw = resolveValue(draft?.excludeTags, prev.excludeTags);
  const searchInRaw = resolveValue(draft?.searchIn, prev.searchIn);
  const activePathPrefixRaw = resolveValue(draft?.activePathPrefix, prev.activePathPrefix);
  const includeSubfoldersRaw = resolveValue(draft?.includeSubfolders, prev.includeSubfolders);
  const searchQueryRaw = resolveValue(draft?.searchQuery, prev.searchQuery);
  const minRatingRaw = resolveValue(draft?.minRating, prev.minRating);
  const exactRatingRaw = resolveValue(draft?.exactRating, prev.exactRating);

  return {
    includeTags: normalizeTagList(includeTagsRaw),
    excludeTags: normalizeTagList(excludeTagsRaw),
    searchIn: normalizeSearchIn(searchInRaw),
    activePathPrefix: normalizePath(activePathPrefixRaw),
    includeSubfolders: Boolean(includeSubfoldersRaw),
    searchQuery: (searchQueryRaw ?? "").toString(),
    minRating: sanitizeMinRating(minRatingRaw),
    exactRating: sanitizeExactRating(exactRatingRaw),
  };
};

const __DEV__ = import.meta.env.MODE !== "production";

function logFilterTransition(action, prev, next) {
  if (!__DEV__) return;
  console.debug("[filters]", {
    ts: new Date().toISOString(),
    action,
    prev: {
      searchIn: prev?.searchIn,
      activePathPrefix: prev?.activePathPrefix,
    },
    next: {
      searchIn: next?.searchIn,
      activePathPrefix: next?.activePathPrefix,
    },
  });
}

export function useFilterState({
  videos,
  filtersButtonRef,
  filtersPopoverRef,
  knownSourcePaths = [],
}) {
  const [filters, setFilters] = useState(() => createDefaultFilters());
  const [isFiltersOpen, setFiltersOpen] = useState(false);

  const updateFilters = useCallback((updater, action = "update") => {
    setFilters((prev) => {
      const nextDraft = typeof updater === "function" ? updater(prev) ?? prev : { ...prev, ...updater };
      const normalized = normalizeFiltersDraft(nextDraft, prev);
      const next =
        normalized.searchIn === "FOLDER" && !normalized.activePathPrefix
          ? { ...normalized, searchIn: "ALL" }
          : normalized;
      logFilterTransition(action, prev, next);
      return next;
    });
  }, []);

  const resetFilters = useCallback(
    () =>
      setFilters((prev) => {
        const next = createDefaultFilters();
        logFilterTransition("reset", prev, next);
        return next;
      }),
    []
  );

  useEffect(() => {
    const knownSet = new Set((knownSourcePaths ?? []).map((entry) => normalizePath(entry)));
    setFilters((prev) => {
      if (prev.searchIn !== "FOLDER") return prev;
      const activePath = normalizePath(prev.activePathPrefix);
      if (activePath && knownSet.has(activePath)) return prev;
      const next = { ...prev, searchIn: "ALL", activePathPrefix: "" };
      logFilterTransition("sourceRemovedFallback", prev, next);
      return next;
    });
  }, [knownSourcePaths]);

  const filteredVideos = useMemo(() => {
    const includeTags = filters.includeTags ?? [];
    const excludeTags = filters.excludeTags ?? [];
    const searchQuery = filters.searchQuery?.trim().toLowerCase() ?? "";
    const minRating = sanitizeMinRating(filters.minRating);
    const exactRating = sanitizeExactRating(filters.exactRating);

    const includeSet = includeTags.length ? new Set(includeTags.map((tag) => tag.toLowerCase())) : null;
    const excludeSet = excludeTags.length ? new Set(excludeTags.map((tag) => tag.toLowerCase())) : null;

    const pathPrefix = filters.searchIn === "FOLDER" ? normalizePath(filters.activePathPrefix) : "";
    const includeSubfolders = Boolean(filters.includeSubfolders);

    return videos.filter((video) => {
      if (pathPrefix) {
        const videoPath = normalizePath(video.fullPath || video.path || video.id);
        if (includeSubfolders) {
          if (!videoPath.startsWith(`${pathPrefix}/`) && videoPath !== pathPrefix) return false;
        } else if (!isDirectChild(videoPath, pathPrefix)) {
          return false;
        }
      }

      const tagList = Array.isArray(video.tags)
        ? video.tags.map((tag) => (tag ?? "").toString().trim().toLowerCase()).filter(Boolean)
        : [];

      if (includeSet) {
        for (const tag of includeSet) if (!tagList.includes(tag)) return false;
      }
      if (excludeSet) {
        for (const tag of excludeSet) if (tagList.includes(tag)) return false;
      }

      if (searchQuery) {
        const haystack = [video.basename, video.name, video.dirname, video.path]
          .map((entry) => (entry ?? "").toString().toLowerCase())
          .join(" ");
        if (!haystack.includes(searchQuery)) return false;
      }

      const ratingValue = Number.isFinite(video.rating) ? Math.round(video.rating) : null;
      if (exactRating !== null) return (ratingValue ?? null) === exactRating;
      if (minRating !== null) return (ratingValue ?? 0) >= minRating;
      return true;
    });
  }, [videos, filters]);

  const filteredVideoIds = useMemo(() => new Set(filteredVideos.map((video) => video.id)), [filteredVideos]);

  const handleRemoveIncludeFilter = useCallback((tag) => {
    if (!tag) return;
    updateFilters((prev) => ({ ...prev, includeTags: (prev.includeTags ?? []).filter((entry) => entry !== tag) }));
  }, [updateFilters]);

  const handleRemoveExcludeFilter = useCallback((tag) => {
    if (!tag) return;
    updateFilters((prev) => ({ ...prev, excludeTags: (prev.excludeTags ?? []).filter((entry) => entry !== tag) }));
  }, [updateFilters]);

  const clearMinRatingFilter = useCallback(() => updateFilters((prev) => ({ ...prev, minRating: null })), [updateFilters]);
  const clearExactRatingFilter = useCallback(() => updateFilters((prev) => ({ ...prev, exactRating: null })), [updateFilters]);

  const ratingSummary = useMemo(() => {
    if (filters.exactRating !== null && filters.exactRating !== undefined) {
      const label = formatRatingLabel(filters.exactRating, "exact");
      return label ? { key: "exact", label, onClear: clearExactRatingFilter } : null;
    }
    if (filters.minRating !== null && filters.minRating !== undefined) {
      const label = formatRatingLabel(filters.minRating, "min");
      return label ? { key: "min", label, onClear: clearMinRatingFilter } : null;
    }
    return null;
  }, [filters.exactRating, filters.minRating, clearExactRatingFilter, clearMinRatingFilter]);

  useEffect(() => {
    if (!isFiltersOpen) return undefined;
    const handlePointerDown = (event) => {
      const anchor = filtersButtonRef?.current;
      const panel = filtersPopoverRef?.current;
      if (panel?.contains(event.target) || anchor?.contains(event.target)) return;
      setFiltersOpen(false);
    };
    const handleKeydown = (event) => event.key === "Escape" && setFiltersOpen(false);
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    window.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [isFiltersOpen, filtersButtonRef, filtersPopoverRef]);

  return {
    filters,
    setFiltersOpen,
    isFiltersOpen,
    updateFilters,
    resetFilters,
    filteredVideos,
    filteredVideoIds,
    filtersActiveCount: useFiltersActiveCount(filters),
    ratingSummary,
    handleRemoveIncludeFilter,
    handleRemoveExcludeFilter,
    clearMinRatingFilter,
    clearExactRatingFilter,
  };
}
