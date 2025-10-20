function defaultClamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function toFinite(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeOverscan(value) {
  const num = toFinite(value, 0);
  return num <= 0 ? 0 : num;
}

function normalizeCount(value) {
  const num = Math.floor(toFinite(value, 0));
  return num <= 0 ? 0 : num;
}

function clampIndex(index, totalCount) {
  if (!Number.isFinite(index)) return 0;
  if (totalCount <= 0) return 0;
  if (index < 0) return 0;
  if (index >= totalCount) return totalCount - 1;
  return index;
}

function computeRange({
  model,
  totalCount,
  viewTop,
  viewHeight,
  overscanPx,
}) {
  const count = normalizeCount(totalCount);
  if (!count) {
    return { start: 0, end: -1 };
  }

  const safeOverscan = normalizeOverscan(overscanPx);
  const top = Math.max(0, toFinite(viewTop, 0));
  const height = Math.max(0, toFinite(viewHeight, 0));

  if (!model || typeof model.offsetToIndex !== "function") {
    return { start: 0, end: count - 1 };
  }

  const safeStartOffset = Math.max(0, top - safeOverscan);
  const safeEndOffset = Math.max(safeStartOffset, top + height + safeOverscan);

  const startIndex = defaultClamp(
    model.offsetToIndex?.(safeStartOffset) ?? 0,
    0,
    count - 1
  );
  const endIndex = defaultClamp(
    model.offsetToIndex?.(safeEndOffset) ?? startIndex,
    startIndex,
    count - 1
  );

  if (typeof model.ensureProjected === "function") {
    model.ensureProjected(startIndex, endIndex);
  }

  return { start: startIndex, end: endIndex };
}

export function createRangeCoordinator({
  model = null,
  totalCount = 0,
  overscanPx = 0,
} = {}) {
  const state = {
    model: model ?? null,
    totalCount: normalizeCount(totalCount),
    overscanPx: normalizeOverscan(overscanPx),
    lastRange: { start: 0, end: normalizeCount(totalCount) - 1 },
    lastComputedAt: 0,
    materializeHandler: null,
    lastMaterialized: { start: 0, end: -1, priority: "idle" },
  };

  function dispatchMaterialize(start, end, priority = "nav") {
    if (!state.materializeHandler) return;
    const count = state.totalCount;
    if (!count) return;
    const safeStart = clampIndex(Math.floor(toFinite(start, 0)), count);
    const safeEnd = clampIndex(Math.floor(toFinite(end, safeStart)), count);
    const normalizedEnd = safeEnd < safeStart ? safeStart : safeEnd;
    const prev = state.lastMaterialized;
    if (
      prev &&
      prev.start <= safeStart &&
      prev.end >= normalizedEnd &&
      (priority === "idle" || prev.priority === priority)
    ) {
      return;
    }
    state.materializeHandler({ start: safeStart, end: normalizedEnd, priority });
    state.lastMaterialized = { start: safeStart, end: normalizedEnd, priority };
  }

  function refreshRange(viewTop = 0, viewHeight = 0, overscanOverride) {
    const next = computeRange({
      model: state.model,
      totalCount: state.totalCount,
      viewTop,
      viewHeight,
      overscanPx:
        overscanOverride != null ? overscanOverride : state.overscanPx,
    });
    state.lastRange = next;
    state.lastComputedAt = Date.now();
    if (state.totalCount > 0) {
      dispatchMaterialize(next.start, next.end, "idle");
    }
    return next;
  }

  return {
    setModel(nextModel) {
      state.model = nextModel ?? null;
    },
    setTotalCount(nextCount) {
      const normalized = normalizeCount(nextCount);
      state.totalCount = normalized;
      if (normalized === 0) {
        state.lastRange = { start: 0, end: -1 };
      } else if (state.lastRange.end >= normalized) {
        const end = normalized - 1;
        const start = Math.min(state.lastRange.start, end);
        state.lastRange = { start, end };
      }
    },
    setOverscanPx(nextOverscan) {
      state.overscanPx = normalizeOverscan(nextOverscan);
    },
    viewportToDesiredRange(viewTop, viewHeight, overscanOverride) {
      return computeRange({
        model: state.model,
        totalCount: state.totalCount,
        viewTop,
        viewHeight,
        overscanPx:
          overscanOverride != null ? overscanOverride : state.overscanPx,
      });
    },
    updateViewport(viewTop, viewHeight, overscanOverride) {
      return refreshRange(viewTop, viewHeight, overscanOverride);
    },
    getRange() {
      return state.lastRange;
    },
    getDiagnostics() {
      return {
        range: state.lastRange,
        totalCount: state.totalCount,
        overscanPx: state.overscanPx,
        lastComputedAt: state.lastComputedAt,
        hasModel: !!state.model,
      };
    },
    setMaterializeHandler(handler) {
      state.materializeHandler = typeof handler === "function" ? handler : null;
      state.lastMaterialized = { start: 0, end: -1, priority: "idle" };
    },
    requestMaterialize(start, end, priority = "nav") {
      dispatchMaterialize(start, end, priority);
    },
    onScrub(targetIndex, { pad = 48 } = {}) {
      const count = state.totalCount;
      if (!count) {
        return { index: 0, offset: 0, height: 0 };
      }
      const index = clampIndex(Math.floor(toFinite(targetIndex, 0)), count);
      if (!state.model || typeof state.model.indexToOffset !== "function") {
        return { index, offset: 0, height: 0 };
      }

      const radius = normalizeCount(pad);
      const start = Math.max(0, index - radius);
      const end = Math.min(count - 1, index + radius);
      if (typeof state.model.ensureProjected === "function") {
        state.model.ensureProjected(start, end);
      }
      dispatchMaterialize(start, end, "rail");

      const entry = state.model.getEntry?.(index);
      if (entry) {
        return { index, offset: entry.y ?? 0, height: entry.height ?? 0 };
      }

      const { y } = state.model.indexToOffset(index);
      return { index, offset: y ?? 0, height: 0 };
    },
    jumpToIndex(
      targetIndex,
      { align = "start", viewportHeight = 0, pad = 96 } = {}
    ) {
      const count = state.totalCount;
      if (!count || !state.model || typeof state.model.indexToOffset !== "function") {
        return 0;
      }

      const index = clampIndex(Math.floor(toFinite(targetIndex, 0)), count);
      if (typeof state.model.ensureProjected === "function") {
        state.model.ensureProjected(index, index);
      }
      const jumpPad = normalizeCount(pad);
      if (jumpPad > 0) {
        const start = Math.max(0, index - jumpPad);
        const end = Math.min(count - 1, index + jumpPad);
        dispatchMaterialize(start, end, "nav");
      } else {
        dispatchMaterialize(index, index, "nav");
      }

      const entry = state.model.getEntry?.(index);
      const { y } = state.model.indexToOffset(index);
      const baseOffset = Number.isFinite(entry?.y) ? entry.y : y ?? 0;
      const height = Number.isFinite(entry?.height) ? entry.height : 0;
      const view = Math.max(0, toFinite(viewportHeight, 0));

      let target = baseOffset;
      if (align === "center" && view > 0) {
        target = baseOffset - Math.max(0, view / 2 - height / 2);
      } else if (align === "end" && view > 0) {
        target = baseOffset - Math.max(0, view - height);
      }

      const totalHeight = state.model.getTotalHeight?.();
      const maxScroll = Number.isFinite(totalHeight)
        ? Math.max(0, totalHeight - view)
        : undefined;

      if (Number.isFinite(maxScroll)) {
        if (target > maxScroll) target = maxScroll;
      }
      if (target < 0) target = 0;

      return target;
    },
  };
}

export default createRangeCoordinator;
