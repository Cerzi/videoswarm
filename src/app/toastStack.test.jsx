import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { TOAST_STACK_ID, showToast } from "./toastStack";
import MemoryAlert from "./components/MemoryAlert";

describe("toast stack", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.getElementById(TOAST_STACK_ID)?.remove();
  });

  it("stacks toasts shown together instead of drawing them on top of each other", () => {
    vi.useFakeTimers();
    const first = showToast("Applied smart view", "success");
    const second = showToast('No clips carry "keeper"', "info");
    const stack = document.getElementById(TOAST_STACK_ID);
    expect([...stack.children]).toEqual([first, second]);
    expect(stack.style.flexDirection).toBe("column");
    expect(stack.style.pointerEvents).toBe("none");
    expect(first.style.position).toBe("");
    expect(second).toHaveAttribute("role", "status");
    expect(showToast("Failed", "error")).toHaveAttribute("role", "alert");

    vi.advanceTimersByTime(3000);
    expect(document.getElementById(TOAST_STACK_ID)).toBeNull();
  });

  it("keeps the memory warning out of the toast corner and out of the way", () => {
    render(<MemoryAlert memStatus={{ isNearLimit: true, currentMemoryMB: 3000, memoryPressure: 91 }} />);
    const alert = document.body.querySelector("div[style*='position: fixed']");
    expect(alert.style.bottom).toBe("20px");
    expect(alert.style.top).toBe("");
    expect(alert.style.pointerEvents).toBe("none");
  });
});
