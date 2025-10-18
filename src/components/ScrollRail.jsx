import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SortKey } from "../sorting/sorting.js";
import "./ScrollRail.css";

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function resolveTimestamp(video) {
  if (!video) return null;
  const direct = Number(video?.createdMs);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  if (video?.dateCreated) {
    const parsed = Date.parse(video.dateCreated);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export default function ScrollRail({
  scrollRef,
  orderedVideos,
  sortKey,
  sortDir,
  getEstimatedOffsetForIndex,
  getEstimatedIndexForOffset,
  getScrollHeightEstimate,
  viewportHeightPx,
  onScrubStateChange = () => {},
  onActiveIndexChange = () => {},
}) {
  const trackRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const totalCount = orderedVideos.length;
  const effectiveIndex = clamp(activeIndex, 0, Math.max(0, totalCount - 1));
  const activeVideo = totalCount ? orderedVideos[effectiveIndex] : null;

  const labelFormatter = useMemo(() => {
    const total = totalCount;
    if (sortKey === SortKey.CREATED) {
      const formatter = new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      return (video, index) => {
        if (!video) return total ? `0/${total}` : "";
        const ts = resolveTimestamp(video);
        const label = ts ? formatter.format(new Date(ts)) : video.basename;
        return label ? `${label} • ${index + 1}/${total}` : `${index + 1}/${total}`;
      };
    }
    if (sortKey === SortKey.NAME) {
      return (video, index) => {
        if (!video) return total ? `0/${total}` : "";
        const name = video.basename || video.filename || video.id || "Video";
        const initial = name.trim().charAt(0).toUpperCase() || "#";
        return `${initial} • ${name} • ${index + 1}/${total}`;
      };
    }
    return (video, index) => {
      if (!video) return total ? `0/${total}` : "";
      const label = video.basename || video.id || "Item";
      return `#${index + 1} • ${label}`;
    };
  }, [sortKey, totalCount]);

  const activeLabel = activeVideo
    ? labelFormatter(activeVideo, effectiveIndex)
    : "";

  const updateFromScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const viewport = el.clientHeight || viewportHeightPx || 1;
    const scrollHeight = el.scrollHeight || 0;
    const estimate = getScrollHeightEstimate();
    const effectiveHeight = Math.max(scrollHeight, estimate || 0);
    const maxScrollRaw = effectiveHeight > viewport ? effectiveHeight - viewport : 0;
    const maxScroll = Math.max(1, maxScrollRaw || 1);
    const top = clamp(el.scrollTop || 0, 0, maxScroll);
    setProgress(top / maxScroll);
    const idx = getEstimatedIndexForOffset(top);
    setActiveIndex(idx);
    onActiveIndexChange(idx);
  }, [
    scrollRef,
    viewportHeightPx,
    getScrollHeightEstimate,
    getEstimatedIndexForOffset,
    onActiveIndexChange,
  ]);

  useEffect(() => {
    if (!totalCount) {
      setProgress(0);
      setActiveIndex(0);
    }
  }, [totalCount]);

  useEffect(() => {
    updateFromScroll();
  }, [updateFromScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateFromScroll();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, updateFromScroll]);

  const applyScrub = useCallback(
    (clientY) => {
      if (!trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      if (!rect || !rect.height) return;
      const rel = clamp((clientY - rect.top) / rect.height, 0, 1);
      setProgress(rel);
      if (!totalCount) return;
      const index = clamp(Math.round(rel * (totalCount - 1)), 0, totalCount - 1);
      setActiveIndex(index);
      onActiveIndexChange(index);
      const el = scrollRef.current;
      if (!el) return;
      const estimatedOffset = getEstimatedOffsetForIndex(index);
      const viewport = el.clientHeight || viewportHeightPx || 0;
      const scrollHeight = el.scrollHeight || 0;
      const estimate = getScrollHeightEstimate();
      const effectiveHeight = Math.max(scrollHeight, estimate || 0);
      const maxScroll = Math.max(0, effectiveHeight - viewport);
      const target = clamp(estimatedOffset, 0, maxScroll);
      el.scrollTo({ top: target, behavior: "auto" });
    },
    [
      totalCount,
      scrollRef,
      getEstimatedOffsetForIndex,
      viewportHeightPx,
      getScrollHeightEstimate,
      onActiveIndexChange,
    ]
  );

  const handlePointerDown = useCallback(
    (event) => {
      if (!trackRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        trackRef.current.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      setIsDragging(true);
      onScrubStateChange(true);
      applyScrub(event.clientY);
    },
    [applyScrub, onScrubStateChange]
  );

  const handleTrackEnter = useCallback(() => {
    setIsHovering(true);
  }, []);

  const handleTrackLeave = useCallback(() => {
    if (isDragging) return;
    setIsHovering(false);
  }, [isDragging]);

  useEffect(() => {
    if (!isDragging) return undefined;
    const handleMove = (event) => {
      applyScrub(event.clientY);
    };
    const handleUp = (event) => {
      try {
        trackRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        // ignore release errors
      }
      setIsDragging(false);
      setIsHovering(false);
      onScrubStateChange(false);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      document.body.style.userSelect = prevUserSelect;
      onScrubStateChange(false);
    };
  }, [isDragging, applyScrub, onScrubStateChange]);

  if (!totalCount) {
    return null;
  }

  const showLabel = (isHovering || isDragging) && activeLabel;

  return (
    <div className={`scroll-rail${isDragging ? " scroll-rail--dragging" : ""}`}>
      <div
        ref={trackRef}
        className="scroll-rail__track"
        role="presentation"
        onPointerDown={handlePointerDown}
        onPointerEnter={handleTrackEnter}
        onPointerLeave={handleTrackLeave}
      >
        <div
          className="scroll-rail__thumb"
          style={{ top: `${progress * 100}%` }}
        />
      </div>
      {showLabel ? (
        <div className="scroll-rail__label" data-sort={sortKey} data-dir={sortDir}>
          {activeLabel}
        </div>
      ) : null}
    </div>
  );
}
