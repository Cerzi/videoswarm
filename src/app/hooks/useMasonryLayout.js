import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import useIntersectionObserverRegistry from "../../hooks/ui-perf/useIntersectionObserverRegistry";
import {
  computeMasonryLayout,
  getScrollTopForItem,
  getVirtualMasonryWindow,
} from "../../layout/masonryLayout";
import {
  SortKey,
  buildComparator,
  groupAndSort,
  buildRandomOrderMap,
} from "../../sorting/sorting.js";
import { clampZoomIndex } from "../../zoom/utils.js";
import { ZOOM_TILE_WIDTHS } from "../../zoom/config";

const IO_ROOT_MARGIN = "100% 0px 100% 0px";
const IO_THRESHOLDS = Object.freeze([0, 0.15]);
const EMPTY_IDS = Object.freeze([]);
const DEFAULT_ASPECT_RATIO = 16 / 9;
const LAYOUT_PADDING = 16;
const LAYOUT_GAP = 4;
const MAX_ACTIVATION_TARGET = 600;
export const MAX_MASONRY_ASPECT_OVERRIDES = 4096;

const setBoundedLruEntry = (map, key, value, limit) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
};

const requestFrame = (callback) => {
  if (typeof requestAnimationFrame === "function") {
    return { type: "raf", id: requestAnimationFrame(callback) };
  }
  return { type: "timeout", id: setTimeout(callback, 0) };
};

const cancelFrame = (handle) => {
  if (!handle) return;
  if (handle.type === "raf" && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle.id);
  } else {
    clearTimeout(handle.id);
  }
};

const normalizeDateValue = (value) => {
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const fileSignature = (video) =>
  `${video?.fullPath ?? video?.relativePath ?? video?.id ?? ""}::${
    Number(video?.size) || 0
  }::${normalizeDateValue(video?.dateModified)}`;

const baseAspectRatio = (video) => {
  const direct = Number(video?.aspectRatio);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const dimensionRatio = Number(video?.dimensions?.aspectRatio);
  if (Number.isFinite(dimensionRatio) && dimensionRatio > 0) {
    return dimensionRatio;
  }

  const width = Number(video?.dimensions?.width);
  const height = Number(video?.dimensions?.height);
  if (
    Number.isFinite(width) &&
    width > 0 &&
    Number.isFinite(height) &&
    height > 0
  ) {
    return width / height;
  }

  return DEFAULT_ASPECT_RATIO;
};

const normalizeRenderLimit = (renderLimit, length) => {
  if (renderLimit == null) return length;
  const number = Number(renderLimit);
  if (!Number.isFinite(number)) return length;
  return Math.max(0, Math.min(length, Math.floor(number)));
};

function findSurvivingAnchor(previousLayout, nextLayout, scrollTop, viewportHeight) {
  if (!previousLayout?.positions?.length || !nextLayout?.positionsById?.size) {
    return null;
  }

  const visible = getVirtualMasonryWindow(previousLayout, {
    scrollTop,
    viewportHeight,
    overscanPx: 0,
  });
  const firstVisible = visible[0] || null;
  if (firstVisible && nextLayout.positionsById.has(firstVisible.id)) {
    return firstVisible;
  }

  const previousOrder = previousLayout.visualOrderIds || [];
  const startIndex = firstVisible
    ? Math.max(0, previousOrder.indexOf(firstVisible.id))
    : 0;

  for (let index = startIndex; index < previousOrder.length; index += 1) {
    const id = previousOrder[index];
    if (nextLayout.positionsById.has(id)) {
      return previousLayout.positionsById.get(id) || null;
    }
  }
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const id = previousOrder[index];
    if (nextLayout.positionsById.has(id)) {
      return previousLayout.positionsById.get(id) || null;
    }
  }

  return null;
}

export function useMasonryLayout({
  videos = EMPTY_IDS,
  filteredVideos = EMPTY_IDS,
  sortKey,
  sortDir,
  groupByFolders,
  randomSeed,
  zoomLevel,
  scrollContainerRef,
  gridRef,
  scrollContainerElement = null,
  gridElement = null,
  renderLimit = null,
  pinnedIds = EMPTY_IDS,
}) {
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [aspectRevision, setAspectRevision] = useState(0);
  const [layoutHoldCount, setLayoutHoldCount] = useState(0);

  const layoutRef = useRef(null);
  const previousLayoutRef = useRef(null);
  const viewportHeightRef = useRef(0);
  const signatureByIdRef = useRef(new Map());
  const aspectOverridesRef = useRef(new Map());
  const pendingAspectOverridesRef = useRef(new Map());
  const aspectFlushFrameRef = useRef(null);
  const scrollFrameRef = useRef(null);
  const ioRefreshFrameRef = useRef(null);

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

  const measureViewport = useCallback(() => {
    const scrollEl = scrollContainerElement || scrollContainerRef?.current;
    const gridEl = gridElement || gridRef?.current;
    const height =
      scrollEl?.clientHeight ||
      (typeof window !== "undefined" ? window.innerHeight : 0);
    const width =
      gridEl?.clientWidth ||
      scrollEl?.clientWidth ||
      (typeof window !== "undefined" ? window.innerWidth : 0);

    setViewportSize((previous) =>
      previous.width === width && previous.height === height
        ? previous
        : { width, height }
    );

    if (scrollEl) {
      const nextScrollTop = Math.max(0, Number(scrollEl.scrollTop) || 0);
      setScrollTop((previous) =>
        Math.abs(previous - nextScrollTop) > 0.5 ? nextScrollTop : previous
      );
    }
  }, [gridElement, gridRef, scrollContainerElement, scrollContainerRef]);

  useEffect(() => {
    const scrollEl = scrollContainerElement || scrollContainerRef?.current;
    const gridEl = gridElement || gridRef?.current;
    measureViewport();

    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => measureViewport())
        : null;
    if (observer) {
      if (scrollEl) observer.observe(scrollEl);
      if (gridEl && gridEl !== scrollEl) observer.observe(gridEl);
    }

    if (typeof window !== "undefined") {
      window.addEventListener("resize", measureViewport);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", measureViewport);
      }
      observer?.disconnect();
    };
  }, [gridElement, gridRef, measureViewport, scrollContainerElement, scrollContainerRef]);

  useEffect(() => {
    const scrollEl = scrollContainerElement || scrollContainerRef?.current;
    if (!scrollEl) return undefined;

    const updateScrollTop = () => {
      scrollFrameRef.current = null;
      const next = Math.max(0, Number(scrollEl.scrollTop) || 0);
      setScrollTop((previous) =>
        Math.abs(previous - next) > 0.5 ? next : previous
      );
    };
    const handleScroll = () => {
      if (!scrollFrameRef.current) {
        scrollFrameRef.current = requestFrame(updateScrollTop);
      }
    };

    scrollEl.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", handleScroll);
      cancelFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    };
  }, [scrollContainerElement, scrollContainerRef]);

  const randomOrderMap = useMemo(
    () =>
      sortKey === SortKey.RANDOM
        ? buildRandomOrderMap(
            (Array.isArray(videos) ? videos : []).map((video) => video.id),
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
    () =>
      groupAndSort(Array.isArray(filteredVideos) ? filteredVideos : [], {
        groupByFolders,
        comparator,
      }),
    [filteredVideos, groupByFolders, comparator]
  );

  const orderedIds = useMemo(
    () => orderedVideos.map((video) => video.id),
    [orderedVideos]
  );
  const layoutVideos = useMemo(
    () => orderedVideos.slice(0, normalizeRenderLimit(renderLimit, orderedVideos.length)),
    [orderedVideos, renderLimit]
  );

  const signatureState = useMemo(() => {
    const signatures = new Map();
    layoutVideos.forEach((video) => {
      if (video?.id != null) signatures.set(video.id, fileSignature(video));
    });
    signatureByIdRef.current = signatures;
    return signatures;
  }, [layoutVideos]);

  useEffect(() => {
    const current = aspectOverridesRef.current;
    const next = new Map();
    current.forEach((entry, id) => {
      if (signatureState.get(id) === entry.signature) {
        setBoundedLruEntry(
          next,
          id,
          entry,
          MAX_MASONRY_ASPECT_OVERRIDES
        );
      }
    });
    if (next.size !== current.size) {
      aspectOverridesRef.current = next;
      setAspectRevision((revision) => revision + 1);
    }

    const pendingCurrent = pendingAspectOverridesRef.current;
    const pendingNext = new Map();
    pendingCurrent.forEach((entry, id) => {
      if (signatureState.get(id) === entry.signature) {
        setBoundedLruEntry(
          pendingNext,
          id,
          entry,
          MAX_MASONRY_ASPECT_OVERRIDES
        );
      }
    });
    if (pendingNext.size !== pendingCurrent.size) {
      pendingAspectOverridesRef.current = pendingNext;
    }
  }, [signatureState]);

  const targetTileWidth =
    ZOOM_TILE_WIDTHS[clampZoomIndex(zoomLevel)] ?? ZOOM_TILE_WIDTHS[1] ?? 200;
  const containerWidth = Math.max(
    1,
    viewportSize.width ||
      (typeof window !== "undefined" ? window.innerWidth : targetTileWidth)
  );

  const layout = useMemo(
    () =>
      computeMasonryLayout(layoutVideos, {
        containerWidth,
        targetTileWidth,
        padding: LAYOUT_PADDING,
        gap: LAYOUT_GAP,
        getAspectRatio: (video) => {
          const override = aspectOverridesRef.current.get(video?.id);
          const signature = signatureState.get(video?.id);
          return override?.signature === signature
            ? override.ratio
            : baseAspectRatio(video);
        },
      }),
    [aspectRevision, containerWidth, layoutRevision, layoutVideos, signatureState, targetTileWidth]
  );
  layoutRef.current = layout;

  const viewportHeight = Math.max(
    0,
    viewportSize.height ||
      (typeof window !== "undefined" ? window.innerHeight : 0)
  );
  viewportHeightRef.current = viewportHeight;

  useLayoutEffect(() => {
    const previousLayout = previousLayoutRef.current;
    const scrollEl = scrollContainerElement || scrollContainerRef?.current;

    if (previousLayout && previousLayout !== layout && scrollEl) {
      const currentScrollTop = Math.max(0, Number(scrollEl.scrollTop) || 0);
      const anchor = findSurvivingAnchor(
        previousLayout,
        layout,
        currentScrollTop,
        viewportHeight
      );
      const nextAnchor = anchor ? layout.positionsById.get(anchor.id) : null;
      if (anchor && nextAnchor) {
        const maximumScrollTop = Math.max(0, layout.totalHeight - viewportHeight);
        const adjusted = Math.max(
          0,
          Math.min(maximumScrollTop, currentScrollTop + nextAnchor.y - anchor.y)
        );
        if (Math.abs(adjusted - currentScrollTop) > 0.5) {
          scrollEl.scrollTop = adjusted;
          setScrollTop(adjusted);
        }
      }
    }

    previousLayoutRef.current = layout;
  }, [layout, scrollContainerElement, scrollContainerRef, viewportHeight]);

  const activationPositions = useMemo(
    () =>
      getVirtualMasonryWindow(layout, {
        scrollTop,
        viewportHeight,
        overscanPx: viewportHeight,
      }),
    [layout, scrollTop, viewportHeight]
  );
  const activationIds = useMemo(
    () => activationPositions.map((position) => position.id),
    [activationPositions]
  );
  const centerPriorityIds = useMemo(() => {
    const viewportCenter = scrollTop + viewportHeight / 2;
    return activationPositions
      .map((position, index) => ({
        id: position.id,
        index,
        distance: Math.abs(
          position.y + position.height / 2 - viewportCenter
        ),
      }))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.index - right.index
      )
      .map((entry) => entry.id);
  }, [activationPositions, scrollTop, viewportHeight]);
  const activationIdSet = useMemo(() => new Set(activationIds), [activationIds]);

  const virtualItems = useMemo(
    () =>
      getVirtualMasonryWindow(layout, {
        scrollTop,
        viewportHeight,
        overscanPx: viewportHeight,
        pinnedIds,
      }),
    [layout, pinnedIds, scrollTop, viewportHeight]
  );

  const visualOrderedIds = layout.visualOrderIds;
  const orderForRange = visualOrderedIds;
  const activationTarget = Math.min(
    MAX_ACTIVATION_TARGET,
    activationIds.length
  );
  const progressiveMaxVisibleNumber = activationTarget || undefined;

  const averageAspectRatio = useMemo(() => {
    const sample = layoutVideos.slice(0, 80);
    if (!sample.length) return DEFAULT_ASPECT_RATIO;
    const total = sample.reduce((sum, video) => {
      const override = aspectOverridesRef.current.get(video?.id);
      const signature = signatureState.get(video?.id);
      const value = override?.signature === signature
        ? override.ratio
        : baseAspectRatio(video);
      return sum + Math.max(0.25, Math.min(4, value));
    }, 0);
    return total / sample.length;
  }, [aspectRevision, layoutVideos, signatureState]);
  const approxTileHeight = Math.max(
    48,
    layout.columnWidth / Math.max(0.25, averageAspectRatio)
  );
  const viewportRows = Math.max(
    1,
    Math.ceil(viewportHeight / Math.max(1, approxTileHeight))
  );

  const nearPx = useMemo(() => {
    const mediumWidth = ZOOM_TILE_WIDTHS[1] ?? ZOOM_TILE_WIDTHS[0] ?? 200;
    const scale = Math.max(
      0.45,
      Math.min(1.6, Math.max(80, layout.columnWidth) / mediumWidth)
    );
    return Math.max(360, Math.round(Math.max(480, viewportHeight) * scale));
  }, [layout.columnWidth, viewportHeight]);

  const ioRootRef = useMemo(
    () => ({
      current: scrollContainerElement || scrollContainerRef?.current || null,
    }),
    [scrollContainerElement, scrollContainerRef]
  );
  const ioRegistry = useIntersectionObserverRegistry(ioRootRef, {
    rootMargin: IO_ROOT_MARGIN,
    threshold: IO_THRESHOLDS,
    nearPx,
  });

  useEffect(() => {
    ioRegistry?.setNearPx?.(nearPx);
  }, [ioRegistry, nearPx]);

  useEffect(() => {
    cancelFrame(ioRefreshFrameRef.current);
    ioRefreshFrameRef.current = requestFrame(() => {
      ioRefreshFrameRef.current = null;
      ioRegistry?.refresh?.();
    });
    return () => {
      cancelFrame(ioRefreshFrameRef.current);
      ioRefreshFrameRef.current = null;
    };
  }, [ioRegistry, layout, virtualItems]);

  const updateAspectRatio = useCallback((id, aspectRatio) => {
    const ratio = Number(aspectRatio);
    const signature = signatureByIdRef.current.get(id);
    if (!signature || !Number.isFinite(ratio) || ratio <= 0) return;

    setBoundedLruEntry(
      pendingAspectOverridesRef.current,
      id,
      { ratio, signature },
      MAX_MASONRY_ASPECT_OVERRIDES
    );
    if (aspectFlushFrameRef.current) return;

    aspectFlushFrameRef.current = requestFrame(() => {
      aspectFlushFrameRef.current = null;
      const pending = pendingAspectOverridesRef.current;
      pendingAspectOverridesRef.current = new Map();
      let changed = false;
      const next = new Map(aspectOverridesRef.current);
      pending.forEach((entry, pendingId) => {
        if (signatureByIdRef.current.get(pendingId) !== entry.signature) return;
        const previous = next.get(pendingId);
        if (
          previous?.signature === entry.signature &&
          previous?.ratio === entry.ratio
        ) {
          return;
        }
        setBoundedLruEntry(
          next,
          pendingId,
          entry,
          MAX_MASONRY_ASPECT_OVERRIDES
        );
        changed = true;
      });
      if (changed) {
        aspectOverridesRef.current = next;
        setAspectRevision((revision) => revision + 1);
      }
    });
  }, []);

  useEffect(
    () => () => {
      cancelFrame(aspectFlushFrameRef.current);
      cancelFrame(ioRefreshFrameRef.current);
      cancelFrame(scrollFrameRef.current);
      aspectFlushFrameRef.current = null;
      ioRefreshFrameRef.current = null;
      scrollFrameRef.current = null;
      pendingAspectOverridesRef.current.clear();
    },
    []
  );

  const scheduleLayout = useCallback(() => {
    measureViewport();
    setLayoutRevision((revision) => revision + 1);
  }, [measureViewport]);
  const onItemsChanged = scheduleLayout;
  const setZoomClass = useCallback(() => {
    scheduleLayout();
  }, [scheduleLayout]);

  const getPositionById = useCallback(
    (id) => layoutRef.current?.positionsById?.get(id) || null,
    []
  );
  const scrollToId = useCallback(
    (id, options = {}) => {
      const scrollEl = scrollContainerElement || scrollContainerRef?.current;
      if (!scrollEl) return false;
      const next = getScrollTopForItem(layoutRef.current, id, {
        viewportHeight: viewportHeightRef.current,
        align: options.align || "center",
      });
      if (next == null) return false;
      scrollEl.scrollTop = next;
      setScrollTop(next);
      return true;
    },
    [scrollContainerElement, scrollContainerRef]
  );

  const getCacheDebugSnapshot = useCallback(
    () => {
      const signatures = signatureByIdRef.current;
      return {
        aspectOverrideEntries: aspectOverridesRef.current.size,
        staleAspectOverrideEntries: Array.from(
          aspectOverridesRef.current.entries()
        ).filter(([id, entry]) => signatures.get(id) !== entry.signature).length,
        pendingAspectOverrideEntries: pendingAspectOverridesRef.current.size,
        stalePendingAspectOverrideEntries: Array.from(
          pendingAspectOverridesRef.current.entries()
        ).filter(([id, entry]) => signatures.get(id) !== entry.signature).length,
        currentSignatureEntries: signatures.size,
        maxAspectOverrideEntries: MAX_MASONRY_ASPECT_OVERRIDES,
      };
    },
    []
  );

  const viewportMetrics = useMemo(
    () => ({
      columnCount: layout.columnCount,
      viewportRows,
      approxTileHeight,
      viewportHeight,
      viewportWidth: containerWidth,
      scrollTop,
      totalHeight: layout.totalHeight,
    }),
    [
      approxTileHeight,
      containerWidth,
      layout.columnCount,
      layout.totalHeight,
      scrollTop,
      viewportHeight,
      viewportRows,
    ]
  );

  return {
    orderedVideos,
    displayVideos: layoutVideos,
    orderedIds,
    visualOrderedIds,
    orderForRange,
    ioRegistry,
    layoutEpoch: 0,
    scheduleLayout,
    updateAspectRatio,
    onItemsChanged,
    setZoomClass,
    progressiveMaxVisibleNumber,
    activationTarget,
    activationIds,
    centerPriorityIds,
    activationIdSet,
    virtualItems,
    totalHeight: layout.totalHeight,
    mountedVideoCount: virtualItems.length,
    viewportMetrics,
    getPositionById,
    scrollToId,
    getCacheDebugSnapshot,
    withLayoutHold,
    isLayoutTransitioning,
  };
}
