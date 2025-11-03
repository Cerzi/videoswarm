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
    expect(result.current.items.length).toBe(50);
    expect(result.current.visibleCount).toBe(50);

    // One tick => +25 => 75
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.items.length).toBe(75);
    expect(result.current.visibleCount).toBe(75);

    // Another tick => +25 => 100
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.items.length).toBe(100);
    expect(result.current.visibleCount).toBe(100);

    vi.useRealTimers();
  });

  test("clamps down on shrink, does not reset on growth", () => {
    vi.useFakeTimers();
    let items = Array.from({ length: 120 }, (_, i) => i);
    const { result, rerender } = renderHook(
      ({ arr }) => useProgressiveList(arr, 80, 40, 50),
      { initialProps: { arr: items } }
    );

    // initial window 80
    expect(result.current.items.length).toBe(80);

    // grow naturally via interval to 120
    act(() => vi.advanceTimersByTime(2 * 50)); // +80 -> 120 capped
    expect(result.current.items.length).toBe(120);

    // shrink source list to 60 — should clamp visible to 60
    items = items.slice(0, 60);
    rerender({ arr: items });
    expect(result.current.items.length).toBe(60);

    // growth does not reset visible; it will continue batching via interval
    items = Array.from({ length: 140 }, (_, i) => i);
    rerender({ arr: items });
    act(() => vi.advanceTimersByTime(50));
    expect(result.current.items.length).toBeGreaterThan(60);

    vi.useRealTimers();
  });

  test("respects maxVisible clamp and expands when raised", () => {
    vi.useFakeTimers();
    const items = Array.from({ length: 300 }, (_, i) => i);

    const { result, rerender } = renderHook(
      ({ cap }) =>
        useProgressiveList(items, 60, 30, 1, {
          forceInterval: true,
          pauseOnScroll: false,
          longTaskAdaptation: false,
          maxVisible: cap,
        }),
      { initialProps: { cap: 90 } }
    );

    expect(result.current.items.length).toBe(60);

    act(() => {
      vi.advanceTimersByTime(5);
    });

    expect(result.current.items.length).toBe(90);

    // Lower the cap → visible count shrinks immediately
    act(() => {
      rerender({ cap: 45 });
    });
    expect(result.current.items.length).toBe(45);

    // Raise the cap and ensure growth resumes
    act(() => {
      rerender({ cap: 150 });
    });

    act(() => {
      vi.advanceTimersByTime(12);
    });
    expect(result.current.items.length).toBeGreaterThan(90);

    vi.useRealTimers();
  });

  test("materializeAll returns the full list but tracks the budget", () => {
    vi.useFakeTimers();
    const items = Array.from({ length: 100 }, (_, i) => i);

    const { result } = renderHook(() =>
      useProgressiveList(items, 20, 20, 1, {
        forceInterval: true,
        pauseOnScroll: false,
        longTaskAdaptation: false,
        materializeAll: true,
      })
    );

    // All items materialized immediately, but visibleCount tracks the progressive budget
    expect(result.current.items.length).toBe(100);
    expect(result.current.visibleCount).toBe(20);

    act(() => {
      vi.advanceTimersByTime(2);
    });

    expect(result.current.items.length).toBe(100);
    expect(result.current.visibleCount).toBeGreaterThan(20);

    vi.useRealTimers();
  });
});
