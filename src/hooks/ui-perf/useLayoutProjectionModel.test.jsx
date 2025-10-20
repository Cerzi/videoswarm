import { render, act, waitFor, cleanup } from "@testing-library/react";
import React, { useEffect } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createMeasurementStore } from "./measurementStore";
import useLayoutProjectionModel from "./useLayoutProjectionModel";

describe("useLayoutProjectionModel", () => {
  afterEach(() => {
    cleanup();
  });

  const logicalOrder = ["a", "b", "c"];

  function Harness({ enabled, onModel, measurementStore }) {
    const model = useLayoutProjectionModel({
      enabled,
      logicalOrder,
      columnCount: 2,
      columnWidth: 200,
      gapX: 8,
      gapY: 8,
      measurementStore,
      defaultHeight: 180,
    });

    useEffect(() => {
      onModel?.(model);
    }, [model, onModel]);

    return null;
  }

  it("returns null when disabled", () => {
    const spy = vi.fn();
    const measurementStore = createMeasurementStore();
    render(<Harness enabled={false} onModel={spy} measurementStore={measurementStore} />);
    expect(spy).toHaveBeenCalledWith(null);
  });

  it("provides a model instance when enabled", async () => {
    const spy = vi.fn();
    const measurementStore = createMeasurementStore();
    function Wrapper({ enabled }) {
      return (
        <Harness
          enabled={enabled}
          onModel={spy}
          measurementStore={measurementStore}
        />
      );
    }

    const { rerender } = render(<Wrapper enabled={false} />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(null));

    await act(async () => {
      rerender(<Wrapper enabled={true} />);
    });

    await waitFor(() => {
      const calls = spy.mock.calls.map(([value]) => value);
      const last = calls[calls.length - 1];
      expect(last).toBeTruthy();
      expect(typeof last.indexToOffset).toBe("function");
      expect(last.getTotalHeight()).toBeGreaterThan(0);
    });

  });
});
