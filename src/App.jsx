// App.jsx
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import VideoCard from "./components/VideoCard/VideoCard";
import FullScreenModal from "./components/FullScreenModal";
import ContextMenu from "./components/ContextMenu";
import RecentFolders from "./components/RecentFolders";
import MetadataPanel from "./components/MetadataPanel";
import HeaderBar from "./components/HeaderBar";
import FiltersPopover from "./components/FiltersPopover";
import DebugSummary from "./components/DebugSummary";

import { useFullScreenModal } from "./hooks/useFullScreenModal";
import useChunkedMasonry from "./hooks/useChunkedMasonry";
import { useVideoCollection } from "./hooks/video-collection";
import useRecentFolders from "./hooks/useRecentFolders";
import useIntersectionObserverRegistry from "./hooks/ui-perf/useIntersectionObserverRegistry";
import useLongTaskFlag from "./hooks/ui-perf/useLongTaskFlag";
import useInitGate from "./hooks/ui-perf/useInitGate";
import useStuckCardAuditor from "./hooks/ui-perf/useStuckCardAuditor";

import useSelectionState from "./hooks/selection/useSelectionState";
import useStableViewAnchoring from "./hooks/selection/useStableViewAnchoring";
import { useContextMenu } from "./hooks/context-menu/useContextMenu";
import useActionDispatch from "./hooks/actions/useActionDispatch";
import { releaseVideoHandlesForAsync } from "./utils/releaseVideoHandles";
import useTrashIntegration from "./hooks/actions/useTrashIntegration";
import {
  getMetadataPanelToggleState,
  shouldAutoOpenMetadataPanel,
} from "./utils/metadataPanelState";

import {
  SortKey,
  buildComparator,
  groupAndSort,
  buildRandomOrderMap,
} from "./sorting/sorting.js";
import { parseSortValue, formatSortValue } from "./sorting/sortOption.js";

import {
  calculateSafeZoom,
  zoomClassForLevel,
  clampZoomIndex,
} from "./zoom/utils.js";
import useHotkeys from "./hooks/selection/useHotkeys";
import { ZOOM_MIN_INDEX, ZOOM_MAX_INDEX, ZOOM_TILE_WIDTHS } from "./zoom/config";

import LoadingProgress from "./components/LoadingProgress";
import feature from "./config/featureFlags";
import "./App.css";

// Helper
const path = {
  dirname: (filePath) => {
    if (!filePath) return "";
    const lastSlash = Math.max(
      filePath.lastIndexOf("/"),
      filePath.lastIndexOf("\\")
    );
    return lastSlash === -1 ? "" : filePath.substring(0, lastSlash);
  },
};

const __DEV__ = import.meta.env.MODE !== "production";

const normalizeVideoFromMain = (video) => {
  if (!video || typeof video !== "object") return video;
  const fingerprint =
    typeof video.fingerprint === "string" && video.fingerprint.length > 0
      ? video.fingerprint
      : null;
  const rating =
    typeof video.rating === "number" && Number.isFinite(video.rating)
      ? Math.max(0, Math.min(5, Math.round(video.rating)))
      : null;
  const tags = Array.isArray(video.tags)
    ? Array.from(
        new Set(
          video.tags
            .map((tag) => (tag ?? "").toString().trim())
            .filter(Boolean)
        )
      )
    : [];

  const rawDimensions = video?.dimensions;
  const width = Number(rawDimensions?.width);
  const height = Number(rawDimensions?.height);
  const sanitizedDimensions =
    Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
      ? {
          width: Math.round(width),
          height: Math.round(height),
          aspectRatio:
            Number.isFinite(rawDimensions?.aspectRatio) && rawDimensions.aspectRatio > 0
              ? rawDimensions.aspectRatio
              : width / height,
        }
      : null;

  const aspectRatio = (() => {
    const candidate = Number(video?.aspectRatio);
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
    return sanitizedDimensions ? sanitizedDimensions.aspectRatio : null;
  })();

  return {
    ...video,
    fingerprint,
    rating,
    tags,
    dimensions: sanitizedDimensions,
    aspectRatio,
  };
};

const LoadingOverlay = ({ show, stage, progress }) => {
  if (!show) return null;
  return (
    <LoadingProgress
      progress={{
        current: typeof progress === "number" ? progress : 0,
        total: 100,
        stage: stage || "",
      }}
    />
  );
};

const MemoryAlert = ({ memStatus }) => {
  if (!memStatus || !memStatus.isNearLimit) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: "80px",
        right: "20px",
        background: "rgba(255, 107, 107, 0.95)",
        color: "white",
        padding: "1rem",
        borderRadius: "8px",
        zIndex: 1000,
        maxWidth: "300px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>
        🚨 Memory Warning
      </div>
      <div style={{ fontSize: "0.9rem" }}>
        Memory usage: {memStatus.currentMemoryMB}MB ({memStatus.memoryPressure}
        %)
        <br />
        Reducing video quality to prevent crashes.
      </div>
    </div>
  );
};
/** --- end split-outs --- */

const createDefaultFilters = () => ({
  includeTags: [],
  excludeTags: [],
  minRating: null,
  exactRating: null,
});

const normalizeTagList = (tags) =>
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

const sanitizeMinRating = (value) => clampRatingValue(value, 1, 5);
const sanitizeExactRating = (value) => clampRatingValue(value, 0, 5);

const formatStars = (value) => {
  const safe = clampRatingValue(value, 0, 5);
  const filled = Math.max(0, safe ?? 0);
  const empty = Math.max(0, 5 - filled);
  return `${"★".repeat(filled)}${"☆".repeat(empty)}`;
};

const formatRatingLabel = (value, mode) => {
  if (value === null || value === undefined) return null;
  const stars = formatStars(value);
  return mode === "min" ? `≥ ${stars}` : `= ${stars}`;
};

function App() {
  const [videos, setVideos] = useState([]);
  // Selection state (SOLID)
  const selection = useSelectionState(); // { selected, size, selectOnly, toggle, clear, setSelected, selectRange, anchorId }
  const selectionSetSelected = selection.setSelected;
  const [recursiveMode, setRecursiveMode] = useState(false);
  const [showFilenames, setShowFilenames] = useState(true);
  const [maxConcurrentPlaying, setMaxConcurrentPlaying] = useState(250);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [sortKey, setSortKey] = useState(SortKey.NAME);
  const [sortDir, setSortDir] = useState("asc");
  const [groupByFolders, setGroupByFolders] = useState(true);
  const [randomSeed, setRandomSeed] = useState(null);

  // Loading state
  const [isLoadingFolder, setIsLoadingFolder] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [loadingProgress, setLoadingProgress] = useState(0);

  // Video collection state
  const [actualPlaying, setActualPlaying] = useState(new Set());
  const [visibleVideos, setVisibleVideos] = useState(new Set());
  const [loadedVideos, setLoadedVideos] = useState(new Set());
  const [loadingVideos, setLoadingVideos] = useState(new Set());

  const { scheduleInit } = useInitGate({ perFrame: 6 });

  const [availableTags, setAvailableTags] = useState([]);
  const [isMetadataPanelOpen, setMetadataPanelOpen] = useState(false);
  const [metadataFocusToken, setMetadataFocusToken] = useState(0);
  const [filters, setFilters] = useState(() => createDefaultFilters());
  const [isFiltersOpen, setFiltersOpen] = useState(false);

  const scrollContainerRef = useRef(null);
  const gridRef = useRef(null);
  const contentRegionRef = useRef(null);
  const metadataPanelRef = useRef(null);
  const filtersButtonRef = useRef(null);
  const filtersPopoverRef = useRef(null);

  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [masonryMetrics, setMasonryMetrics] = useState({
    columnWidth: 0,
    columnCount: 0,
    columnGap: 0,
    gridWidth: 0,
  });
  const [scrollRowsEstimate, setScrollRowsEstimate] = useState(0);
  const metadataAspectCacheRef = useRef(new Map());
  const masonryRefreshRafRef = useRef(0);
  const [ioConfig, setIoConfig] = useState({
    rootMargin: "1600px 0px",
    nearPx: 900,
  });

  const ioRegistry = useIntersectionObserverRegistry(scrollContainerRef, {
    rootMargin: ioConfig.rootMargin,
    threshold: [0, 0.15],
    nearPx: ioConfig.nearPx,
  });

  const videoCollectionAccessRef = useRef({
    canLoadVideo: null,
    performCleanup: null,
  });

  const stuckAudit = useStuckCardAuditor({
    getCandidates: useCallback(() => {
      const gridEl = gridRef.current;
      const scrollRoot = scrollContainerRef.current;
      if (!gridEl || !scrollRoot) return [];

      const rootRect = scrollRoot.getBoundingClientRect?.();
      const top = rootRect?.top ?? 0;
      const bottom =
        rootRect?.bottom ??
        (typeof window !== "undefined" ? window.innerHeight : 0);
      if (!Number.isFinite(bottom) || bottom <= top) return [];

      const nodes = gridEl.querySelectorAll?.(".video-item");
      if (!nodes || !nodes.length) return [];

      const stuck = [];
      let cleanupTriggered = false;

      const { canLoadVideo, performCleanup } = videoCollectionAccessRef.current;

      nodes.forEach((node) => {
        const el = node;
        const id = el?.dataset?.videoId;
        if (!id) return;
        if (loadedVideos.has(id) || loadingVideos.has(id)) return;

        const rect = el.getBoundingClientRect?.();
        if (!rect) return;
        const visible = rect.bottom > top && rect.top < bottom;
        if (!visible) return;

        if (
          typeof canLoadVideo === "function" &&
          !canLoadVideo(id, { assumeVisible: true })
        ) {
          if (!cleanupTriggered) {
            cleanupTriggered = true;
            const victims = performCleanup?.();
            if (Array.isArray(victims) && victims.length) {
              setLoadedVideos((prev) => {
                const ns = new Set(prev);
                victims.forEach((victimId) => ns.delete(victimId));
                return ns;
              });
            }
          }
          if (
            typeof canLoadVideo === "function" &&
            !canLoadVideo(id, { assumeVisible: true })
          ) {
            return;
          }
        }

        stuck.push(id);
      });

      return stuck;
    }, [
      gridRef,
      scrollContainerRef,
      loadedVideos,
      loadingVideos,
      videoCollectionAccessRef,
      setLoadedVideos,
    ]),
    loadedIds: loadedVideos,
    loadingIds: loadingVideos,
    throttleMs: 250,
  });

  const triggerStuckAudit = stuckAudit?.triggerAudit;
  const forcedLoadMap = stuckAudit?.forcedMap;

  const [layoutHoldCount, setLayoutHoldCount] = useState(0);

  const beginLayoutHold = useCallback(() => {
    let released = false;
    setLayoutHoldCount((count) => count + 1);
    return () => {
      if (released) return;
      released = true;
      setLayoutHoldCount((count) => Math.max(0, count - 1));
    };
  }, []);

  const withLayoutHold = useCallback(
    (fn) => {
      const release = beginLayoutHold();
      let result;
      try {
        result = typeof fn === "function" ? fn() : undefined;
      } catch (error) {
        release();
        throw error;
      }
      if (result && typeof result.then === "function") {
        result.then(release, release);
      } else {
        release();
      }
      return result;
    },
    [beginLayoutHold]
  );

  const isLayoutTransitioning = layoutHoldCount > 0;

  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    const gridEl = gridRef.current;

    const compute = () => {
      const currentScroll = scrollContainerRef.current;
      const currentGrid = gridRef.current;
      const height =
        currentScroll?.clientHeight ||
        (typeof window !== "undefined" ? window.innerHeight : 0);
      const width =
        currentGrid?.clientWidth ||
        currentScroll?.clientWidth ||
        (typeof window !== "undefined" ? window.innerWidth : 0);

      setViewportSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height }
      );
    };

    compute();

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => compute())
        : null;
    if (ro) {
      if (scrollEl) ro.observe(scrollEl);
      if (gridEl && gridEl !== scrollEl) ro.observe(gridEl);
    }

    window.addEventListener("resize", compute);

    return () => {
      window.removeEventListener("resize", compute);
      if (ro) {
        if (scrollEl) ro.unobserve(scrollEl);
        if (gridEl && gridEl !== scrollEl) ro.unobserve(gridEl);
        ro.disconnect();
      }
    };
  }, [scrollContainerRef, gridRef]);

  const { hadLongTaskRecently } = useLongTaskFlag();

  const filtersActiveCount = useMemo(() => {
    const includeCount = filters.includeTags?.length ?? 0;
    const excludeCount = filters.excludeTags?.length ?? 0;
    const ratingCount =
      filters.exactRating !== null && filters.exactRating !== undefined
        ? 1
        : filters.minRating !== null && filters.minRating !== undefined
        ? 1
        : 0;
    return includeCount + excludeCount + ratingCount;
  }, [filters]);

  const updateFilters = useCallback((updater) => {
    setFilters((prev) => {
      const resolve = (value, fallback) =>
        value === undefined ? fallback : value;
      const draft =
        typeof updater === "function"
          ? updater(prev) ?? prev
          : { ...prev, ...updater };

      const includeTagsRaw = resolve(draft?.includeTags, prev.includeTags);
      const excludeTagsRaw = resolve(draft?.excludeTags, prev.excludeTags);
      const minRatingRaw = resolve(draft?.minRating, prev.minRating);
      const exactRatingRaw = resolve(draft?.exactRating, prev.exactRating);

      return {
        includeTags: normalizeTagList(includeTagsRaw),
        excludeTags: normalizeTagList(excludeTagsRaw),
        minRating: sanitizeMinRating(minRatingRaw),
        exactRating: sanitizeExactRating(exactRatingRaw),
      };
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

    const includeSet = includeTags.length
      ? new Set(includeTags.map((tag) => tag.toLowerCase()))
      : null;
    const excludeSet = excludeTags.length
      ? new Set(excludeTags.map((tag) => tag.toLowerCase()))
      : null;

    if (!includeSet && !excludeSet && minRating === null && exactRating === null) {
      return videos;
    }

    return videos.filter((video) => {
      const tagList = Array.isArray(video.tags)
        ? video.tags
            .map((tag) => (tag ?? "").toString().trim().toLowerCase())
            .filter(Boolean)
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

      const ratingValue = Number.isFinite(video.rating)
        ? Math.round(video.rating)
        : null;

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

  useEffect(() => {
    if (!selection.size) return;
    selectionSetSelected((prev) => {
      let changed = false;
      const next = new Set();
      prev.forEach((id) => {
        if (filteredVideoIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [filteredVideoIds, selection.size, selectionSetSelected]);

  useEffect(() => {
    if (!isFiltersOpen) return;

    const handlePointerDown = (event) => {
      const anchor = filtersButtonRef.current;
      const panel = filtersPopoverRef.current;
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
  }, [isFiltersOpen]);

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


  // ----- Recent Folders hook -----
  const {
    items: recentFolders,
    add: addRecentFolder,
    remove: removeRecentFolder,
    clear: clearRecentFolders,
  } = useRecentFolders();

  // Track visual (masonry) order for Shift-range selection
  const [visualOrderedIds, setVisualOrderedIds] = useState([]);

  // ----- Masonry hook -----
  const handleMasonryMetrics = useCallback((metrics) => {
    setMasonryMetrics((prev) =>
      prev.columnWidth === metrics.columnWidth &&
      prev.columnCount === metrics.columnCount &&
      prev.columnGap === metrics.columnGap &&
      prev.gridWidth === metrics.gridWidth
        ? prev
        : metrics
    );
  }, []);

  const handleMasonryLayoutComplete = useCallback(() => {
    if (!ioRegistry || typeof ioRegistry.refresh !== "function") {
      if (triggerStuckAudit) triggerStuckAudit({ force: true });
      return;
    }
    if (masonryRefreshRafRef.current && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(masonryRefreshRafRef.current);
    }
    masonryRefreshRafRef.current = requestAnimationFrame(() => {
      masonryRefreshRafRef.current = 0;
      ioRegistry.refresh();
      triggerStuckAudit?.({ force: true });
    });
  }, [ioRegistry, triggerStuckAudit]);

  useEffect(() => () => {
    if (
      masonryRefreshRafRef.current &&
      typeof cancelAnimationFrame === "function"
    ) {
      cancelAnimationFrame(masonryRefreshRafRef.current);
      masonryRefreshRafRef.current = 0;
    }
  }, []);

  useEffect(() => {
    if (!triggerStuckAudit) return undefined;
    const id = setInterval(() => {
      triggerStuckAudit();
    }, 1200);
    return () => clearInterval(id);
  }, [triggerStuckAudit]);

  useEffect(() => {
    if (!triggerStuckAudit) return undefined;
    const timeout = setTimeout(() => {
      triggerStuckAudit({ force: true });
    }, 120);
    return () => clearTimeout(timeout);
  }, [viewportSize.width, viewportSize.height, triggerStuckAudit]);

  const { updateAspectRatio, onItemsChanged, setZoomClass, scheduleLayout } =
    useChunkedMasonry({
      gridRef,
      zoomClassForLevel, // use shared mapping
      getTileWidthForLevel: (level) =>
        ZOOM_TILE_WIDTHS[
          Math.max(0, Math.min(level, ZOOM_TILE_WIDTHS.length - 1))
        ],

      onOrderChange: setVisualOrderedIds,
      onMetricsChange: handleMasonryMetrics,
      onLayoutComplete: handleMasonryLayoutComplete,
    });

  // MEMOIZED sorting & grouping
  const randomOrderMap = useMemo(
    () =>
      sortKey === SortKey.RANDOM
        ? buildRandomOrderMap(
            videos.map((v) => v.id),
            randomSeed ?? Date.now()
          )
        : null,
    [sortKey, randomSeed, videos]
  );

  const comparator = useMemo(
    () => buildComparator({ sortKey, sortDir, randomOrderMap }),
    [sortKey, sortDir, randomOrderMap]
  );

  const orderedVideos = useMemo(
    () => groupAndSort(filteredVideos, { groupByFolders, comparator }),
    [filteredVideos, groupByFolders, comparator]
  );

  const averageAspectRatio = useMemo(() => {
    const sampleLimit = 80;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < orderedVideos.length && count < sampleLimit; i += 1) {
      const video = orderedVideos[i];
      if (!video) continue;
      const direct = Number(video?.aspectRatio);
      if (Number.isFinite(direct) && direct > 0) {
        sum += direct;
        count += 1;
        continue;
      }
      const meta = Number(video?.dimensions?.aspectRatio);
      if (Number.isFinite(meta) && meta > 0) {
        sum += meta;
        count += 1;
      }
    }
    if (!count) return 16 / 9;
    const avg = sum / count;
    return Math.min(3.5, Math.max(0.5, avg));
  }, [orderedVideos]);

  const fallbackTileWidth = useMemo(
    () => ZOOM_TILE_WIDTHS[clampZoomIndex(zoomLevel)] ?? 200,
    [zoomLevel]
  );

  const effectiveColumnWidth =
    masonryMetrics.columnWidth && masonryMetrics.columnWidth > 0
      ? masonryMetrics.columnWidth
      : fallbackTileWidth;

  const approxTileHeight = useMemo(
    () => Math.max(48, effectiveColumnWidth / averageAspectRatio),
    [effectiveColumnWidth, averageAspectRatio]
  );

  const viewportHeight =
    viewportSize.height || (typeof window !== "undefined" ? window.innerHeight : 0);
  const viewportWidth =
    viewportSize.width ||
    (typeof window !== "undefined" ? window.innerWidth : effectiveColumnWidth);

  const derivedColumnCount = useMemo(() => {
    if (masonryMetrics.columnCount && masonryMetrics.columnCount > 0) {
      return masonryMetrics.columnCount;
    }
    const available =
      masonryMetrics.gridWidth && masonryMetrics.gridWidth > 0
        ? masonryMetrics.gridWidth
        : viewportWidth;
    return Math.max(1, Math.floor(available / Math.max(1, effectiveColumnWidth)));
  }, [
    masonryMetrics.columnCount,
    masonryMetrics.gridWidth,
    viewportWidth,
    effectiveColumnWidth,
  ]);

  const viewportRows = useMemo(
    () => Math.max(1, Math.ceil(viewportHeight / Math.max(1, approxTileHeight))),
    [viewportHeight, approxTileHeight]
  );

  const bufferRows = useMemo(
    () => Math.max(3, Math.ceil(viewportRows)),
    [viewportRows]
  );

  const progressiveMaxVisible = useMemo(() => {
    if (!Number.isFinite(derivedColumnCount) || derivedColumnCount <= 0) {
      return null;
    }
    const baseRows = viewportRows + bufferRows;
    const targetRows = Math.max(baseRows, scrollRowsEstimate + bufferRows);
    return derivedColumnCount * targetRows;
  }, [derivedColumnCount, viewportRows, bufferRows, scrollRowsEstimate]);

  const progressiveMaxVisibleNumber = Number.isFinite(progressiveMaxVisible)
    ? Math.max(1, Math.floor(progressiveMaxVisible))
    : undefined;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    let rafId = 0;
    const measure = () => {
      rafId = 0;
      const top = el.scrollTop || 0;
      const rows = Math.max(
        viewportRows,
        Math.ceil((top + viewportHeight) / Math.max(1, approxTileHeight))
      );
      setScrollRowsEstimate((prev) => (prev !== rows ? rows : prev));
    };

    measure();

    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(measure);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [scrollContainerRef, approxTileHeight, viewportHeight, viewportRows]);

  useEffect(() => {
    const mediumWidth = ZOOM_TILE_WIDTHS[1] ?? ZOOM_TILE_WIDTHS[0] ?? 200;
    const tileWidth = Math.max(80, effectiveColumnWidth || mediumWidth);
    const height = viewportHeight;
    const scale = Math.max(0.45, Math.min(1.6, tileWidth / mediumWidth));
    const nearPx = Math.max(360, Math.round(Math.max(480, height * 0.85) * scale));
    const rootMarginPx = Math.max(600, Math.round(1100 * scale));
    const rootMargin = `${rootMarginPx}px 0px`;
    setIoConfig((prev) =>
      prev.nearPx === nearPx && prev.rootMargin === rootMargin
        ? prev
        : { nearPx, rootMargin }
    );
  }, [effectiveColumnWidth, viewportHeight]);

  useEffect(() => {
    if (!ioRegistry) return;
    if (typeof ioRegistry.setNearPx === "function") {
      ioRegistry.setNearPx(ioConfig.nearPx);
    }
    if (typeof ioRegistry.refresh === "function") {
      const raf = requestAnimationFrame(() => {
        ioRegistry.refresh();
      });
      return () => {
        if (typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(raf);
        }
      };
    }
    return undefined;
  }, [ioRegistry, ioConfig.nearPx, ioConfig.rootMargin]);

  useEffect(() => {
    if (!orderedVideos.length) return;
    const cache = metadataAspectCacheRef.current;
    const queue = [];
    for (const video of orderedVideos) {
      if (!video?.id) continue;
      const direct = Number(video?.aspectRatio);
      const meta = Number(video?.dimensions?.aspectRatio);
      const ratio =
        Number.isFinite(direct) && direct > 0
          ? direct
          : Number.isFinite(meta) && meta > 0
          ? meta
          : null;
      if (!ratio) continue;
      if (cache.get(video.id) === ratio) continue;
      cache.set(video.id, ratio);
      queue.push([video.id, ratio]);
    }

    if (!queue.length) return;

    const processChunk = () => {
      const chunk = queue.splice(0, 120);
      chunk.forEach(([id, ratio]) => updateAspectRatio(id, ratio));
      if (queue.length) {
        if (
          typeof window !== "undefined" &&
          typeof window.requestIdleCallback === "function"
        ) {
          window.requestIdleCallback(processChunk, { timeout: 200 });
        } else {
          setTimeout(processChunk, 0);
        }
      }
    };

    if (
      typeof window !== "undefined" &&
      typeof window.requestIdleCallback === "function"
    ) {
      window.requestIdleCallback(processChunk, { timeout: 200 });
    } else {
      setTimeout(processChunk, 0);
    }
  }, [orderedVideos, updateAspectRatio]);

  // data order ids (fallback)
  const orderedIds = useMemo(
    () => orderedVideos.map((v) => v.id),
    [orderedVideos]
  );

  // Prefer visual order if we have it
  const orderForRange = visualOrderedIds.length ? visualOrderedIds : orderedIds;

  const anchorDefaults = useMemo(
    () =>
      feature.stableViewFixes
        ? { settleFrames: 2, stabilizeFrames: 2, maxWaitMs: 700 }
        : { settleFrames: 1, stabilizeFrames: 1, maxWaitMs: 400 },
    []
  );

  const sidebarAnchorOptions = useMemo(
    () => ({
      capture: "fresh",
      settleFrames: anchorDefaults.settleFrames,
      stabilizeFrames: anchorDefaults.stabilizeFrames,
      maxWaitMs: anchorDefaults.maxWaitMs,
    }),
    [
      anchorDefaults.maxWaitMs,
      anchorDefaults.settleFrames,
      anchorDefaults.stabilizeFrames,
    ]
  );

  const zoomAnchorOptions = useMemo(
    () =>
      feature.stableViewFixes
        ? { capture: "fresh", settleFrames: 1, stabilizeFrames: 2, maxWaitMs: 600 }
        : { capture: "fresh", settleFrames: 1, stabilizeFrames: 1, maxWaitMs: 400 },
    []
  );

  const { runWithStableAnchor } = useStableViewAnchoring({
    enabled: feature.stableViewAnchoring,
    scrollRef: scrollContainerRef,
    gridRef,
    observeRef: contentRegionRef,
    selection,
    orderedIds: orderForRange,
    anchorMode: "last",
    settleFrames: anchorDefaults.settleFrames,
    stabilizeFrames: anchorDefaults.stabilizeFrames,
    maxWaitMs: anchorDefaults.maxWaitMs,
  });

  const waitForTransitionEnd = useCallback(
    (element, properties = ["width"], timeoutMs = anchorDefaults.maxWaitMs) => {
      if (!feature.stableViewFixes) return Promise.resolve();
      if (!element || typeof window === "undefined") return Promise.resolve();

      let computed;
      try {
        computed = window.getComputedStyle(element);
      } catch (error) {
        console.debug("[stable-anchor] Failed to read computed style", error);
        return Promise.resolve();
      }

      const parseTime = (value) => {
        if (!value) return 0;
        const trimmed = String(value).trim();
        if (!trimmed) return 0;
        if (trimmed.endsWith("ms")) return parseFloat(trimmed);
        if (trimmed.endsWith("s")) return parseFloat(trimmed) * 1000;
        const parsed = parseFloat(trimmed);
        return Number.isFinite(parsed) ? parsed * 1000 : 0;
      };

      const durations = (computed?.transitionDuration || "")
        .split(",")
        .map(parseTime);
      const delays = (computed?.transitionDelay || "")
        .split(",")
        .map(parseTime);
      const hasDuration = durations.some((duration, index) => {
        const delay = delays[index] ?? delays[delays.length - 1] ?? 0;
        return duration + delay > 0;
      });
      if (!hasDuration) {
        return Promise.resolve();
      }

      const propertySet = Array.isArray(properties) && properties.length > 0
        ? new Set(properties.filter(Boolean))
        : null;

      return new Promise((resolve) => {
        if (!element) {
          resolve();
          return;
        }

        let resolved = false;
        let timer = null;

        function cleanup() {
          if (!element) return;
          element.removeEventListener("transitionend", onTransitionDone);
          element.removeEventListener("transitioncancel", onTransitionDone);
          if (timer != null) {
            window.clearTimeout(timer);
          }
        }

        function finalize() {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve();
        }

        function onTransitionDone(event) {
          if (propertySet && propertySet.size && !propertySet.has(event.propertyName)) {
            return;
          }
          if (propertySet && propertySet.size) {
            propertySet.delete(event.propertyName);
            if (propertySet.size > 0) {
              return;
            }
          }
          finalize();
        }

        element.addEventListener("transitionend", onTransitionDone);
        element.addEventListener("transitioncancel", onTransitionDone);
        timer = window.setTimeout(finalize, timeoutMs ?? anchorDefaults.maxWaitMs);
      });
    },
    [anchorDefaults.maxWaitMs]
  );

  const runSidebarTransition = useCallback(
    (triggerType, applyState) =>
      withLayoutHold(() =>
        runWithStableAnchor(
          triggerType,
          () => {
            const promise = waitForTransitionEnd(
              metadataPanelRef.current,
              ["width"],
              anchorDefaults.maxWaitMs
            );
            if (typeof applyState === "function") {
              applyState();
            }
            scheduleLayout?.();
            return promise;
          },
          sidebarAnchorOptions
        )
      ),
    [
      anchorDefaults.maxWaitMs,
      metadataPanelRef,
      runWithStableAnchor,
      scheduleLayout,
      sidebarAnchorOptions,
      waitForTransitionEnd,
      withLayoutHold,
    ]
  );

  const getById = useCallback(
    (id) => orderedVideos.find((v) => v.id === id),
    [orderedVideos]
  );

  const selectedVideos = useMemo(() => {
    return Array.from(selection.selected)
      .map((id) => getById(id))
      .filter(Boolean);
  }, [selection.selected, getById]);

  const selectedFingerprints = useMemo(() => {
    const set = new Set();
    selectedVideos.forEach((video) => {
      if (video?.fingerprint) {
        set.add(video.fingerprint);
      }
    });
    return Array.from(set);
  }, [selectedVideos]);

  const handleNativeDragStart = useCallback(
    (nativeEvent, video) => {
      if (!video?.isElectronFile || !video?.fullPath) return;
      const electronAPI = window?.electronAPI;
      if (!electronAPI?.startFileDragSync) return;

      const selectedIds = selection?.selected;
      const isInSelection = selectedIds instanceof Set && selectedIds.has(video.id);
      const pool = isInSelection ? selectedVideos : [video];
      const localFiles = pool
        .filter((entry) => entry?.isElectronFile && entry?.fullPath)
        .map((entry) => entry.fullPath);

      if (!localFiles.length) return;

      if (nativeEvent?.dataTransfer) {
        try {
          nativeEvent.dataTransfer.effectAllowed = "copy";
          nativeEvent.dataTransfer.dropEffect = "copy";
        } catch (err) {}
      }

      electronAPI.startFileDragSync(localFiles);
    },
    [selection?.selected, selectedVideos]
  );

  useEffect(() => {
    if (shouldAutoOpenMetadataPanel(selection.size, isMetadataPanelOpen)) {
      runSidebarTransition("sidebar:auto-open", () => {
        setMetadataPanelOpen(true);
        setMetadataFocusToken((token) => token + 1);
      });
    }
  }, [
    isMetadataPanelOpen,
    runSidebarTransition,
    selection.size,
    setMetadataFocusToken,
    setMetadataPanelOpen,
    shouldAutoOpenMetadataPanel,
  ]);

  useEffect(() => {
    if (selection.size === 0 && isMetadataPanelOpen) {
      runSidebarTransition("sidebar:auto-close", () => {
        setMetadataPanelOpen(false);
      });
    }
  }, [
    isMetadataPanelOpen,
    runSidebarTransition,
    selection.size,
    setMetadataPanelOpen,
  ]);

  const sortStatus = useMemo(() => {
    const keyLabels = {
      [SortKey.NAME]: "Name",
      [SortKey.CREATED]: "Created",
      [SortKey.RANDOM]: "Random",
    };
    const arrow =
      sortKey === SortKey.RANDOM ? "" : sortDir === "asc" ? "↑" : "↓";
    const base = `Sorted by ${keyLabels[sortKey]}${arrow ? ` ${arrow}` : ""}`;
    return groupByFolders ? `${base} • Grouped by folders` : base;
  }, [sortKey, sortDir, groupByFolders]);

  // Simple toast used by actions layer
  const notify = useCallback((message, type = "info") => {
    const colors = {
      error: "#ff4444",
      success: "#4CAF50",
      warning: "#ff9800",
      info: "#007acc",
    };
    const icons = { error: "❌", success: "✅", warning: "⚠️", info: "ℹ️" };
    const el = document.createElement("div");
    el.style.cssText = `
      position: fixed; top: 80px; right: 20px;
      background: ${colors[type] || colors.info};
      color: white; padding: 12px 16px; border-radius: 8px; z-index: 10001;
      font-family: system-ui, -apple-system, sans-serif; font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 300px; display:flex; gap:8px;
      animation: slideInFromRight 0.2s ease-out;
    `;
    el.textContent = `${icons[type] || icons.info} ${message}`;
    document.body.appendChild(el);
    setTimeout(() => {
      if (document.body.contains(el)) document.body.removeChild(el);
    }, 3000);
  }, []);

  const refreshTagList = useCallback(async () => {
    const api = window.electronAPI?.metadata;
    if (!api?.listTags) return;
    try {
      const res = await api.listTags();
      if (Array.isArray(res?.tags)) {
        setAvailableTags(res.tags);
      }
    } catch (error) {
      console.warn("Failed to refresh tags:", error);
    }
  }, []);

  useEffect(() => {
    refreshTagList();
  }, [refreshTagList]);

  const applyMetadataPatch = useCallback((updates) => {
    if (!updates || typeof updates !== "object") return;
    setVideos((prev) =>
      prev.map((video) => {
        const fingerprint = video?.fingerprint;
        if (!fingerprint || !updates[fingerprint]) return video;
        return normalizeVideoFromMain({
          ...video,
          ...updates[fingerprint],
          fingerprint,
        });
      })
    );
  }, []);

  const handleAddTags = useCallback(
    async (tagNames) => {
      const api = window.electronAPI?.metadata;
      if (!api?.addTags) return;
      const fingerprints = selectedFingerprints;
      if (!fingerprints.length) return;
      const cleanNames = Array.isArray(tagNames)
        ? tagNames.map((name) => name.trim()).filter(Boolean)
        : [];
      if (!cleanNames.length) return;
      try {
        const result = await api.addTags(fingerprints, cleanNames);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (Array.isArray(result?.tags)) setAvailableTags(result.tags);
        notify(
          `Added ${cleanNames.join(", ")} to ${fingerprints.length} item(s)`,
          "success"
        );
      } catch (error) {
        console.error("Failed to add tags:", error);
        notify("Failed to add tags", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, notify]
  );

  const handleRemoveTag = useCallback(
    async (tagName) => {
      const api = window.electronAPI?.metadata;
      if (!api?.removeTag) return;
      const fingerprints = selectedFingerprints;
      const cleanName = (tagName ?? "").trim();
      if (!fingerprints.length || !cleanName) return;
      try {
        const result = await api.removeTag(fingerprints, cleanName);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (Array.isArray(result?.tags)) setAvailableTags(result.tags);
        notify(
          `Removed "${cleanName}" from ${fingerprints.length} item(s)`,
          "success"
        );
      } catch (error) {
        console.error("Failed to remove tag:", error);
        notify("Failed to remove tag", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, notify]
  );

  const handleSetRating = useCallback(
    async (value, targetFingerprints = selectedFingerprints) => {
      const api = window.electronAPI?.metadata;
      if (!api?.setRating) return;
      const fingerprints = (targetFingerprints || []).filter(Boolean);
      if (!fingerprints.length) return;
      try {
        const result = await api.setRating(fingerprints, value);
        if (result?.updates) applyMetadataPatch(result.updates);
        if (value === null || value === undefined) {
          notify(`Cleared rating for ${fingerprints.length} item(s)`, "success");
        } else {
          const safeRating = Math.max(0, Math.min(5, Math.round(Number(value))));
          notify(
            `Rated ${fingerprints.length} item(s) ${safeRating} star${
              safeRating === 1 ? "" : "s"
            }`,
            "success"
          );
        }
      } catch (error) {
        console.error("Failed to update rating:", error);
        notify("Failed to update rating", "error");
      }
    },
    [selectedFingerprints, applyMetadataPatch, notify]
  );

  const handleClearRating = useCallback(() => {
    handleSetRating(null, selectedFingerprints);
  }, [handleSetRating, selectedFingerprints]);

  const handleApplyExistingTag = useCallback(
    (tagName) => handleAddTags([tagName]),
    [handleAddTags]
  );

  const openMetadataPanel = useCallback(() => {
    runSidebarTransition("sidebar:open", () => {
      setMetadataPanelOpen(true);
      setMetadataFocusToken((token) => token + 1);
    });
  }, [runSidebarTransition, setMetadataFocusToken, setMetadataPanelOpen]);

  const toggleMetadataPanel = useCallback(() => {
    runSidebarTransition("sidebarToggle", () => {
      setMetadataPanelOpen((open) => {
        const { nextOpen, shouldClear } = getMetadataPanelToggleState(
          open,
          selection.size
        );
        if (shouldClear) {
          selection.clear();
        }
        return nextOpen;
      });
    });
  }, [runSidebarTransition, selection.clear, selection.size, setMetadataPanelOpen]);

  const {
    contextMenu,
    showOnItem,
    showOnEmpty,
    hide: hideContextMenu,
  } = useContextMenu();

  const deps = useTrashIntegration({
    electronAPI: window.electronAPI,
    notify,
    confirm: window.confirm,
    releaseVideoHandlesForAsync,
    setVideos,
    setSelected: selection.setSelected,
    setLoadedIds: setLoadedVideos,
    setPlayingIds: setActualPlaying,
    setVisibleIds: setVisibleVideos,
    setLoadingIds: setLoadingVideos,
  });

  const { runAction } = useActionDispatch(deps, getById);

  const handleContextAction = useCallback(
    (actionId) => {
      if (!actionId) return;
      if (actionId === "metadata:open") {
        openMetadataPanel();
        return;
      }
      if (actionId.startsWith("metadata:rate:")) {
        if (!selectedFingerprints.length) return;
        if (actionId === "metadata:rate:clear") {
          handleSetRating(null, selectedFingerprints);
        } else {
          const value = parseInt(actionId.replace("metadata:rate:", ""), 10);
          if (!Number.isNaN(value)) {
            handleSetRating(value, selectedFingerprints);
          }
        }
        return;
      }
      if (actionId.startsWith("metadata:tag:")) {
        const tagName = actionId.replace("metadata:tag:", "");
        if (tagName) {
          handleApplyExistingTag(tagName);
        }
        return;
      }
      runAction(actionId, selection.selected, contextMenu.contextId);
    },
    [
      openMetadataPanel,
      selectedFingerprints,
      handleSetRating,
      handleApplyExistingTag,
      runAction,
      selection.selected,
      contextMenu.contextId,
    ]
  );

  // --- Composite Video Collection Hook ---
  const videoCollection = useVideoCollection({
    videos: orderedVideos,
    visibleVideos,
    loadedVideos,
    loadingVideos,
    actualPlaying,
    maxConcurrentPlaying,
    scrollRef: scrollContainerRef,
    progressive: {
      initial: 120,
      batchSize: 64,
      intervalMs: 100,
      pauseOnScroll: true,
      longTaskAdaptation: true,
      maxVisible: progressiveMaxVisibleNumber,
    },
    hadLongTaskRecently,
    isNear: ioRegistry.isNear,
    suspendEvictions: isLayoutTransitioning,
  });

  const videoCollectionCanLoad = videoCollection?.canLoadVideo;
  const videoCollectionPerformCleanup = videoCollection?.performCleanup;

  useEffect(() => {
    videoCollectionAccessRef.current = {
      canLoadVideo: videoCollectionCanLoad,
      performCleanup: videoCollectionPerformCleanup,
    };
  }, [videoCollectionCanLoad, videoCollectionPerformCleanup]);

  // fullscreen / context menu
  const {
    fullScreenVideo,
    openFullScreen,
    closeFullScreen,
    navigateFullScreen,
  } = useFullScreenModal(orderedVideos, "masonry-vertical", gridRef);

  // Hotkeys operate on current selection
  const runForHotkeys = useCallback(
    (actionId, currentSelection) =>
      runAction(actionId, currentSelection, contextMenu.contextId),
    [runAction, contextMenu.contextId]
  );
  // Global hotkeys (Enter / Ctrl+C / Delete) + Zoom (+ / - and Ctrl/⌘ + Wheel)
  useHotkeys(runForHotkeys, () => selection.selected, {
    getZoomIndex: () => zoomLevel,
    setZoomIndexSafe: (z) => handleZoomChangeSafe(z),
    minZoomIndex: ZOOM_MIN_INDEX,
    maxZoomIndex: ZOOM_MAX_INDEX,
    // wheelStepUnits: 100, // optional sensitivity tuning
  });

  // ====== Zoom logic (refactored) ======

  const handleZoomChange = useCallback(
    (z) => {
      const clamped = clampZoomIndex(z);
      if (clamped === zoomLevel) return; // no-op if unchanged
      withLayoutHold(() =>
        runWithStableAnchor(
          "zoomChange",
          () => {
            setZoomLevel(clamped);
            setZoomClass(clamped);
            window.electronAPI?.saveSettingsPartial?.({
              zoomLevel: clamped,
              recursiveMode,
              maxConcurrentPlaying,
              showFilenames,
            });
            // Nudge masonry after zoom change
            scheduleLayout?.();
          },
          zoomAnchorOptions
        )
      );
    },
    [
      zoomLevel,
      runWithStableAnchor,
      setZoomClass,
      recursiveMode,
      maxConcurrentPlaying,
      showFilenames,
      scheduleLayout,
      zoomAnchorOptions,
      withLayoutHold,
    ]
  );

  const getMinimumZoomLevel = useCallback(() => {
    const videoCount = orderedVideos.length;
    const windowWidth = window.innerWidth;
    if (videoCount > 200 && windowWidth > 2560) return 2;
    if (videoCount > 150 && windowWidth > 1920) return 1;
    return 0;
  }, [orderedVideos.length]);

  const handleZoomChangeSafe = useCallback(
    (newZoom) => {
      const minZoom = getMinimumZoomLevel();
      const safeZoom = Math.max(newZoom, minZoom);
      if (safeZoom === zoomLevel) return; // nothing to do
      if (safeZoom !== newZoom) {
        console.warn(
          `🛡️ Zoom limited to ${getZoomLabelByIndex(
            safeZoom
          )} for memory safety (requested ${getZoomLabelByIndex(newZoom)})`
        );
      }
      handleZoomChange(safeZoom);
    },
    [getMinimumZoomLevel, handleZoomChange, zoomLevel]
  );

  // === MEMORY MONITORING (dev helpers) ===
  useEffect(() => {
    if (performance.memory) {
      console.log("🧠 Initial memory limits:", {
        jsHeapSizeLimit:
          Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) + "MB",
        totalJSHeapSize:
          Math.round(performance.memory.totalJSHeapSize / 1024 / 1024) + "MB",
        usedJSHeapSize:
          Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + "MB",
      });
    } else {
      console.log("📊 performance.memory not available");
    }

    if (process.env.NODE_ENV !== "production") {
      const handleKeydown = (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === "G") {
          if (window.gc) {
            const before = performance.memory?.usedJSHeapSize;
            window.gc();
            const after = performance.memory?.usedJSHeapSize;
            const freed =
              before && after ? Math.round((before - after) / 1024 / 1024) : 0;
            console.log(`🧹 Manual GC: ${freed}MB freed`);
          } else {
            console.warn(
              '🚫 GC not available - start with --js-flags="--expose-gc"'
            );
          }
        }
      };
      window.addEventListener("keydown", handleKeydown);
      return () => window.removeEventListener("keydown", handleKeydown);
    }
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && videoCollection.memoryStatus) {
      const { currentMemoryMB, memoryPressure } = videoCollection.memoryStatus;
      if (currentMemoryMB > 3000) {
        console.warn(
          `🔥 DEV WARNING: High memory usage (${currentMemoryMB}MB) - this would crash in production!`
        );
      }
      if (memoryPressure > 80) {
        console.warn(
          `⚠️ DEV WARNING: Memory pressure at ${memoryPressure}% - production limits would kick in`
        );
      }
    }
  }, [
    videoCollection.memoryStatus?.currentMemoryMB,
    videoCollection.memoryStatus?.memoryPressure,
  ]);

  // === DYNAMIC ZOOM RESIZE / COUNT ===
  useEffect(() => {
    if (!window.electronAPI?.isElectron) return;
    const handleResize = () => {
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      const videoCount = orderedVideos.length;
      if (videoCount > 50) {
        const safeZoom = calculateSafeZoom(
          windowWidth,
          windowHeight,
          videoCount
        );
        if (safeZoom > zoomLevel) {
          console.log(
            `📐 Window resized: ${windowWidth}x${windowHeight} with ${videoCount} videos - adjusting zoom to ${getZoomLabelByIndex(
              safeZoom
            )} for safety`
          );
          handleZoomChange(safeZoom);
        }
      }
    };
    let resizeTimeout;
    const debouncedResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(handleResize, 500);
    };
    window.addEventListener("resize", debouncedResize);
    return () => {
      window.removeEventListener("resize", debouncedResize);
      clearTimeout(resizeTimeout);
    };
  }, [orderedVideos.length, zoomLevel, handleZoomChange]);

  useEffect(() => {
    if (orderedVideos.length > 100) {
      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      const safeZoom = calculateSafeZoom(
        windowWidth,
        windowHeight,
        orderedVideos.length
      );
      if (safeZoom > zoomLevel) {
        console.log(
          `📹 Large collection detected (${orderedVideos.length} videos) - adjusting zoom for memory safety`
        );
        handleZoomChange(safeZoom);
      }
    }
  }, [orderedVideos.length, zoomLevel, handleZoomChange]);

  // settings load + folder selection event
  useEffect(() => {
    const load = async () => {
      const api = window.electronAPI;
      if (!api?.getSettings) {
        setSettingsLoaded(true);
        return;
      }
      try {
        const s = await api.getSettings();
        if (s.recursiveMode !== undefined) setRecursiveMode(s.recursiveMode);
        if (s.showFilenames !== undefined) setShowFilenames(s.showFilenames);
        if (s.maxConcurrentPlaying !== undefined)
          setMaxConcurrentPlaying(s.maxConcurrentPlaying);
        if (s.zoomLevel !== undefined)
          setZoomLevel(clampZoomIndex(s.zoomLevel));
        if (s.sortKey) setSortKey(s.sortKey);
        if (s.sortDir) setSortDir(s.sortDir);
        if (s.groupByFolders !== undefined) setGroupByFolders(s.groupByFolders);
        if (s.randomSeed !== undefined) setRandomSeed(s.randomSeed);
      } catch {}
      setSettingsLoaded(true);
    };
    load();

    window.electronAPI?.onFolderSelected?.(
      (folderPath) => {
        handleElectronFolderSelection(folderPath);
      },
      [handleElectronFolderSelection]
    );
  }, []); // eslint-disable-line

  // FS listeners
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const handleFileAdded = (videoFile) => {
      const normalized = normalizeVideoFromMain(videoFile);
      setVideos((prev) => {
        const existingIndex = prev.findIndex((v) => v.id === normalized.id);
        if (existingIndex !== -1) {
          const next = prev.slice();
          next[existingIndex] = normalized;
          return next;
        }
        return [...prev, normalized].sort((a, b) =>
          a.basename.localeCompare(b.basename, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        );
      });
      if (normalized.tags.length) {
        refreshTagList();
      }
    };
    const handleFileRemoved = (filePath) => {
      setVideos((prev) => prev.filter((v) => v.id !== filePath));
      selection.setSelected((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setActualPlaying((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setLoadedVideos((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setLoadingVideos((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      setVisibleVideos((prev) => {
        const ns = new Set(prev);
        ns.delete(filePath);
        return ns;
      });
      refreshTagList();
    };
    const handleFileChanged = (videoFile) => {
      const normalized = normalizeVideoFromMain(videoFile);
      setVideos((prev) =>
        prev.map((v) => (v.id === normalized.id ? normalized : v))
      );
      if (normalized.tags.length) {
        refreshTagList();
      }
    };

    api.onFileAdded?.(handleFileAdded);
    api.onFileRemoved?.(handleFileRemoved);
    api.onFileChanged?.(handleFileChanged);

    return () => {
      api?.stopFolderWatch?.().catch(() => {});
    };
  }, [selection.setSelected, refreshTagList]);

  // relayout when list changes
  useEffect(() => {
    if (orderedVideos.length) onItemsChanged();
  }, [orderedVideos.length, onItemsChanged]);

  // zoom handling via hook
  useEffect(() => {
    setZoomClass(zoomLevel);
  }, [zoomLevel, setZoomClass]);

  // aspect ratio updates from cards
  const handleVideoLoaded = useCallback(
    (videoId, aspectRatio) => {
      setLoadedVideos((prev) => new Set([...prev, videoId]));
      updateAspectRatio(videoId, aspectRatio);
    },
    [updateAspectRatio]
  );

  const handleVideoStartLoading = useCallback((videoId) => {
    setLoadingVideos((prev) => new Set([...prev, videoId]));
  }, []);

  const handleVideoStopLoading = useCallback((videoId) => {
    setLoadingVideos((prev) => {
      const ns = new Set(prev);
      ns.delete(videoId);
      return ns;
    });
  }, []);

  const handleVideoVisibilityChange = useCallback((videoId, isVisible) => {
    setVisibleVideos((prev) => {
      const ns = new Set(prev);
      if (isVisible) ns.add(videoId);
      else ns.delete(videoId);
      return ns;
    });
  }, []);

  const handleElectronFolderSelection = useCallback(
    async (folderPath) => {
      const api = window.electronAPI;
      if (!api?.readDirectory) return;

      try {
        console.log(
          "🔍 Starting folder selection with recursive =",
          recursiveMode
        );
        setIsLoadingFolder(true);
        setLoadingStage("Reading directory...");
        setLoadingProgress(10);
        await new Promise((r) => setTimeout(r, 100));

        await api.stopFolderWatch?.();

        setVideos([]);
        selection.clear();
        setVisibleVideos(new Set());
        setLoadedVideos(new Set());
        setLoadingVideos(new Set());
        setActualPlaying(new Set());

        setLoadingStage("Scanning for video files...");
        setLoadingProgress(30);
        await new Promise((r) => setTimeout(r, 200));

        console.log("📁 Calling readDirectory with:", {
          folderPath,
          recursiveMode,
        });
        const files = await api.readDirectory(folderPath, recursiveMode);
        console.log("📁 readDirectory returned:", files.length, "files");
        const normalizedFiles = files.map((file) =>
          normalizeVideoFromMain(file)
        );

        setLoadingStage(
          `Found ${files.length} videos — initializing masonry...`
        );
        setLoadingProgress(70);
        await new Promise((r) => setTimeout(r, 200));

        setVideos(normalizedFiles);
        await new Promise((r) => setTimeout(r, 300));

        setLoadingStage("Complete!");
        setLoadingProgress(100);
        await new Promise((r) => setTimeout(r, 250));
        setIsLoadingFolder(false);

        refreshTagList();

        const watchResult = await api.startFolderWatch?.(folderPath);
        if (watchResult?.success && __DEV__) console.log("👁️ watching folder");

        // record in recent folders AFTER successful open
        addRecentFolder(folderPath);
      } catch (e) {
        console.error("Error reading directory:", e);
        setIsLoadingFolder(false);
      }
    },
    [recursiveMode, addRecentFolder, selection, refreshTagList]
  );

  const handleFolderSelect = useCallback(async () => {
    const res = await window.electronAPI?.selectFolder?.();
    if (res?.folderPath) await handleElectronFolderSelection(res.folderPath);
  }, [handleElectronFolderSelection]);

  const handleWebFileSelection = useCallback(
    (event) => {
      const files = Array.from(event.target.files || []).filter((f) => {
        const isVideoType = f.type.startsWith("video/");
        const hasExt = /\.(mp4|mov|avi|mkv|webm|m4v|flv|wmv|3gp|ogv)$/i.test(
          f.name
        );
        return isVideoType || hasExt;
      });
      const list = files.map((f) => ({
        id: f.name + f.size,
        name: f.name,
        file: f,
        loaded: false,
        isElectronFile: false,
        basename: f.name,
        dirname: "",
        createdMs: f.lastModified || 0,
        fingerprint: null,
        tags: [],
        rating: null,
      }));
      setVideos(list);
      selection.clear();
      setVisibleVideos(new Set());
      setLoadedVideos(new Set());
      setLoadingVideos(new Set());
      setActualPlaying(new Set());
    },
    [selection]
  );

  const toggleRecursive = useCallback(() => {
    const next = !recursiveMode;
    setRecursiveMode(next);
    window.electronAPI?.saveSettingsPartial?.({
      recursiveMode: next,
      maxConcurrentPlaying,
      zoomLevel,
      showFilenames,
    });
  }, [recursiveMode, maxConcurrentPlaying, zoomLevel, showFilenames]);

  const toggleFilenames = useCallback(() => {
    const next = !showFilenames;
    setShowFilenames(next);
    window.electronAPI?.saveSettingsPartial?.({
      showFilenames: next,
      recursiveMode,
      maxConcurrentPlaying,
      zoomLevel,
    });
  }, [showFilenames, recursiveMode, maxConcurrentPlaying, zoomLevel]);

  const handleVideoLimitChange = useCallback(
    (n) => {
      setMaxConcurrentPlaying(n);
      window.electronAPI?.saveSettingsPartial?.({
        maxConcurrentPlaying: n,
        recursiveMode,
        zoomLevel,
        showFilenames,
      });
    },
    [recursiveMode, zoomLevel, showFilenames]
  );

  const handleSortChange = useCallback(
    (value) => {
      const { sortKey: key, sortDir: dir } = parseSortValue(value);
      setSortKey(key);
      setSortDir(dir);
      let seed = randomSeed;
      if (key === SortKey.RANDOM && seed == null) {
        seed = Date.now();
        setRandomSeed(seed);
      }
      window.electronAPI?.saveSettingsPartial?.({
        sortKey: key,
        sortDir: dir,
        groupByFolders,
        randomSeed: seed,
      });
    },
    [groupByFolders, randomSeed]
  );

  const toggleGroupByFolders = useCallback(() => {
    const next = !groupByFolders;
    setGroupByFolders(next);
    window.electronAPI?.saveSettingsPartial?.({
      sortKey,
      sortDir,
      groupByFolders: next,
      randomSeed,
    });
  }, [groupByFolders, sortKey, sortDir, randomSeed]);

  const reshuffleRandom = useCallback(() => {
    const seed = Date.now();
    setRandomSeed(seed);
    window.electronAPI?.saveSettingsPartial?.({
      sortKey,
      sortDir,
      groupByFolders,
      randomSeed: seed,
    });
  }, [sortKey, sortDir, groupByFolders]);

  // Selection via clicks on cards (single / ctrl-multi / shift-range / double → fullscreen)
  const handleVideoSelect = useCallback(
    (videoId, isCtrlClick, isShiftClick, isDoubleClick) => {
      const video = getById(videoId);
      if (isDoubleClick && video) {
        openFullScreen(video, videoCollection.playingVideos);
        return;
      }
      if (isShiftClick) {
        // Shift: range selection (additive if Ctrl also held)
        selection.selectRange(
          orderForRange,
          videoId,
          /* additive */ isCtrlClick
        );
        return;
      }
      if (isCtrlClick) {
        // Ctrl only: toggle
        selection.toggle(videoId);
      } else {
        // Plain click: single select + set anchor
        selection.selectOnly(videoId);
      }
    },
    [
      getById,
      openFullScreen,
      videoCollection.playingVideos,
      selection,
      orderForRange,
    ]
  );

  // Right-click on a card: select it (if not in selection) and open menu
  const handleCardContextMenu = useCallback(
    (e, video) => {
      const isSelected = selection.selected.has(video.id);
      showOnItem(e, video.id, isSelected, selection.selectOnly);
    },
    [selection.selected, selection.selectOnly, showOnItem]
  );

  // Right-click on empty background: clear selection and open menu
  const handleBackgroundContextMenu = useCallback(
    (e) => showOnEmpty(e, selection.clear),
    [showOnEmpty, selection.clear]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && isLoadingFolder) setIsLoadingFolder(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isLoadingFolder]);

  // cleanup pass from videoCollection
  // drive the effect by stable scalars; apply deletions, not replacement; de-bounce one tick
  const maxLoaded = videoCollection.limits?.maxLoaded ?? 0;                 
  const loadedSize = loadedVideos.size;                                    
  const playingSize = actualPlaying.size;                                  
  const loadingSize = loadingVideos.size;                                   

  useEffect(() => {
    if (isLayoutTransitioning) return undefined;
    const id = setTimeout(() => {
      const victims = videoCollection.performCleanup?.();
      if (Array.isArray(victims) && victims.length) {
        setLoadedVideos((prev) => {
          const ns = new Set(prev);
          for (const vid of victims) ns.delete(vid);
          return ns;
        });
      }
    }, 0);
    return () => clearTimeout(id);
  }, [
    isLayoutTransitioning,
    maxLoaded,
    loadedSize,
    playingSize,
    loadingSize,
    videoCollection.performCleanup,
  ]);

  return (
    <div className="app" onContextMenu={handleBackgroundContextMenu}>
      {!settingsLoaded ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            color: "#888",
          }}
        >
          Loading settings...
        </div>
      ) : (
        <>
          {/* Memory Alert */}
          <MemoryAlert memStatus={videoCollection.memoryStatus} />

          {/* Loading overlay */}
          <LoadingOverlay
            show={isLoadingFolder}
            stage={loadingStage}
            progress={loadingProgress}
          />

          <HeaderBar
            isLoadingFolder={isLoadingFolder}
            handleFolderSelect={handleFolderSelect}
            handleWebFileSelection={handleWebFileSelection}
            recursiveMode={recursiveMode}
            toggleRecursive={toggleRecursive}
            showFilenames={showFilenames}
            toggleFilenames={toggleFilenames}
            maxConcurrentPlaying={maxConcurrentPlaying}
            handleVideoLimitChange={handleVideoLimitChange}
            zoomLevel={zoomLevel}
            handleZoomChangeSafe={handleZoomChangeSafe}
            getMinimumZoomLevel={getMinimumZoomLevel}
            sortKey={sortKey}
            sortSelection={formatSortValue(sortKey, sortDir)}
            groupByFolders={groupByFolders}
            onSortChange={handleSortChange}
            onGroupByFoldersToggle={toggleGroupByFolders}
            onReshuffle={reshuffleRandom}
            recentFolders={recentFolders}
            onRecentOpen={(path) => handleElectronFolderSelection(path)}
            hasOpenFolder={videos.length > 0}
            onFiltersToggle={() => setFiltersOpen((open) => !open)}
            filtersActiveCount={filtersActiveCount}
            filtersAreOpen={isFiltersOpen}
            filtersButtonRef={filtersButtonRef}
          />

          {isFiltersOpen && (
            <FiltersPopover
              ref={filtersPopoverRef}
              filters={filters}
              availableTags={availableTags}
              onChange={updateFilters}
              onReset={resetFilters}
              onClose={() => setFiltersOpen(false)}
            />
          )}

          {filtersActiveCount > 0 && (
            <div className="filters-summary">
              {filters.includeTags.length > 0 && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Include</span>
                  <div className="filters-summary__chips">
                    {filters.includeTags.map((tag) => (
                      <button
                        type="button"
                        key={`include-${tag}`}
                        className="filters-summary__chip filters-summary__chip--include"
                        onClick={() => handleRemoveIncludeFilter(tag)}
                        title={`Remove include filter for ${tag}`}
                      >
                        #{tag}
                        <span className="filters-summary__chip-remove">×</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {filters.excludeTags.length > 0 && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Exclude</span>
                  <div className="filters-summary__chips">
                    {filters.excludeTags.map((tag) => (
                      <button
                        type="button"
                        key={`exclude-${tag}`}
                        className="filters-summary__chip filters-summary__chip--exclude"
                        onClick={() => handleRemoveExcludeFilter(tag)}
                        title={`Remove exclude filter for ${tag}`}
                      >
                        #{tag}
                        <span className="filters-summary__chip-remove">×</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {ratingSummary && (
                <div className="filters-summary__section">
                  <span className="filters-summary__label">Rating</span>
                  <div className="filters-summary__chips">
                    <button
                      type="button"
                      className="filters-summary__chip filters-summary__chip--rating"
                      onClick={ratingSummary.onClear}
                      title="Clear rating filter"
                    >
                      {ratingSummary.label}
                      <span className="filters-summary__chip-remove">×</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <DebugSummary
            total={videoCollection.stats.total}
            rendered={videoCollection.stats.rendered}
            playing={videoCollection.stats.playing}
            inView={visibleVideos.size}
            memoryStatus={videoCollection.memoryStatus}
            zoomLevel={zoomLevel}
            getMinimumZoomLevel={getMinimumZoomLevel}
            sortStatus={sortStatus}
          />

          {/* Home state: Recent Locations when nothing is loaded */}
          {videos.length === 0 && !isLoadingFolder ? (
            <>
              <RecentFolders
                items={recentFolders}
                onOpen={(path) => handleElectronFolderSelection(path)}
                onRemove={removeRecentFolder}
                onClear={clearRecentFolders}
              />
              <div className="drop-zone">
                <h2>🐝 Welcome to Video Swarm 🐝</h2>
                <p>
                  Click "Select Folder" above to browse your video collection
                </p>
                {window.innerWidth > 2560 && (
                  <p style={{ color: "#ffa726", fontSize: "0.9rem" }}>
                    🖥️ Large display detected - zoom will auto-adjust for memory
                    safety
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="content-region" ref={contentRegionRef}>
              <div
                className="content-region__viewport"
                ref={scrollContainerRef}
              >
                <div
                  ref={gridRef}
                className={`video-grid masonry-vertical ${
                    !showFilenames ? "hide-filenames" : ""
                  } ${zoomClassForLevel(zoomLevel)}`}
              >
                {orderedVideos.length === 0 &&
                  videos.length > 0 &&
                  !isLoadingFolder && (
                    <div className="filters-empty-state">
                      No videos match your current filters.
                    </div>
                  )}

                {videoCollection.videosToRender.map((video) => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    observeIntersection={ioRegistry.observe}
                    unobserveIntersection={ioRegistry.unobserve}
                    scrollRootRef={scrollContainerRef}
                    selected={selection.selected.has(video.id)}
                    onSelect={(...args) => handleVideoSelect(...args)}
                    onContextMenu={handleCardContextMenu}
                    onNativeDragStart={handleNativeDragStart}
                    showFilenames={showFilenames}
                    // Video Collection Management
                    canLoadMoreVideos={(opts) =>
                      videoCollection.canLoadVideo(video.id, opts)
                    }
                    isLoading={loadingVideos.has(video.id)}
                    isLoaded={loadedVideos.has(video.id)}
                    isVisible={visibleVideos.has(video.id)}
                    isPlaying={videoCollection.isVideoPlaying(video.id)}
                    isNear={ioRegistry.isNear}
                    forceLoadEpoch={forcedLoadMap?.get(video.id) ?? 0}
                    // Lifecycle callbacks
                    onStartLoading={handleVideoStartLoading}
                    onStopLoading={handleVideoStopLoading}
                    onVideoLoad={handleVideoLoaded}
                    onVisibilityChange={handleVideoVisibilityChange}
                    // Media events → update orchestrator + actual playing count
                    onVideoPlay={(id) => {
                      videoCollection.reportStarted(id);
                      setActualPlaying((prev) => {
                        const next = new Set(prev);
                        next.add(id);
                        return next;
                      });
                    }}
                    onVideoPause={(id) => {
                      setActualPlaying((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                      });
                    }}
                    onPlayError={(id) => {
                      videoCollection.reportPlayError(id);
                      setActualPlaying((prev) => {
                        const next = new Set(prev);
                        next.delete(id);
                        return next;
                      });
                    }}
                    // Hover for priority
                    onHover={(id) => videoCollection.markHover(id)}
                    scheduleInit={scheduleInit}
                  />
                ))}
                </div>
              </div>
              <MetadataPanel
                ref={metadataPanelRef}
                isOpen={isMetadataPanelOpen && selection.size > 0}
                onToggle={toggleMetadataPanel}
                selectionCount={selection.size}
                selectedVideos={selectedVideos}
                availableTags={availableTags}
                onAddTag={handleAddTags}
                onRemoveTag={handleRemoveTag}
                onApplyTagToSelection={handleApplyExistingTag}
                onSetRating={handleSetRating}
                onClearRating={handleClearRating}
                focusToken={metadataFocusToken}
              />
            </div>
          )}

          {fullScreenVideo && (
            <FullScreenModal
              video={fullScreenVideo}
              onClose={() => closeFullScreen()}
              onNavigate={navigateFullScreen}
              showFilenames={showFilenames}
              gridRef={gridRef}
            />
          )}

          {contextMenu.visible && (
            <ContextMenu
              visible={contextMenu.visible}
              position={contextMenu.position}
              contextId={contextMenu.contextId}
              getById={getById}
              selectionCount={selection.size}
              electronAPI={window.electronAPI}
              onClose={hideContextMenu}
              onAction={handleContextAction}
            />
          )}
        </>
      )}
    </div>
  );
}

export default App;
