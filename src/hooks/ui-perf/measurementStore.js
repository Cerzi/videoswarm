const DEFAULT_VARIANCE_THRESHOLD = 0.35;

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base];
  const upper = sorted[Math.min(sorted.length - 1, base + 1)];
  return lower + (upper - lower) * rest;
}

function aggregateHeights(entries, column) {
  const list = [];
  entries.forEach((entry) => {
    if (!entry) return;
    const { height, column: entryColumn } = entry;
    if (!Number.isFinite(height) || height <= 0) return;
    if (column == null || entryColumn === column) {
      list.push(height);
    }
  });
  if (!list.length) {
    return {
      count: 0,
      avg: 0,
      p50: 0,
      p90: 0,
    };
  }
  list.sort((a, b) => a - b);
  const sum = list.reduce((acc, value) => acc + value, 0);
  return {
    count: list.length,
    avg: sum / list.length,
    p50: quantile(list, 0.5),
    p90: quantile(list, 0.9),
  };
}

export function createMeasurementStore({
  varianceThreshold = DEFAULT_VARIANCE_THRESHOLD,
  defaultEstimate = 180,
} = {}) {
  let version = 1;
  let layoutSignature = null;
  let defaultHeight = Math.max(1, Number.isFinite(defaultEstimate) ? defaultEstimate : 180);
  const entries = new Map();
  const listeners = new Set();

  const notify = (event) => {
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("MeasurementStore listener error", error);
        }
      }
    });
  };

  const api = {
    get version() {
      return version;
    },
    getDefaultEstimate() {
      return defaultHeight;
    },
    setDefaultEstimate(next) {
      const num = toNumber(next);
      if (!num || num <= 0) return;
      if (num === defaultHeight) return;
      defaultHeight = num;
    },
    updateLayoutSignature(signature) {
      const normalized = stableStringify(signature);
      if (normalized === layoutSignature) return;
      layoutSignature = normalized;
      version += 1;
      entries.clear();
      notify({ type: "version", version });
    },
    get(id) {
      const entry = entries.get(id);
      return entry ? entry.height : undefined;
    },
    upsert(id, height, meta = {}) {
      if (!id) return;
      const numericHeight = toNumber(height);
      if (!numericHeight || numericHeight <= 0) return;

      const column = Number.isFinite(meta?.column) ? Number(meta.column) : null;

      const previous = entries.get(id);
      entries.set(id, {
        height: numericHeight,
        column,
        updatedAt: Date.now(),
        version,
      });

      if (
        previous &&
        previous.column === column &&
        Number.isFinite(previous.height) &&
        Math.abs(previous.height - numericHeight) / previous.height > varianceThreshold
      ) {
        notify({
          type: "variance",
          id,
          previousHeight: previous.height,
          nextHeight: numericHeight,
          column,
        });
      }

      notify({ type: "measurement", id, height: numericHeight, column });
    },
    delete(id) {
      if (!entries.has(id)) return;
      entries.delete(id);
      notify({ type: "delete", id });
    },
    clear() {
      if (!entries.size) return;
      entries.clear();
      notify({ type: "clear" });
    },
    count() {
      return entries.size;
    },
    statsForColumn(column) {
      const stats = aggregateHeights(entries, column);
      if (stats.count > 0) return stats;
      if (column == null) return stats;
      const fallback = aggregateHeights(entries, null);
      if (fallback.count > 0) return fallback;
      return {
        count: 0,
        avg: defaultHeight,
        p50: defaultHeight,
        p90: defaultHeight,
      };
    },
    getAll() {
      return Array.from(entries.entries()).map(([id, value]) => ({ id, ...value }));
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return api;
}

export default createMeasurementStore;
