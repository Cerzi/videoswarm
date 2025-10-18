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
  const [scrollRowsEstimate, setScrollRowsEstimate] = useState(0);
  const [visualOrderedIds, setVisualOrderedIds] = useState([]);
  const metadataAspectCacheRef = useRef(new Map());
  const masonryRefreshRafRef = useRef(0);
  const [ioConfig, setIoConfig] = useState({ rootMargin: "1600px 0px", nearPx: 900 });
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [layoutHoldCount, setLayoutHoldCount] = useState(0);
  const layoutSummaryRef = useRef({ totalHeight: 0, metrics: null });
  const measuredPositionsRef = useRef([]);
  const itemPositionMapRef = useRef(new Map());

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

  const handleMasonryLayoutComplete = useCallback(
    (info = {}) => {
      if (info && Array.isArray(info.positions)) {
        const map = itemPositionMapRef.current;
        info.positions.forEach((pos) => {
          if (!pos || !pos.id) return;
          map.set(pos.id, {
            y: Number.isFinite(pos.y) ? pos.y : 0,
            height: Number.isFinite(pos.height) ? pos.height : 0,
          });
        });
        measuredPositionsRef.current = info.positions.slice();
      }

      if (info && (Number.isFinite(info.maxHeight) || info.metrics)) {
        const nextSummary = {
          totalHeight: Number.isFinite(info.maxHeight)
            ? info.maxHeight
            : layoutSummaryRef.current.totalHeight,
          metrics: info.metrics || layoutSummaryRef.current.metrics,
        };
        layoutSummaryRef.current = nextSummary;
      }

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
    },
    [ioRegistry, bumpLayoutEpoch]
  );

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

  const bufferRows = useMemo(() => Math.max(3, Math.ceil(viewportRows)), [viewportRows]);

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

  const orderIndexMap = useMemo(() => {
    const map = new Map();
    orderForRange.forEach((id, idx) => {
      if (!id) return;
      map.set(id, idx);
    });
    return map;
  }, [orderForRange]);

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

  const getEstimatedOffsetForIndex = useCallback(
    (index) => {
      if (!orderForRange.length) return 0;
      const clampedIndex = Math.max(
        0,
        Math.min(orderForRange.length - 1, Math.floor(index ?? 0))
      );
      const id = orderForRange[clampedIndex];
      if (id) {
        const pos = itemPositionMapRef.current.get(id);
        if (pos && Number.isFinite(pos.y)) {
          return pos.y;
        }
      }

      const summary = layoutSummaryRef.current;
      const metrics = summary.metrics || masonryMetrics;
      const columnCount = Math.max(
        1,
        Number.isFinite(metrics?.columnCount)
          ? metrics.columnCount
          : derivedColumnCount || 1
      );
      const columnGap = Number.isFinite(metrics?.columnGap)
        ? metrics.columnGap
        : Number.isFinite(masonryMetrics.columnGap)
        ? masonryMetrics.columnGap
        : 0;
      const approxHeight = approxTileHeight + columnGap;
      const approxRow = Math.floor(clampedIndex / Math.max(1, columnCount));
      return approxRow * Math.max(1, approxHeight);
    },
    [
      orderForRange,
      approxTileHeight,
      derivedColumnCount,
      masonryMetrics.columnGap,
    ]
  );

  const getEstimatedIndexForOffset = useCallback(
    (offset) => {
      if (!orderForRange.length || !Number.isFinite(offset)) {
        return 0;
      }

      const measured = measuredPositionsRef.current;
      if (measured.length) {
        const first = measured[0];
        const last = measured[measured.length - 1];
        if (first && Number.isFinite(first.y) && offset <= first.y) {
          const idx = orderIndexMap.get(first.id);
          if (typeof idx === "number") {
            return idx;
          }
        }
        if (last && Number.isFinite(last.y) && offset >= last.y) {
          const idx = orderIndexMap.get(last.id);
          if (typeof idx === "number") {
            return idx;
          }
        }

        let low = 0;
        let high = measured.length - 1;
        let bestIdx = 0;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const value = measured[mid]?.y ?? 0;
          if (value <= offset) {
            bestIdx = mid;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        const candidate = measured[Math.min(bestIdx, measured.length - 1)];
        if (candidate) {
          const idx = orderIndexMap.get(candidate.id);
          if (typeof idx === "number") {
            return idx;
          }
        }
      }

      const summary = layoutSummaryRef.current;
      const metrics = summary.metrics || masonryMetrics;
      const columnCount = Math.max(
        1,
        Number.isFinite(metrics?.columnCount)
          ? metrics.columnCount
          : derivedColumnCount || 1
      );
      const columnGap = Number.isFinite(metrics?.columnGap)
        ? metrics.columnGap
        : Number.isFinite(masonryMetrics.columnGap)
        ? masonryMetrics.columnGap
        : 0;
      const approxHeight = approxTileHeight + columnGap;
      const approxRow = Math.floor(offset / Math.max(1, approxHeight));
      const approxIndex = approxRow * Math.max(1, columnCount);
      return Math.max(
        0,
        Math.min(orderForRange.length - 1, Math.floor(approxIndex))
      );
    },
    [
      orderForRange,
      orderIndexMap,
      approxTileHeight,
      derivedColumnCount,
      masonryMetrics.columnGap,
    ]
  );

  const getScrollHeightEstimate = useCallback(() => {
    const summary = layoutSummaryRef.current;
    if (Number.isFinite(summary.totalHeight) && summary.totalHeight > 0) {
      return summary.totalHeight;
    }
    const columnGap = Number.isFinite(masonryMetrics.columnGap)
      ? masonryMetrics.columnGap
      : 0;
    const columnCount = Math.max(1, derivedColumnCount || 1);
    const approxRows = Math.ceil(orderForRange.length / columnCount);
    return approxRows * (approxTileHeight + columnGap);
  }, [
    approxTileHeight,
    derivedColumnCount,
    masonryMetrics.columnGap,
    orderForRange.length,
  ]);

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
    withLayoutHold,
    isLayoutTransitioning,
    getEstimatedOffsetForIndex,
    getEstimatedIndexForOffset,
    getScrollHeightEstimate,
    viewportHeightPx: viewportHeight,
  };
}
