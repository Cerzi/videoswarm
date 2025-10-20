import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./ScrollRail.css";

const clamp01 = (value) => {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

export default function ScrollRail({
  total = 0,
  rangeStart = 0,
  rangeEnd = 0,
  indexToOffset,
  getEntry,
  offsetToIndex,
  totalHeight = 0,
  labelForIndex,
  onScrub,
  onCommit,
}) {
  const hasItems = total > 0;
  const trackRef = useRef(null);
  const [isActive, setIsActive] = useState(false);
  const [preview, setPreview] = useState(null);
  const previewRef = useRef(null);
  const [focusIndex, setFocusIndex] = useState(0);

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
      const entry = getEntry?.(index);
      if (entry) {
        const offset = Number.isFinite(entry.y) ? entry.y : 0;
        const height = Number.isFinite(entry.height) ? entry.height : 0;
        return { offset, height };
      }
      if (typeof indexToOffset === "function") {
        const { y = 0 } = indexToOffset(index) || {};
        return { offset: Number.isFinite(y) ? y : 0, height: 0 };
      }
      return { offset: 0, height: 0 };
    },
    [getEntry, hasItems, indexToOffset]
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
  ]);

  const thumbStyle = useMemo(
    () => ({
      top: `calc(${activeRatio * 100}% - 12px)`,
    }),
    [activeRatio]
  );

  const previewStyle = useMemo(() => {
    if (!preview) return null;
    return {
      top: `calc(${preview.ratio * 100}% - 18px)`,
    };
  }, [preview]);

  const ariaLabel = useMemo(() => {
    const base = preview?.label || (labelForIndex ? labelForIndex(activeIndex) : "Scroll position");
    return base;
  }, [activeIndex, labelForIndex, preview]);

  return (
    <div className="scroll-rail" aria-hidden={!hasItems}>
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
  );
}
