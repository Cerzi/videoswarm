import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import useChunkedMasonry from "../../hooks/useChunkedMasonry";
import useIntersectionObserverRegistry from "../../hooks/ui-perf/useIntersectionObserverRegistry";
import {
  SortKey,
  buildComparator,
  groupAndSort,
  buildRandomOrderMap,
} from "../../sorting/sorting.js";
import { clampZoomIndex, zoomClassForLevel } from "../../zoom/utils.js";
import { ZOOM_TILE_WIDTHS } from "../../zoom/config";

export function useMasonryLayout({
  videos,
  filteredVideos,
  sortKey,
  sortDir,
  groupByFolders,
  randomSeed,
  zoomLevel,
  scrollContainerRef,
  gridRef,
}) {
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [masonryMetrics, setMasonryMetrics] = useState({
    columnWidth: 0,
    columnCount: 0,
    columnGap: 0,
    gridWidth: 0,
  });
  const [scrollTop, setScrollTop] = useState(0);
  const [visualOrderedIds, setVisualOrderedIds] = useState([]);
  const metadataAspectCacheRef = useRef(new Map());
  const masonryRefreshRafRef = useRef(0);
  const [ioConfig, setIoConfig] = useState({
    rootMargin: "100% 0px 100% 0px",
    nearPx: 900,
  });
  const [layoutEpoch, setLayoutEpoch] = useState(0);
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

      if (currentScroll) {
        const top = currentScroll.scrollTop || 0;
        setScrollTop((prev) => (Math.abs(prev - top) > 0.5 ? top : prev));
      }
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

  const ioRegistry = useIntersectionObserverRegistry(scrollContainerRef, {
    rootMargin: ioConfig.rootMargin,
    threshold: [0, 0.15],
    nearPx: ioConfig.nearPx,
  });

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

  const bumpLayoutEpoch = useCallback(() => {
    setLayoutEpoch((prev) => (prev >= Number.MAX_SAFE_INTEGER ? 1 : prev + 1));
  }, []);

  const handleMasonryLayoutComplete = useCallback(() => {
    if (masonryRefreshRafRef.current && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(masonryRefreshRafRef.current);
    }

    const runRefresh = () => {
      masonryRefreshRafRef.current = 0;
      if (ioRegistry?.refresh) {
        ioRegistry.refresh();
      }
      bumpLayoutEpoch();
    };

    if (typeof requestAnimationFrame === "function") {
      masonryRefreshRafRef.current = requestAnimationFrame(runRefresh);
    } else {
      runRefresh();
    }
  }, [ioRegistry, bumpLayoutEpoch]);

  useEffect(
    () => () => {
      if (masonryRefreshRafRef.current && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(masonryRefreshRafRef.current);
        masonryRefreshRafRef.current = 0;
      }
    },
    []
  );

  useEffect(() => {
    bumpLayoutEpoch();
  }, [viewportSize.width, viewportSize.height, bumpLayoutEpoch]);

  const { updateAspectRatio, onItemsChanged, setZoomClass, scheduleLayout } =
    useChunkedMasonry({
      gridRef,
      zoomClassForLevel,
      getTileWidthForLevel: (level) =>
        ZOOM_TILE_WIDTHS[Math.max(0, Math.min(level, ZOOM_TILE_WIDTHS.length - 1))],
      onOrderChange: setVisualOrderedIds,
      onMetricsChange: handleMasonryMetrics,
      onLayoutComplete: handleMasonryLayoutComplete,
    });

  const randomOrderMap = useMemo(
    () =>
      sortKey === SortKey.RANDOM
        ? buildRandomOrderMap(videos.map((v) => v.id), randomSeed ?? Date.now())
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

  const orderedIds = useMemo(() => orderedVideos.map((v) => v.id), [orderedVideos]);

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
  }, [masonryMetrics.columnCount, masonryMetrics.gridWidth, viewportWidth, effectiveColumnWidth]);

  const viewportRows = useMemo(
    () => Math.max(1, Math.ceil(viewportHeight / Math.max(1, approxTileHeight))),
    [viewportHeight, approxTileHeight]
  );

  const viewportItems = useMemo(() => {
    if (!Number.isFinite(derivedColumnCount) || derivedColumnCount <= 0) {
      return null;
    }
    return derivedColumnCount * viewportRows;
  }, [derivedColumnCount, viewportRows]);

  const activationTarget = useMemo(() => {
    if (!Number.isFinite(viewportItems) || viewportItems <= 0) {
      return null;
    }
    const multiplier = 2;
    const desired = Math.ceil(viewportItems * multiplier);
    const min = 100;
    const max = 600;
    return Math.max(min, Math.min(max, desired));
  }, [viewportItems]);

  const progressiveMaxVisibleNumber = activationTarget || undefined;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    let rafId = 0;
    const updateScroll = () => {
      rafId = 0;
      const top = el.scrollTop || 0;
      setScrollTop((prev) => (Math.abs(prev - top) > 0.5 ? top : prev));
    };

    updateScroll();

    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(updateScroll);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [scrollContainerRef]);

  useEffect(() => {
    const mediumWidth = ZOOM_TILE_WIDTHS[1] ?? ZOOM_TILE_WIDTHS[0] ?? 200;
    const tileWidth = Math.max(80, effectiveColumnWidth || mediumWidth);
    const height = viewportHeight;
    const scale = Math.max(0.45, Math.min(1.6, tileWidth / mediumWidth));
    const nearPx = Math.max(360, Math.round(Math.max(480, height) * scale));
    const rootMargin = "100% 0px 100% 0px";
    setIoConfig((prev) =>
      prev.nearPx === nearPx && prev.rootMargin === rootMargin
        ? prev
        : { nearPx, rootMargin }
    );
  }, [effectiveColumnWidth, viewportHeight]);

  useEffect(() => {
    if (!ioRegistry) return undefined;
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

  const orderForRange = visualOrderedIds.length ? visualOrderedIds : orderedIds;

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

  const viewportMetrics = useMemo(
    () => ({
      columnCount: derivedColumnCount,
      viewportRows,
      approxTileHeight,
      viewportHeight,
      scrollTop,
    }),
    [derivedColumnCount, viewportRows, approxTileHeight, viewportHeight, scrollTop]
  );

  return {
    orderedVideos,
    orderedIds,
    visualOrderedIds,
    orderForRange,
    ioRegistry,
    layoutEpoch,
    scheduleLayout,
    updateAspectRatio,
    onItemsChanged,
    setZoomClass,
    progressiveMaxVisibleNumber,
    activationTarget,
    viewportMetrics,
    withLayoutHold,
    isLayoutTransitioning,
  };
}
