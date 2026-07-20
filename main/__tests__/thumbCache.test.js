import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { ThumbnailCache } = require("../thumb-cache");

const fsPromises = fs.promises;
const app = { getPath: () => "/unused" };

function imageApi({ width = 8, height = 8, corruptPrefix = null } = {}) {
  return {
    createFromBuffer(buffer) {
      const corrupt =
        corruptPrefix && buffer.subarray(0, corruptPrefix.length).equals(corruptPrefix);
      return {
        isEmpty: () => Boolean(corrupt),
        getSize: () => ({ width, height }),
      };
    },
  };
}

function payload(pathKey, signature, bytes = 6, fill = 1) {
  return {
    path: pathKey,
    signature,
    base64: Buffer.alloc(bytes, fill).toString("base64"),
  };
}

function createBlockingIo() {
  let writeBlocker = null;
  let readBlocker = null;
  let indexBlocker = null;
  let indexWrites = 0;
  return {
    io: {
      ...fsPromises,
      async writeFile(filePath, data, encoding) {
        if (/index\.json\..*\.tmp$/u.test(filePath)) {
          indexWrites += 1;
          if (indexBlocker && !indexBlocker.used) {
            indexBlocker.used = true;
            indexBlocker.markStarted();
            await indexBlocker.released;
          }
        }
        if (
          writeBlocker &&
          !writeBlocker.used &&
          /\.png\..*\.tmp$/u.test(filePath)
        ) {
          writeBlocker.used = true;
          writeBlocker.markStarted();
          await writeBlocker.released;
        }
        return fsPromises.writeFile(filePath, data, encoding);
      },
      async open(filePath, flags) {
        const handle = await fsPromises.open(filePath, flags);
        if (!readBlocker || readBlocker.used || !filePath.endsWith(".png")) {
          return handle;
        }
        const blocker = readBlocker;
        return {
          stat: (...args) => handle.stat(...args),
          async read(...args) {
            if (!blocker.used) {
              blocker.used = true;
              blocker.markStarted();
              await blocker.released;
            }
            return handle.read(...args);
          },
          close: (...args) => handle.close(...args),
        };
      },
    },
    blockNextThumbnailWrite() {
      let markStarted;
      let release;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      writeBlocker = { started, markStarted, released, release, used: false };
      return writeBlocker;
    },
    blockNextThumbnailRead() {
      let markStarted;
      let release;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      readBlocker = { started, markStarted, released, release, used: false };
      return readBlocker;
    },
    blockNextIndexWrite() {
      let markStarted;
      let release;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      indexBlocker = { started, markStarted, released, release, used: false };
      return indexBlocker;
    },
    getIndexWrites: () => indexWrites,
  };
}

describe("ThumbnailCache", () => {
  const tempRoots = [];

  async function profile(name = "profile") {
    const root = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "videoswarm-thumb-cache-")
    );
    tempRoots.push(root);
    return path.join(root, name);
  }

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(
      tempRoots.splice(0).map((root) =>
        fsPromises.rm(root, { recursive: true, force: true })
      )
    );
  });

  it("evicts memory and disk LRU entries by entry quotas", async () => {
    const root = await profile("count-profile");
    const cache = new ThumbnailCache({
      maxMemoryEntries: 2,
      maxMemoryBytes: 1024 * 1024,
      maxDiskEntries: 2,
      maxDiskBytes: 1024 * 1024,
      persistDebounceMs: 60_000,
    });
    await cache.init(app, root);
    await cache.put(imageApi(), payload("/a.mp4", "a"));
    await cache.put(imageApi(), payload("/b.mp4", "b"));
    await cache.put(imageApi(), payload("/c.mp4", "c"));
    expect(cache.getSnapshot()).toMatchObject({
      memory: { entries: 2, bytes: 512 },
      disk: { entries: 2, bytes: 12 },
    });
    await expect(cache.has("/a.mp4", "a", imageApi())).resolves.toEqual({
      ok: true,
      available: false,
    });
    await cache.shutdown();
  });

  it("keeps path accounting one-to-one when one signature is rebound many times", async () => {
    const root = await profile("signature-rebind");
    const cache = new ThumbnailCache({ persistDebounceMs: 60_000 });
    await cache.init(app, root);

    for (let index = 0; index < 100; index += 1) {
      await expect(
        cache.put(
          imageApi(),
          payload(`/folder-${index}/clip.mp4`, "shared-signature", 6, index)
        )
      ).resolves.toEqual({ ok: true });
    }
    expect(cache.getSnapshot()).toMatchObject({
      disk: { entries: 1, bytes: 6 },
      mappings: { paths: 1, signatures: 1 },
    });
    await expect(
      cache.has("/folder-0/clip.mp4", "shared-signature", imageApi())
    ).resolves.toEqual({ ok: true, available: false });
    await expect(
      cache.has("/folder-99/clip.mp4", "shared-signature", imageApi())
    ).resolves.toMatchObject({ ok: true, available: true });

    await cache.reset();
    await cache.init(app, root);
    expect(cache.getSnapshot()).toMatchObject({
      disk: { entries: 1, bytes: 6 },
      mappings: { paths: 1, signatures: 1 },
    });
    expect(cache.getForDrag(imageApi(), "/folder-99/clip.mp4")).toBeNull();
    await expect(
      cache.has("/folder-99/clip.mp4", "shared-signature", imageApi())
    ).resolves.toMatchObject({ ok: true, available: true });
    expect(cache.getForDrag(imageApi(), "/folder-99/clip.mp4")).toBeTruthy();

    await expect(
      cache.put(
        imageApi(),
        payload("/folder-99/clip.mp4", "replacement-signature", 6, 7)
      )
    ).resolves.toEqual({ ok: true });
    expect(cache.getSnapshot()).toMatchObject({
      disk: { entries: 1, bytes: 6 },
      mappings: { paths: 1, signatures: 1 },
    });
    const sharedHash = crypto
      .createHash("sha1")
      .update("shared-signature")
      .digest("hex");
    await expect(
      fsPromises.stat(path.join(root, "thumbs", `${sharedHash}.png`))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await cache.reset();
    await cache.init(app, root);
    expect(cache.getSnapshot().mappings).toEqual({ paths: 1, signatures: 1 });
    await cache.shutdown();
  });

  it("evicts memory and disk LRU entries by byte budgets", async () => {
    const root = await profile();
    let now = 1;
    const cache = new ThumbnailCache({
      maxMemoryEntries: 2,
      maxMemoryBytes: 300,
      maxDiskEntries: 2,
      maxDiskBytes: 10,
      persistDebounceMs: 60_000,
      clock: { now: () => now, setTimeout, clearTimeout },
    });
    await cache.init(app, root);

    await expect(cache.put(imageApi(), payload("/a.mp4", "a", 6, 1))).resolves
      .toMatchObject({ ok: true });
    now += 1;
    await expect(cache.put(imageApi(), payload("/b.mp4", "b", 6, 2))).resolves
      .toMatchObject({ ok: true });
    now += 1;
    await expect(cache.put(imageApi(), payload("/c.mp4", "c", 6, 3))).resolves
      .toMatchObject({ ok: true });

    const snapshot = cache.getSnapshot();
    expect(snapshot.memory).toEqual({ entries: 1, bytes: 256 });
    expect(snapshot.disk).toEqual({ entries: 1, bytes: 6 });
    expect(snapshot.limits).toMatchObject({
      maxMemoryEntries: 2,
      maxMemoryBytes: 300,
      maxDiskEntries: 2,
      maxDiskBytes: 10,
      maxPayloadBytes: 512 * 1024,
      maxImagePixels: 65_536,
      maxIndexBytes: 8 * 1024 * 1024,
      readConcurrency: 2,
      maxPendingReads: 64,
      writeConcurrency: 1,
      maxPendingWrites: 64,
    });
    await expect(cache.has("/a.mp4", "a", imageApi())).resolves.toEqual({
      ok: true,
      available: false,
    });
    expect(cache.getForDrag(imageApi(), "/c.mp4")).toBeTruthy();
    await cache.shutdown();
  });

  it("rejects oversized payloads and images before admitting disk work", async () => {
    const root = await profile();
    const cache = new ThumbnailCache({
      maxPayloadBytes: 16,
      maxImagePixels: 64,
    });
    await cache.init(app, root);

    await expect(
      cache.put(imageApi(), payload("/large.mp4", "large", 17))
    ).resolves.toEqual({ ok: false, error: "IMAGE_PAYLOAD_TOO_LARGE" });
    await expect(
      cache.put(imageApi({ width: 9, height: 8 }), payload("/wide.mp4", "wide"))
    ).resolves.toEqual({ ok: false, error: "IMAGE_DIMENSIONS_TOO_LARGE" });
    expect(cache.getSnapshot()).toMatchObject({
      disk: { entries: 0, bytes: 0 },
      writes: { active: 0, pending: 0 },
    });
    await cache.shutdown();
  });

  it("keeps the persisted index within its byte budget", async () => {
    const root = await profile("index-budget");
    const cache = new ThumbnailCache({
      maxIndexBytes: 180,
      persistDebounceMs: 60_000,
    });
    await cache.init(app, root);
    for (let index = 0; index < 5; index += 1) {
      await cache.put(
        imageApi(),
        payload(`/long-folder-name-${index}/clip.mp4`, `signature-${index}`)
      );
    }
    await cache.flush();
    const indexPath = path.join(root, "thumbs", "index.json");
    expect((await fsPromises.stat(indexPath)).size).toBeLessThanOrEqual(180);
    expect(cache.getSnapshot().disk.entries).toBeLessThan(5);
    await cache.shutdown();
  });

  it("coalesces slow index persistence to one active and one dirty flush", async () => {
    const root = await profile("coalesced-index");
    const blocking = createBlockingIo();
    const cache = new ThumbnailCache({
      io: blocking.io,
      persistDebounceMs: 60_000,
    });
    await cache.init(app, root);
    await cache.put(imageApi(), payload("/clip.mp4", "clip"));

    const gate = blocking.blockNextIndexWrite();
    const flushing = cache.flush();
    await gate.started;
    for (let index = 0; index < 100; index += 1) {
      expect(cache.getForDrag(imageApi(), "/clip.mp4")).toBeTruthy();
    }
    expect(blocking.getIndexWrites()).toBe(1);
    expect(cache.getSnapshot().persistence).toEqual({
      scheduled: false,
      inFlight: true,
      dirty: true,
      attempts: 0,
      exhausted: false,
    });

    gate.release();
    await flushing;
    expect(blocking.getIndexWrites()).toBe(1);
    expect(cache.getSnapshot().persistence).toMatchObject({
      scheduled: true,
      inFlight: false,
      dirty: true,
    });
    await cache.flush();
    expect(blocking.getIndexWrites()).toBe(2);
    expect(cache.getSnapshot().persistence).toEqual({
      scheduled: false,
      inFlight: false,
      dirty: false,
      attempts: 0,
      exhausted: false,
    });
    await cache.shutdown();
  });

  it("bounds persistence retries and rearms only on explicit flush or mutation", async () => {
    vi.useFakeTimers();
    const root = await profile("failed-index");
    let indexWrites = 0;
    const io = {
      ...fsPromises,
      async writeFile(filePath, data, encoding) {
        if (/index\.json\..*\.tmp$/u.test(filePath)) {
          indexWrites += 1;
          const error = new Error("permanent index failure");
          error.code = "EIO";
          throw error;
        }
        return fsPromises.writeFile(filePath, data, encoding);
      },
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new ThumbnailCache({
      io,
      persistDebounceMs: 10,
      maxPersistRetries: 3,
      persistRetryBaseMs: 20,
      persistRetryMaxMs: 50,
      clock: { now: () => Date.now(), setTimeout, clearTimeout },
    });
    await cache.init(app, root);
    await cache.put(imageApi(), payload("/clip.mp4", "clip"));

    const waitForPersistence = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!cache.getSnapshot().persistence.inFlight) return;
        await fsPromises.stat(root);
        await Promise.resolve();
      }
      throw new Error("Thumbnail persistence did not settle");
    };

    await cache.flush();
    expect(cache.getSnapshot().persistence).toMatchObject({
      attempts: 1,
      scheduled: true,
      exhausted: false,
    });
    for (const [index, delay] of [20, 40, 50].entries()) {
      expect(cache.getForDrag(imageApi(), "/clip.mp4")).toBeTruthy();
      await cache.put(
        imageApi(),
        payload(`/mutation-${index}.mp4`, `mutation-${index}`)
      );
      await vi.advanceTimersByTimeAsync(delay);
      await waitForPersistence();
    }
    expect(indexWrites).toBe(4);
    expect(cache.getSnapshot().persistence).toEqual({
      scheduled: false,
      inFlight: false,
      dirty: true,
      attempts: 4,
      exhausted: true,
    });

    expect(cache.getForDrag(imageApi(), "/clip.mp4")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(indexWrites).toBe(4);
    expect(cache.getSnapshot().persistence.exhausted).toBe(true);

    await cache.put(imageApi(), payload("/rearm.mp4", "rearm"));
    expect(cache.getSnapshot().persistence).toMatchObject({
      attempts: 0,
      scheduled: true,
      exhausted: false,
    });
    await cache.flush();
    expect(indexWrites).toBe(5);
    expect(cache.getSnapshot().persistence).toMatchObject({
      attempts: 1,
      scheduled: true,
      exhausted: false,
    });
    await cache.shutdown();
    expect(cache.getSnapshot().persistence).toEqual({
      scheduled: false,
      inFlight: false,
      dirty: false,
      attempts: 0,
      exhausted: false,
    });
  });

  it("ignores a corrupt index and evicts corrupt cached image files while warming", async () => {
    const root = await profile();
    const thumbs = path.join(root, "thumbs");
    await fsPromises.mkdir(thumbs, { recursive: true });
    await fsPromises.writeFile(path.join(thumbs, "index.json"), "{broken");

    const corruptIndexCache = new ThumbnailCache({ persistDebounceMs: 60_000 });
    await corruptIndexCache.init(app, root);
    expect(corruptIndexCache.getSnapshot().disk).toEqual({ entries: 0, bytes: 0 });
    await corruptIndexCache.shutdown();

    const signature = "corrupt-signature";
    const hash = crypto.createHash("sha1").update(signature).digest("hex");
    const corruptBytes = Buffer.from("bad-image");
    await fsPromises.writeFile(path.join(thumbs, `${hash}.png`), corruptBytes);
    await fsPromises.writeFile(
      path.join(thumbs, "index.json"),
      JSON.stringify({
        version: 2,
        entries: {
          "/corrupt.mp4": {
            signature,
            hash,
            size: corruptBytes.length,
            lastUsed: 1,
          },
        },
      })
    );

    const cache = new ThumbnailCache({ persistDebounceMs: 60_000 });
    await cache.init(app, root);
    expect(cache.getSnapshot().disk.entries).toBe(1);
    await expect(
      cache.has("/corrupt.mp4", signature, imageApi({ corruptPrefix: Buffer.from("bad") }))
    ).resolves.toEqual({ ok: true, available: false });
    expect(cache.getSnapshot()).toMatchObject({
      disk: { entries: 0, bytes: 0 },
      memory: { entries: 0, bytes: 0 },
    });
    await expect(fsPromises.stat(path.join(thumbs, `${hash}.png`))).rejects
      .toMatchObject({ code: "ENOENT" });
    await cache.shutdown();
  });

  it("reconciles orphan/temp files and rejects oversized disk entries without reading them", async () => {
    const root = await profile("reconcile");
    const thumbs = path.join(root, "thumbs");
    await fsPromises.mkdir(thumbs, { recursive: true });
    const signature = "oversized";
    const hash = crypto.createHash("sha1").update(signature).digest("hex");
    const oversizedPath = path.join(thumbs, `${hash}.png`);
    const orphanPath = path.join(thumbs, "orphan.png");
    const temporaryPath = path.join(thumbs, "index.json.123.tmp");
    await fsPromises.writeFile(oversizedPath, Buffer.alloc(17));
    await fsPromises.writeFile(orphanPath, Buffer.from("orphan"));
    await fsPromises.writeFile(temporaryPath, Buffer.from("temporary"));
    await fsPromises.writeFile(
      path.join(thumbs, "index.json"),
      JSON.stringify({
        version: 2,
        entries: {
          "/oversized.mp4": {
            signature,
            hash,
            size: 17,
            lastUsed: 1,
          },
        },
      })
    );

    const cache = new ThumbnailCache({
      maxPayloadBytes: 16,
      persistDebounceMs: 60_000,
    });
    await cache.init(app, root);
    expect(cache.getSnapshot().disk).toEqual({ entries: 0, bytes: 0 });
    await Promise.all(
      [oversizedPath, orphanPath, temporaryPath].map((filePath) =>
        expect(fsPromises.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" })
      )
    );
    await cache.shutdown();
  });

  it("stops stale reconciliation before it can delete files from a newer same-root generation", async () => {
    const root = await profile("reconcile-generation");
    const thumbs = path.join(root, "thumbs");
    await fsPromises.mkdir(thumbs, { recursive: true });
    await fsPromises.writeFile(
      path.join(thumbs, "index.json"),
      JSON.stringify({ version: 2, entries: {} })
    );

    let reachedReconcile;
    let releaseReconcile;
    const reconcileReached = new Promise((resolve) => {
      reachedReconcile = resolve;
    });
    const reconcileReleased = new Promise((resolve) => {
      releaseReconcile = resolve;
    });
    let opendirCalls = 0;
    const io = {
      ...fsPromises,
      async opendir(directoryPath) {
        const directory = await fsPromises.opendir(directoryPath);
        opendirCalls += 1;
        if (opendirCalls !== 1) return directory;
        return {
          async *[Symbol.asyncIterator]() {
            reachedReconcile();
            await reconcileReleased;
            for await (const entry of directory) yield entry;
          },
        };
      },
    };
    const cache = new ThumbnailCache({ io, persistDebounceMs: 60_000 });
    const staleInit = cache.init(app, root);
    await reconcileReached;
    await cache.reset();

    const signature = "new-generation";
    const hash = crypto.createHash("sha1").update(signature).digest("hex");
    const imagePath = path.join(thumbs, `${hash}.png`);
    await fsPromises.writeFile(imagePath, Buffer.alloc(6, 9));
    await fsPromises.writeFile(
      path.join(thumbs, "index.json"),
      JSON.stringify({
        version: 2,
        entries: {
          "/new.mp4": { signature, hash, size: 6, lastUsed: 1 },
        },
      })
    );
    await cache.init(app, root);
    releaseReconcile();
    await expect(staleInit).rejects.toMatchObject({ code: "CACHE_INVALIDATED" });
    await expect(fsPromises.stat(imagePath)).resolves.toMatchObject({ size: 6 });
    expect(cache.getSnapshot().disk).toEqual({ entries: 1, bytes: 6 });
    await cache.shutdown();
  });

  it("bounds read admission, settles owner cancellation, and warms drag memory after restart", async () => {
    const root = await profile("read-queue");
    const blocking = createBlockingIo();
    const cache = new ThumbnailCache({
      io: blocking.io,
      readConcurrency: 1,
      maxPendingReads: 1,
      persistDebounceMs: 60_000,
    });
    await cache.init(app, root);
    await cache.put(imageApi(), payload("/a.mp4", "a", 6, 1));
    await cache.put(imageApi(), payload("/b.mp4", "b", 6, 2));
    await cache.put(imageApi(), payload("/c.mp4", "c", 6, 3));
    await cache.reset();
    await cache.init(app, root);
    expect(cache.getForDrag(imageApi(), "/a.mp4")).toBeNull();

    const gate = blocking.blockNextThumbnailRead();
    const active = cache.has("/a.mp4", "a", imageApi(), {
      ownerId: "renderer-a",
    });
    await gate.started;
    const pending = cache.has("/b.mp4", "b", imageApi(), {
      ownerId: "renderer-a",
    });
    await expect(
      cache.has("/c.mp4", "c", imageApi(), { ownerId: "renderer-b" })
    ).resolves.toEqual({ ok: false, error: "READ_QUEUE_FULL" });

    expect(cache.cancelOwner("renderer-a")).toBe(2);
    gate.release();
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "OWNER_CANCELLED",
    });
    await expect(active).resolves.toEqual({
      ok: false,
      error: "OWNER_CANCELLED",
    });
    expect(cache.getSnapshot()).toMatchObject({
      reads: { active: 0, pending: 0, inFlight: 0 },
      owners: { active: 0, operations: 0 },
    });

    await expect(
      cache.has("/a.mp4", "a", imageApi(), { ownerId: "renderer-b" })
    ).resolves.toEqual({ ok: true, available: true, signature: "a" });
    expect(cache.getForDrag(imageApi(), "/a.mp4")).toBeTruthy();
    await cache.shutdown();
  });

  it("settles overflow and repeatedly prevents old-profile writes from repopulating", async () => {
    const root = await profile("profiles");
    const blocking = createBlockingIo();
    const cache = new ThumbnailCache({
      io: blocking.io,
      writeConcurrency: 1,
      maxPendingWrites: 1,
      persistDebounceMs: 60_000,
    });
    let currentProfile = path.join(root, "profile-0");
    await cache.init(app, currentProfile);

    for (let index = 0; index < 3; index += 1) {
      const gate = blocking.blockNextThumbnailWrite();
      const stale = cache.put(
        imageApi(),
        payload(`/stale-${index}.mp4`, `stale-${index}`),
        { ownerId: "renderer-a" }
      );
      await gate.started;

      let queued = null;
      if (index === 0) {
        queued = cache.put(
          imageApi(),
          payload("/queued.mp4", "queued"),
          { ownerId: "renderer-a" }
        );
        await expect(
          cache.put(imageApi(), payload("/overflow.mp4", "overflow"))
        ).resolves.toEqual({ ok: false, error: "WRITE_QUEUE_FULL" });
      }

      const nextProfile = path.join(root, `profile-${index + 1}`);
      const switched = cache.reset().then(() => cache.init(app, nextProfile));
      gate.release();
      await expect(stale).resolves.toEqual({
        ok: false,
        error: "CACHE_INVALIDATED",
      });
      if (queued) {
        await expect(queued).resolves.toEqual({
          ok: false,
          error: "CACHE_INVALIDATED",
        });
      }
      await switched;
      currentProfile = nextProfile;
      expect(cache.getSnapshot()).toMatchObject({
        memory: { entries: 0, bytes: 0 },
        disk: { entries: 0, bytes: 0 },
        reads: { active: 0, pending: 0 },
        writes: { active: 0, pending: 0 },
        owners: { active: 0, operations: 0 },
      });
    }

    await expect(
      cache.put(imageApi(), payload("/fresh.mp4", "fresh"), {
        ownerId: "renderer-b",
      })
    ).resolves.toEqual({ ok: true });
    expect(cache.getSnapshot()).toMatchObject({
      memory: { entries: 1, bytes: 256 },
      disk: { entries: 1, bytes: 6 },
    });
    expect(cache.getForDrag(imageApi(), "/fresh.mp4")).toBeTruthy();
    expect(currentProfile).toMatch(/profile-3$/u);
    await cache.shutdown();
  });

  it("cancels renderer-owned queued writes and prevents the active write from committing", async () => {
    const root = await profile();
    const blocking = createBlockingIo();
    const cache = new ThumbnailCache({
      io: blocking.io,
      writeConcurrency: 1,
      maxPendingWrites: 2,
      persistDebounceMs: 60_000,
    });
    await cache.init(app, root);
    const gate = blocking.blockNextThumbnailWrite();
    const active = cache.put(imageApi(), payload("/same.mp4", "same", 6, 1), {
      ownerId: "renderer-a",
    });
    await gate.started;
    const pending = cache.put(imageApi(), payload("/pending.mp4", "pending"), {
      ownerId: "renderer-a",
    });
    const replacement = cache.put(
      imageApi(),
      payload("/same.mp4", "same", 6, 2),
      { ownerId: "renderer-b" }
    );

    expect(cache.cancelOwner("renderer-a")).toBe(2);
    gate.release();
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "OWNER_CANCELLED",
    });
    await expect(active).resolves.toEqual({
      ok: false,
      error: "OWNER_CANCELLED",
    });
    await expect(replacement).resolves.toEqual({ ok: true });
    expect(cache.getSnapshot()).toMatchObject({
      memory: { entries: 1, bytes: 256 },
      disk: { entries: 1, bytes: 6 },
      writes: { active: 0, pending: 0 },
      owners: { active: 0, operations: 0 },
    });
    expect(cache.getForDrag(imageApi(), "/same.mp4")).toBeTruthy();
    await cache.shutdown();
  });

  it("cannot be reinitialized after permanent shutdown", async () => {
    const root = await profile("shutdown");
    const cache = new ThumbnailCache();
    await cache.init(app, root);
    await cache.shutdown();
    expect(cache.getSnapshot()).toMatchObject({
      closed: true,
      initialized: false,
    });
    await expect(cache.init(app, root)).rejects.toMatchObject({
      code: "CACHE_SHUTDOWN",
    });
  });
});
