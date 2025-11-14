import { useCallback } from 'react';

const MIN_PARTIAL_OVERLAP_RATIO = 0.2;

function clampPointer(pointer, fallbackRect) {
  if (!pointer ||
      typeof pointer.clientX !== 'number' ||
      Number.isNaN(pointer.clientX) ||
      typeof pointer.clientY !== 'number' ||
      Number.isNaN(pointer.clientY)) {
    const centerX = (fallbackRect.left + fallbackRect.right) / 2;
    const centerY = (fallbackRect.top + fallbackRect.bottom) / 2;
    return { x: centerX, y: centerY };
  }

  return { x: pointer.clientX, y: pointer.clientY };
}

function overlapsMeaningfully(rect, box, pointer) {
  const overlapLeft = Math.max(box.left, rect.left);
  const overlapRight = Math.min(box.right, rect.right);
  const overlapTop = Math.max(box.top, rect.top);
  const overlapBottom = Math.min(box.bottom, rect.bottom);

  const overlapWidth = overlapRight - overlapLeft;
  const overlapHeight = overlapBottom - overlapTop;

  if (overlapWidth <= 0 || overlapHeight <= 0) {
    return false;
  }

  const overlapArea = overlapWidth * overlapHeight;
  const rectWidth = rect.width ?? rect.right - rect.left;
  const rectHeight = rect.height ?? rect.bottom - rect.top;
  const rectArea = rectWidth * rectHeight;

  const coverage = rectArea > 0 ? overlapArea / rectArea : 0;

  const pointerInside = pointer &&
    pointer.x >= rect.left &&
    pointer.x <= rect.right &&
    pointer.y >= rect.top &&
    pointer.y <= rect.bottom;

  const boxInsideRect =
    box.left >= rect.left &&
    box.right <= rect.right &&
    box.top >= rect.top &&
    box.bottom <= rect.bottom;

  return coverage >= MIN_PARTIAL_OVERLAP_RATIO || pointerInside || boxInsideRect;
}

/**
 * Given a masonry gridRef, provides helpers to compute/select a bounding-box range.
 * Assumes each card root has: class="video-item" and data-video-id={id}
 */
export default function useMasonryBoxSelection(gridRef) {
  const getBoxSelectionIds = useCallback((anchorId, endId, pointer) => {
    const grid = gridRef?.current;
    if (!grid || !anchorId || !endId) return new Set();

    const items = Array.from(grid.querySelectorAll('.video-item'));
    if (!items.length) return new Set();

    const rects = items.map(el => ({
      id: el.dataset.videoId || el.dataset.filename,
      rect: el.getBoundingClientRect()
    }));

    const anchorRect = rects.find(r => r.id === anchorId)?.rect;
    const endRect = rects.find(r => r.id === endId)?.rect;
    if (!anchorRect || !endRect) return new Set();

    const pointerPos = clampPointer(pointer, endRect);

    const endCenterX = (endRect.left + endRect.right) / 2;
    const endCenterY = (endRect.top + endRect.bottom) / 2;

    const endEdgeX = pointerPos.x >= endCenterX ? endRect.right : endRect.left;
    const endEdgeY = pointerPos.y >= endCenterY ? endRect.bottom : endRect.top;

    const box = {
      left: Math.min(anchorRect.left, anchorRect.right, endEdgeX, pointerPos.x),
      right: Math.max(anchorRect.left, anchorRect.right, endEdgeX, pointerPos.x),
      top: Math.min(anchorRect.top, anchorRect.bottom, endEdgeY, pointerPos.y),
      bottom: Math.max(anchorRect.top, anchorRect.bottom, endEdgeY, pointerPos.y)
    };

    const ids = rects
      .filter(r => overlapsMeaningfully(r.rect, box, pointerPos))
      .map(r => r.id);

    const idSet = new Set(ids);
    if (rects.some(r => r.id === anchorId)) idSet.add(anchorId);
    if (rects.some(r => r.id === endId)) idSet.add(endId);

    return idSet;
  }, [gridRef]);

  const selectRangeByBox = useCallback((selection, anchorId, endId, additive = false, pointer) => {
    const boxIds = getBoxSelectionIds(anchorId, endId, pointer);
    if (!boxIds.size) return;

    if (additive) {
      selection.setSelected(prev => {
        const next = new Set(prev);
        boxIds.forEach(id => next.add(id));
        return next;
      });
    } else {
      selection.setSelected(() => boxIds);
    }
    // keep existing anchor; or expose selection.setAnchor(endId) if you prefer
  }, [getBoxSelectionIds]);

  return { getBoxSelectionIds, selectRangeByBox };
}
