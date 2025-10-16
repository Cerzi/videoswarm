import { useCallback, useEffect, useRef } from "react";
import useSelectionScrollCycler from "./useSelectionScrollCycler";

const MAX_SELECTION_VISIBILITY_ATTEMPTS = 8;

const escapeAttributeValue = (value) => {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(str);
  }
  return str.replace(/["\\]/g, "\\$&");
};

const isElementVerticallyVisible = (container, element, margin = 0) => {
  if (!container || !element) return false;
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return (
    elementRect.bottom >= containerRect.top + margin &&
    elementRect.top <= containerRect.bottom - margin
  );
};

export default function useSelectionVisibilityManager({
  selection,
  orderedSelectionIds,
  scrollContainerRef,
  gridRef,
}) {
  const selectionScrollSnapshotRef = useRef(null);
  const selectionVisibilityScheduleRef = useRef({ handle: null, attempts: 0 });

  const captureSnapshot = useCallback(() => {
    if (selection.size === 0) {
      selectionScrollSnapshotRef.current = null;
      return null;
    }

    const container = scrollContainerRef.current;
    const gridEl = gridRef.current;
    if (!container || !gridEl) {
      selectionScrollSnapshotRef.current = null;
      return null;
    }

    const firstSelectedId =
      selection.anchorId ??
      (selection.selected.size
        ? selection.selected.values().next().value
        : null);

    if (firstSelectedId == null) {
      selectionScrollSnapshotRef.current = null;
      return null;
    }

    const selector = `[data-video-id="${escapeAttributeValue(firstSelectedId)}"]`;
    const cardEl = gridEl.querySelector(selector);
    if (!cardEl) {
      selectionScrollSnapshotRef.current = null;
      return null;
    }

    const containerRect = container.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const snapshot = {
      id: firstSelectedId,
      selector,
      offset: cardRect.top - containerRect.top,
    };
    selectionScrollSnapshotRef.current = snapshot;
    return snapshot;
  }, [selection.anchorId, selection.selected, selection.size, scrollContainerRef, gridRef]);

  const clearSnapshot = useCallback(() => {
    selectionScrollSnapshotRef.current = null;
  }, []);

  const restoreSnapshot = useCallback(
    ({ releaseSnapshot = false, margin = 24 } = {}) => {
      const container = scrollContainerRef.current;
      const gridEl = gridRef.current;
      if (!container || !gridEl) {
        if (releaseSnapshot) selectionScrollSnapshotRef.current = null;
        return false;
      }

      const snapshot = selectionScrollSnapshotRef.current;
      const selectedId = snapshot?.id
        ? snapshot.id
        : selection.anchorId ??
          (selection.selected.size
            ? selection.selected.values().next().value
            : null);

      if (selectedId == null) {
        if (releaseSnapshot || !selection.size) {
          selectionScrollSnapshotRef.current = null;
        }
        return true;
      }

      const selector = snapshot?.selector
        ? snapshot.selector
        : `[data-video-id="${escapeAttributeValue(selectedId)}"]`;
      const cardEl = gridEl.querySelector(selector);
      if (!cardEl) {
        if (releaseSnapshot) selectionScrollSnapshotRef.current = null;
        return false;
      }

      if (snapshot) {
        const containerRect = container.getBoundingClientRect();
        const cardRect = cardEl.getBoundingClientRect();
        const desiredOffset = snapshot.offset;
        const currentOffset = cardRect.top - containerRect.top;
        const delta = currentOffset - desiredOffset;
        if (Math.abs(delta) > 1) {
          container.scrollTop += delta;
        }
      }

      let visible = isElementVerticallyVisible(container, cardEl, margin);
      if (!visible) {
        cardEl.scrollIntoView({ block: "nearest", inline: "nearest" });
        visible = isElementVerticallyVisible(container, cardEl, margin);
      }

      if (visible || releaseSnapshot) {
        selectionScrollSnapshotRef.current = null;
      }

      return visible;
    },
    [
      gridRef,
      scrollContainerRef,
      selection.anchorId,
      selection.selected,
      selection.size,
    ]
  );

  const scheduleEnsureVisible = useCallback(() => {
    if (selection.size === 0) {
      selectionScrollSnapshotRef.current = null;
      return;
    }

    const state = selectionVisibilityScheduleRef.current;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    const cancelRaf =
      typeof cancelAnimationFrame === "function"
        ? cancelAnimationFrame
        : clearTimeout;

    if (state.handle !== null) {
      cancelRaf(state.handle);
      state.handle = null;
    }
    state.attempts = 0;

    const run = () => {
      state.handle = null;
      const releaseSnapshot =
        state.attempts >= MAX_SELECTION_VISIBILITY_ATTEMPTS - 1;
      const visible = restoreSnapshot({ releaseSnapshot, margin: 32 });
      state.attempts += 1;
      if (!visible && state.attempts < MAX_SELECTION_VISIBILITY_ATTEMPTS) {
        state.handle = raf(run);
      }
    };

    state.handle = raf(run);
  }, [restoreSnapshot, selection.size]);

  useEffect(() => {
    const cancelRaf =
      typeof cancelAnimationFrame === "function"
        ? cancelAnimationFrame
        : clearTimeout;
    return () => {
      const state = selectionVisibilityScheduleRef.current;
      if (state.handle !== null) {
        cancelRaf(state.handle);
        state.handle = null;
      }
    };
  }, []);

  const ensureSelectedCardVisible = useCallback(
    (targetId) => {
      if (!targetId) return false;
      const container = scrollContainerRef.current;
      const gridEl = gridRef.current;
      if (!container || !gridEl) return false;

      const selector = `[data-video-id="${escapeAttributeValue(targetId)}"]`;
      const cardEl = gridEl.querySelector(selector);
      if (!cardEl) return false;

      let visible = isElementVerticallyVisible(container, cardEl, 32);
      if (!visible) {
        cardEl.scrollIntoView({ block: "center", inline: "nearest" });
        visible = isElementVerticallyVisible(container, cardEl, 32);
      }

      const containerRect = container.getBoundingClientRect();
      const cardRect = cardEl.getBoundingClientRect();
      selectionScrollSnapshotRef.current = {
        id: targetId,
        selector,
        offset: cardRect.top - containerRect.top,
      };

      return visible;
    },
    [gridRef, scrollContainerRef]
  );

  const ensureAndSchedule = useCallback(
    (targetId) => {
      const success = ensureSelectedCardVisible(targetId);
      if (success) {
        scheduleEnsureVisible();
      }
      return success;
    },
    [ensureSelectedCardVisible, scheduleEnsureVisible]
  );

  const scrollSelectedCardFromPanel = useSelectionScrollCycler(
    orderedSelectionIds,
    ensureAndSchedule
  );

  useEffect(() => {
    const gridEl = gridRef.current;
    if (!gridEl || typeof ResizeObserver === "undefined") return undefined;

    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    const cancelRaf =
      typeof cancelAnimationFrame === "function"
        ? cancelAnimationFrame
        : clearTimeout;

    let pendingHandle = null;
    const observer = new ResizeObserver(() => {
      if (!selectionScrollSnapshotRef.current) return;
      if (pendingHandle !== null) {
        cancelRaf(pendingHandle);
      }
      pendingHandle = raf(() => {
        pendingHandle = null;
        scheduleEnsureVisible();
      });
    });

    observer.observe(gridEl);

    return () => {
      observer.disconnect();
      if (pendingHandle !== null) {
        cancelRaf(pendingHandle);
      }
    };
  }, [gridRef, scheduleEnsureVisible]);

  return {
    captureSnapshot,
    clearSnapshot,
    scheduleEnsureVisible,
    scrollSelectedCardFromPanel,
  };
}
