import { useCallback, useEffect, useRef } from "react";

const safeCssEscape = (value) => {
  if (typeof value !== "string") {
    value = value != null ? String(value) : "";
  }
  if (typeof window !== "undefined" && window.CSS?.escape) {
    return window.CSS.escape(value);
  }
  return value.replace(/"/g, '\\"').replace(/'/g, "\\'");
};

const getScrollPadding = (el) => {
  if (!el || typeof window === "undefined") {
    return { top: 0, bottom: 0 };
  }
  let style;
  try {
    style = window.getComputedStyle(el);
  } catch (error) {
    return { top: 0, bottom: 0 };
  }
  const top = parseFloat(style?.scrollPaddingTop) || 0;
  const bottom = parseFloat(style?.scrollPaddingBottom) || 0;
  return { top, bottom };
};

export default function useSelectionScroller({
  orderedIds = [],
  gridRef,
  scrollRef,
  runWithStableAnchor,
} = {}) {
  const indexRef = useRef(0);

  useEffect(() => {
    indexRef.current = 0;
  }, [orderedIds]);

  const getElementForId = useCallback(
    (id) => {
      const grid = gridRef?.current;
      if (!grid || !id) return null;
      const escaped = safeCssEscape(String(id));
      try {
        return grid.querySelector(`[data-video-id="${escaped}"]`);
      } catch (error) {
        return null;
      }
    },
    [gridRef]
  );

  const scrollElementIntoView = useCallback(
    (element) => {
      if (!element) return false;
      const scrollEl = scrollRef?.current;
      if (!scrollEl) return false;

      const viewportRect = scrollEl.getBoundingClientRect?.();
      if (!viewportRect) return false;

      const targetRect = element.getBoundingClientRect?.();
      if (!targetRect) return false;

      const { top: paddingTop, bottom: paddingBottom } = getScrollPadding(scrollEl);

      const topBoundary = viewportRect.top + paddingTop;
      const bottomBoundary = viewportRect.bottom - paddingBottom;

      if (targetRect.top < topBoundary) {
        const delta = targetRect.top - topBoundary;
        scrollEl.scrollTop += delta;
        return true;
      }

      if (targetRect.bottom > bottomBoundary) {
        const delta = targetRect.bottom - bottomBoundary;
        scrollEl.scrollTop += delta;
        return true;
      }

      return true;
    },
    [scrollRef]
  );

  const scrollToNextSelected = useCallback(() => {
    const total = orderedIds.length;
    if (!total) return false;

    const currentIndex = indexRef.current % total;
    indexRef.current = (currentIndex + 1) % total;

    const targetId = orderedIds[currentIndex];
    if (!targetId) return false;

    const performScroll = () => {
      const element = getElementForId(targetId);
      if (!element) return false;
      const ok = scrollElementIntoView(element);
      if (!ok && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "nearest" });
        return true;
      }
      return ok;
    };

    if (typeof runWithStableAnchor === "function") {
      return runWithStableAnchor(
        "selection:scroll-to",
        () => performScroll(),
        { capture: "reuse-visible", settleFrames: 0, stabilizeFrames: 1 }
      );
    }

    return performScroll();
  }, [getElementForId, orderedIds, runWithStableAnchor, scrollElementIntoView]);

  return { scrollToNextSelected };
}
