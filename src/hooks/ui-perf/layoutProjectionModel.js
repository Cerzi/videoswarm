import { createMeasurementStore } from "./measurementStore";

const BLOCK_SIZE = 64;

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

function cloneTails(tails, columnCount) {
  if (!Array.isArray(tails) || tails.length !== columnCount) {
    return new Array(columnCount).fill(0);
  }
  return tails.slice();
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
  const safeGapY = Number.isFinite(gapY) ? gapY : 0;
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
    blockSummaries: [],
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

  function recordBlock(index) {
    if (index < 0) return;
    const blockIndex = Math.floor(index / BLOCK_SIZE);
    const maxY = state.columnHeights.reduce(
      (acc, value) => (value > acc ? value : acc),
      0
    );
    state.blockSummaries[blockIndex] = {
      endIndex: index,
      maxY,
      tails: state.columnHeights.slice(),
    };
  }

  function ensureProjectedRange(start, end) {
    if (!ids.length) return;
    const maxIndex = ids.length - 1;
    const from = clampIndex(Math.min(start, end), maxIndex);
    const to = clampIndex(Math.max(start, end), maxIndex);

    let index = from;
    while (index <= to) {
      if (state.projections[index]) {
        index += 1;
        continue;
      }

      if (index > state.projectedUntil + 1) {
        ensureProjectedRange(state.projectedUntil + 1, index);
        continue;
      }

      const id = ids[index];
      if (!id) {
        state.projections[index] = null;
        index += 1;
        continue;
      }

      const column = pickNextColumn();
      const measuredHeight = measure?.get?.(id);
      const height =
        Number.isFinite(measuredHeight) && measuredHeight > 0
          ? measuredHeight
          : resolveEstimate(measure, column, fallbackHeight);
      const y = state.columnHeights[column];

      state.projections[index] = {
        id,
        column,
        height,
        y,
      };
      state.columnHeights[column] = y + height + safeGapY;

      recordBlock(index);
      if (index > state.projectedUntil) {
        state.projectedUntil = index;
      }

      index += 1;
    }
  }

  function recomputeFrom(index) {
    if (!ids.length) return;
    const maxIndex = ids.length - 1;
    const safeIndex = clampIndex(index, maxIndex);
    const blockIndex = Math.floor(safeIndex / BLOCK_SIZE);
    const blockStart = blockIndex * BLOCK_SIZE;

    let baselineTails = new Array(safeColumnCount).fill(0);
    if (blockIndex > 0) {
      const prior = state.blockSummaries[blockIndex - 1];
      if (!prior) {
        ensureProjectedRange(0, Math.min(maxIndex, blockStart - 1));
      }
      const refreshed = state.blockSummaries[blockIndex - 1];
      baselineTails = cloneTails(refreshed?.tails, safeColumnCount);
    }

    for (let i = blockStart; i <= maxIndex; i += 1) {
      state.projections[i] = null;
    }
    state.projectedUntil = blockStart - 1;
    state.columnHeights = baselineTails;
    state.blockSummaries.length = blockIndex;

    if (blockStart <= safeIndex) {
      ensureProjectedRange(blockStart, safeIndex);
    }
  }

  function recomputeAll() {
    state.columnHeights = new Array(safeColumnCount).fill(0);
    state.projections = new Array(ids.length).fill(null);
    state.projectedUntil = -1;
    state.blockSummaries = [];
  }

  function ensureBlocksCover(targetOffset) {
    if (!ids.length) return;
    const maxIndex = ids.length - 1;
    if (state.projectedUntil < 0) {
      ensureProjectedRange(0, Math.min(maxIndex, BLOCK_SIZE - 1));
    }
    let lastSummary = state.blockSummaries[state.blockSummaries.length - 1];
    while (
      state.projectedUntil < maxIndex &&
      (!lastSummary || !Number.isFinite(lastSummary.maxY) || lastSummary.maxY <= targetOffset)
    ) {
      const nextEnd = Math.min(maxIndex, state.projectedUntil + BLOCK_SIZE);
      ensureProjectedRange(state.projectedUntil + 1, nextEnd);
      lastSummary = state.blockSummaries[state.blockSummaries.length - 1];
    }
  }

  const api = {
    indexToOffset(index) {
      if (!ids.length) return { y: 0, column: 0 };
      const safeIndex = clampIndex(index, ids.length - 1);
      let entry = state.projections[safeIndex];
      if (!entry) {
        ensureProjectedRange(safeIndex, safeIndex);
        entry = state.projections[safeIndex];
      }
      if (!entry) return { y: 0, column: 0 };
      return { y: entry.y, column: entry.column };
    },
    getEntry(index) {
      if (!ids.length) return null;
      const safeIndex = clampIndex(index, ids.length - 1);
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
      if (!ids.length) return 0;
      const target = Number.isFinite(offsetY) ? offsetY : 0;
      ensureBlocksCover(target);
      if (!state.blockSummaries.length) {
        return clampIndex(ids.length - 1, ids.length - 1);
      }

      let low = 0;
      let high = state.blockSummaries.length - 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (state.blockSummaries[mid].maxY > target) {
          high = mid;
        } else {
          low = mid + 1;
        }
      }

      let blockIndex = low;
      while (
        blockIndex < state.blockSummaries.length - 1 &&
        state.blockSummaries[blockIndex].maxY <= target
      ) {
        blockIndex += 1;
      }

      const blockStart = blockIndex * BLOCK_SIZE;
      const blockEnd = Math.min(ids.length - 1, state.blockSummaries[blockIndex].endIndex);
      for (let i = blockStart; i <= blockEnd; i += 1) {
        ensureProjectedRange(i, i);
        const entry = state.projections[i];
        if (!entry) continue;
        if (target < entry.y + entry.height) {
          return i;
        }
      }

      return clampIndex(ids.length - 1, ids.length - 1);
    },
    getTotalHeight() {
      if (!ids.length) return 0;
      if (state.projectedUntil < 0) {
        ensureProjectedRange(0, Math.min(ids.length - 1, BLOCK_SIZE - 1));
      }
      const last = state.blockSummaries[state.blockSummaries.length - 1];
      if (last && Number.isFinite(last.maxY)) {
        return Math.max(0, last.maxY - safeGapY);
      }
      const max = state.columnHeights.reduce(
        (acc, value) => (value > acc ? value : acc),
        0
      );
      return Math.max(0, max - safeGapY);
    },
    ensureProjected(i0, i1) {
      ensureProjectedRange(i0, i1);
    },
    updateMeasurement(id, height) {
      this.applyMeasurements?.([{ id, height }]);
    },
    applyMeasurements(list) {
      if (!Array.isArray(list) || !list.length) return;
      let earliest = null;
      for (let i = 0; i < list.length; i += 1) {
        const item = list[i];
        if (!item || item.height == null) continue;
        const index = idToIndex.get(item.id);
        if (index == null) continue;
        const entry = state.projections[index];
        if (!entry) continue;
        const nextHeight = Number(item.height);
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) continue;
        if (Math.abs(entry.height - nextHeight) < 0.5) continue;
        if (earliest == null || index < earliest) {
          earliest = index;
        }
      }
      if (earliest != null) {
        recomputeFrom(earliest);
      }
    },
    reset() {
      recomputeAll();
    },
    getProjectedRange() {
      return state.projectedUntil;
    },
  };

  return api;
}

export default createLayoutProjectionModel;
