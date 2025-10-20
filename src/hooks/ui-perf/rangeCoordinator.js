const SCRUB_THROTTLE_MS = 75;
const MAX_RAIL_ITEMS = 1200;
const MIN_RAIL_ITEMS = 240;
const DEFAULT_VIEWPORT_SPAN = 60;

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

function computeViewportSpan(range) {
  if (!range) return 0;
  const { start, end } = range;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end < start) return 0;
  return end - start + 1;
}

function computeMaxRailWindow(viewportSpan) {
  const base = viewportSpan > 0 ? viewportSpan : DEFAULT_VIEWPORT_SPAN;
  const expanded = base * 3;
  const padded = base + Math.ceil(base * 0.75);
  const minimum = Math.max(MIN_RAIL_ITEMS, padded);
  return Math.min(MAX_RAIL_ITEMS, Math.max(expanded, minimum));
}

function computeRailWindow({ index, totalCount, spanHint }) {
  const count = normalizeCount(totalCount);
  if (!count) {
    return { start: 0, end: -1, window: 0 };
  }

  const safeIndex = clampIndex(index, count);
  const desiredWindow = computeMaxRailWindow(spanHint);
  const halfWindow = Math.max(0, Math.floor(desiredWindow / 2));

  let start = safeIndex - halfWindow;
  let end = safeIndex + (desiredWindow - halfWindow - 1);

  if (start < 0) {
    end += -start;
    start = 0;
  }

  if (end >= count) {
    const overshoot = end - (count - 1);
    start = Math.max(0, start - overshoot);
    end = count - 1;
  }

  if (start > safeIndex) {
    start = safeIndex;
  }

  const window = Math.max(1, Math.min(desiredWindow, end - start + 1));

  return { start, end, window };
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
    viewportSpan: 0,
    lastRailDispatch: 0,
    pendingRail: null,
    pendingRailTimer: null,
  };

  function clearPendingRail() {
    if (state.pendingRailTimer) {
      clearTimeout(state.pendingRailTimer);
      state.pendingRailTimer = null;
    }
    state.pendingRail = null;
  }

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

  function flushPendingRail() {
    if (!state.pendingRail) return;
    const payload = state.pendingRail;
    clearPendingRail();
    state.lastRailDispatch = Date.now();
    dispatchMaterialize(payload.start, payload.end, "rail");
  }

  function scheduleRailMaterialize(start, end) {
    if (!state.materializeHandler) return;
    const now = Date.now();
    state.pendingRail = { start, end };

    const elapsed = now - state.lastRailDispatch;
    if (elapsed >= SCRUB_THROTTLE_MS) {
      flushPendingRail();
      return;
    }

    if (!state.pendingRailTimer) {
      const delay = Math.max(8, SCRUB_THROTTLE_MS - elapsed);
      state.pendingRailTimer = setTimeout(() => {
        state.pendingRailTimer = null;
        flushPendingRail();
      }, delay);
    }
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
    state.viewportSpan = computeViewportSpan(next);
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
        viewportSpan: state.viewportSpan,
      };
    },
    setMaterializeHandler(handler) {
      clearPendingRail();
      state.materializeHandler = typeof handler === "function" ? handler : null;
      state.lastMaterialized = { start: 0, end: -1, priority: "idle" };
      state.lastRailDispatch = 0;
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

      const spanHint = state.viewportSpan || computeViewportSpan(state.lastRange);
      const window = computeRailWindow({
        index,
        totalCount: count,
        spanHint,
      });
      let { start, end } = window;

      if (Number.isFinite(pad) && pad > 0) {
        const paddedStart = Math.max(0, index - Math.floor(pad));
        const paddedEnd = Math.min(count - 1, index + Math.floor(pad));
        start = Math.max(window.start, paddedStart);
        end = Math.min(window.end, paddedEnd);
      }

      if (typeof state.model.ensureProjected === "function") {
        state.model.ensureProjected(start, end);
      }

      scheduleRailMaterialize(start, end);

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

      flushPendingRail();

      const index = clampIndex(Math.floor(toFinite(targetIndex, 0)), count);
      if (typeof state.model.ensureProjected === "function") {
        state.model.ensureProjected(index, index);
      }

      const spanHint = state.viewportSpan || computeViewportSpan(state.lastRange);
      const maxWindow = computeRailWindow({
        index,
        totalCount: count,
        spanHint,
      });
      const jumpPad = normalizeCount(pad);
      let start = maxWindow.start;
      let end = maxWindow.end;
      if (jumpPad > 0) {
        const paddedStart = Math.max(0, index - jumpPad);
        const paddedEnd = Math.min(count - 1, index + jumpPad);
        start = Math.max(maxWindow.start, paddedStart);
        end = Math.min(maxWindow.end, paddedEnd);
      }
      dispatchMaterialize(start, end, "nav");

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
