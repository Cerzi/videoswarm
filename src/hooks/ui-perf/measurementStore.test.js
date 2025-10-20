import { describe, it, expect, vi } from "vitest";
import { createMeasurementStore } from "./measurementStore";

describe("createMeasurementStore", () => {
  it("stores and retrieves measurements", () => {
    const store = createMeasurementStore();
    store.upsert("a", 120, { column: 0 });
    store.upsert("b", 150, { column: 1 });

    expect(store.get("a")).toBe(120);
    expect(store.get("b")).toBe(150);
    expect(store.count()).toBe(2);

    const stats0 = store.statsForColumn(0);
    expect(stats0.p50).toBe(120);
    const statsAll = store.statsForColumn(null);
    expect(statsAll.count).toBe(2);
  });

  it("clears measurements when layout signature changes", () => {
    const store = createMeasurementStore();
    store.upsert("a", 120, { column: 0 });
    expect(store.count()).toBe(1);
    const prevVersion = store.version;

    store.updateLayoutSignature({ columnWidth: 200, columnCount: 3 });
    expect(store.version).toBe(prevVersion + 1);
    expect(store.count()).toBe(0);
    expect(store.get("a")).toBeUndefined();
  });

  it("notifies subscribers on measurement updates", () => {
    const store = createMeasurementStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.upsert("x", 180, { column: 2 });
    expect(listener).toHaveBeenCalledWith({
      type: "measurement",
      id: "x",
      height: 180,
      column: 2,
    });

    listener.mockClear();
    unsubscribe();
    store.upsert("x", 200, { column: 2 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("reports variance events when the delta exceeds threshold", () => {
    const store = createMeasurementStore({ varianceThreshold: 0.1 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.upsert("x", 100, { column: 0 });
    listener.mockClear();
    store.upsert("x", 130, { column: 0 });

    expect(listener).toHaveBeenCalledWith({
      type: "variance",
      id: "x",
      previousHeight: 100,
      nextHeight: 130,
      column: 0,
    });
  });
});
