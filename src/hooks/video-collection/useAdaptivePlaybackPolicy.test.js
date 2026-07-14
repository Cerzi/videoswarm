import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import useAdaptivePlaybackPolicy from "./useAdaptivePlaybackPolicy";

const base = {
  mode: "balanced",
  visibleCount: 30,
  capabilities: {
    platform: "linux",
    logicalCores: 4,
    totalMemoryMB: 8192,
  },
  averagePixelArea: 1280 * 720,
  telemetry: {
    sampleCount: 1,
    systemMemoryMB: 8192,
    availableMemoryMB: 4096,
    frameDelayMs: 16,
    longTaskRate: 0,
    droppedFrameRatio: 0,
    workingSetDeltaMB: 0,
  },
};

describe("useAdaptivePlaybackPolicy", () => {
  it("shrinks on unhealthy telemetry and recovers no faster than one slot", () => {
    const rendered = renderHook((props) => useAdaptivePlaybackPolicy(props), {
      initialProps: base,
    });
    const initial = rendered.result.current.target;

    act(() => {
      rendered.rerender({
        ...base,
        telemetry: {
          ...base.telemetry,
          sampleCount: 2,
          droppedFrameRatio: 0.2,
        },
      });
    });
    const reduced = rendered.result.current.target;
    expect(reduced).toBeLessThan(initial);

    for (let sampleCount = 3; sampleCount <= 5; sampleCount += 1) {
      act(() => {
        rendered.rerender({
          ...base,
          telemetry: { ...base.telemetry, sampleCount },
        });
      });
    }
    expect(rendered.result.current.target).toBeLessThanOrEqual(reduced + 1);
  });

  it("applies a telemetry sample only once across scroll and layout updates", () => {
    const rendered = renderHook((props) => useAdaptivePlaybackPolicy(props), {
      initialProps: base,
    });

    act(() => {
      rendered.rerender({
        ...base,
        telemetry: {
          ...base.telemetry,
          sampleCount: 2,
          droppedFrameRatio: 0.2,
        },
      });
    });
    const reducedOnce = rendered.result.current.target;

    for (const visibleCount of [31, 32, 30, 29]) {
      act(() => {
        rendered.rerender({
          ...base,
          visibleCount,
          telemetry: {
            ...base.telemetry,
            sampleCount: 2,
            droppedFrameRatio: 0.2,
          },
        });
      });
      expect(rendered.result.current.target).toBe(reducedOnce);
    }

    act(() => {
      rendered.rerender({
        ...base,
        visibleCount: 29,
        telemetry: {
          ...base.telemetry,
          sampleCount: 3,
          droppedFrameRatio: 0.2,
        },
      });
    });
    expect(rendered.result.current.target).toBeLessThan(reducedOnce);
  });

  it("immediately returns zero while suspended", () => {
    const { result } = renderHook(() =>
      useAdaptivePlaybackPolicy({ ...base, suspended: true })
    );
    expect(result.current).toMatchObject({
      target: 0,
      health: "suspended",
    });
  });

  it("does not telemetry-derate explicit All Motion mode", () => {
    const { result, rerender } = renderHook(
      (props) => useAdaptivePlaybackPolicy(props),
      {
        initialProps: {
          ...base,
          mode: "all-motion",
        },
      }
    );

    expect(result.current).toMatchObject({
      target: 30,
      safetyCap: 30,
      health: "unrestricted",
    });

    act(() => {
      rerender({
        ...base,
        mode: "all-motion",
        telemetry: {
          ...base.telemetry,
          sampleCount: 2,
          droppedFrameRatio: 0.5,
          frameDelayMs: 200,
          longTaskRate: 0.5,
          workingSetDeltaMB: 1024,
          availableMemoryMB: 64,
        },
      });
    });

    expect(result.current).toMatchObject({
      target: 30,
      safetyCap: 30,
      health: "unrestricted",
    });
  });
});
