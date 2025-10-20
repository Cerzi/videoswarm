import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReportMeasuredHeight } from "./useReportMeasuredHeight";

const createMockStore = () => ({
  upsert: vi.fn(),
});

describe("useReportMeasuredHeight", () => {
  const originalResizeObserver = global.ResizeObserver;

  beforeEach(() => {
    global.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        // Immediately invoke to simulate resize
        this.callback();
      }
      disconnect() {}
    };
  });

  afterEach(() => {
    global.ResizeObserver = originalResizeObserver;
  });

  it("reports height measurements to the store", () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "getBoundingClientRect", {
      value: () => ({ width: 200, height: 180 }),
    });
    element.dataset.column = "2";

    const ref = { current: element };
    const store = createMockStore();

    renderHook(() =>
      useReportMeasuredHeight({
        id: "video-1",
        elementRef: ref,
        measurementStore: store,
        layoutEpoch: 0,
      })
    );

    expect(store.upsert).toHaveBeenCalledWith("video-1", 180, { column: 2 });
  });
});
