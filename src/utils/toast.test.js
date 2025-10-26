import { describe, it, expect, vi, afterEach } from "vitest";
import { showToast } from "./toast";

describe("showToast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a toast that ignores pointer events and cleans up", () => {
    vi.useFakeTimers();

    const { element, dispose } = showToast("Hello", "info");

    expect(element.style.pointerEvents).toBe("none");
    expect(document.body.contains(element)).toBe(true);

    vi.advanceTimersByTime(3100);
    expect(document.body.contains(element)).toBe(false);

    // calling dispose after removal should be safe
    dispose();
  });
});
