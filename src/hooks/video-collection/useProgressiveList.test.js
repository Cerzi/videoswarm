import { describe, test, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useProgressiveList } from "./useProgressiveList";

describe("useProgressiveList", () => {
  it("shows initial slice then batches over time", () => {
    vi.useFakeTimers();
    const items = Array.from({ length: 200 }, (_, i) => i);

    // Force deterministic interval mode
    const { result } = renderHook(() =>
      useProgressiveList(items, 50, 25, 1, {
        forceInterval: true,
        pauseOnScroll: false,
        longTaskAdaptation: false,
      })
    );

    // Initial slice
    expect(result.current.length).toBe(50);

    // One tick => +25 => 75
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.length).toBe(75);

    // Another tick => +25 => 100
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.length).toBe(100);
  });

  test("clamps down on shrink, does not reset on growth", () => {
    vi.useFakeTimers();
    let items = Array.from({ length: 120 }, (_, i) => i);
    const { result, rerender } = renderHook(
      ({ arr }) => useProgressiveList(arr, 80, 40, 50),
      { initialProps: { arr: items } }
    );

    // initial window 80
    expect(result.current.length).toBe(80);

    // grow naturally via interval to 120
    act(() => vi.advanceTimersByTime(2 * 50)); // +80 -> 120 capped
    expect(result.current.length).toBe(120);

    // shrink source list to 60 — should clamp visible to 60
    items = items.slice(0, 60);
    rerender({ arr: items });
    expect(result.current.length).toBe(60);

    // growth does not reset visible; it will continue batching via interval
    items = Array.from({ length: 140 }, (_, i) => i);
    rerender({ arr: items });
    act(() => vi.advanceTimersByTime(50));
    expect(result.current.length).toBeGreaterThan(60);

    vi.useRealTimers();
  });
});
