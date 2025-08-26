// hooks/useChunkedMasonry.js
import { useCallback, useEffect, useRef } from "react";
import { zoomClassForLevel } from "../zoom/utils.js";

export default function useChunkedMasonry({
  gridRef,
  // Now uses the shared zoomClassForLevel so it's always in sync with CSS
  zoomClassForLevel: zoomClassForLevelProp = zoomClassForLevel,
  defaultAspect = 16 / 9,
  chunkSize = 200,
  columnGapFallback = 12,
  onOrderChange,
}) {
  const aspectRatioCacheRef = useRef(new Map());
  const cachedGridMeasurementsRef = useRef(null);
  const lastOrderRef = useRef(null);

  const isLayingOutRef = useRef(false);
  const relayoutRequestedRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const lastUserActionRef = useRef(0);

  const resizeTimeoutRef = useRef(null);

  // ---- helpers ----
  const getColumnCount = useCallback((computedStyle) => {
    const gtc = computedStyle.gridTemplateColumns;
    if (!gtc || gtc === "none") return 1;
    return gtc.split(" ").length;
  }, []);

  const updateCachedGridMeasurements = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const cs = window.getComputedStyle(grid);
    const columnCount = getColumnCount(cs);
    const columnGap = parseFloat(cs.columnGap) || parseFloat(cs.gap) || columnGapFallback;

    const gridWidth = grid.clientWidth || grid.getBoundingClientRect().width || 0;
    const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
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
  }, [gridRef, getColumnCount, columnGapFallback]);

  const scheduleLayout = useCallback(() => {
    // coalesce concurrent requests
    if (isLayingOutRef.current) {
      relayoutRequestedRef.current = true;
      return;
    }
    isLayingOutRef.current = true;

    requestAnimationFrame(() => {
      const grid = gridRef.current;
      if (!grid) {
        isLayingOutRef.current = false;
        return;
      }

      if (!cachedGridMeasurementsRef.current) updateCachedGridMeasurements();
      const { columnWidth, columnCount, columnGap } = cachedGridMeasurementsRef.current || {};
      if (!columnWidth || !columnCount) {
        isLayingOutRef.current = false;
        return;
      }

      const columnHeights = new Array(columnCount).fill(0);
      const items = Array.from(grid.querySelectorAll(".video-item"));

      // Collect positions for order calculation
      const positions = [];

      // work in chunks to avoid long tasks
      let i = 0;
      const step = () => {
        const end = Math.min(i + chunkSize, items.length);
        for (; i < end; i++) {
          const el = items[i];

          const id = el.dataset.videoId || el.dataset.filename || `__idx_${i}`;
          let ar = aspectRatioCacheRef.current.get(id);
          if (!ar) {
            const v = el.querySelector("video");
            if (v && v.videoWidth && v.videoHeight) {
              ar = v.videoWidth / v.videoHeight;
              aspectRatioCacheRef.current.set(id, ar);
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

          const vc = el.querySelector(".video-container, .video-placeholder, .error-indicator");
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
          requestAnimationFrame(step);
        } else {
          const maxHeight = columnHeights.length ? Math.max(...columnHeights) : 0;
          grid.style.height = `${maxHeight}px`;
          grid.style.position = "relative";

          // Compute and publish visual order (top-to-bottom, then left-to-right)
          if (typeof onOrderChange === "function") {
            positions.sort((a, b) => (a.y - b.y) || (a.x - b.x));
            const order = positions.map(p => p.id);
            const prev = lastOrderRef.current || [];
            // shallow compare to avoid needless updates
            const changed = order.length !== prev.length || order.some((id, idx) => id !== prev[idx]);
            if (changed) {
              lastOrderRef.current = order;
              onOrderChange(order);
            }
          }

          isLayingOutRef.current = false;
          if (relayoutRequestedRef.current) {
            relayoutRequestedRef.current = false;
            scheduleLayout();
          }
        }
      };

      step();
    });
  }, [gridRef, updateCachedGridMeasurements, chunkSize, defaultAspect, onOrderChange]);

  // public API: call when item AR becomes known
  const updateAspectRatio = useCallback(
    (id, ar) => {
      if (!id || !Number.isFinite(ar) || ar <= 0) return;
      const prev = aspectRatioCacheRef.current.get(id);
      if (prev !== ar) {
        aspectRatioCacheRef.current.set(id, ar);
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
      const grid = gridRef.current;
      if (!grid) return;

      // remove all known zoom classes and add the desired one
      const classes = ["zoom-small", "zoom-medium", "zoom-large", "zoom-xlarge", "zoom-xxlarge"];
      classes.forEach((c) => grid.classList.remove(c));
      grid.classList.add(zoomClassForLevelProp(level));
      cachedGridMeasurementsRef.current = null;
      scheduleLayout();
    },
    [gridRef, zoomClassForLevelProp, scheduleLayout]
  );

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
  };
}
