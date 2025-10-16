import { useCallback, useEffect, useMemo, useRef } from "react";

const DEFAULT_TRIGGER = "metadata:scrollToSelection";

const getScrollPadding = (element) => {
  if (!element || typeof window === "undefined") {
    return { top: 0, bottom: 0 };
  }
  try {
    const style = window.getComputedStyle(element);
    return {
      top: parseFloat(style.scrollPaddingTop) || 0,
      bottom: parseFloat(style.scrollPaddingBottom) || 0,
    };
  } catch (error) {
    console.debug("[selection-cycler] Failed to read scroll padding", error);
    return { top: 0, bottom: 0 };
  }
};

const cssEscape = (value) => {
  const stringValue = value == null ? "" : String(value);
  if (typeof window !== "undefined" && window.CSS?.escape) {
    return window.CSS.escape(stringValue);
  }
  return stringValue.replace(/"/g, '\\"').replace(/'/g, "\\'");
};

const clampScrollTop = (value) => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
};

export default function useSelectionCycler({
  orderedSelectionIds = [],
  scrollRef,
  gridRef,
  runWithStableAnchor,
  anchorOptions,
  triggerType = DEFAULT_TRIGGER,
} = {}) {
  const selectionKey = useMemo(() => {
    if (!Array.isArray(orderedSelectionIds) || orderedSelectionIds.length === 0) {
      return "";
    }
    return orderedSelectionIds.map((id) => String(id)).join("|");
  }, [orderedSelectionIds]);

  const cycleStateRef = useRef({ key: selectionKey, index: -1 });

  useEffect(() => {
    cycleStateRef.current = { key: selectionKey, index: -1 };
  }, [selectionKey]);

  return useCallback(() => {
    const ids = Array.isArray(orderedSelectionIds) ? orderedSelectionIds : [];
    if (!ids.length) return false;

    const scrollEl = scrollRef?.current;
    const gridEl = gridRef?.current;
    if (!scrollEl || !gridEl) return false;

    const state = cycleStateRef.current;
    if (state.key !== selectionKey) {
      state.key = selectionKey;
      state.index = -1;
    }

    const previousIndex = Number.isInteger(state.index) ? state.index : -1;
    const nextIndex = ids.length === 1 ? 0 : (previousIndex + 1) % ids.length;
    const targetId = ids[nextIndex];
    if (targetId == null) return false;

    const applyScroll = () => {
      let targetNode = null;
      const escapedId = cssEscape(targetId);
      try {
        targetNode = gridEl.querySelector(
          `[data-video-id="${escapedId}"]`
        );
      } catch (error) {
        console.debug("[selection-cycler] Failed to query target node", error);
        return false;
      }
      if (!targetNode?.getBoundingClientRect) return false;
      if (!scrollEl.getBoundingClientRect) return false;

      const viewportRect = scrollEl.getBoundingClientRect();
      const targetRect = targetNode.getBoundingClientRect();
      const viewportHeight = scrollEl.clientHeight ?? viewportRect.height ?? 0;
      if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;

      const padding = getScrollPadding(scrollEl);
      const topOffset = targetRect.top - viewportRect.top;
      const bottomOffset = targetRect.bottom - viewportRect.top;
      const upperBound = padding.top;
      const lowerBound = viewportHeight - padding.bottom;
      const currentTop = scrollEl.scrollTop ?? 0;

      if (topOffset < upperBound) {
        const nextTop = clampScrollTop(currentTop + topOffset - upperBound);
        scrollEl.scrollTop = nextTop;
        return true;
      }

      if (bottomOffset > lowerBound) {
        const nextTop = clampScrollTop(currentTop + bottomOffset - lowerBound);
        scrollEl.scrollTop = nextTop;
        return true;
      }

      const available = viewportHeight - padding.top - padding.bottom - targetRect.height;
      if (Number.isFinite(available) && available > 0) {
        const delta = topOffset - padding.top - available / 2;
        const nextTop = clampScrollTop(currentTop + delta);
        scrollEl.scrollTop = nextTop;
      }

      return true;
    };

    const run = typeof runWithStableAnchor === "function"
      ? runWithStableAnchor(triggerType, applyScroll, anchorOptions)
      : applyScroll();

    const didScroll = run === true;
    if (didScroll) {
      state.index = nextIndex;
      state.key = selectionKey;
    } else {
      state.index = previousIndex;
    }

    return didScroll;
  }, [anchorOptions, gridRef, orderedSelectionIds, runWithStableAnchor, scrollRef, selectionKey, triggerType]);
}
