import { createMeasurementStore } from "./measurementStore";

function clampIndex(index, max) {
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  if (index > max) return max;
  return index;
}

function resolveEstimate(store, column, fallback) {
  if (!store) return fallback;
  const stats = store.statsForColumn(column);
  if (stats && stats.count > 0) {
    const median = Number.isFinite(stats.p50) && stats.p50 > 0 ? stats.p50 : null;
    const trimmed =
      Number.isFinite(stats.trimmedMean) && stats.trimmedMean > 0
        ? stats.trimmedMean
        : null;
    const avg = Number.isFinite(stats.avg) && stats.avg > 0 ? stats.avg : null;
    const p90 = Number.isFinite(stats.p90) && stats.p90 > 0 ? stats.p90 : null;
    const p10 = Number.isFinite(stats.p10) && stats.p10 > 0 ? stats.p10 : null;

    let candidate = trimmed ?? median ?? avg ?? fallback;
    if (median && trimmed) {
      const delta = Math.abs(trimmed - median) / Math.max(1, median);
      if (delta > 0.25) {
        candidate = median;
      } else {
        const upper = p90 ?? Math.max(median, trimmed);
        const lower = p10 ?? Math.min(median, trimmed);
        const clamped = Math.min(Math.max(candidate, lower), upper);
        candidate = clamped;
      }
    } else if (median) {
      candidate = median;
    }

    return Math.max(1, Math.round(candidate || fallback));
  }
  return fallback;
}

export function createLayoutProjectionModel({
  logicalOrder = [],
  columnCount = 1,
  columnWidth = 200,
  gapX = 12,
  gapY = 12,
  measure = createMeasurementStore(),
  defaultHeight,
} = {}) {
  const safeColumnCount = Math.max(1, Math.floor(columnCount));
  const ids = Array.isArray(logicalOrder) ? logicalOrder.slice() : [];
  const idToIndex = new Map();
  ids.forEach((id, idx) => {
    if (id == null || id === "") return;
    if (!idToIndex.has(id)) {
      idToIndex.set(id, idx);
    }
  });

  const fallbackHeight = Math.max(
    24,
    Number.isFinite(defaultHeight) && defaultHeight > 0
      ? defaultHeight
      : Math.round(columnWidth / (16 / 9)) || 180
  );

  const state = {
    columnHeights: new Array(safeColumnCount).fill(0),
    projections: new Array(ids.length).fill(null),
    projectedUntil: -1,
  };

  function pickNextColumn() {
    let bestIndex = 0;
    let bestValue = state.columnHeights[0];
    for (let i = 1; i < safeColumnCount; i += 1) {
      const value = state.columnHeights[i];
      if (value < bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  function ensureProjectedRange(start, end) {
    if (!ids.length) return;
    const maxIndex = ids.length - 1;
    const from = clampIndex(Math.min(start, end), maxIndex);
    const to = clampIndex(Math.max(start, end), maxIndex);

    for (let index = from; index <= to; index += 1) {
      if (state.projections[index]) continue;
      const id = ids[index];
      if (!id) continue;

      const column = pickNextColumn();
      const measuredHeight = measure?.get(id);
      const height = Number.isFinite(measuredHeight) && measuredHeight > 0
        ? measuredHeight
        : resolveEstimate(measure, column, fallbackHeight);
      const y = state.columnHeights[column];

      state.projections[index] = {
        id,
        column,
        height,
        y,
      };
      state.columnHeights[column] = y + height + gapY;
    }

    if (to > state.projectedUntil) {
      state.projectedUntil = to;
    }
  }

  function recomputeAll() {
    const projected = state.projectedUntil;
    state.columnHeights = new Array(safeColumnCount).fill(0);
    state.projections = new Array(ids.length).fill(null);
    state.projectedUntil = -1;
    if (projected >= 0) {
      ensureProjectedRange(0, projected);
    }
  }

  const api = {
    indexToOffset(index) {
      const safeIndex = clampIndex(index, ids.length - 1);
      const entry = state.projections[safeIndex];
      if (entry) return { y: entry.y, column: entry.column };
      ensureProjectedRange(safeIndex, safeIndex);
      const next = state.projections[safeIndex];
      return next ? { y: next.y, column: next.column } : { y: 0, column: 0 };
    },
    getEntry(index) {
      if (!ids.length) return null;
      const safeIndex = clampIndex(index, ids.length - 1);
      if (safeIndex < 0) return null;
      let entry = state.projections[safeIndex];
      if (!entry) {
        ensureProjectedRange(safeIndex, safeIndex);
        entry = state.projections[safeIndex];
      }
      if (!entry) return null;
      return {
        id: entry.id,
        column: entry.column,
        height: entry.height,
        y: entry.y,
      };
    },
    offsetToIndex(offsetY) {
      const target = Number.isFinite(offsetY) ? offsetY : 0;
      let candidate = 0;
      let candidateBottom = 0;
      for (let index = 0; index < ids.length; index += 1) {
        ensureProjectedRange(candidate, index);
        const entry = state.projections[index];
        if (!entry) continue;
        const bottom = entry.y + entry.height;
        if (target < bottom) {
          return index;
        }
        candidate = index;
        candidateBottom = bottom;
      }
      if (target >= candidateBottom) {
        return clampIndex(ids.length - 1, ids.length - 1);
      }
      return candidate;
    },
    getTotalHeight() {
      if (!ids.length) return 0;
      ensureProjectedRange(0, state.projectedUntil >= 0 ? state.projectedUntil : ids.length - 1);
      let max = 0;
      for (let i = 0; i < state.columnHeights.length; i += 1) {
        if (state.columnHeights[i] > max) {
          max = state.columnHeights[i];
        }
      }
      return Math.max(0, max - gapY);
    },
    ensureProjected(i0, i1) {
      ensureProjectedRange(i0, i1);
    },
    updateMeasurement(id, height) {
      if (!idToIndex.has(id)) return;
      const index = idToIndex.get(id);
      const entry = state.projections[index];
      if (entry && Number.isFinite(height) && height > 0) {
        entry.height = height;
        recomputeAll();
      }
    },
    reset() {
      state.columnHeights = new Array(safeColumnCount).fill(0);
      state.projections = new Array(ids.length).fill(null);
      state.projectedUntil = -1;
    },
    getProjectedRange() {
      return state.projectedUntil;
    },
  };

  return api;
}

export default createLayoutProjectionModel;
