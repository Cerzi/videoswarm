import React, { useRef, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import useSelectionCycler from "./useSelectionCycler";

const TestHarness = ({
  selectionIds,
  renderedIds = selectionIds,
  runWithStableAnchor = (_, fn) => fn(),
  anchorOptions,
}) => {
  const scrollRef = useRef(null);
  const gridRef = useRef(null);
  const [result, setResult] = useState(null);

  const focusNext = useSelectionCycler({
    orderedSelectionIds: selectionIds,
    scrollRef,
    gridRef,
    runWithStableAnchor,
    anchorOptions,
  });

  return (
    <div>
      <div
        ref={scrollRef}
        data-testid="scroll"
        style={{ height: "200px", overflowY: "auto" }}
      >
        <div ref={gridRef} data-testid="grid">
          {renderedIds.map((id) => (
            <div key={id} data-video-id={id} data-testid={`item-${id}`} />
          ))}
        </div>
      </div>
      <button type="button" onClick={() => setResult(focusNext())}>
        focus
      </button>
      <output data-testid="result">{String(result)}</output>
    </div>
  );
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSelectionCycler", () => {
  const setupDom = (ids, positions) => {
    const scrollEl = screen.getByTestId("scroll");
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 200,
      configurable: true,
    });
    scrollEl.scrollTop = 0;
    scrollEl.getBoundingClientRect = () => ({
      top: 0,
      bottom: 200,
      height: 200,
      width: 200,
      left: 0,
      right: 200,
    });

    ids.forEach((id) => {
      const el = screen.getByTestId(`item-${id}`);
      const base = positions.get(id) ?? 0;
      Object.defineProperty(el, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          top: base - scrollEl.scrollTop,
          bottom: base - scrollEl.scrollTop + 120,
          height: 120,
          width: 160,
          left: 0,
          right: 160,
        }),
      });
    });

    return { scrollEl };
  };

  it("cycles through selected ids and scrolls within the viewport", () => {
    const selectionIds = ["1", "2", "3"];
    const positions = new Map([
      ["1", 0],
      ["2", 260],
      ["3", 520],
    ]);
    const runWithStableAnchor = vi.fn((_, fn) => fn());

    render(
      <TestHarness
        selectionIds={selectionIds}
        runWithStableAnchor={runWithStableAnchor}
      />
    );

    const { scrollEl } = setupDom(selectionIds, positions);
    scrollEl.dispatchEvent = vi.fn(() => true);
    const button = screen.getByRole("button", { name: "focus" });
    const result = screen.getByTestId("result");

    fireEvent.click(button);
    expect(result.textContent).toBe("true");
    expect(scrollEl.scrollTop).toBe(0);
    expect(scrollEl.dispatchEvent).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(result.textContent).toBe("true");
    expect(scrollEl.scrollTop).toBeCloseTo(180, 1);
    expect(scrollEl.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(scrollEl.dispatchEvent.mock.calls[0][0]).toBeInstanceOf(Event);
    expect(scrollEl.dispatchEvent.mock.calls[0][0].type).toBe("scroll");

    fireEvent.click(button);
    expect(result.textContent).toBe("true");
    expect(scrollEl.scrollTop).toBeCloseTo(440, 1);
    expect(scrollEl.dispatchEvent).toHaveBeenCalledTimes(2);

    fireEvent.click(button);
    expect(result.textContent).toBe("true");
    expect(scrollEl.scrollTop).toBe(0);

    expect(runWithStableAnchor).toHaveBeenCalledTimes(4);
    expect(runWithStableAnchor).toHaveBeenLastCalledWith(
      "metadata:scrollToSelection",
      expect.any(Function),
      undefined
    );
  });

  it("returns false when the target element is not rendered", () => {
    const selectionIds = ["missing"];
    const runWithStableAnchor = vi.fn((_, fn) => fn());

    render(
      <TestHarness
        selectionIds={selectionIds}
        renderedIds={[]}
        runWithStableAnchor={runWithStableAnchor}
      />
    );

    const scrollEl = screen.getByTestId("scroll");
    Object.defineProperty(scrollEl, "clientHeight", {
      value: 200,
      configurable: true,
    });
    scrollEl.getBoundingClientRect = () => ({
      top: 0,
      bottom: 200,
      height: 200,
      width: 200,
      left: 0,
      right: 200,
    });

    const button = screen.getByRole("button", { name: "focus" });
    const result = screen.getByTestId("result");

    fireEvent.click(button);
    expect(result.textContent).toBe("false");
    expect(scrollEl.scrollTop).toBe(0);
    expect(runWithStableAnchor).toHaveBeenCalledTimes(1);
  });

  it("does nothing when selection is empty", () => {
    const runWithStableAnchor = vi.fn((_, fn) => fn());

    render(
      <TestHarness
        selectionIds={[]}
        runWithStableAnchor={runWithStableAnchor}
      />
    );

    const button = screen.getByRole("button", { name: "focus" });
    const result = screen.getByTestId("result");

    fireEvent.click(button);
    expect(result.textContent).toBe("false");
    expect(runWithStableAnchor).not.toHaveBeenCalled();
  });

  it("dispatches a synthetic scroll event when programmatic scroll occurs", () => {
    const selectionIds = ["2"];
    const positions = new Map([["2", 260]]);
    const runWithStableAnchor = vi.fn((_, fn) => fn());

    render(
      <TestHarness
        selectionIds={selectionIds}
        runWithStableAnchor={runWithStableAnchor}
      />
    );

    const { scrollEl } = setupDom(selectionIds, positions);
    const dispatchSpy = vi.fn(() => true);
    scrollEl.dispatchEvent = dispatchSpy;

    const button = screen.getByRole("button", { name: "focus" });
    fireEvent.click(button);

    expect(scrollEl.scrollTop).toBeCloseTo(180, 1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const [event] = dispatchSpy.mock.calls[0];
    expect(event).toBeInstanceOf(Event);
    expect(event.type).toBe("scroll");
  });
});
