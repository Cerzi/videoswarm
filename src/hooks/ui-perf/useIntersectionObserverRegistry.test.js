import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import useIntersectionObserverRegistry from "./useIntersectionObserverRegistry";

class MockIntersectionObserver {
  static instances = [];

  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.observed = new Set();
    MockIntersectionObserver.instances.push(this);
  }

  observe(element) {
    this.observed.add(element);
  }

  unobserve(element) {
    this.observed.delete(element);
  }

  disconnect() {
    this.observed.clear();
  }

  takeRecords() {
    return [];
  }
}

describe("useIntersectionObserverRegistry", () => {
  let previousIO;

  beforeEach(() => {
    previousIO = global.IntersectionObserver;
    // @ts-ignore
    global.IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    // @ts-ignore
    global.IntersectionObserver = previousIO;
    MockIntersectionObserver.instances.length = 0;
  });

  it("immediately reports visibility for elements already in view", () => {
    const rootEl = document.createElement("div");
    rootEl.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
    document.body.appendChild(rootEl);

    const child = document.createElement("div");
    child.getBoundingClientRect = () => ({ top: 100, bottom: 200 });
    rootEl.appendChild(child);

    const handler = vi.fn();

    const { result } = renderHook(() =>
      useIntersectionObserverRegistry({ current: rootEl }, {
        rootMargin: "0px",
        threshold: [0],
      })
    );

    act(() => {
      result.current.observe(child, "vid-1", handler);
    });

    expect(handler).toHaveBeenCalled();
    const [visible] = handler.mock.calls[0];
    expect(visible).toBe(true);
    expect(result.current.isVisible("vid-1")).toBe(true);
    expect(result.current.getVisibleIds().has("vid-1")).toBe(true);

    document.body.removeChild(rootEl);
  });

  it("marks elements outside the viewport as not visible", () => {
    const rootEl = document.createElement("div");
    rootEl.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
    document.body.appendChild(rootEl);

    const child = document.createElement("div");
    child.getBoundingClientRect = () => ({ top: 800, bottom: 900 });
    rootEl.appendChild(child);

    const handler = vi.fn();

    const { result } = renderHook(() =>
      useIntersectionObserverRegistry({ current: rootEl })
    );

    act(() => {
      result.current.observe(child, "vid-2", handler);
    });

    expect(handler).toHaveBeenCalled();
    const [visible] = handler.mock.calls[0];
    expect(visible).toBe(false);
    expect(result.current.isVisible("vid-2")).toBe(false);
    expect(result.current.getVisibleIds().has("vid-2")).toBe(false);

    document.body.removeChild(rootEl);
  });
});
