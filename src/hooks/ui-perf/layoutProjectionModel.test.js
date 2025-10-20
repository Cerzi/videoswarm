import { describe, it, expect } from "vitest";
import { createLayoutProjectionModel } from "./layoutProjectionModel";
import { createMeasurementStore } from "./measurementStore";

describe("createLayoutProjectionModel", () => {
  it("projects items using measured heights when available", () => {
    const measure = createMeasurementStore();
    measure.upsert("a", 120, { column: 0 });
    measure.upsert("b", 180, { column: 1 });

    const model = createLayoutProjectionModel({
      logicalOrder: ["a", "b", "c", "d"],
      columnCount: 2,
      columnWidth: 200,
      gapY: 10,
      measure,
      defaultHeight: 160,
    });

    model.ensureProjected(0, 3);

    const first = model.indexToOffset(0);
    expect(first).toEqual({ y: 0, column: 0 });

    const second = model.indexToOffset(1);
    expect(second.column).toBe(1);
    expect(second.y).toBe(0);

    const third = model.indexToOffset(2);
    expect(third.column).toBe(0);
    expect(third.y).toBe(120 + 10);

    const totalHeight = model.getTotalHeight();
    expect(totalHeight).toBeGreaterThan(0);
  });

  it("updates projections when new measurements arrive", () => {
    const measure = createMeasurementStore();
    const model = createLayoutProjectionModel({
      logicalOrder: ["a", "b"],
      columnCount: 1,
      columnWidth: 200,
      gapY: 8,
      measure,
      defaultHeight: 150,
    });

    model.ensureProjected(0, 1);
    let entry = model.indexToOffset(1);
    expect(entry.y).toBe(150 + 8);

    measure.upsert("a", 220, { column: 0 });
    model.updateMeasurement("a", 220);

    entry = model.indexToOffset(1);
    expect(entry.y).toBe(220 + 8);
  });

  it("finds index from offset", () => {
    const model = createLayoutProjectionModel({
      logicalOrder: ["a", "b", "c"],
      columnCount: 1,
      columnWidth: 160,
      gapY: 5,
      defaultHeight: 120,
    });

    model.ensureProjected(0, 2);
    expect(model.offsetToIndex(0)).toBe(0);
    expect(model.offsetToIndex(130)).toBeGreaterThanOrEqual(1);
  });

  it("returns projected entries with height and column data", () => {
    const measure = createMeasurementStore();
    measure.upsert("x", 140, { column: 0 });
    const model = createLayoutProjectionModel({
      logicalOrder: ["x", "y"],
      columnCount: 2,
      columnWidth: 200,
      gapY: 10,
      measure,
      defaultHeight: 150,
    });

    const entry = model.getEntry(0);
    expect(entry).toMatchObject({ id: "x", column: 0, height: 140, y: 0 });

    const fallback = model.getEntry(1);
    expect(fallback).not.toBeNull();
    expect(fallback?.height).toBeGreaterThan(0);
    expect(fallback?.y).toBeGreaterThanOrEqual(0);
  });
});
