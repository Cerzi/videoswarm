import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useSelectionScroller from "./useSelectionScroller";

const createRect = ({ top, bottom, left = 0, right = 0 }) => ({
  top,
  bottom,
  left,
  right,
  width: Math.max(0, right - left),
  height: Math.max(0, bottom - top),
});

describe("useSelectionScroller", () => {
  let originalGetComputedStyle;

  beforeEach(() => {
    originalGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = vi.fn(() => ({
      scrollPaddingTop: "0px",
      scrollPaddingBottom: "0px",
    }));
  });

  afterEach(() => {
    window.getComputedStyle = originalGetComputedStyle;
  });

  it("cycles through selected ids and scrolls them into view", () => {
    const scrollEl = document.createElement("div");
    const gridEl = document.createElement("div");

    const cardA = document.createElement("div");
    cardA.setAttribute("data-video-id", "a");
    const cardB = document.createElement("div");
    cardB.setAttribute("data-video-id", "b");

    gridEl.appendChild(cardA);
    gridEl.appendChild(cardB);

    scrollEl.getBoundingClientRect = vi.fn(() => createRect({ top: 0, bottom: 400 }));
    cardA.getBoundingClientRect = vi.fn(() => createRect({ top: -30, bottom: 70 }));
    cardB.getBoundingClientRect = vi.fn(() => createRect({ top: 450, bottom: 550 }));

    Object.defineProperty(scrollEl, "scrollTop", {
      value: 100,
      writable: true,
      configurable: true,
    });

    const runWithStableAnchor = vi.fn((trigger, fn, options) => fn());

    const { result, rerender } = renderHook(
      ({ ids }) =>
        useSelectionScroller({
          orderedIds: ids,
          gridRef: { current: gridEl },
          scrollRef: { current: scrollEl },
          runWithStableAnchor,
        }),
      { initialProps: { ids: ["a", "b"] } }
    );

    let scrolled;
    act(() => {
      scrolled = result.current.scrollToNextSelected();
    });

    expect(scrolled).toBe(true);
    expect(runWithStableAnchor).toHaveBeenCalledWith(
      "selection:scroll-to",
      expect.any(Function),
      expect.objectContaining({ capture: "reuse-visible", settleFrames: 0 })
    );
    expect(scrollEl.scrollTop).toBe(70);

    act(() => {
      scrolled = result.current.scrollToNextSelected();
    });

    expect(scrolled).toBe(true);
    expect(scrollEl.scrollTop).toBe(220);

    // Change selection to single item and ensure cycling resets
    cardB.getBoundingClientRect = vi.fn(() => createRect({ top: -10, bottom: 90 }));
    rerender({ ids: ["b"] });

    act(() => {
      scrolled = result.current.scrollToNextSelected();
    });

    expect(scrolled).toBe(true);
    expect(scrollEl.scrollTop).toBe(210);
  });

  it("returns false when no ids are provided", () => {
    const runWithStableAnchor = vi.fn();
    const { result } = renderHook(() =>
      useSelectionScroller({
        orderedIds: [],
        gridRef: { current: null },
        scrollRef: { current: null },
        runWithStableAnchor,
      })
    );

    let scrolled;
    act(() => {
      scrolled = result.current.scrollToNextSelected();
    });

    expect(scrolled).toBe(false);
    expect(runWithStableAnchor).not.toHaveBeenCalled();
  });
});
