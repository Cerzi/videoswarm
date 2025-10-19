import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import ScrollRail from "../ScrollRail.jsx";
import { SortKey } from "../../sorting/sorting.js";

globalThis.React = React;

describe("ScrollRail", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("scrubs across the estimated height when DOM scroll range is shorter", () => {
    const scrollElement = document.createElement("div");
    Object.defineProperty(scrollElement, "clientHeight", {
      configurable: true,
      value: 500,
    });
    Object.defineProperty(scrollElement, "scrollHeight", {
      configurable: true,
      get() {
        return 800; // much shorter than our estimate
      },
    });
    scrollElement.scrollTop = 0;
    scrollElement.scrollTo = vi.fn(({ top }) => {
      scrollElement.scrollTop = top;
    });

    const orderedVideos = Array.from({ length: 100 }, (_, index) => ({
      id: `video-${index}`,
      basename: `Video ${index}`,
    }));

    const scrollRef = { current: scrollElement };
    const getEstimatedOffsetForIndex = vi.fn((index) => index * 100);
    const getEstimatedIndexForOffset = vi.fn(() => 0);
    const getScrollHeightEstimate = vi.fn(() => 5000);
    const onActiveIndexChange = vi.fn();

    const { container } = render(
      <ScrollRail
        scrollRef={scrollRef}
        orderedVideos={orderedVideos}
        sortKey={SortKey.NAME}
        sortDir="asc"
        getEstimatedOffsetForIndex={getEstimatedOffsetForIndex}
        getEstimatedIndexForOffset={getEstimatedIndexForOffset}
        getScrollHeightEstimate={getScrollHeightEstimate}
        viewportHeightPx={500}
        onScrubStateChange={() => {}}
        onActiveIndexChange={onActiveIndexChange}
      />
    );

    const track = container.querySelector(".scroll-rail__track");
    if (!track) throw new Error("track element not found");
    track.getBoundingClientRect = () => ({
      top: 0,
      height: 400,
      bottom: 400,
      left: 0,
      right: 12,
      width: 12,
    });
    track.setPointerCapture = vi.fn();
    track.releasePointerCapture = vi.fn();

    const OriginalPointerEvent = global.PointerEvent;

    class PointerEventMock extends MouseEvent {
      constructor(type, params = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
        Object.defineProperty(this, "clientY", {
          configurable: true,
          enumerable: true,
          value: params.clientY ?? 0,
        });
      }
    }

    global.PointerEvent = PointerEventMock;

    const pointerEvent = new PointerEventMock("pointerdown", {
      bubbles: true,
      clientY: 380,
      pointerId: 1,
    });
    track.dispatchEvent(pointerEvent);

    global.PointerEvent = OriginalPointerEvent;

    expect(getEstimatedOffsetForIndex).toHaveBeenCalled();
    const lastIndexCall =
      getEstimatedOffsetForIndex.mock.calls[
        getEstimatedOffsetForIndex.mock.calls.length - 1
      ];
    expect(lastIndexCall?.[0]).toBeGreaterThan(0);
    expect(onActiveIndexChange).toHaveBeenCalled();
    expect(scrollElement.scrollTo).toHaveBeenCalled();

    const [{ top, behavior }] = scrollElement.scrollTo.mock.calls.pop();
    expect(behavior).toBe("auto");
    expect(top).toBeCloseTo(4500, 0); // clamped to estimated max scroll range

    fireEvent.pointerUp(window, { pointerId: 1 });
  });
});

