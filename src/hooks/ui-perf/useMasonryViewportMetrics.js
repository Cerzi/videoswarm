// src/hooks/ui-perf/useMasonryViewportMetrics.js
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clampZoomIndex } from "../../zoom/utils.js";
import { ZOOM_TILE_WIDTHS } from "../../zoom/config.js";

const DEFAULT_ASPECT = 16 / 9;
const DEFAULT_NEAR_MIN = 260;
const DEFAULT_NEAR_MAX = 1400;

const initialMetrics = {
  columns: 1,
  rowsInViewport: 4,
  estimatedTileHeight: 180,
  viewportHeight: 720,
  targetVisible: 24,
  trailingBuffer: 24,
  nearPx: 900,
  rootMargin: "1400px 0px",
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function readNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Estimate masonry viewport metrics from DOM measurements + zoom level.
 * Used to clamp progressive rendering and tighten IO lookahead.
 */
export default function useMasonryViewportMetrics({
  gridRef,
  scrollRef,
  zoomLevel = 0,
  bufferRows = 2,
  defaultAspectRatio = DEFAULT_ASPECT,
  minNearPx = DEFAULT_NEAR_MIN,
  maxNearPx = DEFAULT_NEAR_MAX,
} = {}) {
  const [metrics, setMetrics] = useState(() => initialMetrics);
  const lastSignatureRef = useRef(null);

  const compute = useCallback(() => {
    const grid = gridRef?.current ?? null;
    const scrollEl = scrollRef?.current ?? null;

    const safeZoomIndex = clampZoomIndex(zoomLevel);
    const desiredTileWidth =
      ZOOM_TILE_WIDTHS[safeZoomIndex] ?? ZOOM_TILE_WIDTHS[0] ?? 200;

    let availableWidth = 0;
    let columnGap = 12;
    let columns = 1;

    if (grid && typeof window !== "undefined") {
      const style = window.getComputedStyle(grid);
      const padding =
        readNumber(style.paddingLeft) + readNumber(style.paddingRight);
      columnGap = readNumber(style.columnGap) || readNumber(style.gap) || 12;
      const width = grid.clientWidth || grid.getBoundingClientRect().width || 0;
      availableWidth = Math.max(0, width - padding);
      const denom = Math.max(1, desiredTileWidth + columnGap);
      columns = Math.max(1, Math.floor((availableWidth + columnGap) / denom));
    } else if (typeof window !== "undefined") {
      availableWidth = window.innerWidth || desiredTileWidth;
      const denom = Math.max(1, desiredTileWidth + columnGap);
      columns = Math.max(1, Math.floor((availableWidth + columnGap) / denom));
    }

    if (availableWidth <= 0) {
      availableWidth = columns * desiredTileWidth + columnGap * Math.max(0, columns - 1);
    }

    const effectiveColumnWidth = Math.max(
      1,
      Math.floor(
        (availableWidth - columnGap * Math.max(0, columns - 1)) /
          Math.max(1, columns)
      )
    );

    const tileHeight = Math.max(
      1,
      Math.round(effectiveColumnWidth / Math.max(defaultAspectRatio, 0.01))
    );
    const rowPitch = tileHeight + columnGap;

    const viewportHeight = scrollEl?.clientHeight
      ? scrollEl.clientHeight
      : typeof window !== "undefined"
      ? window.innerHeight || tileHeight * 4
      : tileHeight * 4;

    const rowsInViewport = Math.max(
      1,
      Math.ceil(viewportHeight / Math.max(1, rowPitch))
    );

    const safeBufferRows = Math.max(1, Math.floor(bufferRows));
    const targetRows = rowsInViewport + safeBufferRows;
    const targetVisible = Math.max(columns, columns * targetRows);
    const trailingBuffer = Math.max(columns, columns * safeBufferRows * 2);

    const nearPx = clamp(rowPitch * targetRows, minNearPx, maxNearPx);
    const rootMarginValue = clamp(
      Math.round(rowPitch * (rowsInViewport + safeBufferRows * 2)),
      minNearPx,
      Math.max(maxNearPx, minNearPx)
    );
    const rootMargin = `${Math.round(rootMarginValue)}px 0px`;

    const signature = `${columns}|${rowsInViewport}|${tileHeight}|${viewportHeight}|${targetVisible}|${trailingBuffer}|${nearPx}|${rootMargin}`;
    if (signature === lastSignatureRef.current) {
      return;
    }
    lastSignatureRef.current = signature;

    setMetrics({
      columns,
      rowsInViewport,
      estimatedTileHeight: tileHeight,
      viewportHeight,
      targetVisible,
      trailingBuffer,
      nearPx,
      rootMargin,
    });
  }, [
    gridRef,
    scrollRef,
    zoomLevel,
    bufferRows,
    defaultAspectRatio,
    minNearPx,
    maxNearPx,
  ]);

  useEffect(() => {
    compute();
  }, [compute]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;

    const observers = [];

    if (gridRef?.current) {
      const ro = new ResizeObserver(() => compute());
      ro.observe(gridRef.current);
      observers.push(ro);
    }

    if (scrollRef?.current && scrollRef.current !== gridRef?.current) {
      const ro = new ResizeObserver(() => compute());
      ro.observe(scrollRef.current);
      observers.push(ro);
    }

    return () => {
      observers.forEach((ro) => {
        try {
          ro.disconnect();
        } catch {}
      });
    };
  }, [gridRef, scrollRef, compute]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handler = () => compute();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [compute]);

  return useMemo(() => metrics, [metrics]);
}

