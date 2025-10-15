import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import useSelectionScrollCycler from "./useSelectionScrollCycler";

describe("useSelectionScrollCycler", () => {
  it("cycles through selection ids sequentially", () => {
    const ensureVisible = vi.fn().mockReturnValue(true);
    const { result } = renderHook(
      ({ ids }) => useSelectionScrollCycler(ids, ensureVisible),
      { initialProps: { ids: ["a", "b", "c"] } }
    );

    act(() => {
      result.current();
      result.current();
      result.current();
      result.current();
    });

    expect(ensureVisible).toHaveBeenNthCalledWith(1, "a");
    expect(ensureVisible).toHaveBeenNthCalledWith(2, "b");
    expect(ensureVisible).toHaveBeenNthCalledWith(3, "c");
    expect(ensureVisible).toHaveBeenNthCalledWith(4, "a");
  });

  it("resets cycle when selection ids change", () => {
    const ensureVisible = vi.fn().mockReturnValue(true);
    const { result, rerender } = renderHook(
      ({ ids }) => useSelectionScrollCycler(ids, ensureVisible),
      { initialProps: { ids: ["a", "b"] } }
    );

    act(() => {
      result.current();
    });

    rerender({ ids: ["c", "d"] });

    act(() => {
      result.current();
    });

    expect(ensureVisible).toHaveBeenNthCalledWith(1, "a");
    expect(ensureVisible).toHaveBeenNthCalledWith(2, "c");
  });

  it("returns false when ensure function missing or ids empty", () => {
    const { result: noIds } = renderHook(() =>
      useSelectionScrollCycler([], () => true)
    );

    let outcome;
    act(() => {
      outcome = noIds.current();
    });
    expect(outcome).toBe(false);

    const { result: noEnsure } = renderHook(() =>
      useSelectionScrollCycler(["a"], null)
    );

    act(() => {
      outcome = noEnsure.current();
    });
    expect(outcome).toBe(false);
  });
});
