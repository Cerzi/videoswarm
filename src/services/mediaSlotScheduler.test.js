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

  it("caps decoder leases exactly and reconciles priority synchronously", () => {
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
      new Set(["d", "c"])
    );
    expect(scheduler.getSnapshot().decoders).toBe(2);
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

  it("prunes inactive ids and invalidates all work on scope reset", () => {
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

    scheduler.retainIds(["b"]);
    expect(scheduler.getSnapshot().residentIds).toEqual(new Set(["b"]));
    expect(scheduler.getSnapshot().decoderIds).toEqual(new Set(["b"]));

    scheduler.reset();
    expect(scheduler.getSnapshot()).toMatchObject({
      loading: 0,
      resident: 0,
      decoders: 0,
      reservedResident: 0,
    });
    expect(scheduler.releaseMedia(b)).toBe(false);
  });
});
