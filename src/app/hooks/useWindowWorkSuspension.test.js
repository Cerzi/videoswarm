import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useWindowWorkSuspension from "./useWindowWorkSuspension";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("useWindowWorkSuspension", () => {
  let hidden;
  let visibilityState;
  let hiddenDescriptor;
  let visibilityDescriptor;
  let previousElectronApi;

  beforeEach(() => {
    hidden = false;
    visibilityState = "visible";
    hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    visibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState"
    );
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    previousElectronApi = window.electronAPI;
    delete window.electronAPI;
  });

  afterEach(() => {
    if (hiddenDescriptor) {
      Object.defineProperty(document, "hidden", hiddenDescriptor);
    } else {
      delete document.hidden;
    }
    if (visibilityDescriptor) {
      Object.defineProperty(
        document,
        "visibilityState",
        visibilityDescriptor
      );
    } else {
      delete document.visibilityState;
    }
    if (previousElectronApi === undefined) {
      delete window.electronAPI;
    } else {
      window.electronAPI = previousElectronApi;
    }
    vi.restoreAllMocks();
  });

  it("tracks repeated document hide/restore transitions without resubscribing", () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useWindowWorkSuspension({ enabled }),
      { initialProps: { enabled: true } }
    );

    expect(result.current).toMatchObject({
      isSuspended: false,
      reason: null,
      activity: { active: true, documentHidden: false },
    });

    for (let index = 0; index < 3; index += 1) {
      act(() => {
        hidden = true;
        visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(result.current).toMatchObject({
        isSuspended: true,
        reason: "document-hidden",
        activity: { active: false, documentHidden: true },
      });

      act(() => {
        hidden = false;
        visibilityState = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(result.current.isSuspended).toBe(false);
    }

    rerender({ enabled: false });
    act(() => {
      hidden = true;
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toMatchObject({
      isSuspended: false,
      reason: null,
      activity: { active: true, documentHidden: true },
    });

    expect(
      addSpy.mock.calls.filter(([type]) => type === "visibilitychange")
    ).toHaveLength(1);
    unmount();
    expect(
      removeSpy.mock.calls.filter(([type]) => type === "visibilitychange")
    ).toHaveLength(1);
  });

  it("prefers a newer window event over a late initial activity result", async () => {
    const initialActivity = deferred();
    let emitActivity;
    const unsubscribe = vi.fn();
    const setRendererActive = vi.fn(() => Promise.resolve());
    window.electronAPI = {
      playback: {
        getWindowActivity: vi.fn(() => initialActivity.promise),
        onWindowActivity: vi.fn((callback) => {
          emitActivity = callback;
          return unsubscribe;
        }),
        setRendererActive,
      },
    };

    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useWindowWorkSuspension({ enabled }),
      { initialProps: { enabled: true } }
    );
    expect(window.electronAPI.playback.onWindowActivity).toHaveBeenCalledOnce();

    act(() => {
      emitActivity({
        active: false,
        visible: true,
        minimized: true,
        reason: "window-minimized",
      });
    });
    expect(result.current).toMatchObject({
      isSuspended: true,
      reason: "window-minimized",
      activity: { active: false, minimized: true },
    });

    await act(async () => {
      initialActivity.resolve({ active: true, visible: true, minimized: false });
      await initialActivity.promise;
      await Promise.resolve();
    });
    expect(result.current.isSuspended).toBe(true);

    act(() => {
      emitActivity({
        active: true,
        visible: true,
        hidden: false,
        minimized: false,
      });
    });
    expect(result.current).toMatchObject({
      isSuspended: false,
      reason: null,
      activity: { active: true, minimized: false },
    });

    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(window.electronAPI.playback.onWindowActivity).toHaveBeenCalledOnce();
    expect(setRendererActive.mock.calls.map(([active]) => active)).toEqual(
      expect.arrayContaining([true, false])
    );

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    act(() => emitActivity({ active: false, minimized: true }));
  });
});
