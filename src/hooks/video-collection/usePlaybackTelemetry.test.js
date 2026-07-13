import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import usePlaybackTelemetry, {
  MAX_REGISTERED_MEDIA,
} from "./usePlaybackTelemetry";

class MockPerformanceObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.observe = vi.fn();
    this.disconnect = vi.fn();
    MockPerformanceObserver.instances.push(this);
  }

  emit(entries) {
    this.callback({ getEntries: () => entries });
  }
}

let rafCallbacks;
let rafSequence;

const fireNextFrame = (timestamp) => {
  const first = rafCallbacks.entries().next().value;
  if (!first) throw new Error("No animation frame is queued");
  const [id, callback] = first;
  rafCallbacks.delete(id);
  act(() => callback(timestamp));
};

const flushAsync = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const advanceSample = async (ms = 1000) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
};

const makeQualityElement = ({
  total = 100,
  dropped = 0,
  width = 1280,
  height = 720,
} = {}) => {
  const counters = { total, dropped };
  return {
    paused: false,
    ended: false,
    videoWidth: width,
    videoHeight: height,
    counters,
    getVideoPlaybackQuality: vi.fn(() => ({
      totalVideoFrames: counters.total,
      droppedVideoFrames: counters.dropped,
    })),
  };
};

describe("usePlaybackTelemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rafCallbacks = new Map();
    rafSequence = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
      const id = ++rafSequence;
      rafCallbacks.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id) => {
      rafCallbacks.delete(id);
    }));
    MockPerformanceObserver.instances = [];
    vi.stubGlobal("PerformanceObserver", MockPerformanceObserver);
    window.appMem = {
      get: vi.fn().mockResolvedValue({
        totals: {
          wsMB: 512,
          totalMB: 8192,
          availableMB: 6144,
        },
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete window.appMem;
  });

  it("samples exact-element frame deltas and source pixel area", async () => {
    const { result } = renderHook(() =>
      usePlaybackTelemetry({ sampleIntervalMs: 1000 })
    );
    await flushAsync();
    const element = makeQualityElement({ total: 100, dropped: 2 });

    act(() => {
      result.current.registerMediaElement("clip", element);
    });
    await advanceSample(); // establishes the exact element's baseline
    expect(result.current.telemetry.droppedFrameRatio).toBeNull();

    element.counters.total = 120;
    element.counters.dropped = 4;
    await advanceSample();

    expect(result.current.telemetry).toMatchObject({
      activeMedia: 1,
      registeredMedia: 1,
      qualitySupportedMedia: 1,
      averagePixelArea: 1280 * 720,
      workingSetMB: 512,
      systemMemoryMB: 8192,
      availableMemoryMB: 6144,
      workingSetDeltaMB: 0,
    });
    expect(result.current.telemetry.droppedFrameRatio).toBeCloseTo(0.1);
  });

  it("treats quality counter rollback as a new baseline", async () => {
    const { result } = renderHook(() => usePlaybackTelemetry());
    await flushAsync();
    const element = makeQualityElement({ total: 100, dropped: 4 });
    act(() => result.current.registerMediaElement("clip", element));
    await advanceSample();

    element.counters.total = 5;
    element.counters.dropped = 0;
    await advanceSample();
    expect(result.current.telemetry.droppedFrameRatio).toBeNull();

    element.counters.total = 15;
    element.counters.dropped = 1;
    await advanceSample();
    expect(result.current.telemetry.droppedFrameRatio).toBeCloseTo(0.1);
  });

  it("keeps unsupported dropped-frame metrics unknown", async () => {
    const { result } = renderHook(() => usePlaybackTelemetry());
    await flushAsync();
    const unsupported = {
      paused: false,
      ended: false,
      videoWidth: 640,
      videoHeight: 360,
    };
    act(() => result.current.registerMediaElement("unsupported", unsupported));
    await advanceSample();

    expect(result.current.telemetry).toMatchObject({
      activeMedia: 1,
      qualitySupportedMedia: 0,
      droppedFrameRatio: null,
      averagePixelArea: 640 * 360,
    });
  });

  it("bounds registrations and lets only the exact replacement disposer win", async () => {
    const { result } = renderHook(() => usePlaybackTelemetry());
    await flushAsync();
    const oldElement = makeQualityElement({ width: 320, height: 180 });
    const currentElement = makeQualityElement({ width: 1920, height: 1080 });
    let disposeOld;
    let disposeCurrent;

    act(() => {
      disposeOld = result.current.registerMediaElement("same", oldElement);
      disposeCurrent = result.current.registerMediaElement("same", currentElement);
      for (let index = 0; index < MAX_REGISTERED_MEDIA + 5; index += 1) {
        result.current.registerMediaElement(`clip-${index}`, makeQualityElement());
      }
      disposeOld();
    });
    await advanceSample();
    expect(result.current.telemetry.registeredMedia).toBe(
      MAX_REGISTERED_MEDIA
    );

    // The replacement may be LRU-evicted by the cap exercise, so verify exact
    // disposer ownership separately with a fresh ID.
    const replacement = makeQualityElement({ width: 800, height: 600 });
    let staleDispose;
    let liveDispose;
    act(() => {
      staleDispose = result.current.registerMediaElement("owned", oldElement);
      liveDispose = result.current.registerMediaElement("owned", replacement);
      staleDispose();
      disposeCurrent();
    });
    await advanceSample();
    expect(result.current.telemetry.registeredMedia).toBe(
      MAX_REGISTERED_MEDIA
    );

    act(() => liveDispose());
    await advanceSample();
    expect(result.current.telemetry.registeredMedia).toBe(
      MAX_REGISTERED_MEDIA - 1
    );
  });

  it("uses one observer, one rAF loop and one interval, then cleans them up", async () => {
    const { unmount } = renderHook(() => usePlaybackTelemetry());
    await flushAsync();

    expect(MockPerformanceObserver.instances).toHaveLength(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    const observer = MockPerformanceObserver.instances[0];
    unmount();

    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(rafCallbacks.size).toBe(0);
  });

  it("reports long tasks without adding per-card observers", async () => {
    const { result } = renderHook(() => usePlaybackTelemetry());
    await flushAsync();
    act(() => {
      MockPerformanceObserver.instances[0].emit([{ duration: 250 }]);
    });
    expect(result.current.hadLongTaskRecently).toBe(true);

    await advanceSample();
    expect(result.current.telemetry.longTaskRate).toBeCloseTo(0.25);
    expect(result.current.hadLongTaskRecently).toBe(true);

    await advanceSample();
    expect(result.current.hadLongTaskRecently).toBe(false);
  });

  it("fully stops while suspended and ignores the resume-sized frame gap", async () => {
    const { result, rerender } = renderHook(
      ({ suspended }) =>
        usePlaybackTelemetry({ suspended, sampleIntervalMs: 1000 }),
      { initialProps: { suspended: false } }
    );
    await flushAsync();
    fireNextFrame(0);
    fireNextFrame(16);
    const callsBeforeSuspend = window.appMem.get.mock.calls.length;

    rerender({ suspended: true });
    expect(result.current.telemetry.suspended).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await advanceSample(5000);
    expect(window.appMem.get).toHaveBeenCalledTimes(callsBeforeSuspend);

    rerender({ suspended: false });
    await flushAsync();
    fireNextFrame(10_000); // first frame is a fresh baseline
    fireNextFrame(10_016);
    await advanceSample();

    expect(result.current.telemetry.suspended).toBe(false);
    expect(result.current.telemetry.frameDelayMs).toBe(16);
    expect(result.current.hadLongTaskRecently).toBe(false);
    expect(result.current.telemetry.workingSetDeltaMB).toBe(0);
  });
});

