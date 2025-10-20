import { describe, expect, it, vi } from "vitest";
import { createRangeCoordinator } from "./rangeCoordinator";

describe("createRangeCoordinator", () => {
  const buildModel = ({
    total = 100,
    heights = [],
    gap = 12,
  } = {}) => {
    const cumulative = [];
    const entries = [];
    let cursor = 0;
    for (let i = 0; i < total; i += 1) {
      const h = heights[i] ?? heights[i % heights.length] ?? 200;
      cumulative[i] = cursor;
      entries[i] = { id: `item-${i}`, column: i % 3, height: h, y: cursor };
      cursor += h + gap;
    }

    return {
      offsetToIndex: vi.fn((offset) => {
        const target = Number(offset) || 0;
        let lo = 0;
        let hi = cumulative.length - 1;
        let result = 0;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (cumulative[mid] <= target) {
            result = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        return result;
      }),
      ensureProjected: vi.fn(),
      indexToOffset: vi.fn((index) => {
        const safe = Math.max(0, Math.min(cumulative.length - 1, Math.floor(index)));
        return { y: cumulative[safe] ?? 0, column: safe % 3 };
      }),
      getEntry: vi.fn((index) => {
        const safe = Math.max(0, Math.min(entries.length - 1, Math.floor(index)));
        return entries[safe] ?? null;
      }),
      getTotalHeight: vi.fn(() => {
        if (!entries.length) return 0;
        const last = entries[entries.length - 1];
        return last.y + last.height;
      }),
    };
  };

  it("returns full range when model missing", () => {
    const coordinator = createRangeCoordinator({ totalCount: 5 });
    const range = coordinator.viewportToDesiredRange(200, 600);
    expect(range).toEqual({ start: 0, end: 4 });
    expect(coordinator.getRange()).toEqual({ start: 0, end: 4 });
  });

  it("clamps range for empty collections", () => {
    const coordinator = createRangeCoordinator({ model: buildModel({ total: 0 }), totalCount: 0 });
    expect(coordinator.viewportToDesiredRange(0, 400)).toEqual({ start: 0, end: -1 });
  });

  it("computes range using model offsets", () => {
    const model = buildModel({ total: 50, heights: [180, 220, 260], gap: 24 });
    const coordinator = createRangeCoordinator({ model, totalCount: 50, overscanPx: 200 });
    const range = coordinator.updateViewport(480, 720);
    expect(range.start).toBeGreaterThanOrEqual(0);
    expect(range.end).toBeGreaterThan(range.start);
    expect(model.ensureProjected).toHaveBeenCalled();
    const diagnostics = coordinator.getDiagnostics();
    expect(diagnostics.range).toEqual(range);
    expect(diagnostics.hasModel).toBe(true);
    expect(diagnostics.totalCount).toBe(50);
  });

  it("updates bounds when collection shrinks", () => {
    const model = buildModel({ total: 20 });
    const coordinator = createRangeCoordinator({ model, totalCount: 20 });
    coordinator.setTotalCount(5);
    expect(coordinator.getRange()).toEqual({ start: 0, end: 4 });
  });

  it("respects overscan override", () => {
    const model = buildModel({ total: 10, heights: [100] });
    const coordinator = createRangeCoordinator({ model, totalCount: 10, overscanPx: 0 });
    const narrow = coordinator.viewportToDesiredRange(300, 200, 0);
    const wide = coordinator.viewportToDesiredRange(300, 200, 600);
    expect(wide.end).toBeGreaterThanOrEqual(narrow.end);
  });

  it("requests materialization for scrubbed ranges", () => {
    const model = buildModel({ total: 30, heights: [100] });
    const coordinator = createRangeCoordinator({ model, totalCount: 30 });
    const handler = vi.fn();
    coordinator.setMaterializeHandler(handler);

    const preview = coordinator.onScrub(12, { pad: 4 });
    expect(preview.index).toBe(12);
    expect(model.ensureProjected).toHaveBeenCalled();
    expect(preview.offset).toBeGreaterThanOrEqual(0);

    coordinator.requestMaterialize(10, 14, "rail");
    expect(handler).toHaveBeenCalledWith({ start: 10, end: 14, priority: "rail" });
  });

  it("computes jump offsets with alignment and clamps to bounds", () => {
    const model = buildModel({ total: 10, heights: [100], gap: 0 });
    const coordinator = createRangeCoordinator({ model, totalCount: 10 });

    const startOffset = coordinator.jumpToIndex(0, { viewportHeight: 300 });
    expect(startOffset).toBe(0);

    const centerOffset = coordinator.jumpToIndex(5, {
      align: "center",
      viewportHeight: 200,
    });
    expect(centerOffset).toBeGreaterThanOrEqual(0);

    const endOffset = coordinator.jumpToIndex(9, {
      align: "end",
      viewportHeight: 400,
    });
    const totalHeight = model.getTotalHeight();
    expect(endOffset).toBeLessThanOrEqual(totalHeight);
  });
});
