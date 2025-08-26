import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useFullScreenController } from "./useFullScreenController";

describe("useFullScreenController", () => {
  const vids = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("open/close sets state; togglePlay flips intent; nav resets to play", () => {
    const { result } = renderHook(() => useFullScreenController(vids));

    act(() => result.current.open("b"));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.currentVideo).toEqual({ id: "b" });
    expect(result.current.playIntent).toBe("play");

    act(() => result.current.togglePlay());
    expect(result.current.playIntent).toBe("pause");

    act(() => result.current.next());
    expect(result.current.currentVideo).toEqual({ id: "c" });
    expect(result.current.playIntent).toBe("play");

    act(() => result.current.prev());
    expect(result.current.currentVideo).toEqual({ id: "b" });

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.currentVideo).toBeNull();
  });
});
