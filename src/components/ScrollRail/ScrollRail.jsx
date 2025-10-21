import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import "./ScrollRail.css";

const clamp01 = (value) => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

const THUMB_HEIGHT = 24;
const PREVIEW_HEIGHT = 36;
const OVERLAY_ROOT_ID = "vs-scroll-rail-overlay-root";

const ensureOverlayHost = () => {
  if (typeof document === "undefined") return null;
  let host = document.getElementById(OVERLAY_ROOT_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = OVERLAY_ROOT_ID;
    host.className = "scroll-rail-overlay-root";
    document.body.appendChild(host);
  }
  return host;
};

export default function ScrollRail({
  total = 0,
  rangeStart = 0,
  rangeEnd = 0,
  indexToOffset,
  offsetToIndex,
  totalHeight = 0,
  labelForIndex,
  onScrub,
  onCommit,
}) {
  const hasItems = total > 0;
  const [overlayHost, setOverlayHost] = useState(() => ensureOverlayHost());
  const trackRef = useRef(null);
  const [isActive, setIsActive] = useState(false);
  const [preview, setPreview] = useState(null);
  const previewRef = useRef(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [trackHeight, setTrackHeight] = useState(0);

  useEffect(() => {
    if (overlayHost || typeof document === "undefined") return undefined;
    const host = ensureOverlayHost();
    if (host) {
      setOverlayHost(host);
    }
    return undefined;
  }, [overlayHost]);

  const measureTrack = useCallback(() => {
    const node = trackRef.current;
    if (!node) return;
    try {
      const rect = node.getBoundingClientRect?.();
      const nextHeight = rect && Number.isFinite(rect.height) ? rect.height : 0;
      setTrackHeight((prev) => (Math.abs(prev - nextHeight) > 0.5 ? nextHeight : prev));
    } catch {
      setTrackHeight((prev) => (prev > 0 ? prev : 0));
    }
  }, []);

  useLayoutEffect(() => {
    if (!hasItems) {
      setTrackHeight(0);
      return undefined;
    }
    measureTrack();
    const node = trackRef.current;
    let resizeObserver;
    if (typeof ResizeObserver !== "undefined" && node) {
      resizeObserver = new ResizeObserver(() => measureTrack());
      resizeObserver.observe(node);
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", measureTrack);
    }
    return () => {
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else if (typeof window !== "undefined") {
        window.removeEventListener("resize", measureTrack);
      }
    };
  }, [hasItems, measureTrack]);

  const clampIndex = useCallback(
    (index) => {
      if (!hasItems) return 0;
      if (!Number.isFinite(index)) return 0;
      if (index < 0) return 0;
      if (index >= total) return total - 1;
      return index;
    },
    [hasItems, total]
  );

  useEffect(() => {
    if (isActive || !hasItems) return;
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) return;
    const center = clampIndex(Math.floor((rangeStart + rangeEnd) / 2));
    setFocusIndex(center);
  }, [isActive, hasItems, rangeStart, rangeEnd, clampIndex]);

  const resolveEntryOffset = useCallback(
    (index) => {
      if (!hasItems) return { offset: 0, height: 0 };
      if (typeof indexToOffset === "function") {
        const { y = 0, height = 0 } = indexToOffset(index) || {};
        return {
          offset: Number.isFinite(y) ? y : 0,
          height: Number.isFinite(height) ? height : 0,
        };
      }
      return { offset: 0, height: 0 };
    },
    [hasItems, indexToOffset]
  );

  const updatePreview = useCallback(
    (targetIndex) => {
      if (!hasItems) return;
      const safeIndex = clampIndex(targetIndex);
      const details = onScrub?.(safeIndex) || { index: safeIndex };
      const resolvedIndex = clampIndex(details?.index ?? safeIndex);
      const fallback = resolveEntryOffset(resolvedIndex);
      const offset = Number.isFinite(details?.offset)
        ? details.offset
        : fallback.offset;
      const height = Number.isFinite(details?.height) ? details.height : fallback.height;
      const ratio = totalHeight > 0 ? clamp01(offset / totalHeight) : resolvedIndex / Math.max(1, total);
      const label = labelForIndex
        ? labelForIndex(resolvedIndex)
        : `${resolvedIndex + 1} of ${total}`;
      const snapshot = {
        index: resolvedIndex,
        offset,
        height,
        ratio,
        label,
      };
      previewRef.current = snapshot;
      setPreview(snapshot);
      setFocusIndex(resolvedIndex);
    },
    [
      clampIndex,
      hasItems,
      onScrub,
      resolveEntryOffset,
      totalHeight,
      total,
      labelForIndex,
    ]
  );

  const releasePreview = useCallback(() => {
    previewRef.current = null;
    setPreview(null);
    setIsActive(false);
  }, []);

  const commitPreview = useCallback(() => {
    const snapshot = previewRef.current;
    if (!snapshot) return;
    onCommit?.(snapshot.index);
  }, [onCommit]);

  const deriveIndexFromPointer = useCallback(
    (event) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return focusIndex;
      const relative = event.clientY - rect.top;
      const ratio = clamp01(rect.height > 0 ? relative / rect.height : 0);
      if (typeof offsetToIndex === "function" && totalHeight > 0) {
        const offset = ratio * totalHeight;
        return clampIndex(offsetToIndex(offset));
      }
      return clampIndex(Math.round(ratio * Math.max(0, total - 1)));
    },
    [clampIndex, focusIndex, offsetToIndex, total, totalHeight]
  );

  const handlePointerDown = useCallback(
    (event) => {
      if (!hasItems) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.currentTarget.focus === "function") {
        try {
          event.currentTarget.focus({ preventScroll: true });
        } catch {
          event.currentTarget.focus();
        }
      }
      const index = deriveIndexFromPointer(event);
      setIsActive(true);
      updatePreview(index);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [deriveIndexFromPointer, hasItems, updatePreview]
  );

  const handlePointerMove = useCallback(
    (event) => {
      if (!isActive) return;
      event.preventDefault();
      event.stopPropagation();
      const index = deriveIndexFromPointer(event);
      updatePreview(index);
    },
    [deriveIndexFromPointer, isActive, updatePreview]
  );

  const handlePointerUp = useCallback(
    (event) => {
      if (!isActive) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      commitPreview();
      releasePreview();
    },
    [commitPreview, isActive, releasePreview]
  );

  const handlePointerCancel = useCallback(
    (event) => {
      if (!isActive) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      releasePreview();
    },
    [isActive, releasePreview]
  );

  const handleKeyDown = useCallback(
    (event) => {
      if (!hasItems) return;
      let nextIndex = focusIndex;
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        nextIndex = clampIndex(focusIndex + 1);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        nextIndex = clampIndex(focusIndex - 1);
      } else if (event.key === "PageDown") {
        nextIndex = clampIndex(focusIndex + Math.max(1, Math.floor(total / 10)));
      } else if (event.key === "PageUp") {
        nextIndex = clampIndex(focusIndex - Math.max(1, Math.floor(total / 10)));
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = total - 1;
      } else {
        return;
      }
      event.preventDefault();
      setFocusIndex(nextIndex);
      updatePreview(nextIndex);
      commitPreview();
      releasePreview();
    },
    [clampIndex, commitPreview, focusIndex, hasItems, releasePreview, total, updatePreview]
  );

  const activeIndex = preview?.index ?? clampIndex(focusIndex);
  const activeEntry = resolveEntryOffset(activeIndex);
  const activeRatio = totalHeight > 0
    ? clamp01(activeEntry.offset / totalHeight)
    : activeIndex / Math.max(1, total);

  const clampToTrack = useCallback(
    (value, pad = 0) => {
      if (!(trackHeight > 0)) return null;
      const max = Math.max(trackHeight - pad, 0);
      if (value < 0) return 0;
      if (value > max) return max;
      return value;
    },
    [trackHeight]
  );

  const highlightStyle = useMemo(() => {
    if (!hasItems) return { top: "0%", height: "0%" };
    const startIndex = clampIndex(Math.min(rangeStart, rangeEnd));
    const endIndex = clampIndex(Math.max(rangeStart, rangeEnd));
    if (endIndex < startIndex) return { top: "0%", height: "0%" };
    const startEntry = resolveEntryOffset(startIndex);
    const endEntry = resolveEntryOffset(endIndex);
    const startRatio = totalHeight > 0
      ? clamp01(startEntry.offset / totalHeight)
      : startIndex / Math.max(1, total);
    const endOffset = endEntry.offset + Math.max(0, endEntry.height);
    const endRatio = totalHeight > 0
      ? clamp01(endOffset / totalHeight)
      : (endIndex + 1) / Math.max(1, total);
    const diff = Math.max(0.015, endRatio - startRatio);

    if (trackHeight > 0) {
      const startPx = clampToTrack(startRatio * trackHeight);
      const endPx = clampToTrack(endRatio * trackHeight, 0);
      const heightPx = Math.max(trackHeight * 0.015, (endPx ?? 0) - (startPx ?? 0));
      return {
        top: `${startPx ?? 0}px`,
        height: `${Math.min(trackHeight, heightPx)}px`,
      };
    }

    return {
      top: `${startRatio * 100}%`,
      height: `${diff * 100}%`,
    };
  }, [
    clampIndex,
    hasItems,
    rangeEnd,
    rangeStart,
    resolveEntryOffset,
    totalHeight,
    total,
    trackHeight,
    clampToTrack,
  ]);

  const thumbStyle = useMemo(
    () => {
      const centered = activeRatio * trackHeight - THUMB_HEIGHT / 2;
      const clamped = clampToTrack(centered, THUMB_HEIGHT);
      if (clamped == null) {
        return { top: `calc(${activeRatio * 100}% - ${THUMB_HEIGHT / 2}px)` };
      }
      return { top: `${clamped}px` };
    },
    [activeRatio, clampToTrack, trackHeight]
  );

  const previewStyle = useMemo(() => {
    if (!preview) return null;
    const centered = preview.ratio * trackHeight - PREVIEW_HEIGHT / 2;
    const clamped = clampToTrack(centered, PREVIEW_HEIGHT);
    if (clamped == null) {
      return { top: `calc(${preview.ratio * 100}% - ${PREVIEW_HEIGHT / 2}px)` };
    }
    return { top: `${clamped}px` };
  }, [preview, clampToTrack, trackHeight]);

  const ariaLabel = useMemo(() => {
    const base = preview?.label || (labelForIndex ? labelForIndex(activeIndex) : "Scroll position");
    return base;
  }, [activeIndex, labelForIndex, preview]);

  if (!overlayHost) {
    return null;
  }

  return createPortal(
    <div className="scroll-rail-overlay" aria-hidden={!hasItems}>
      <div className="scroll-rail">
        <div
          className="scroll-rail__track"
          ref={trackRef}
          role="slider"
          tabIndex={hasItems ? 0 : -1}
          aria-valuemin={hasItems ? 1 : 0}
          aria-valuemax={hasItems ? total : 0}
          aria-valuenow={hasItems ? activeIndex + 1 : 0}
          aria-label={ariaLabel}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <div className="scroll-rail__range" style={highlightStyle} />
          <div className="scroll-rail__thumb" style={thumbStyle} />
        </div>
        {preview && (
          <div className="scroll-rail__label" style={previewStyle}>
            <span>{preview.label}</span>
          </div>
        )}
      </div>
    </div>,
    overlayHost
  );
}
