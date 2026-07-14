import { afterEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  createDirectoryAggregateBatcher,
} = require("../directory-aggregate-batcher");

function root(name) {
  return path.join(os.tmpdir(), "videoswarm-aggregate-tests", name);
}

function createManualClock() {
  let currentTime = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => currentTime,
    setTimeout: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, dueAt: currentTime + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async advance(milliseconds) {
      currentTime += milliseconds;
      while (true) {
        const ready = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= currentTime)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (!ready) break;
        timers.delete(ready[0]);
        await ready[1].callback();
      }
    },
    count: () => timers.size,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function activeBatcher(options = {}) {
  const active = { profileId: "default", generation: 1 };
  const batcher = createDirectoryAggregateBatcher(options);
  batcher.activate(active);
  return { active, batcher };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("directory aggregate refresh batching", () => {
  it("coalesces a watcher burst into one refresh after the debounce", async () => {
    const clock = createManualClock();
    const refresh = vi.fn();
    const { batcher } = activeBatcher({ refresh, clock });

    for (let index = 0; index < 1000; index += 1) {
      expect(batcher.markDirty({ rootPath: root("one") })).toBe(true);
    }
    expect(batcher.snapshot()).toMatchObject({
      dirtyRoots: 1,
      scheduledRoots: 1,
      totals: { marked: 1000, coalesced: 999 },
    });
    await clock.advance(149);
    expect(refresh).not.toHaveBeenCalled();
    await clock.advance(1);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: path.resolve(root("one")),
        profileId: "default",
        generation: 1,
        assertActive: expect.any(Function),
      })
    );
    expect(batcher.snapshot()).toMatchObject({
      dirtyRoots: 0,
      totals: { refreshesStarted: 1, refreshesCompleted: 1 },
    });
    await batcher.dispose();
  });

  it("refreshes by the maximum wait while marks keep resetting debounce", async () => {
    const clock = createManualClock();
    const refresh = vi.fn();
    const { batcher } = activeBatcher({
      refresh,
      clock,
      debounceMs: 150,
      maxWaitMs: 1000,
    });

    batcher.markDirty({ rootPath: root("one") });
    for (let elapsed = 100; elapsed <= 900; elapsed += 100) {
      await clock.advance(100);
      batcher.markDirty({ rootPath: root("one") });
    }
    await clock.advance(99);
    expect(refresh).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await batcher.dispose();
  });

  it("serializes refresh operations across different roots", async () => {
    let activeRefreshes = 0;
    let maximumActive = 0;
    const order = [];
    const refresh = vi.fn(async ({ rootPath }) => {
      activeRefreshes += 1;
      maximumActive = Math.max(maximumActive, activeRefreshes);
      order.push(path.basename(rootPath));
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRefreshes -= 1;
    });
    const { batcher } = activeBatcher({ refresh });
    batcher.markDirty({ rootPath: root("a") });
    batcher.markDirty({ rootPath: root("b") });
    batcher.markDirty({ rootPath: root("c") });

    const results = await batcher.flushAll();
    expect(results).toHaveLength(3);
    expect(order).toEqual(["a", "b", "c"]);
    expect(maximumActive).toBe(1);
    expect(batcher.snapshot()).toMatchObject({
      dirtyRoots: 0,
      queuedOperations: 0,
    });
    await batcher.dispose();
  });

  it("flushes one root immediately without disturbing another root's timer", async () => {
    const clock = createManualClock();
    const refresh = vi.fn();
    const { batcher } = activeBatcher({ refresh, clock });
    batcher.markDirty({ rootPath: root("a") });
    batcher.markDirty({ rootPath: root("b") });

    await expect(batcher.flushRoot(root("a"))).resolves.toMatchObject({
      refreshed: true,
      rootPath: path.resolve(root("a")),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(batcher.snapshot()).toMatchObject({ dirtyRoots: 1, scheduledRoots: 1 });
    await clock.advance(150);
    expect(refresh).toHaveBeenCalledTimes(2);
    await batcher.dispose();
  });

  it("drains a root changed in flight before an explicit flush resolves", async () => {
    const clock = createManualClock();
    const first = deferred();
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const { batcher } = activeBatcher({ refresh, clock });
    batcher.markDirty({ rootPath: root("one") });
    const flushing = batcher.flushRoot(root("one"));
    await Promise.resolve();
    batcher.markDirty({ rootPath: root("one") });
    first.resolve();
    await flushing;

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(batcher.snapshot()).toMatchObject({
      dirtyRoots: 0,
      scheduledRoots: 0,
      totals: { refreshesCompleted: 2 },
    });
    await batcher.dispose();
  });

  it("cancels stale scheduled generations and rejects stale marks", async () => {
    const clock = createManualClock();
    const refresh = vi.fn();
    const { batcher } = activeBatcher({ refresh, clock });
    batcher.markDirty({
      rootPath: root("one"),
      profileId: "default",
      generation: 1,
    });

    expect(batcher.activate({ profileId: "default", generation: 2 })).toBe(1);
    expect(
      batcher.markDirty({
        rootPath: root("stale"),
        profileId: "default",
        generation: 1,
      })
    ).toBe(false);
    await clock.advance(1000);
    expect(refresh).not.toHaveBeenCalled();

    batcher.markDirty({ rootPath: root("current") });
    await clock.advance(150);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2 })
    );
    expect(batcher.snapshot().totals.staleCancelled).toBeGreaterThanOrEqual(2);
    await batcher.dispose();
  });

  it("provides cooperative stale cancellation to an in-flight refresh", async () => {
    const started = deferred();
    const resume = deferred();
    const refresh = vi.fn(async ({ assertActive }) => {
      started.resolve();
      await resume.promise;
      assertActive();
    });
    const { batcher } = activeBatcher({ refresh });
    batcher.markDirty({ rootPath: root("one") });
    const flushing = batcher.flushRoot(root("one"));
    await started.promise;

    batcher.activate({ profileId: "other", generation: 1 });
    resume.resolve();
    await expect(flushing).resolves.toMatchObject({
      refreshed: false,
      stale: true,
    });
    expect(batcher.snapshot()).toMatchObject({ dirtyRoots: 0 });
    await batcher.dispose();
  });

  it("also honors an external context validity check", async () => {
    let valid = true;
    const clock = createManualClock();
    const refresh = vi.fn();
    const { batcher } = activeBatcher({
      refresh,
      clock,
      isContextActive: () => valid,
    });
    batcher.markDirty({ rootPath: root("one") });
    valid = false;
    await clock.advance(150);

    expect(refresh).not.toHaveBeenCalled();
    expect(batcher.snapshot()).toMatchObject({ dirtyRoots: 0 });
    await batcher.dispose({ flush: false });
  });

  it("enforces a hard bound on retained dirty roots", async () => {
    const clock = createManualClock();
    const { batcher } = activeBatcher({
      refresh: vi.fn(),
      clock,
      maxDirtyRoots: 2,
    });
    batcher.markDirty({ rootPath: root("a") });
    batcher.markDirty({ rootPath: root("b") });
    expect(() => batcher.markDirty({ rootPath: root("c") })).toThrow(
      expect.objectContaining({ code: "DIRECTORY_AGGREGATE_ROOT_LIMIT" })
    );
    expect(batcher.snapshot()).toMatchObject({
      dirtyRoots: 2,
      totals: { overflowRejected: 1 },
    });
    await batcher.dispose();
  });

  it("surfaces an explicit flush failure and retries a deferred failure", async () => {
    const clock = createManualClock();
    const error = new Error("database busy");
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce("recovered");
    const { batcher } = activeBatcher({
      refresh,
      clock,
      retryBaseMs: 250,
      maxRetries: 2,
    });
    batcher.markDirty({ rootPath: root("one") });

    await expect(batcher.flushRoot(root("one"))).rejects.toThrow("database busy");
    expect(batcher.snapshot()).toMatchObject({ dirtyRoots: 1, scheduledRoots: 1 });
    await clock.advance(249);
    expect(refresh).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(batcher.snapshot()).toMatchObject({
      dirtyRoots: 0,
      totals: { refreshesFailed: 1, refreshesCompleted: 1 },
    });
    await batcher.dispose();
  });

  it("stops after the retry bound and rearms only on later activity", async () => {
    const clock = createManualClock();
    const refresh = vi.fn(async () => {
      throw new Error("persistent database failure");
    });
    const { batcher } = activeBatcher({
      refresh,
      clock,
      debounceMs: 10,
      retryBaseMs: 20,
      maxRetries: 2,
    });
    batcher.markDirty({ rootPath: root("persistent") });

    await clock.advance(10);
    await clock.advance(20);
    await clock.advance(40);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(batcher.snapshot()).toMatchObject({
      dirtyRoots: 1,
      scheduledRoots: 0,
      totals: { refreshesFailed: 3 },
    });

    await clock.advance(10_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    batcher.markDirty({ rootPath: root("persistent") });
    await clock.advance(10);
    expect(refresh).toHaveBeenCalledTimes(4);
    await batcher.dispose({ flush: false });
  });

  it("rearms a new dirty version that arrives during the final failed attempt", async () => {
    const clock = createManualClock();
    const first = deferred();
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce("new-version");
    const { batcher } = activeBatcher({
      refresh,
      clock,
      debounceMs: 25,
      maxRetries: 0,
      logger: { error: vi.fn() },
    });
    batcher.markDirty({ rootPath: root("in-flight-final") });
    const failedFlush = batcher
      .flushRoot(root("in-flight-final"))
      .catch((error) => error);
    await Promise.resolve();
    batcher.markDirty({ rootPath: root("in-flight-final") });
    first.reject(new Error("first version failed"));

    await expect(failedFlush).resolves.toMatchObject({
      message: "first version failed",
    });
    expect(batcher.snapshot()).toMatchObject({
      dirtyRoots: 1,
      scheduledRoots: 1,
    });
    await clock.advance(25);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(batcher.snapshot().dirtyRoots).toBe(0);
    await batcher.dispose();
  });

  it("flushes on dispose by default and rejects later work", async () => {
    const clock = createManualClock();
    const refresh = vi.fn();
    const { batcher } = activeBatcher({ refresh, clock });
    batcher.markDirty({ rootPath: root("one") });

    await batcher.dispose();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(batcher.snapshot()).toMatchObject({
      accepting: false,
      disposed: true,
      activeOwnership: null,
      dirtyRoots: 0,
    });
    expect(() => batcher.markDirty({ rootPath: root("two") })).toThrow(
      expect.objectContaining({ code: "DIRECTORY_AGGREGATE_BATCHER_DISPOSED" })
    );
  });
});
