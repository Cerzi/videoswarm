import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardIdAtPoint, useHoverUnderPointer } from "./useHoverUnderPointer";

describe("useHoverUnderPointer", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete document.elementFromPoint;
    document.body.innerHTML = "";
  });

  it("names the card under a point, or nothing", () => {
    document.body.innerHTML = '<div class="video-item" data-video-id="a"><video></video></div>';
    const inner = document.querySelector("video");
    expect(cardIdAtPoint({ x: 1, y: 1 }, { elementFromPoint: () => inner })).toBe("a");
    expect(cardIdAtPoint({ x: 1, y: 1 }, { elementFromPoint: () => document.body })).toBeNull();
    expect(cardIdAtPoint(null, { elementFromPoint: () => inner })).toBeNull();
  });

  it("enters the card under a still pointer when the cards change", () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div class="video-item" data-video-id="new"></div>';
    document.elementFromPoint = vi.fn(() => document.querySelector(".video-item"));
    const onEnter = vi.fn();
    const { rerender } = renderHook(({ trigger }) => useHoverUnderPointer(trigger, onEnter), {
      initialProps: { trigger: null },
    });
    // No pointer seen yet: nothing to enter.
    rerender({ trigger: 1 });
    vi.advanceTimersByTime(1000);
    expect(onEnter).not.toHaveBeenCalled();

    window.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 40, clientY: 50 }));
    rerender({ trigger: 2 });
    vi.advanceTimersByTime(1000);
    expect(document.elementFromPoint).toHaveBeenCalledWith(40, 50);
    expect(onEnter).toHaveBeenCalledWith("new");

    // A pointer that left the window enters nothing.
    onEnter.mockClear();
    document.documentElement.dispatchEvent(new Event("mouseleave"));
    rerender({ trigger: 3 });
    vi.advanceTimersByTime(1000);
    expect(onEnter).not.toHaveBeenCalled();
  });
});
