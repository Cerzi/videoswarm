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

const BLOCK_SIZE = 64;

const clampIndex = (index, length) => {
  if (!Number.isFinite(index) || length <= 0) return 0;
  if (index <= 0) return 0;
  if (index >= length) return length - 1;
  return index;
};

const alignOffset = (offset, height, align, viewport) => {
  const targetViewport = Math.max(1, viewport || 0);
  const itemHeight = Math.max(1, height || 0);
  if (align === "center") {
    return offset - Math.max(0, (targetViewport - itemHeight) / 2);
  }
  if (align === "end") {
    return offset - Math.max(0, targetViewport - itemHeight);
  }
  return offset;
};

const getNodeHeight = (node, fallback) => {
  if (!node) return fallback;
  const styleHeight = Number.parseFloat(node.style?.height);
  if (Number.isFinite(styleHeight) && styleHeight > 0) {
    return styleHeight;
  }
  if (typeof node.getBoundingClientRect === "function") {
    const rect = node.getBoundingClientRect();
    if (Number.isFinite(rect?.height) && rect.height > 0) {
      return rect.height;
    }
  }
  return fallback;
};

const maybeNumber = (value, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;

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
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [layoutHoldCount, setLayoutHoldCount] = useState(0);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const metadataAspectCacheRef = useRef(new Map());
  const masonryRefreshRafRef = useRef(0);
  const scrollMetricsRef = useRef({ entries: [], blocks: [], totalHeight: 0 });
  const [scrollMetricsVersion, setScrollMetricsVersion] = useState(0);
  const [ioConfig] = useState({ rootMargin: "1600px 0px", nearPx: 900 });

  const scheduleFrame = useCallback((cb) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      return window.requestAnimationFrame(cb);
    }
    return setTimeout(cb, 16);
  }, []);

  const cancelFrame = useCallback((handle) => {
    if (handle == null) return;
    if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(handle);
    } else {
      clearTimeout(handle);
    }
  }, []);

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

  const recomputeScrollMetrics = useCallback(() => {
    const gridEl = gridRef.current;
    if (!gridEl) return;
    const nodes = Array.from(gridEl.querySelectorAll(".video-item"));
    const map = new Map();
    for (const node of nodes) {
      const id = node.dataset.videoId || node.dataset.filename || node.dataset.id;
      if (!id) continue;
      const datasetY = Number.parseFloat(node.dataset?.y);
      const offset = Number.isFinite(datasetY) ? datasetY : maybeNumber(node.offsetTop, 0);
      const height = getNodeHeight(node, approxTileHeight);
      const safeHeight = height > 0 ? height : approxTileHeight;
      map.set(id, {
        offset,
        height: safeHeight,
        bottom: offset + Math.max(0, safeHeight),
      });
    }

    const entries = [];
    for (let index = 0; index < orderedIds.length; index += 1) {
      const id = orderedIds[index];
      const record = id ? map.get(id) : null;
      const fallbackRow = Math.floor(index / Math.max(1, derivedColumnCount));
      const fallbackOffset = fallbackRow * approxTileHeight;
      const height = record?.height ?? approxTileHeight;
      const offset = record?.offset ?? fallbackOffset;
      entries.push({
        index,
        id,
        offset,
        height,
        bottom: offset + Math.max(0, height),
      });
    }

    const blocks = [];
    for (let i = 0; i < entries.length; i += BLOCK_SIZE) {
      blocks.push({ index: entries[i].index, offset: entries[i].offset });
    }

    let totalHeight = 0;
    if (entries.length) {
      const last = entries[entries.length - 1];
      totalHeight = Math.max(
        maybeNumber(Number.parseFloat(gridEl.style?.height), 0),
        maybeNumber(gridEl.scrollHeight, 0),
        last.bottom
      );
    } else {
      totalHeight = maybeNumber(Number.parseFloat(gridEl.style?.height), 0);
    }

    scrollMetricsRef.current = { entries, blocks, totalHeight };
    setScrollMetricsVersion((version) => version + 1);
  }, [gridRef, orderedIds, derivedColumnCount, approxTileHeight]);

  const handleMasonryLayoutComplete = useCallback(() => {
    if (masonryRefreshRafRef.current && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(masonryRefreshRafRef.current);
    }

    const runRefresh = () => {
      masonryRefreshRafRef.current = 0;
      recomputeScrollMetrics();
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
  }, [ioRegistry, bumpLayoutEpoch, recomputeScrollMetrics]);

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
      onOrderChange: recomputeScrollMetrics,
      onMetricsChange: handleMasonryMetrics,
      onLayoutComplete: handleMasonryLayoutComplete,
    });

  const rebuildMetrics = useCallback(() => {
    recomputeScrollMetrics();
  }, [recomputeScrollMetrics]);

  useEffect(() => {
    rebuildMetrics();
  }, [orderedIds.length, rebuildMetrics]);

  useEffect(() => {
    rebuildMetrics();
  }, [derivedColumnCount, approxTileHeight, rebuildMetrics]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    let rafId = 0;
    const updateRange = () => {
      rafId = 0;
      const metrics = scrollMetricsRef.current;
      const entries = metrics.entries;
      if (!entries.length) {
        setVisibleRange({ start: 0, end: 0 });
        return;
      }
      const top = container.scrollTop || 0;
      const bottom = top + (container.clientHeight || viewportHeight || 0);

      let start = 0;
      let end = entries.length - 1;

      let lo = 0;
      let hi = entries.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].bottom <= top) {
          lo = mid + 1;
        } else {
          start = mid;
          hi = mid - 1;
        }
      }

      lo = start;
      hi = entries.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid].offset < bottom) {
          end = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      setVisibleRange((prev) =>
        prev.start === start && prev.end === end ? prev : { start, end }
      );
    };

    updateRange();

    const onScroll = () => {
      if (rafId) return;
      rafId = scheduleFrame(updateRange);
    };

    container.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", onScroll);
      if (rafId) {
        cancelFrame(rafId);
      }
    };
  }, [scrollContainerRef, scheduleFrame, cancelFrame, viewportHeight, scrollMetricsVersion]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const metrics = scrollMetricsRef.current;
    const entries = metrics.entries;
    if (!entries.length) {
      setVisibleRange({ start: 0, end: 0 });
      return;
    }
    const top = container.scrollTop || 0;
    const bottom = top + (container.clientHeight || viewportHeight || 0);

    let start = 0;
    let end = entries.length - 1;

    let lo = 0;
    let hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].bottom <= top) {
        lo = mid + 1;
      } else {
        start = mid;
        hi = mid - 1;
      }
    }

    lo = start;
    hi = entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].offset < bottom) {
        end = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    setVisibleRange((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end }
    );
  }, [scrollMetricsVersion, scrollContainerRef, viewportHeight]);

  const clampScrollTarget = useCallback(
    (value) => {
      const container = scrollContainerRef.current;
      if (!container) return value;
      const total = scrollMetricsRef.current.totalHeight;
      const viewport = container.clientHeight || viewportHeight || 0;
      const max = Math.max(0, total - viewport);
      if (!Number.isFinite(value)) return 0;
      if (value < 0) return 0;
      if (value > max) return max;
      return value;
    },
    [scrollContainerRef, viewportHeight]
  );

  const indexToOffset = useCallback(
    (index) => {
      const metrics = scrollMetricsRef.current;
      const entries = metrics.entries;
      if (!entries.length) {
        return { y: 0, height: approxTileHeight };
      }
      const clamped = clampIndex(index, entries.length);
      const entry = entries[clamped];
      if (entry) {
        return { y: entry.offset, height: entry.height };
      }
      const row = Math.floor(clamped / Math.max(1, derivedColumnCount));
      const fallbackOffset = row * approxTileHeight;
      return { y: fallbackOffset, height: approxTileHeight };
    },
    [scrollMetricsVersion, approxTileHeight, derivedColumnCount]
  );

  const offsetToIndex = useCallback(
    (offset) => {
      const metrics = scrollMetricsRef.current;
      const entries = metrics.entries;
      if (!entries.length) return 0;
      const blocks = metrics.blocks;
      let startIndex = 0;
      if (blocks.length) {
        let lo = 0;
        let hi = blocks.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (blocks[mid].offset <= offset) {
            startIndex = blocks[mid].index;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
      }
      let index = startIndex;
      const limit = Math.min(entries.length, startIndex + BLOCK_SIZE + 1);
      for (let i = startIndex; i < limit; i += 1) {
        if (entries[i].offset <= offset) {
          index = i;
        } else {
          break;
        }
      }
      return index;
    },
    [scrollMetricsVersion]
  );

  const previewLogicalIndex = useCallback(
    (targetIndex) => {
      const count = orderedIds.length;
      if (!count) {
        return { index: 0, offset: 0, height: approxTileHeight };
      }
      const normalized = clampIndex(
        Math.floor(Number.isFinite(targetIndex) ? targetIndex : 0),
        count
      );
      const entry = indexToOffset(normalized);
      return { index: normalized, offset: entry.y ?? 0, height: entry.height ?? approxTileHeight };
    },
    [orderedIds.length, indexToOffset, approxTileHeight]
  );

  const scrollToLogicalIndex = useCallback(
    (targetIndex, { align = "start", behavior = "auto" } = {}) => {
      const container = scrollContainerRef?.current;
      if (!container) return;
      const count = orderedIds.length;
      if (!count) return;
      const normalized = clampIndex(
        Math.floor(Number.isFinite(targetIndex) ? targetIndex : 0),
        count
      );
      const entry = indexToOffset(normalized);
      const aligned = alignOffset(
        entry.y ?? 0,
        entry.height ?? approxTileHeight,
        align,
        container.clientHeight || viewportHeight || 0
      );
      const clampedTop = clampScrollTarget(aligned);
      container.scrollTo({ top: clampedTop, behavior });
    },
    [
      scrollContainerRef,
      orderedIds.length,
      indexToOffset,
      approxTileHeight,
      viewportHeight,
      clampScrollTarget,
    ]
  );

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

  const totalHeight = useMemo(
    () => scrollMetricsRef.current.totalHeight,
    [scrollMetricsVersion]
  );

  const orderForRange = useMemo(() => orderedIds, [orderedIds]);

  return {
    orderedVideos,
    orderedIds,
    orderForRange,
    ioRegistry,
    layoutEpoch,
    scheduleLayout,
    updateAspectRatio,
    onItemsChanged,
    setZoomClass,
    withLayoutHold,
    isLayoutTransitioning,
    viewportHeight,
    previewLogicalIndex,
    scrollToLogicalIndex,
    scrollMetrics: {
      totalHeight,
      indexToOffset,
      offsetToIndex,
    },
    visibleRange,
  };
}

export default useMasonryLayout;
