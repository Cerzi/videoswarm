import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

const DEFAULT_SETTLE_FRAMES = 1;
const MAX_RETRY_FRAMES = 2;

const cssEscape = (value) => {
  if (typeof value !== "string") {
    value = value != null ? String(value) : "";
  }
  if (typeof window !== "undefined" && window.CSS?.escape) {
    return window.CSS.escape(value);
  }
  return value.replace(/"/g, '\\"').replace(/'/g, "\\'");
};

const computeVisibility = (top, bottom, viewportHeight) => {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;
  return bottom > 0 && top < viewportHeight;
};

const getScrollPadding = (el) => {
  if (!el || typeof window === "undefined") return { top: 0, bottom: 0 };
  const style = window.getComputedStyle(el);
  const paddingTop = parseFloat(style.scrollPaddingTop) || 0;
  const paddingBottom = parseFloat(style.scrollPaddingBottom) || 0;
  return { top: paddingTop, bottom: paddingBottom };
};

const buildMeasurement = ({
  type,
  anchorId = null,
  top,
  bottom,
  viewportHeight,
  ids = [],
  sourceRects = [],
}) => {
  const height = bottom - top;
  const centroid = top + height / 2;
  return {
    type,
    anchorId,
    top,
    bottom,
    height,
    viewportY: centroid,
    viewportHeight,
    isVisible: computeVisibility(top, bottom, viewportHeight),
    ids,
    sourceRects,
  };
};

export default function useStableViewAnchoring({
  enabled = false,
  scrollRef,
  gridRef,
  selection,
  orderedIds = [],
  anchorMode = "last",
  settleFrames = DEFAULT_SETTLE_FRAMES,
} = {}) {
  const pendingRef = useRef(null);
  const lastMeasurementRef = useRef(null);
  const settleFramesRef = useRef(settleFrames);
  const lastKnownTriggerRef = useRef(null);

  useEffect(() => {
    settleFramesRef.current = Number.isFinite(settleFrames)
      ? Math.max(0, Math.floor(settleFrames))
      : DEFAULT_SETTLE_FRAMES;
  }, [settleFrames]);

  const resolveOrderedSelection = useCallback(() => {
    const selectedSet = selection?.selected;
    if (!selectedSet || selectedSet.size === 0) return [];

    if (Array.isArray(orderedIds) && orderedIds.length > 0) {
      const ordered = [];
      for (const id of orderedIds) {
        if (selectedSet.has(id)) ordered.push(id);
      }
      if (ordered.length > 0) return ordered;
    }

    return Array.from(selectedSet);
  }, [orderedIds, selection?.selected]);

  const getElementForId = useCallback(
    (id) => {
      const grid = gridRef?.current;
      if (!grid || !id) return null;
      const escaped = cssEscape(String(id));
      try {
        return grid.querySelector(`[data-video-id="${escaped}"]`);
      } catch (error) {
        console.debug("[stable-anchor] Failed to query element", error);
        return null;
      }
    },
    [gridRef]
  );

  const measureAnchor = useCallback(() => {
    if (!enabled) return null;
    const scrollEl = scrollRef?.current;
    const gridEl = gridRef?.current;
    if (!scrollEl || !gridEl) return null;

    const orderedSelection = resolveOrderedSelection();
    if (!orderedSelection.length) return null;

    const viewportRect = scrollEl.getBoundingClientRect();
    const viewportHeight = viewportRect?.height || scrollEl.clientHeight || 0;
    if (viewportHeight <= 0) return null;

    const buildElementMeasurement = (id) => {
      const node = getElementForId(id);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const top = rect.top - viewportRect.top;
      const bottom = rect.bottom - viewportRect.top;
      return buildMeasurement({
        type: "element",
        anchorId: id,
        top,
        bottom,
        viewportHeight,
        ids: [id],
        sourceRects: [rect],
      });
    };

    if (anchorMode === "centroid") {
      const rects = [];
      orderedSelection.forEach((id) => {
        const node = getElementForId(id);
        if (!node) return;
        rects.push({ id, rect: node.getBoundingClientRect() });
      });
      if (!rects.length) return null;
      let minTop = Infinity;
      let maxBottom = -Infinity;
      rects.forEach(({ rect }) => {
        const top = rect.top - viewportRect.top;
        const bottom = rect.bottom - viewportRect.top;
        if (top < minTop) minTop = top;
        if (bottom > maxBottom) maxBottom = bottom;
      });
      return buildMeasurement({
        type: "centroid",
        anchorId: null,
        top: minTop,
        bottom: maxBottom,
        viewportHeight,
        ids: rects.map((entry) => entry.id),
        sourceRects: rects.map((entry) => entry.rect),
      });
    }

    if (anchorMode === "topVisible") {
      const viewportHeightSafe = viewportHeight;
      for (const id of orderedSelection) {
        const m = buildElementMeasurement(id);
        if (m && computeVisibility(m.top, m.bottom, viewportHeightSafe)) {
          return m;
        }
      }
      // Fallback to last interacted or first selected
    }

    const candidateId = (() => {
      const selectedSet = selection?.selected;
      if (anchorMode === "last") {
        const anchorId = selection?.anchorId;
        if (anchorId && selectedSet?.has(anchorId)) return anchorId;
      }
      if (anchorMode === "topVisible") {
        return orderedSelection[0];
      }
      return selection?.anchorId && selection.selected.has(selection.anchorId)
        ? selection.anchorId
        : orderedSelection[0];
    })();

    if (!candidateId) return null;
    return buildElementMeasurement(candidateId);
  }, [
    anchorMode,
    enabled,
    getElementForId,
    gridRef,
    resolveOrderedSelection,
    scrollRef,
    selection?.anchorId,
    selection?.selected,
  ]);

  const adjustScroll = useCallback(
    (delta) => {
      if (!enabled) return;
      const scrollEl = scrollRef?.current;
      if (!scrollEl) return;
      if (!Number.isFinite(delta) || Math.abs(delta) < 0.25) return;
      const next = scrollEl.scrollTop + delta;
      scrollEl.scrollTop = next;
    },
    [enabled, scrollRef]
  );

  const ensureVisible = useCallback(
    (measurement) => {
      if (!enabled || !measurement) return;
      const scrollEl = scrollRef?.current;
      if (!scrollEl) return;
      const viewportHeight = scrollEl.clientHeight;
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return;

      const { top, bottom } = measurement;
      const { top: paddingTop, bottom: paddingBottom } = getScrollPadding(scrollEl);
      const upperBound = paddingTop;
      const lowerBound = viewportHeight - paddingBottom;

      if (top < upperBound) {
        adjustScroll(top - upperBound);
      } else if (bottom > lowerBound) {
        adjustScroll(bottom - lowerBound);
      }
    },
    [adjustScroll, enabled, scrollRef]
  );

  const finalizeForToken = useCallback(
    (token) => {
      if (!enabled) return;
      const pending = pendingRef.current;
      if (!pending || pending.token !== token) return;

      let frames = 0;
      const step = () => {
        const state = pendingRef.current;
        if (!state || state.token !== token) return;
        if (frames < state.settleFrames) {
          frames += 1;
          requestAnimationFrame(step);
          return;
        }

        const after = measureAnchor();
        if (!after) {
          if ((state.retryCount || 0) < MAX_RETRY_FRAMES) {
            state.retryCount = (state.retryCount || 0) + 1;
            requestAnimationFrame(step);
            return;
          }
          console.debug(
            `[stable-anchor] Anchor not found after ${state.triggerType}; skipping compensation.`
          );
          pendingRef.current = null;
          return;
        }

        const delta = after.viewportY - state.before.viewportY;
        if (Math.abs(delta) > 0.5) {
          adjustScroll(delta);
          const remeasured = measureAnchor();
          if (remeasured) {
            ensureVisible(remeasured);
            lastMeasurementRef.current = remeasured;
          } else {
            ensureVisible(after);
            lastMeasurementRef.current = after;
          }
        } else {
          ensureVisible(after);
          lastMeasurementRef.current = after;
        }

        pendingRef.current = null;
      };

      requestAnimationFrame(step);
    },
    [adjustScroll, enabled, ensureVisible, measureAnchor]
  );

  const begin = useCallback(
    (triggerType, options = {}) => {
      if (!enabled) {
        return () => {};
      }
      const before =
        options.capture === "fresh"
          ? measureAnchor()
          : lastMeasurementRef.current || measureAnchor();
      if (!before || before.isVisible === false) {
        return () => {};
      }
      const settle = Number.isFinite(options.settleFrames)
        ? Math.max(0, Math.floor(options.settleFrames))
        : settleFramesRef.current || DEFAULT_SETTLE_FRAMES;
      const token = Symbol(triggerType || "layout-change");
      lastKnownTriggerRef.current = triggerType;

      return () => {
        if (!enabled) return;
        pendingRef.current = {
          token,
          triggerType,
          before,
          settleFrames: settle,
          retryCount: 0,
        };
        finalizeForToken(token);
      };
    },
    [enabled, finalizeForToken, measureAnchor]
  );

  const notifyLayoutChange = useCallback(
    (triggerType, options = {}) => {
      const finish = begin(triggerType, options);
      finish();
    },
    [begin]
  );

  const runWithStableAnchor = useCallback(
    (triggerType, fn, options = {}) => {
      const finish = begin(triggerType, options);
      let result;
      let threw = false;
      try {
        result = typeof fn === "function" ? fn() : undefined;
      } catch (error) {
        threw = true;
        finish();
        throw error;
      }
      if (result && typeof result.then === "function") {
        return result
          .then((value) => {
            finish();
            return value;
          })
          .catch((error) => {
            finish();
            throw error;
          });
      }
      if (!threw) finish();
      return result;
    },
    [begin]
  );

  useLayoutEffect(() => {
    if (!enabled) {
      lastMeasurementRef.current = null;
      pendingRef.current = null;
      return;
    }
    const measurement = measureAnchor();
    if (measurement) {
      lastMeasurementRef.current = measurement;
    }
  });

  useEffect(() => {
    if (!enabled) return;
    const scrollEl = scrollRef?.current;
    if (!scrollEl) return;
    scrollEl.style.setProperty("overflow-anchor", "auto");
  }, [enabled, scrollRef]);

  useEffect(() => {
    if (!enabled) return undefined;
    let raf = null;
    const handleResize = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        notifyLayoutChange("windowResize", { settleFrames: 1 });
      });
    };
    window.addEventListener("resize", handleResize, { passive: true });
    return () => {
      window.removeEventListener("resize", handleResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [enabled, notifyLayoutChange]);

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof ResizeObserver === "undefined") return undefined;
    const gridEl = gridRef?.current;
    if (!gridEl) return undefined;

    let lastWidth = gridEl.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect?.width;
        if (!Number.isFinite(width)) continue;
        if (lastWidth == null) {
          lastWidth = width;
          continue;
        }
        if (Math.abs(width - lastWidth) >= 0.5) {
          lastWidth = width;
          notifyLayoutChange("gridWidthChange", { settleFrames: 1 });
        }
      }
    });

    observer.observe(gridEl);
    return () => observer.disconnect();
  }, [enabled, gridRef, notifyLayoutChange]);

  return {
    runWithStableAnchor,
    notifyLayoutChange,
    beginLayoutChange: begin,
    lastKnownTrigger: lastKnownTriggerRef.current,
  };
}
