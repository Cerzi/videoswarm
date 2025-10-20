import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import ScrollRail from "./ScrollRail";

describe("ScrollRail", () => {
  beforeEach(() => {
    if (!document.getElementById("vs-scroll-rail-overlay-root")) {
      const host = document.createElement("div");
      host.id = "vs-scroll-rail-overlay-root";
      document.body.appendChild(host);
    }
  });

  afterEach(() => {
    const host = document.getElementById("vs-scroll-rail-overlay-root");
    if (host) {
      host.remove();
    }
  });

  const buildProps = (overrides = {}) => ({
    total: 10,
    rangeStart: 0,
    rangeEnd: 4,
    indexToOffset: (index) => ({ y: index * 100, column: 0 }),
    getEntry: (index) => ({ id: `id-${index}`, y: index * 100, height: 80, column: 0 }),
    offsetToIndex: (offset) => Math.max(0, Math.min(9, Math.floor(offset / 100))),
    totalHeight: 1000,
    labelForIndex: (index) => `Video ${index + 1}`,
    onScrub: vi.fn((index) => ({ index, offset: index * 100, height: 80 })),
    onCommit: vi.fn(),
    ...overrides,
  });

  it("invokes onScrub and shows preview label on pointer interaction", () => {
    const props = buildProps();
    const { getByRole, getByText } = render(<ScrollRail {...props} />);
    const slider = getByRole("slider");
    slider.getBoundingClientRect = () => ({ top: 0, height: 200, bottom: 200, left: 0, right: 0, width: 10 });

    fireEvent.pointerDown(slider, { clientX: 5, clientY: 40, pointerId: 1 });
    expect(props.onScrub).toHaveBeenCalled();

    getByText(/Video/);

    fireEvent.pointerUp(slider, { clientX: 5, clientY: 40, pointerId: 1 });
    expect(props.onCommit).toHaveBeenCalled();
  });

  it("supports keyboard based navigation", () => {
    const props = buildProps();
    const { getByRole } = render(<ScrollRail {...props} />);
    const slider = getByRole("slider");

    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(props.onScrub).toHaveBeenCalled();
    expect(props.onCommit).toHaveBeenCalled();
  });

  it("renders without items when total is zero", () => {
    const props = buildProps({ total: 0, rangeStart: 0, rangeEnd: -1 });
    const { getByRole } = render(<ScrollRail {...props} />);
    const slider = getByRole("slider", { hidden: true });
    expect(slider).toHaveAttribute("aria-valuemax", "0");
  });

  it("keeps the thumb within the track bounds when measured", async () => {
    const props = buildProps();
    const { getByRole } = render(<ScrollRail {...props} />);
    const slider = getByRole("slider");
    slider.getBoundingClientRect = () => ({
      top: 0,
      height: 200,
      bottom: 200,
      left: 0,
      right: 10,
      width: 10,
    });

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    const thumb = document.querySelector(".scroll-rail__thumb");
    await waitFor(() => {
      const initial = parseFloat(thumb.style.top);
      expect(initial).toBeCloseTo(28, 0);
    });

  });
});
