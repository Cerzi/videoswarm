import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  BoundedAsyncCache,
  BoundedLruCache,
} = require("../bounded-async-cache");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("BoundedLruCache", () => {
  it("evicts the least recently used entry at its exact bound", () => {
    const cache = new BoundedLruCache(2);
    cache.set("old", 1);
    cache.set("kept", 2);
    expect(cache.get("old")).toBe(1);

    cache.set("new", 3);

    expect(cache.size).toBe(2);
    expect(cache.has("old")).toBe(true);
    expect(cache.has("kept")).toBe(false);
    expect(cache.get("new")).toBe(3);
  });
});

describe("BoundedAsyncCache", () => {
  it("deduplicates active work and removes it after resolution", async () => {
    const deferred = createDeferred();
    const factory = vi.fn(() => deferred.promise);
    const cache = new BoundedAsyncCache({ maxEntries: 2, maxInFlight: 2 });

    const first = cache.getOrCreate("same", factory);
    const second = cache.getOrCreate("same", factory);
    expect(factory).not.toHaveBeenCalled();
    expect(cache.getSnapshot()).toMatchObject({ inFlight: 1 });

    deferred.resolve("value");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "value",
      "value",
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(cache.getSnapshot()).toMatchObject({
      entries: 1,
      inFlight: 0,
      totals: { deduplicated: 1, resolved: 1 },
    });
  });

  it("removes rejected work so a later request can retry", async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("recovered");
    const cache = new BoundedAsyncCache({ maxEntries: 2, maxInFlight: 2 });

    await expect(cache.getOrCreate("retry", factory)).rejects.toThrow(
      "temporary failure"
    );
    expect(cache.getSnapshot()).toMatchObject({ entries: 0, inFlight: 0 });
    await expect(cache.getOrCreate("retry", factory)).resolves.toBe(
      "recovered"
    );
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("invalidates unsettled generations without retaining their result", async () => {
    const deferred = createDeferred();
    const cache = new BoundedAsyncCache({ maxEntries: 2, maxInFlight: 2 });
    const factory = vi.fn(() => deferred.promise);
    const work = cache.getOrCreate("stale", factory);
    await Promise.resolve();
    expect(factory).toHaveBeenCalledOnce();

    cache.clear();
    expect(cache.getSnapshot()).toMatchObject({
      entries: 0,
      inFlight: 1,
      currentGenerationInFlight: 0,
    });
    deferred.resolve("old generation");
    await expect(work).resolves.toBe("old generation");
    expect(cache.getSnapshot()).toMatchObject({ entries: 0, inFlight: 0 });
  });

  it("does not start a scheduled factory after generation invalidation", async () => {
    const factory = vi.fn(async () => "must not run");
    const cache = new BoundedAsyncCache({ maxEntries: 2, maxInFlight: 1 });
    const work = cache.getOrCreate("superseded", factory);

    cache.clear();

    await expect(work).rejects.toMatchObject({
      name: "CacheInvalidatedError",
      code: "CACHE_INVALIDATED",
      generation: 0,
      currentGeneration: 1,
      disposed: false,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(cache.getSnapshot()).toMatchObject({
      entries: 0,
      inFlight: 0,
      currentGenerationInFlight: 0,
    });
  });

  it("does not start a scheduled factory after disposal", async () => {
    const factory = vi.fn(async () => "must not run");
    const cache = new BoundedAsyncCache({ maxEntries: 2, maxInFlight: 1 });
    const work = cache.getOrCreate("disposed", factory);

    cache.dispose();

    await expect(work).rejects.toMatchObject({
      name: "CacheInvalidatedError",
      code: "CACHE_INVALIDATED",
      disposed: true,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(cache.getSnapshot()).toMatchObject({
      disposed: true,
      inFlight: 0,
    });
  });

  it("rejects distinct work at capacity and admits it after settlement", async () => {
    const firstDeferred = createDeferred();
    const secondDeferred = createDeferred();
    const cache = new BoundedAsyncCache({ maxEntries: 4, maxInFlight: 1 });
    const first = cache.getOrCreate("first", () => firstDeferred.promise);

    await expect(
      cache.getOrCreate("second", () => secondDeferred.promise)
    ).rejects.toMatchObject({
      name: "CacheCapacityError",
      code: "CACHE_IN_FLIGHT_LIMIT",
      maxInFlight: 1,
      inFlight: 1,
    });
    expect(cache.getSnapshot()).toMatchObject({
      inFlight: 1,
      maxInFlight: 1,
      totals: { overflowed: 1 },
    });

    firstDeferred.resolve("first value");
    await first;
    const second = cache.getOrCreate("second", () => secondDeferred.promise);
    secondDeferred.resolve("second value");
    await expect(second).resolves.toBe("second value");
  });
});
