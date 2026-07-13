import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import useVideoResourceManager from "./useVideoResourceManager";

const makeVideos = (count) =>
  Array.from({ length: count }, (_, index) => ({ id: String(index + 1) }));

const flushAsync = async (times = 2) => {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const makeReady = (manager, id, options = { assumeVisible: true }) => {
  const lease = manager.reserveLoadSlot(id, options);
  if (!lease) return null;
  return manager.finishLoadSlot(lease, { ready: true });
};

beforeEach(() => {
  global.window = global.window || {};
  window.appMem = {
    get: vi.fn().mockResolvedValue({
      totals: { wsMB: 512, totalMB: 8192 },
      processes: [],
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useVideoResourceManager scheduler admission", () => {
  test("same-tick visible requests never exceed the exact loader cap", async () => {
    const progressiveVideos = makeVideos(80);
    const visible = new Set(progressiveVideos.map((video) => video.id));
    const { result } = renderHook(() =>
      useVideoResourceManager({
        progressiveVideos,
        visibleVideos: visible,
        loadedVideos: new Set(),
        loadingVideos: new Set(),
        playingVideos: new Set(),
        isNear: () => true,
      })
    );
    await flushAsync();

    const cap = result.current.limits.maxConcurrentLoading;
    const leases = progressiveVideos.map((video) =>
      result.current.reserveLoadSlot(video.id, { assumeVisible: true })
    );

    expect(leases.filter(Boolean)).toHaveLength(cap);
    expect(result.current.mediaScheduler.getSnapshot().loading).toBe(cap);
    expect(
      result.current.canLoadVideo("overflow", { assumeVisible: true })
    ).toBe(false);

    result.current.finishLoadSlot(leases[0], { ready: false });
    expect(
      result.current.reserveLoadSlot("replacement", { assumeVisible: true })
    ).toBeTruthy();
    expect(result.current.mediaScheduler.getSnapshot().loading).toBe(cap);
  });

  test("visibility changes priority but never bypasses an exhausted cap", async () => {
    const progressiveVideos = makeVideos(40);
    const { result } = renderHook(() =>
      useVideoResourceManager({
        progressiveVideos,
        visibleVideos: new Set(),
        loadedVideos: new Set(),
        loadingVideos: new Set(),
        playingVideos: new Set(),
        isNear: () => false,
      })
    );
    await flushAsync();

    const cap = result.current.limits.maxConcurrentLoading;
    const backgroundLimit = Math.floor(cap * 0.5);
    for (let index = 0; index < backgroundLimit; index += 1) {
      expect(
        result.current.reserveLoadSlot(`near-${index}`, { assumeNear: true })
      ).toBeTruthy();
    }

    expect(result.current.canLoadVideo("far")).toBe(false);
    expect(
      result.current.canLoadVideo("visible", { assumeVisible: true })
    ).toBe(true);

    for (let index = backgroundLimit; index < cap; index += 1) {
      result.current.reserveLoadSlot(`visible-${index}`, {
        assumeVisible: true,
      });
    }
    expect(
      result.current.reserveLoadSlot("strict-overflow", {
        assumeVisible: true,
      })
    ).toBeNull();
  });

  test("cleanup scores scheduler-owned residents and protects visible/playing ids", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const progressiveVideos = makeVideos(200);
    const visible = new Set(["1", "2", "3"]);
    const playing = new Set(["1"]);
    const loaded = new Set();
    const { result } = renderHook(() =>
      useVideoResourceManager({
        progressiveVideos,
        visibleVideos: visible,
        loadedVideos: loaded,
        loadingVideos: new Set(),
        playingVideos: playing,
        isNear: () => false,
      })
    );
    await flushAsync();

    const initialCap = result.current.limits.maxLoaded;
    for (let index = 1; index <= initialCap; index += 1) {
      const id = String(index);
      loaded.add(id);
      expect(makeReady(result.current, id)).toBeTruthy();
    }

    act(() => result.current.reportPlayerCreationFailure());
    await flushAsync();
    now += 600;

    const victims = result.current.performCleanup();
    expect(victims?.length).toBe(initialCap - result.current.limits.maxLoaded);
    expect(victims).not.toContain("1");
    expect(victims).not.toContain("2");
    expect(victims).not.toContain("3");
    expect(victims.every((id) => loaded.has(id))).toBe(true);
  });

  test("cleanup remains blocked during layout-owned eviction suspension", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const progressiveVideos = makeVideos(120);
    const props = {
      progressiveVideos,
      visibleVideos: new Set(["1"]),
      loadedVideos: new Set(),
      loadingVideos: new Set(),
      playingVideos: new Set(),
      isNear: () => false,
      suspendEvictions: true,
    };
    const { result, rerender } = renderHook(
      (current) => useVideoResourceManager(current),
      { initialProps: props }
    );
    await flushAsync();

    const initialCap = result.current.limits.maxLoaded;
    for (let index = 1; index <= initialCap; index += 1) {
      makeReady(result.current, String(index));
    }
    act(() => result.current.reportPlayerCreationFailure());
    await flushAsync();
    expect(result.current.performCleanup()).toBeUndefined();

    rerender({ ...props, suspendEvictions: false });
    await flushAsync();
    now += 600;
    expect(result.current.performCleanup()?.length).toBeGreaterThan(0);
  });
});

describe("reportPlayerCreationFailure", () => {
  test("halves configured limits and blocks new resident reservations", async () => {
    const progressiveVideos = makeVideos(200);
    const { result } = renderHook(() =>
      useVideoResourceManager({
        progressiveVideos,
        visibleVideos: new Set(),
        loadedVideos: new Set(),
        loadingVideos: new Set(),
        playingVideos: new Set(),
        isNear: () => false,
      })
    );
    await flushAsync();

    const before = result.current.limits;
    for (let index = 0; index < before.maxLoaded; index += 1) {
      expect(makeReady(result.current, `loaded-${index}`)).toBeTruthy();
    }

    act(() => result.current.reportPlayerCreationFailure());
    await flushAsync();

    expect(result.current.limits.maxLoaded).toBe(
      Math.floor(before.maxLoaded * 0.5)
    );
    expect(result.current.limits.maxConcurrentLoading).toBe(
      Math.max(2, Math.floor(before.maxConcurrentLoading * 0.5))
    );
    expect(
      result.current.reserveLoadSlot("extra", { assumeVisible: true })
    ).toBeNull();
  });
});

describe("work suspension", () => {
  test("stops memory polling and drives loader, resident, and decoder caps to zero", async () => {
    const progressiveVideos = makeVideos(20);
    const props = {
      progressiveVideos,
      visibleVideos: new Set(["1"]),
      loadedVideos: new Set(),
      loadingVideos: new Set(),
      playingVideos: new Set(),
      isNear: () => true,
      workSuspended: false,
      maxDecoders: 4,
    };
    const { result, rerender } = renderHook(
      (current) => useVideoResourceManager(current),
      { initialProps: props }
    );
    await flushAsync();
    expect(result.current.reserveLoadSlot("1", { assumeVisible: true })).toBeTruthy();

    rerender({ ...props, workSuspended: true });
    expect(result.current.limits).toMatchObject({
      maxLoaded: 0,
      maxConcurrentLoading: 0,
    });
    expect(result.current.reserveLoadSlot("2", { assumeVisible: true })).toBeNull();
    expect(result.current.mediaScheduler.getSnapshot().limits).toMatchObject({
      maxResident: 0,
      maxLoaders: 0,
      maxDecoders: 0,
      maxExternalDecoders: 0,
      maxAuxiliaryDecoders: 0,
    });
    expect(result.current.memoryStatus.pollingSuspended).toBe(true);
  });
});
