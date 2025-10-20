import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import useChunkedMasonry from "../../hooks/useChunkedMasonry";
import useIntersectionObserverRegistry from "../../hooks/ui-perf/useIntersectionObserverRegistry";
import { createMeasurementStore } from "../../hooks/ui-perf/measurementStore";
import useLayoutProjectionModel from "../../hooks/ui-perf/useLayoutProjectionModel";
import { createRangeCoordinator } from "../../hooks/ui-perf/rangeCoordinator";
import {
  SortKey,
  buildComparator,
  groupAndSort,
  buildRandomOrderMap,
} from "../../sorting/sorting.js";
import { clampZoomIndex, zoomClassForLevel } from "../../zoom/utils.js";
import { ZOOM_TILE_WIDTHS } from "../../zoom/config";
import feature from "../../config/featureFlags";

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
  ensureVisibleRange,
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
  const measurementStoreRef = useRef(null);
  if (!measurementStoreRef.current) {
    measurementStoreRef.current = createMeasurementStore();
  }
  const measurementStore = measurementStoreRef.current;
  const correctionStateRef = useRef({ token: 0, rafA: null, rafB: null, timeout: null });

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

  const cancelPendingCorrection = useCallback(() => {
    const state = correctionStateRef.current;
    if (!state) return;
    if (state.rafA != null) {
      cancelFrame(state.rafA);
      state.rafA = null;
    }
    if (state.rafB != null) {
      cancelFrame(state.rafB);
      state.rafB = null;
    }
    if (state.timeout != null) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }
  }, [cancelFrame]);

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

  useEffect(() => {
    if (!measurementStore) return;
    measurementStore.setDefaultEstimate(Math.max(48, Math.round(approxTileHeight)));
  }, [measurementStore, approxTileHeight]);

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

  const estimatedGap = useMemo(
    () =>
      Number.isFinite(masonryMetrics.columnGap) && masonryMetrics.columnGap > 0
        ? masonryMetrics.columnGap
        : 12,
    [masonryMetrics.columnGap]
  );

  useEffect(() => {
    if (!measurementStore) return;
    measurementStore.updateLayoutSignature({
      columnWidth: Math.max(1, Math.round(effectiveColumnWidth || 0)),
      columnCount: Math.max(1, derivedColumnCount),
      gapY: estimatedGap,
      gapX: estimatedGap,
    });
  }, [measurementStore, effectiveColumnWidth, derivedColumnCount, estimatedGap]);

  useEffect(() => cancelPendingCorrection, [cancelPendingCorrection]);

  const lpmEnabled = Boolean(feature.experimentalLayoutProjection);

  useEffect(() => {
    if (!lpmEnabled) {
      cancelPendingCorrection();
    }
  }, [lpmEnabled, cancelPendingCorrection]);

  const bufferRows = useMemo(() => Math.max(3, Math.ceil(viewportRows)), [viewportRows]);
  const layoutProjectionModel = useLayoutProjectionModel({
    enabled: lpmEnabled,
    logicalOrder: orderedIds,
    columnCount: Math.max(1, derivedColumnCount),
    columnWidth: Math.max(1, effectiveColumnWidth),
    gapX: estimatedGap,
    gapY: estimatedGap,
    measurementStore,
    defaultHeight: Math.max(48, Math.round(approxTileHeight)),
  });

  const clampScrollTarget = useCallback(
    (value) => {
      let next = Number.isFinite(value) ? value : 0;
      if (next < 0) next = 0;
      if (lpmEnabled && layoutProjectionModel?.getTotalHeight) {
        const totalHeight = layoutProjectionModel.getTotalHeight();
        if (Number.isFinite(totalHeight) && viewportHeight > 0) {
          const maxScroll = Math.max(0, totalHeight - viewportHeight);
          if (next > maxScroll) {
            next = maxScroll;
          }
        }
      }
      return next;
    },
    [lpmEnabled, layoutProjectionModel, viewportHeight]
  );

  const computeAlignedOffset = useCallback(
    (offset, height, alignMode) => {
      const base = Number.isFinite(offset) ? offset : 0;
      const itemHeight = Number.isFinite(height) && height > 0 ? height : approxTileHeight;
      if (alignMode === "center" && viewportHeight > 0) {
        return base - Math.max(0, viewportHeight / 2 - itemHeight / 2);
      }
      if (alignMode === "end" && viewportHeight > 0) {
        return base - Math.max(0, viewportHeight - itemHeight);
      }
      return base;
    },
    [approxTileHeight, viewportHeight]
  );

  const schedulePostMaterializeCorrection = useCallback(
    (targetIndex, alignMode) => {
      if (!lpmEnabled || !layoutProjectionModel) {
        return;
      }
      const container = scrollContainerRef?.current;
      if (!container) return;

      const state = correctionStateRef.current;
      if (!state) return;
      state.token += 1;
      cancelPendingCorrection();
      const token = state.token;

      const applyCorrection = () => {
        if (!lpmEnabled || !layoutProjectionModel) return;
        if (correctionStateRef.current.token !== token) return;
        const activeContainer = scrollContainerRef?.current;
        if (!activeContainer) return;

        const entry = layoutProjectionModel.getEntry?.(targetIndex);
        const fallback = layoutProjectionModel.indexToOffset?.(targetIndex);
        const baseOffset = Number.isFinite(entry?.y)
          ? entry.y
          : Number.isFinite(fallback?.y)
          ? fallback.y
          : 0;
        const itemHeight = Number.isFinite(entry?.height)
          ? entry.height
          : Number.isFinite(fallback?.height)
          ? fallback.height
          : approxTileHeight;
        let target = computeAlignedOffset(baseOffset, itemHeight, alignMode);
        target = clampScrollTarget(target);
        if (!Number.isFinite(target)) {
          return;
        }
        const current = activeContainer.scrollTop;
        const delta = Math.abs(target - current);
        const threshold = viewportHeight > 0 ? viewportHeight / 3 : 16;
        if (delta <= 1) {
          return;
        }
        if (threshold > 0 && delta <= threshold) {
          return;
        }
        activeContainer.scrollTo({ top: target, behavior: "auto" });
      };

      state.rafA = scheduleFrame(() => {
        state.rafA = null;
        if (correctionStateRef.current.token !== token) return;
        state.rafB = scheduleFrame(() => {
          state.rafB = null;
          if (correctionStateRef.current.token !== token) return;
          applyCorrection();
          if (correctionStateRef.current.token !== token) return;
          state.timeout = setTimeout(() => {
            state.timeout = null;
            applyCorrection();
          }, 160);
        });
      });
    },
    [
      lpmEnabled,
      layoutProjectionModel,
      scrollContainerRef,
      cancelPendingCorrection,
      computeAlignedOffset,
      clampScrollTarget,
      scheduleFrame,
      approxTileHeight,
      viewportHeight,
    ]
  );

  useEffect(() => {
    if (!lpmEnabled || !layoutProjectionModel || !orderedIds.length) return;
    const projectedRows = viewportRows + bufferRows;
    const span = Math.max(
      0,
      Math.min(orderedIds.length - 1, projectedRows * derivedColumnCount)
    );
    layoutProjectionModel.ensureProjected(0, span);

    if (process.env.NODE_ENV !== "production") {
      try {
        const totalHeight = layoutProjectionModel.getTotalHeight();
        const measuredCount = measurementStore?.count?.() ?? 0;
        const projectedRange = layoutProjectionModel.getProjectedRange?.();
        console.debug("[LPM] shadow run", {
          totalHeight: Math.round(totalHeight),
          measuredCount,
          projectedRange,
          logical: orderedIds.length,
        });
      } catch (error) {
        console.debug("[LPM] shadow run error", error);
      }
    }
  }, [
    lpmEnabled,
    layoutProjectionModel,
    orderedIds,
    viewportRows,
    bufferRows,
    derivedColumnCount,
    measurementStore,
  ]);

  const rangeOverscanPx = useMemo(
    () => Math.max(0, Math.round(bufferRows * approxTileHeight)),
    [bufferRows, approxTileHeight]
  );

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

  const rangeCoordinatorRef = useRef(null);
  if (!rangeCoordinatorRef.current) {
    rangeCoordinatorRef.current = createRangeCoordinator({
      model: lpmEnabled ? layoutProjectionModel : null,
      totalCount: orderedIds.length,
      overscanPx: rangeOverscanPx,
    });
  } else {
    rangeCoordinatorRef.current.setModel(lpmEnabled ? layoutProjectionModel : null);
    rangeCoordinatorRef.current.setTotalCount(orderedIds.length);
    rangeCoordinatorRef.current.setOverscanPx(rangeOverscanPx);
  }

  const rangeCoordinator = rangeCoordinatorRef.current;
  useEffect(() => {
    if (!rangeCoordinator?.setMaterializeHandler) return undefined;
    if (!lpmEnabled || !layoutProjectionModel) {
      rangeCoordinator.setMaterializeHandler(null);
      return undefined;
    }
    const handler = ({ start, end, priority }) => {
      layoutProjectionModel.ensureProjected?.(start, end);
      if (typeof ensureVisibleRange === "function") {
        ensureVisibleRange(start, end, { priority });
      }
    };
    rangeCoordinator.setMaterializeHandler(handler);
    return () => {
      rangeCoordinator.setMaterializeHandler(null);
    };
  }, [
    rangeCoordinator,
    lpmEnabled,
    layoutProjectionModel,
    ensureVisibleRange,
  ]);

  const scrubPad = useMemo(
    () => Math.max(24, (derivedColumnCount || 0) * 4),
    [derivedColumnCount]
  );

  const [logicalRange, setLogicalRange] = useState(() =>
    rangeCoordinator?.getRange?.() ?? { start: 0, end: orderedIds.length - 1 }
  );

  const syncLogicalRange = useCallback(
    (overscanOverride) => {
      if (!rangeCoordinator) {
        const fallbackEnd = orderedIds.length ? orderedIds.length - 1 : -1;
        const fallback = { start: 0, end: fallbackEnd };
        setLogicalRange((prev) =>
          prev.start === fallback.start && prev.end === fallback.end ? prev : fallback
        );
        return fallback;
      }
      if (!lpmEnabled || !layoutProjectionModel) {
        const fallbackEnd = orderedIds.length ? orderedIds.length - 1 : -1;
        const fallback = { start: 0, end: fallbackEnd };
        setLogicalRange((prev) =>
          prev.start === fallback.start && prev.end === fallback.end ? prev : fallback
        );
        return fallback;
      }
      const container = scrollContainerRef.current;
      const top = container?.scrollTop ?? 0;
      const next = rangeCoordinator.updateViewport(
        top,
        viewportHeight,
        overscanOverride
      );
      setLogicalRange((prev) =>
        prev.start === next.start && prev.end === next.end ? prev : next
      );
      return next;
    },
    [
      rangeCoordinator,
      orderedIds.length,
      lpmEnabled,
      layoutProjectionModel,
      scrollContainerRef,
      viewportHeight,
    ]
  );

  useEffect(() => {
    if (!lpmEnabled || !layoutProjectionModel) {
      syncLogicalRange();
      return undefined;
    }
    syncLogicalRange();
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    const onScroll = () => {
      syncLogicalRange();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
    };
  }, [
    lpmEnabled,
    layoutProjectionModel,
    scrollContainerRef,
    orderedIds.length,
    syncLogicalRange,
  ]);

  useEffect(() => {
    if (!lpmEnabled || !layoutProjectionModel) return;
    syncLogicalRange();
  }, [
    lpmEnabled,
    layoutProjectionModel,
    viewportHeight,
    rangeOverscanPx,
    measurementStore?.version,
    layoutEpoch,
    syncLogicalRange,
  ]);

  const previewLogicalIndex = useCallback(
    (targetIndex) => {
      const count = orderedIds.length;
      if (!count) {
        return { index: 0, offset: 0, height: 0 };
      }
      const normalizedIndex = Math.max(
        0,
        Math.min(count - 1, Math.floor(Number.isFinite(targetIndex) ? targetIndex : 0))
      );

      if (!lpmEnabled || !layoutProjectionModel || !rangeCoordinator?.onScrub) {
        const rows = Math.floor(normalizedIndex / Math.max(1, derivedColumnCount));
        const offset = rows * approxTileHeight;
        return { index: normalizedIndex, offset, height: approxTileHeight };
      }

      const result = rangeCoordinator.onScrub(normalizedIndex, { pad: scrubPad });
      if (result && typeof result === "object") {
        return result;
      }

      const entry = layoutProjectionModel.getEntry?.(normalizedIndex);
      if (entry) {
        return {
          index: normalizedIndex,
          offset: entry.y ?? 0,
          height: entry.height ?? approxTileHeight,
        };
      }

      const { y } = layoutProjectionModel.indexToOffset(normalizedIndex);
      return { index: normalizedIndex, offset: y ?? 0, height: approxTileHeight };
    },
    [
      orderedIds.length,
      lpmEnabled,
      layoutProjectionModel,
      rangeCoordinator,
      scrubPad,
      derivedColumnCount,
      approxTileHeight,
    ]
  );

  const scrollToLogicalIndex = useCallback(
    (targetIndex, { align = "start", behavior = "auto" } = {}) => {
      const container = scrollContainerRef?.current;
      if (!container) return;
      const count = orderedIds.length;
      if (!count) return;
      const normalizedIndex = Math.max(
        0,
        Math.min(count - 1, Math.floor(Number.isFinite(targetIndex) ? targetIndex : 0))
      );

      let top = 0;
      if (lpmEnabled && layoutProjectionModel && rangeCoordinator?.jumpToIndex) {
        const offset = rangeCoordinator.jumpToIndex(normalizedIndex, {
          align,
          viewportHeight,
          pad: scrubPad,
        });
        if (Number.isFinite(offset)) {
          top = offset;
        } else {
          const entry = layoutProjectionModel.getEntry?.(normalizedIndex);
          if (entry && Number.isFinite(entry.y)) {
            top = entry.y;
          } else {
            const { y } = layoutProjectionModel.indexToOffset(normalizedIndex);
            top = Number.isFinite(y) ? y : 0;
          }
        }
      } else {
        const rows = Math.floor(normalizedIndex / Math.max(1, derivedColumnCount));
        top = rows * approxTileHeight;
      }

      const clampedTop = clampScrollTarget(top);
      container.scrollTo({ top: clampedTop, behavior });
      if (lpmEnabled && layoutProjectionModel) {
        syncLogicalRange();
        schedulePostMaterializeCorrection(normalizedIndex, align);
      }
    },
    [
      scrollContainerRef,
      orderedIds.length,
      lpmEnabled,
      layoutProjectionModel,
      rangeCoordinator,
      viewportHeight,
      derivedColumnCount,
      approxTileHeight,
      syncLogicalRange,
      clampScrollTarget,
      schedulePostMaterializeCorrection,
    ]
  );

  const logicalRangeIds = useMemo(() => {
    if (!lpmEnabled) return null;
    if (!orderedIds.length) return [];
    const start = Math.max(
      0,
      Math.min(orderedIds.length - 1, Number.isFinite(logicalRange.start) ? logicalRange.start : 0)
    );
    const end = Math.max(
      start,
      Math.min(
        orderedIds.length - 1,
        Number.isFinite(logicalRange.end) ? logicalRange.end : logicalRange.start ?? start
      )
    );
    return orderedIds.slice(start, end + 1);
  }, [lpmEnabled, orderedIds, logicalRange.start, logicalRange.end]);

  const orderForRange = useMemo(() => {
    if (lpmEnabled) {
      return orderedIds;
    }
    return visualOrderedIds.length ? visualOrderedIds : orderedIds;
  }, [lpmEnabled, orderedIds, visualOrderedIds]);

  const progressiveMaxVisibleNumber = useMemo(() => {
    if (!Number.isFinite(derivedColumnCount) || derivedColumnCount <= 0) {
      return undefined;
    }
    const baseRows = viewportRows + bufferRows;
    const targetRows = Math.max(baseRows, scrollRowsEstimate + bufferRows);
    const baseline = derivedColumnCount * targetRows;
    if (!Number.isFinite(baseline)) {
      return undefined;
    }
    let result = Math.max(1, Math.floor(baseline));
    if (lpmEnabled) {
      const endIndex = logicalRange?.end;
      if (Number.isFinite(endIndex) && endIndex >= 0) {
        result = Math.max(result, Math.floor(endIndex + 1));
      }
    }
    if (orderedIds.length) {
      result = Math.min(result, orderedIds.length);
    }
    return result;
  }, [
    derivedColumnCount,
    viewportRows,
    bufferRows,
    scrollRowsEstimate,
    lpmEnabled,
    logicalRange?.end,
    orderedIds.length,
  ]);

  useEffect(() => {
    if (!lpmEnabled || process.env.NODE_ENV === "production") return;
    const size = Number.isFinite(logicalRange.end) && Number.isFinite(logicalRange.start)
      ? Math.max(0, logicalRange.end - logicalRange.start + 1)
      : 0;
    if (
      Number.isFinite(progressiveMaxVisibleNumber) &&
      size > progressiveMaxVisibleNumber
    ) {
      console.warn("[RangeCoordinator] window exceeds progressive budget", {
        size,
        budget: progressiveMaxVisibleNumber,
      });
    }
  }, [lpmEnabled, logicalRange.start, logicalRange.end, progressiveMaxVisibleNumber]);

  const rangeDiagnostics = useMemo(() => {
    if (!lpmEnabled || !rangeCoordinator?.getDiagnostics) return null;
    const diagnostics = rangeCoordinator.getDiagnostics();
    if (!diagnostics?.range) return null;
    const { start, end } = diagnostics.range;
    const size = Number.isFinite(end) && Number.isFinite(start) && end >= start
      ? end - start + 1
      : 0;
    return {
      start,
      end,
      size,
      overscanPx: diagnostics.overscanPx,
      totalCount: diagnostics.totalCount,
      lastComputedAt: diagnostics.lastComputedAt,
    };
  }, [lpmEnabled, rangeCoordinator, logicalRange.start, logicalRange.end]);

  const lastLoggedRangeRef = useRef({ start: null, end: null });
  useEffect(() => {
    if (!lpmEnabled || process.env.NODE_ENV === "production") return;
    const diagnostics = rangeCoordinator?.getDiagnostics?.();
    if (!diagnostics?.range) return;
    const { start, end } = diagnostics.range;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const prev = lastLoggedRangeRef.current;
    if (prev.start === start && prev.end === end) return;
    lastLoggedRangeRef.current = { start, end };
    const size = end >= start ? end - start + 1 : 0;
    console.debug("[RangeCoordinator] window", {
      start,
      end,
      size,
      overscanPx: diagnostics.overscanPx,
      projected: layoutProjectionModel?.getProjectedRange?.(),
    });
  }, [
    lpmEnabled,
    rangeCoordinator,
    logicalRange.start,
    logicalRange.end,
    layoutProjectionModel,
  ]);

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

  return {
    orderedVideos,
    orderedIds,
    visualOrderedIds,
    logicalRangeIds,
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
    measurementStore,
    layoutProjectionModel,
    rangeCoordinator,
    logicalRange,
    rangeDiagnostics,
    layoutProjectionEnabled: lpmEnabled,
    previewLogicalIndex,
    scrollToLogicalIndex,
    viewportHeight,
  };
}
