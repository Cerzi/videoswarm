import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useInitGate from "./useInitGate";

describe("useInitGate", () => {
  let callbacks;
  let nextId;
  let previousRaf;
  let previousCancelRaf;

  beforeEach(() => {
    callbacks = new Map();
    nextId = 1;
    previousRaf = global.requestAnimationFrame;
    previousCancelRaf = global.cancelAnimationFrame;
    global.requestAnimationFrame = vi.fn((callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
    global.cancelAnimationFrame = vi.fn((id) => callbacks.delete(id));
  });

  afterEach(() => {
    global.requestAnimationFrame = previousRaf;
    global.cancelAnimationFrame = previousCancelRaf;
  });

  const flushFrame = () => {
    const [id, callback] = callbacks.entries().next().value ?? [];
    if (!callback) return;
    callbacks.delete(id);
    act(() => callback(0));
  };

  it("sleeps while idle and only schedules another frame when work remains", () => {
    const { result } = renderHook(() => useInitGate({ perFrame: 2 }));
    const calls = [vi.fn(), vi.fn(), vi.fn()];

    expect(requestAnimationFrame).not.toHaveBeenCalled();

    act(() => calls.forEach((call) => result.current.scheduleInit(call)));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(calls[0]).toHaveBeenCalledOnce();
    expect(calls[1]).toHaveBeenCalledOnce();
    expect(calls[2]).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    flushFrame();
    expect(calls[2]).toHaveBeenCalledOnce();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it("cancels queued work and clears its pending frame", () => {
    const { result, unmount } = renderHook(() => useInitGate());
    const task = vi.fn();

    let cancel;
    act(() => {
      cancel = result.current.scheduleInit(task);
      cancel();
    });

    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    flushFrame();
    expect(task).not.toHaveBeenCalled();

    act(() => result.current.scheduleInit(task));
    unmount();
    flushFrame();
    expect(task).not.toHaveBeenCalled();
  });

  it("clears work while suspended and resumes without stale callbacks", () => {
    const rendered = renderHook(
      ({ suspended }) => useInitGate({ perFrame: 1, suspended }),
      { initialProps: { suspended: false } }
    );
    const stale = vi.fn();
    const current = vi.fn();

    act(() => rendered.result.current.scheduleInit(stale));
    rendered.rerender({ suspended: true });
    flushFrame();
    expect(stale).not.toHaveBeenCalled();

    expect(rendered.result.current.scheduleInit(current)).toBeTypeOf("function");
    expect(callbacks.size).toBe(0);
    rendered.rerender({ suspended: false });
    act(() => rendered.result.current.scheduleInit(current));
    flushFrame();
    expect(current).toHaveBeenCalledOnce();
  });

  it("bounds pending initialization work", () => {
    const { result } = renderHook(() =>
      useInitGate({ perFrame: 1, maxPending: 2 })
    );
    const calls = [vi.fn(), vi.fn(), vi.fn()];
    act(() => calls.forEach((call) => result.current.scheduleInit(call)));
    flushFrame();
    flushFrame();
    expect(calls[0]).toHaveBeenCalledOnce();
    expect(calls[1]).toHaveBeenCalledOnce();
    expect(calls[2]).not.toHaveBeenCalled();
  });
});
