import React, { useLayoutEffect, useRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import useIntersectionObserverRegistry from "./useIntersectionObserverRegistry";

const RegistryHarness = ({ onReady }) => {
  const rootRef = useRef(null);
  const registry = useIntersectionObserverRegistry(rootRef, {
    rootMargin: "0px 0px",
    nearPx: 0,
  });

  useLayoutEffect(() => {
    if (rootRef.current) {
      onReady(registry);
    }
  }, [onReady, registry]);

  return (
    <div ref={rootRef} data-testid="root">
      <div data-testid="item" />
    </div>
  );
};

describe("useIntersectionObserverRegistry", () => {
  let originalIntersectionObserver;

  beforeEach(() => {
    originalIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver = vi.fn(function (callback) {
      this.observe = vi.fn((element) => {
        callback(
          [
            {
              target: element,
              boundingClientRect: element.getBoundingClientRect?.(),
            },
          ]
        );
      });
      this.unobserve = vi.fn();
      this.disconnect = vi.fn();
      this.takeRecords = vi.fn(() => []);
    });
  });

  afterEach(() => {
    window.IntersectionObserver = originalIntersectionObserver;
    vi.restoreAllMocks();
  });

  it("refresh recalculates visibility and notifies handlers", () => {
    let registry = null;
    const handler = vi.fn();

    render(<RegistryHarness onReady={(reg) => (registry = reg)} />);

    expect(registry).not.toBeNull();

    const root = screen.getByTestId("root");
    const item = screen.getByTestId("item");

    Object.defineProperty(root, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 200,
        left: 0,
        right: 200,
        width: 200,
        height: 200,
      }),
    });

    let itemTop = 20;
    Object.defineProperty(item, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: itemTop,
        bottom: itemTop + 120,
        left: 0,
        right: 160,
        width: 160,
        height: 120,
      }),
    });

    act(() => {
      registry.observe(item, "video-1", handler);
    });

    handler.mockClear();

    act(() => {
      registry.refresh();
    });

    expect(handler).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ target: item })
    );

    handler.mockClear();
    itemTop = 260;

    act(() => {
      registry.refresh();
    });

    expect(handler).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ target: item })
    );
  });
});
