import { describe, expect, it } from "vitest";
import { createMediaSlotScheduler } from "./mediaSlotScheduler";

describe("mediaSlotScheduler", () => {
  it("atomically caps same-tick loader and future resident reservations", () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 3,
      maxLoaders: 2,
      maxDecoders: 2,
    });

    const leases = Array.from({ length: 20 }, (_, index) =>
      scheduler.reserveLoader(`video-${index}`)
    ).filter(Boolean);

    expect(leases).toHaveLength(2);
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 2,
      resident: 0,
      reservedResident: 2,
    });

    expect(scheduler.markLoaderReady(leases[0])).toBe(leases[0]);
    const third = scheduler.reserveLoader("video-20");
    expect(third).toBeTruthy();
    expect(scheduler.reserveLoader("video-21")).toBeNull();
    expect(scheduler.getSnapshot().reservedResident).toBe(3);
  });

  it("uses opaque scoped leases so stale releases cannot affect replacements", () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 2,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const first = scheduler.reserveLoader("same-id");
    expect(scheduler.failLoader(first)).toBe(true);

    const replacement = scheduler.reserveLoader("same-id");
    expect(replacement).not.toBe(first);
    expect(scheduler.failLoader(first)).toBe(false);
    expect(scheduler.getSnapshot().loading).toBe(1);

    scheduler.reset();
    const nextScope = scheduler.reserveLoader("same-id");
    expect(scheduler.markLoaderReady(replacement)).toBeNull();
    expect(scheduler.getSnapshot().loading).toBe(1);
    expect(nextScope.scope).not.toBe(replacement.scope);
  });

  it("keeps a resident lease after readiness and releases it idempotently", () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const media = scheduler.reserveLoader("ready");

    expect(scheduler.markLoaderReady(media)).toBe(media);
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 0,
      resident: 1,
      reservedResident: 1,
    });
    expect(scheduler.reserveLoader("blocked")).toBeNull();
    expect(scheduler.releaseMedia(media)).toBe(true);
    expect(scheduler.releaseMedia(media)).toBe(false);
    expect(scheduler.reserveLoader("unblocked")).toBeTruthy();
  });

  it("never replaces a resident before its owner acknowledges physical cleanup", () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const resident = scheduler.reserveLoader("same");
    scheduler.markLoaderReady(resident);

    expect(
      scheduler.reserveLoader("same", { replaceResident: true })
    ).toBeNull();
    expect(scheduler.releaseMedia(resident)).toBe(true);
    expect(scheduler.reserveLoader("same")).toBeTruthy();
  });

  it("caps decoder leases and waits for physical-stop acknowledgement before handoff", () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 4,
      maxLoaders: 4,
      maxDecoders: 2,
    });
    for (const id of ["a", "b", "c", "d"]) {
      const lease = scheduler.reserveLoader(id);
      scheduler.markLoaderReady(lease);
    }

    expect(scheduler.reconcileDecoders(["a", "b", "c", "d"])).toEqual(
      new Set(["a", "b"])
    );
    expect(scheduler.reserveDecoder("c")).toBeNull();

    expect(scheduler.reconcileDecoders(["d", "c", "b", "a"])).toEqual(
      new Set()
    );
    expect(scheduler.getSnapshot().decoders).toBe(2);
    expect(scheduler.getSnapshot().stoppingDecoders).toBe(2);

    const a = scheduler.getDecoderLease("a");
    const b = scheduler.getDecoderLease("b");
    expect(scheduler.acknowledgeDecoderStopped(a)).toBe(true);
    expect(scheduler.acknowledgeDecoderStopped(b)).toBe(true);
    expect(scheduler.reconcileDecoders(["d", "c", "b", "a"])).toEqual(
      new Set(["d", "c"])
    );
  });

  it("ties decoder ownership to the resident generation", () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const first = scheduler.reserveLoader("same");
    scheduler.markLoaderReady(first);
    const decoder = scheduler.reserveDecoder("same");

    expect(scheduler.releaseMedia(first)).toBe(true);
    expect(scheduler.releaseDecoder(decoder)).toBe(false);

    const second = scheduler.reserveLoader("same");
    scheduler.markLoaderReady(second);
    const nextDecoder = scheduler.reserveDecoder("same");
    expect(nextDecoder.ownerToken).toBe(second.token);
    expect(nextDecoder.ownerToken).not.toBe(decoder.ownerToken);
  });

  it("invalidates all work on scope reset", () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 3,
      maxLoaders: 3,
      maxDecoders: 3,
    });
    const a = scheduler.reserveLoader("a");
    const b = scheduler.reserveLoader("b");
    scheduler.markLoaderReady(a);
    scheduler.markLoaderReady(b);
    scheduler.reconcileDecoders(["a", "b"]);

    scheduler.reset();
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 0,
      resident: 0,
      decoders: 0,
      reservedResident: 0,
    });
    expect(scheduler.releaseMedia(b)).toBe(false);
  });

  it("bounds fullscreen decoders in a separate stale-safe lane", () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 1,
      maxLoaders: 1,
      maxDecoders: 0,
      maxExternalDecoders: 1,
    });

    const first = scheduler.reserveExternalDecoder("fullscreen-a");
    expect(first).toBeTruthy();
    expect(scheduler.reserveExternalDecoder("fullscreen-b")).toBeNull();
    expect(scheduler.getSnapshot()).toMatchObject({
      decoders: 0,
      externalDecoders: 1,
      totalDecoders: 1,
    });

    expect(scheduler.releaseDecoder(first)).toBe(true);
    const replacement = scheduler.reserveExternalDecoder("fullscreen-b");
    scheduler.reset();
    expect(scheduler.releaseDecoder(replacement)).toBe(false);
    expect(scheduler.getSnapshot().externalDecoders).toBe(0);
  });

  it("wakes queued loaders by priority and never invokes a cancelled waiter", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 3,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const first = scheduler.reserveLoader("first");
    const granted = [];
    const background = scheduler.queueLoader(
      "background",
      { priority: 1 },
      (lease) => granted.push(lease.id)
    );
    scheduler.queueLoader("visible", { priority: 2 }, (lease) => {
      granted.push(lease.id);
    });
    expect(scheduler.cancelQueuedLoader(background)).toBe(true);

    scheduler.markLoaderReady(first);
    await Promise.resolve();

    expect(granted).toEqual(["visible"]);
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 1,
      queuedLoading: 0,
      reservedResident: 2,
    });
  });

  it("blocks reload during native mutation and discards moved waiters", async () => {
    const scheduler = createMediaSlotScheduler({
      maxResident: 2,
      maxLoaders: 1,
      maxDecoders: 1,
    });
    const active = scheduler.reserveLoader("failed-trash");
    scheduler.blockIds(["failed-trash", "moved"]);
    scheduler.failLoader(active);

    const granted = [];
    scheduler.queueLoader("failed-trash", { priority: 2 }, (lease) => {
      granted.push(lease.id);
    });
    scheduler.queueLoader("moved", { priority: 2 }, (lease) => {
      granted.push(lease.id);
    });
    await Promise.resolve();
    expect(granted).toEqual([]);

    scheduler.discardIds(["moved"]);
    scheduler.unblockIds(["failed-trash", "moved"]);
    await Promise.resolve();

    expect(granted).toEqual(["failed-trash"]);
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 1,
      queuedLoading: 0,
    });
  });
});
