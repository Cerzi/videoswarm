// hooks/useChunkedMasonry.js
import { useCallback, useEffect, useRef } from "react";
import { zoomClassForLevel } from "../zoom/utils.js";

export const MAX_CHUNKED_MASONRY_ASPECT_CACHE_ENTRIES = 4096;

const setBoundedAspectRatio = (cache, id, ratio) => {
  cache.delete(id);
  cache.set(id, ratio);
  while (cache.size > MAX_CHUNKED_MASONRY_ASPECT_CACHE_ENTRIES) {
    const oldestId = cache.keys().next().value;
    if (oldestId === undefined) break;
    cache.delete(oldestId);
  }
};

export default function useChunkedMasonry({
  gridRef,
  zoomClassForLevel: zoomClassForLevelProp = zoomClassForLevel,
  getTileWidthForLevel, // (level:number)=>px; if provided, we compute columns from this
  defaultAspect = 16 / 9,
  chunkSize = 200,
  columnGapFallback = 12,
  onOrderChange,
  onMetricsChange,
  onLayoutComplete,
}) {
  const aspectRatioCacheRef = useRef(new Map());
  const cachedGridMeasurementsRef = useRef(null);
  const lastOrderRef = useRef(null);
  const lastMetricsRef = useRef(null);

  const isLayingOutRef = useRef(false);
  const layoutGenerationRef = useRef(0);
  const layoutFrameIdsRef = useRef(new Set());
  const activeLayoutDisposeRef = useRef(null);
  const activeLayoutItemCountRef = useRef(0);
  const disposedRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const lastUserActionRef = useRef(0);

  const resizeTimeoutRef = useRef(null);
  const pendingZoomLevelRef = useRef(null);
  const zoomFrameRef = useRef(0);
  const currentZoomLevelRef = useRef(null);

  // ---- helpers ----
  const getColumnCount = useCallback(
    (grid, computedStyle) => {
      // If caller supplies a desired tile width, compute column count from it
      if (typeof getTileWidthForLevel === "function") {
        const cs = computedStyle;
        const gridWidth =
          grid.clientWidth || grid.getBoundingClientRect().width || 0;
        const padding =
          (parseFloat(cs.paddingLeft) || 0) +
          (parseFloat(cs.paddingRight) || 0);
        const available = Math.max(0, gridWidth - padding);
        // We read current level from DOM class: zoom-*
        const cls = grid.className || "";
        const match = cls.match(/zoom-(small|medium|large|xlarge|xxlarge)/);
        const levelIndex = [
          "small",
          "medium",
          "large",
          "xlarge",
          "xxlarge",
        ].indexOf(match?.[1] || "medium");
        const desired = Math.max(
          80,
          Math.floor(getTileWidthForLevel(levelIndex) || 200)
        );
        return Math.max(1, Math.floor(available / desired));
      }
      // Fallback: parse CSS grid-template-columns
      const gtc = computedStyle.gridTemplateColumns;
      if (!gtc || gtc === "none") return 1;
      return gtc.split(" ").length;
    },
    [getTileWidthForLevel]
  );

  const updateCachedGridMeasurements = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const cs = window.getComputedStyle(grid);
    const columnCount = getColumnCount(grid, cs);
    const columnGap =
      parseFloat(cs.columnGap) || parseFloat(cs.gap) || columnGapFallback;

    const gridWidth =
      grid.clientWidth || grid.getBoundingClientRect().width || 0;
    const padding =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const availableWidth = Math.max(0, gridWidth - padding);

    const totalGapWidth = columnGap * Math.max(0, columnCount - 1);
    const columnWidth = Math.max(
      1,
      Math.floor((availableWidth - totalGapWidth) / Math.max(1, columnCount))
    );

    cachedGridMeasurementsRef.current = {
      columnWidth,
      columnCount,
      columnGap,
      gridWidth: availableWidth,
    };

    if (typeof onMetricsChange === "function") {
      const next = {
        columnWidth,
        columnCount,
        columnGap,
        gridWidth: availableWidth,
      };
      const prev = lastMetricsRef.current;
      const changed =
        !prev ||
        prev.columnWidth !== next.columnWidth ||
        prev.columnCount !== next.columnCount ||
        prev.columnGap !== next.columnGap ||
        prev.gridWidth !== next.gridWidth;
      if (changed) {
        lastMetricsRef.current = next;
        onMetricsChange(next);
      }
    }
  }, [gridRef, getColumnCount, columnGapFallback, onMetricsChange]);

  const cancelActiveLayout = useCallback(() => {
    layoutGenerationRef.current += 1;
    for (const frameId of layoutFrameIdsRef.current) {
      cancelAnimationFrame(frameId);
    }
    layoutFrameIdsRef.current.clear();
    activeLayoutDisposeRef.current?.();
    activeLayoutDisposeRef.current = null;
    activeLayoutItemCountRef.current = 0;
    isLayingOutRef.current = false;
  }, []);

  const scheduleLayoutFrame = useCallback((layoutGeneration, callback) => {
    if (
      disposedRef.current ||
      layoutGeneration !== layoutGenerationRef.current
    ) {
      return null;
    }

    let frameId = null;
    let invokedSynchronously = false;
    const wrapped = (timestamp) => {
      invokedSynchronously = true;
      if (frameId !== null) layoutFrameIdsRef.current.delete(frameId);
      if (
        disposedRef.current ||
        layoutGeneration !== layoutGenerationRef.current
      ) {
        return;
      }
      callback(timestamp);
    };
    frameId = requestAnimationFrame(wrapped);
    if (!invokedSynchronously) layoutFrameIdsRef.current.add(frameId);
    return frameId;
  }, []);

  const scheduleLayout = useCallback(() => {
    if (disposedRef.current) return;
    // Each request replaces the prior generation. Cancelling both the frame
    // and its captured item array prevents stale large DOM collections from
    // surviving until every old chunk would otherwise have run.
    cancelActiveLayout();
    const layoutGeneration = layoutGenerationRef.current;
    isLayingOutRef.current = true;

    scheduleLayoutFrame(layoutGeneration, () => {
      let grid = gridRef.current;
      if (!grid) {
        isLayingOutRef.current = false;
        return;
      }

      if (!cachedGridMeasurementsRef.current) updateCachedGridMeasurements();
      const { columnWidth, columnCount, columnGap } =
        cachedGridMeasurementsRef.current || {};
      if (!columnWidth || !columnCount) {
        isLayingOutRef.current = false;
        return;
      }

      const columnHeights = new Array(columnCount).fill(0);
      const items = Array.from(grid.querySelectorAll(".video-item"));
      activeLayoutItemCountRef.current = items.length;

      const currentIds = new Set(
        items.map(
          (element, index) =>
            element.dataset.videoId ||
            element.dataset.filename ||
            `__idx_${index}`
        )
      );
      for (const cachedId of aspectRatioCacheRef.current.keys()) {
        if (!currentIds.has(cachedId)) {
          aspectRatioCacheRef.current.delete(cachedId);
        }
      }
      currentIds.clear();

      // Collect positions for order calculation
      const positions = [];

      let cancelled = false;
      const disposeLayout = () => {
        if (cancelled) return;
        cancelled = true;
        items.length = 0;
        positions.length = 0;
        grid = null;
        activeLayoutItemCountRef.current = 0;
      };
      activeLayoutDisposeRef.current = disposeLayout;

      // work in chunks to avoid long tasks
      let i = 0;
      const step = () => {
        if (
          cancelled ||
          disposedRef.current ||
          layoutGeneration !== layoutGenerationRef.current
        ) {
          return;
        }
        const end = Math.min(i + chunkSize, items.length);
        for (; i < end; i++) {
          const el = items[i];

          const id = el.dataset.videoId || el.dataset.filename || `__idx_${i}`;
          let ar = aspectRatioCacheRef.current.get(id);
          if (!ar) {
            const datasetRatio = Number(el.dataset?.aspectRatio);
            if (Number.isFinite(datasetRatio) && datasetRatio > 0) {
              ar = datasetRatio;
              setBoundedAspectRatio(aspectRatioCacheRef.current, id, ar);
            }
          }
          if (!ar) {
            const v = el.querySelector("video");
            if (v && v.videoWidth && v.videoHeight) {
              ar = v.videoWidth / v.videoHeight;
              setBoundedAspectRatio(aspectRatioCacheRef.current, id, ar);
            } else {
              ar = defaultAspect;
            }
          }

          const h = Math.max(1, Math.round(columnWidth / ar));

          // find shortest column (columnCount is small)
          let minIdx = 0;
          let minVal = columnHeights[0];
          for (let c = 1; c < columnCount; c++) {
            const val = columnHeights[c];
            if (val < minVal) {
              minVal = val;
              minIdx = c;
            }
          }

          const x = minIdx * (columnWidth + columnGap);
          const y = columnHeights[minIdx];

          // write styles; prefer transforms to reduce layout thrash
          el.style.position = "absolute";
          el.style.width = `${columnWidth}px`;
          el.style.height = `${h}px`;
          el.style.transform = `translate(${x}px, ${y}px)`;

          const vc = el.querySelector(
            ".video-container, .video-placeholder, .error-indicator"
          );
          if (vc) vc.style.height = `${h}px`;

          // ✅ Mark as positioned so CSS can fade it in (prevents 1-frame ghost at 0,0)
          if (el.dataset.pos !== "1") {
            el.dataset.pos = "1";
          }

          // Record position for ordering
          el.dataset.x = String(x);
          el.dataset.y = String(y);
          positions.push({ id, x, y }); // NEW

          columnHeights[minIdx] = y + h + columnGap;
        }

        if (i < items.length) {
          scheduleLayoutFrame(layoutGeneration, step);
        } else {
          const maxHeight = columnHeights.length
            ? Math.max(...columnHeights)
            : 0;
          grid.style.height = `${maxHeight}px`;
          grid.style.position = "relative";

          // Compute the callback payloads before releasing all captured DOM.
          let orderToPublish = null;
          if (typeof onOrderChange === "function") {
            positions.sort((a, b) => a.y - b.y || a.x - b.x);
            const order = positions.map((p) => p.id);
            const prev = lastOrderRef.current || [];
            // shallow compare to avoid needless updates
            const changed =
              order.length !== prev.length ||
              order.some((id, idx) => id !== prev[idx]);
            if (changed) {
              lastOrderRef.current = order;
              orderToPublish = order;
            }
          }

          const completionPayload = {
            columnHeights: columnHeights.slice(),
            maxHeight,
            metrics: cachedGridMeasurementsRef.current || null,
          };
          if (activeLayoutDisposeRef.current === disposeLayout) {
            activeLayoutDisposeRef.current = null;
          }
          isLayingOutRef.current = false;
          disposeLayout();

          if (orderToPublish) onOrderChange(orderToPublish);
          if (typeof onLayoutComplete === "function") {
            try {
              onLayoutComplete(completionPayload);
            } catch (err) {
              if (process.env.NODE_ENV !== "production") {
                // eslint-disable-next-line no-console
                console.error("useChunkedMasonry onLayoutComplete error", err);
              }
            }
          }
        }
      };

      step();
    });
  }, [
    gridRef,
    cancelActiveLayout,
    updateCachedGridMeasurements,
    scheduleLayoutFrame,
    chunkSize,
    defaultAspect,
    onOrderChange,
    onLayoutComplete,
  ]);

  // public API: call when item AR becomes known
  const updateAspectRatio = useCallback(
    (id, ar) => {
      if (!id || !Number.isFinite(ar) || ar <= 0) return;
      const prev = aspectRatioCacheRef.current.get(id);
      if (prev !== ar) {
        setBoundedAspectRatio(aspectRatioCacheRef.current, id, ar);
        const grid = gridRef.current;
        if (grid) {
          const selectorId = window.CSS?.escape ? window.CSS.escape(id) : id;
          const el = selectorId
            ? grid.querySelector(`[data-video-id="${selectorId}"]`)
            : null;
          if (el) {
            el.dataset.aspectRatio = String(ar);
            el.style.aspectRatio = String(ar);
          }
        }
        // don’t layout immediately; coalesce
        scheduleLayout();
      }
    },
    [scheduleLayout]
  );

  // public API: call when item list/order changes
  const onItemsChanged = useCallback(() => {
    // keep existing positioned items visible; new items (without data-pos) will be hidden by CSS
    cachedGridMeasurementsRef.current = null;
    scheduleLayout();
  }, [scheduleLayout]);

  // zoom: swap classes & relayout
  const setZoomClass = useCallback(
    (level) => {
      const desired = Math.max(0, Math.floor(level));
      pendingZoomLevelRef.current = desired;

      if (zoomFrameRef.current) return;

      zoomFrameRef.current = requestAnimationFrame(() => {
        zoomFrameRef.current = 0;
        const target = pendingZoomLevelRef.current;
        pendingZoomLevelRef.current = null;

        if (!Number.isFinite(target)) return;

        const grid = gridRef.current;
        if (!grid) return;

        if (currentZoomLevelRef.current === target) return;
        currentZoomLevelRef.current = target;

        const classes = [
          "zoom-small",
          "zoom-medium",
          "zoom-large",
          "zoom-xlarge",
          "zoom-xxlarge",
        ];
        classes.forEach((c) => grid.classList.remove(c));
        grid.classList.add(zoomClassForLevelProp(target));
        cachedGridMeasurementsRef.current = null;
        updateCachedGridMeasurements();
        scheduleLayout();
      });
    },
    [gridRef, zoomClassForLevelProp, scheduleLayout, updateCachedGridMeasurements]
  );

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      cancelActiveLayout();
      if (zoomFrameRef.current) {
        cancelAnimationFrame(zoomFrameRef.current);
        zoomFrameRef.current = 0;
      }
      aspectRatioCacheRef.current.clear();
    };
  }, [cancelActiveLayout]);

  // scroll tracking — avoid thrashing while user is scrolling
  useEffect(() => {
    let t;
    const onScroll = () => {
      isUserScrollingRef.current = true;
      lastUserActionRef.current = Date.now();
      clearTimeout(t);
      t = setTimeout(() => {
        isUserScrollingRef.current = false;
        // after user stops: a gentle relayout
        scheduleLayout();
      }, 150);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      clearTimeout(t);
    };
  }, [scheduleLayout]);

  // debounced resize
  useEffect(() => {
    const onResize = () => {
      clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(() => {
        cachedGridMeasurementsRef.current = null;
        scheduleLayout();
      }, 300);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimeoutRef.current);
    };
  }, [scheduleLayout]);

  // kick once on mount (e.g. when grid first appears)
  useEffect(() => {
    scheduleLayout();
  }, [scheduleLayout]);

  return {
    updateAspectRatio,
    onItemsChanged,
    setZoomClass,
    scheduleLayout, // exposed in case you want a manual nudge
    getCacheDebugSnapshot: () => ({
      aspectRatioEntries: aspectRatioCacheRef.current.size,
      maxAspectRatioEntries: MAX_CHUNKED_MASONRY_ASPECT_CACHE_ENTRIES,
      scheduledLayoutFrames: layoutFrameIdsRef.current.size,
      layoutInProgress: isLayingOutRef.current,
      activeLayoutItems: activeLayoutItemCountRef.current,
    }),
  };
}
