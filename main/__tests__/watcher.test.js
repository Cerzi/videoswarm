import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EventEmitter } from "events";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const chokidar = require("chokidar");
const { createFolderWatcher } = require("../watcher");

class FakeNativeWatcher extends EventEmitter {
  constructor() {
    super();
    this.close = vi.fn(async () => {});
    this.getWatched = vi.fn(() => ({}));
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe("folder watcher sessions", () => {
  let nativeWatchers;
  let watchSpy;
  let logger;

  beforeEach(() => {
    nativeWatchers = [];
    watchSpy = vi.spyOn(chokidar, "watch").mockImplementation(() => {
      const nativeWatcher = new FakeNativeWatcher();
      nativeWatchers.push(nativeWatcher);
      return nativeWatcher;
    });
    logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    watchSpy.mockRestore();
  });

  it("propagates context and event metadata for the active session", async () => {
    const context = { profileId: "profile-a", rootId: 42 };
    const createVideoFileObject = vi.fn(async (filePath) => ({
      id: filePath,
    }));
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
    });
    const added = vi.fn();
    const removed = vi.fn();
    watcher.on("added", added);
    watcher.on("removed", removed);

    const result = await watcher.start("/library", {
      recursive: false,
      context,
    });
    const nativeWatcher = nativeWatchers[0];
    nativeWatcher.emit("add", "/library/clip.mp4");
    await flushPromises();

    expect(result).toMatchObject({
      success: true,
      mode: "watch",
      recursive: false,
      sessionId: "watch-1",
    });
    expect(createVideoFileObject).toHaveBeenCalledWith(
      "/library/clip.mp4",
      "/library",
      expect.objectContaining({
        profileId: "profile-a",
        rootId: 42,
        assertActive: expect.any(Function),
      })
    );
    expect(() => createVideoFileObject.mock.calls[0][2].assertActive()).not.toThrow();
    expect(added).toHaveBeenCalledWith(
      { id: "/library/clip.mp4" },
      {
        folderPath: "/library",
        sessionId: "watch-1",
        context,
      }
    );

    nativeWatcher.emit("unlink", "/library/clip.mp4");
    expect(removed).toHaveBeenCalledWith(
      "/library/clip.mp4",
      {
        folderPath: "/library",
        sessionId: "watch-1",
        context,
      }
    );

    await watcher.stop();
  });

  it("defers per-file counts and marks the owning root dirty for native events", async () => {
    const onDirectoryAggregatesDirty = vi.fn();
    const createVideoFileObject = vi.fn(async (filePath) => ({ id: filePath }));
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      onDirectoryAggregatesDirty,
      logger,
    });
    const context = { profileId: "profile-a", generation: 7 };
    await watcher.start("/library", { context });

    nativeWatchers[0].emit("add", "/library/added.mp4");
    await flushPromises();
    nativeWatchers[0].emit("unlink", "/library/removed.mp4");

    expect(createVideoFileObject).toHaveBeenCalledWith(
      "/library/added.mp4",
      "/library",
      expect.objectContaining({ refreshDirectoryCounts: false })
    );
    expect(onDirectoryAggregatesDirty).toHaveBeenCalledTimes(2);
    expect(onDirectoryAggregatesDirty).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        rootPath: "/library",
        profileId: "profile-a",
        generation: 7,
        assertActive: expect.any(Function),
      })
    );

    await watcher.stop();
  });

  it("captures the pre-ready baseline and replays only initialization deltas", async () => {
    const createVideoFileObject = vi.fn(async (filePath) => ({ id: filePath }));
    const onDirectoryAggregatesDirty = vi.fn();
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      onDirectoryAggregatesDirty,
      logger,
    });
    const added = vi.fn();
    const changed = vi.fn();
    const removed = vi.fn();
    watcher.on("added", added);
    watcher.on("changed", changed);
    watcher.on("removed", removed);

    const result = await watcher.start("/library", {
      context: { scanId: "scan-1" },
      bufferInitialEvents: true,
    });
    const nativeWatcher = nativeWatchers[0];
    expect(chokidar.watch).toHaveBeenCalledWith(
      "/library",
      expect.objectContaining({ ignoreInitial: false, alwaysStat: true })
    );

    nativeWatcher.emit("add", "/library/unchanged.mp4", {
      size: 10,
      mtimeMs: 100,
    });
    const release = watcher.releaseInitialization(result.sessionId, [
      {
        filePath: "/library/unchanged.mp4",
        stats: { size: 10, mtimeMs: 100 },
      },
      {
        filePath: "/library/changed.mp4",
        stats: { size: 20, mtimeMs: 100 },
      },
      {
        filePath: "/library/removed.mp4",
        stats: { size: 30, mtimeMs: 100 },
      },
    ]);

    // This mutation arrives after release was requested but before chokidar's
    // initial attachment completed. It must still belong to the init generation.
    nativeWatcher.emit("change", "/library/changed.mp4", {
      size: 21,
      mtimeMs: 200,
    });
    nativeWatcher.emit("add", "/library/new.mp4", {
      size: 40,
      mtimeMs: 200,
    });
    nativeWatcher.emit("unlink", "/library/removed.mp4");
    nativeWatcher.emit("ready");

    await expect(release).resolves.toMatchObject({
      success: true,
      buffered: 4,
      replayed: 2,
      removed: 1,
    });
    await flushPromises();

    expect(createVideoFileObject.mock.calls.map((call) => call[0]).sort()).toEqual([
      path.resolve("/library/changed.mp4"),
      path.resolve("/library/new.mp4"),
    ]);
    expect(onDirectoryAggregatesDirty).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledWith(
      { id: path.resolve("/library/changed.mp4") },
      expect.objectContaining({ sessionId: result.sessionId })
    );
    expect(added).toHaveBeenCalledWith(
      { id: path.resolve("/library/new.mp4") },
      expect.objectContaining({ sessionId: result.sessionId })
    );
    expect(removed).toHaveBeenCalledWith(
      path.resolve("/library/removed.mp4"),
      expect.objectContaining({ sessionId: result.sessionId })
    );
    expect(watcher.getSnapshot()).toMatchObject({
      initializing: false,
      bufferedInitializationEvents: 0,
    });
    await watcher.stop();
  });

  it("seeds overflow reconciliation from the authoritative scan baseline", async () => {
    const scanFolderForChanges = vi.fn(async (_folderPath, options) => {
      expect(options.pollingState).toMatchObject({ initialized: true });
      expect([...options.pollingState.lastFiles.keys()].sort()).toEqual([
        path.resolve("/library/one.mp4"),
        path.resolve("/library/two.mp4"),
      ]);
    });
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject: vi.fn(),
      scanFolderForChanges,
      logger,
      maxInitializationEvents: 1,
    });

    const result = await watcher.start("/library", {
      bufferInitialEvents: true,
    });
    nativeWatchers[0].emit("add", "/library/one.mp4", {
      size: 1,
      mtimeMs: 1,
    });
    nativeWatchers[0].emit("add", "/library/two.mp4", {
      size: 2,
      mtimeMs: 2,
    });
    nativeWatchers[0].emit("ready");

    await expect(
      watcher.releaseInitialization(result.sessionId, [
        { filePath: "/library/one.mp4", stats: { size: 1, mtimeMs: 1 } },
        { filePath: "/library/two.mp4", stats: { size: 2, mtimeMs: 2 } },
      ])
    ).resolves.toMatchObject({
      success: true,
      overflowed: true,
      fullReconciliation: true,
    });
    expect(scanFolderForChanges).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it("detects an enumerated file deleted before chokidar attached its subtree", async () => {
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject: vi.fn(),
      scanFolderForChanges: vi.fn(),
      logger,
    });
    const removed = vi.fn();
    watcher.on("removed", removed);
    const result = await watcher.start("/library", {
      bufferInitialEvents: true,
    });

    // Chokidar reaches ready without ever observing the file that the main
    // enumeration saw. The one targeted verification closes that attach race.
    nativeWatchers[0].emit("ready");
    await expect(
      watcher.releaseInitialization(result.sessionId, [
        {
          filePath: "/library/deleted-before-attach.mp4",
          stats: { size: 10, mtimeMs: 10 },
        },
      ])
    ).resolves.toMatchObject({ success: true, removed: 1 });

    expect(removed).toHaveBeenCalledWith(
      path.resolve("/library/deleted-before-attach.mp4"),
      expect.objectContaining({ sessionId: result.sessionId })
    );
    await watcher.stop();
  });

  it("cannot hang initialization when native watching errors before ready", async () => {
    const scanFolderForChanges = vi.fn(async () => {});
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject: vi.fn(),
      scanFolderForChanges,
      logger,
    });
    watcher.on("error", vi.fn());
    const result = await watcher.start("/library", {
      bufferInitialEvents: true,
    });

    nativeWatchers[0].emit(
      "error",
      Object.assign(new Error("permission failure"), { code: "EACCES" })
    );

    await expect(
      watcher.releaseInitialization(result.sessionId, [])
    ).resolves.toMatchObject({
      success: true,
      fullReconciliation: true,
    });
    expect(scanFolderForChanges).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it("invalidates synchronously and silently drops stale async enrichment", async () => {
    const enrichment = createDeferred();
    const createVideoFileObject = vi.fn(() => enrichment.promise);
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
    });
    const added = vi.fn();
    const errors = vi.fn();
    watcher.on("added", added);
    watcher.on("error", errors);

    await watcher.start("/library", {
      context: { profileId: "profile-a" },
    });
    nativeWatchers[0].emit("add", "/library/slow.mp4");
    await flushPromises();

    const helperOptions = createVideoFileObject.mock.calls[0][2];
    const stopping = watcher.stop();
    expect(() => helperOptions.assertActive()).toThrowError(
      expect.objectContaining({ code: "WATCHER_SESSION_STALE" })
    );

    enrichment.resolve({ id: "/library/slow.mp4" });
    await stopping;
    await flushPromises();

    expect(added).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("makes overlapping stop calls await the same native close boundary", async () => {
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject: vi.fn(),
      scanFolderForChanges: vi.fn(),
      logger,
    });
    await watcher.start("/library");
    const closeGate = createDeferred();
    nativeWatchers[0].close.mockImplementation(() => closeGate.promise);

    const firstStop = watcher.stop();
    let secondSettled = false;
    const secondStop = watcher.stop().then(() => {
      secondSettled = true;
    });
    await flushPromises();

    expect(nativeWatchers[0].close).toHaveBeenCalledOnce();
    expect(secondSettled).toBe(false);
    closeGate.resolve();
    await Promise.all([firstStop, secondStop]);
    expect(secondSettled).toBe(true);
  });

  it("makes stop await a native close already queued by watch-limit fallback", async () => {
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject: vi.fn(),
      scanFolderForChanges: vi.fn(),
      logger,
    });
    await watcher.start("/library");
    const closeGate = createDeferred();
    nativeWatchers[0].close.mockImplementation(() => closeGate.promise);

    nativeWatchers[0].emit(
      "error",
      Object.assign(new Error("watch limit"), { code: "ENOSPC" })
    );
    await flushPromises();

    let stopSettled = false;
    const stopping = watcher.stop().then(() => {
      stopSettled = true;
    });
    await flushPromises();

    expect(nativeWatchers[0].close).toHaveBeenCalledOnce();
    expect(stopSettled).toBe(false);
    closeGate.resolve();
    await stopping;
    expect(stopSettled).toBe(true);
    expect(watcher.isPolling()).toBe(false);
  });

  it("treats an invalidated owner context as stale before watcher teardown", async () => {
    const context = { profileId: "profile-a", cancelled: false };
    const createVideoFileObject = vi.fn();
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
    });
    const removed = vi.fn();
    watcher.on("removed", removed);

    await watcher.start("/library", { context });
    context.cancelled = true;
    nativeWatchers[0].emit("add", "/library/new.mp4");
    nativeWatchers[0].emit("unlink", "/library/old.mp4");
    await flushPromises();

    expect(createVideoFileObject).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it("keeps polling single-flight with session-owned baseline state", async () => {
    vi.useFakeTimers();
    const firstScan = createDeferred();
    const pollingFailure = new Error("poll failed");
    const scanFolderForChanges = vi.fn((_folderPath, options) => {
      options.pollingState.initialized = true;
      return scanFolderForChanges.mock.calls.length === 1
        ? firstScan.promise
        : Promise.reject(pollingFailure);
    });
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject: vi.fn(),
      scanFolderForChanges,
      onDirectoryAggregatesDirty: vi.fn(),
      logger,
    });
    const errors = vi.fn();
    watcher.on("error", errors);

    await watcher.start("/library", {
      recursive: true,
      context: { profileId: "profile-a", profileGeneration: 7 },
    });
    nativeWatchers[0].emit(
      "error",
      Object.assign(new Error("watch limit"), { code: "ENOSPC" })
    );
    await flushPromises();

    expect(watcher.isPolling()).toBe(true);
    expect(scanFolderForChanges).toHaveBeenCalledTimes(1);
    const firstOptions = scanFolderForChanges.mock.calls[0][1];
    expect(firstOptions).toMatchObject({
      recursive: true,
      profileId: "profile-a",
      profileGeneration: 7,
      assertActive: expect.any(Function),
      refreshDirectoryCounts: false,
      sendEvent: expect.any(Function),
      pollingState: {
        initialized: true,
        lastFiles: expect.any(Map),
      },
    });

    vi.advanceTimersByTime(15000);
    await flushPromises();
    expect(scanFolderForChanges).toHaveBeenCalledTimes(1);

    firstScan.resolve();
    await flushPromises();
    vi.advanceTimersByTime(5000);
    await flushPromises();

    expect(scanFolderForChanges).toHaveBeenCalledTimes(2);
    expect(scanFolderForChanges.mock.calls[1][1].pollingState).toBe(
      firstOptions.pollingState
    );
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Switched to polling mode" }),
      expect.objectContaining({
        folderPath: "/library",
        sessionId: "watch-1",
      })
    );
    expect(errors).toHaveBeenCalledWith(
      pollingFailure,
      expect.objectContaining({
        folderPath: "/library",
        sessionId: "watch-1",
      })
    );

    await watcher.stop();
  });

  it("bounds change debouncers and preserves evicted notifications", async () => {
    vi.useFakeTimers();
    const createVideoFileObject = vi.fn(async (filePath) => ({ id: filePath }));
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
      maxChangeDebouncers: 2,
    });
    const changed = vi.fn();
    watcher.on("changed", changed);
    await watcher.start("/library");

    nativeWatchers[0].emit("change", "/library/one.mp4");
    nativeWatchers[0].emit("change", "/library/two.mp4");
    nativeWatchers[0].emit("change", "/library/three.mp4");

    expect(watcher.getSnapshot()).toMatchObject({
      pendingChangeDebouncers: 2,
      limits: { maxChangeDebouncers: 2 },
    });
    await flushPromises();
    vi.advanceTimersByTime(1000);
    await flushPromises();

    expect(createVideoFileObject).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(watcher.getSnapshot()).toMatchObject({
      pendingChangeDebouncers: 0,
      activeEnrichments: 0,
      pendingEnrichments: 0,
    });
    await watcher.stop();
  });

  it("coalesces a bounded enrichment queue and reconciles once after overflow", async () => {
    const enrichments = [];
    const createVideoFileObject = vi.fn((filePath) => {
      const deferred = createDeferred();
      enrichments.push({ filePath, deferred });
      return deferred.promise;
    });
    const scanFolderForChanges = vi.fn(async () => {});
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges,
      logger,
      enrichmentConcurrency: 1,
      maxPendingEnrichments: 1,
    });
    await watcher.start("/library", {
      context: { profileId: "profile-a" },
    });
    const nativeWatcher = nativeWatchers[0];

    nativeWatcher.emit("add", "/library/active.mp4");
    nativeWatcher.emit("add", "/library/coalesced.mp4");
    nativeWatcher.emit("add", "/library/coalesced.mp4");
    nativeWatcher.emit("add", "/library/overflow.mp4");

    expect(createVideoFileObject).toHaveBeenCalledTimes(1);
    expect(watcher.getSnapshot()).toMatchObject({
      activeEnrichments: 1,
      pendingEnrichments: 1,
      reconciliationNeeded: true,
      limits: {
        enrichmentConcurrency: 1,
        maxPendingEnrichments: 1,
      },
      totals: { coalesced: 1, overflowed: 1 },
    });
    expect(scanFolderForChanges).not.toHaveBeenCalled();

    enrichments[0].deferred.resolve({ id: enrichments[0].filePath });
    await flushPromises();
    expect(createVideoFileObject).toHaveBeenCalledTimes(2);
    expect(scanFolderForChanges).not.toHaveBeenCalled();

    enrichments[1].deferred.resolve({ id: enrichments[1].filePath });
    await flushPromises();
    await flushPromises();
    expect(scanFolderForChanges).toHaveBeenCalledTimes(1);
    expect(scanFolderForChanges).toHaveBeenCalledWith(
      "/library",
      expect.objectContaining({
        profileId: "profile-a",
        assertActive: expect.any(Function),
        pollingState: expect.any(Object),
      })
    );
    expect(watcher.getSnapshot()).toMatchObject({
      activeEnrichments: 0,
      pendingEnrichments: 0,
      reconciliationNeeded: false,
      totals: { reconciliations: 1 },
    });
    await watcher.stop();
  });

  it("releases an enrichment lane after rejected file work", async () => {
    const createVideoFileObject = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValueOnce({ id: "recovered" });
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
      enrichmentConcurrency: 1,
      maxPendingEnrichments: 1,
    });
    await watcher.start("/library");

    nativeWatchers[0].emit("add", "/library/fails.mp4");
    nativeWatchers[0].emit("add", "/library/recovers.mp4");
    await flushPromises();

    expect(createVideoFileObject).toHaveBeenCalledTimes(2);
    expect(watcher.getSnapshot()).toMatchObject({
      activeEnrichments: 0,
      pendingEnrichments: 0,
      totals: { completed: 2 },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("createVideoFileObject failed"),
      expect.objectContaining({ message: "temporary read failure" })
    );
    await watcher.stop();
  });

  it("cancels active enrichment on unlink and suppresses its late add", async () => {
    const enrichment = createDeferred();
    const createVideoFileObject = vi.fn(() => enrichment.promise);
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
      enrichmentConcurrency: 1,
    });
    const added = vi.fn();
    const removed = vi.fn();
    watcher.on("added", added);
    watcher.on("removed", removed);
    await watcher.start("/library");

    nativeWatchers[0].emit("add", "/library/deleted.mp4");
    const helperOptions = createVideoFileObject.mock.calls[0][2];
    nativeWatchers[0].emit("unlink", "/library/deleted.mp4");

    expect(helperOptions.signal.aborted).toBe(true);
    expect(removed).toHaveBeenCalledOnce();
    expect(watcher.getSnapshot()).toMatchObject({
      activeEnrichments: 0,
      pendingEnrichments: 0,
      totals: { cancelled: 1 },
    });

    enrichment.resolve({ id: "/library/deleted.mp4" });
    await flushPromises();
    expect(added).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it("coalesces a same-path change behind active add enrichment", async () => {
    vi.useFakeTimers();
    const enrichments = [];
    const createVideoFileObject = vi.fn((filePath) => {
      const deferred = createDeferred();
      enrichments.push({ filePath, deferred });
      return deferred.promise;
    });
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
      enrichmentConcurrency: 1,
    });
    const added = vi.fn();
    const changed = vi.fn();
    watcher.on("added", added);
    watcher.on("changed", changed);
    await watcher.start("/library");

    nativeWatchers[0].emit("add", "/library/same.mp4");
    nativeWatchers[0].emit("change", "/library/same.mp4");
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(watcher.getSnapshot()).toMatchObject({
      activeEnrichments: 1,
      pendingEnrichments: 0,
      totals: { coalesced: 1 },
    });

    enrichments[0].deferred.resolve({ id: "first" });
    await flushPromises();
    expect(createVideoFileObject).toHaveBeenCalledTimes(2);
    expect(added).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();

    enrichments[1].deferred.resolve({ id: "second" });
    await flushPromises();
    expect(changed).toHaveBeenCalledOnce();
    expect(watcher.getSnapshot().activeEnrichments).toBe(0);
    await watcher.stop();
  });

  it("releases stale session lanes so a new session can enrich immediately", async () => {
    const oldEnrichment = createDeferred();
    const newEnrichment = createDeferred();
    const createVideoFileObject = vi.fn((filePath) =>
      filePath.includes("old") ? oldEnrichment.promise : newEnrichment.promise
    );
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
      enrichmentConcurrency: 1,
    });
    const added = vi.fn();
    watcher.on("added", added);

    await watcher.start("/old", { context: { generation: "old" } });
    nativeWatchers[0].emit("add", "/old/stalled.mp4");
    expect(watcher.getSnapshot().activeEnrichments).toBe(1);

    await watcher.start("/new", { context: { generation: "new" } });
    nativeWatchers[1].emit("add", "/new/current.mp4");
    expect(createVideoFileObject).toHaveBeenCalledTimes(2);
    expect(watcher.getSnapshot()).toMatchObject({
      currentFolder: "/new",
      activeEnrichments: 1,
      totals: { cancelled: 1 },
    });

    newEnrichment.resolve({ id: "new" });
    await flushPromises();
    expect(added).toHaveBeenCalledTimes(1);
    expect(added.mock.calls[0][0]).toEqual({ id: "new" });

    oldEnrichment.resolve({ id: "old" });
    await flushPromises();
    expect(added).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it("hard-bounds raw enrichment across unlink and session churn", async () => {
    const enrichments = [];
    const createVideoFileObject = vi.fn((filePath) => {
      const deferred = createDeferred();
      enrichments.push({ filePath, deferred });
      return deferred.promise;
    });
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject,
      scanFolderForChanges: vi.fn(),
      logger,
      enrichmentConcurrency: 1,
      maxOutstandingEnrichments: 2,
    });
    const added = vi.fn();
    watcher.on("added", added);

    await watcher.start("/old", { context: { generation: "old" } });
    nativeWatchers[0].emit("add", "/old/one.mp4");
    nativeWatchers[0].emit("unlink", "/old/one.mp4");
    nativeWatchers[0].emit("add", "/old/two.mp4");
    nativeWatchers[0].emit("unlink", "/old/two.mp4");
    nativeWatchers[0].emit("add", "/old/blocked.mp4");

    expect(createVideoFileObject).toHaveBeenCalledTimes(2);
    expect(watcher.getSnapshot()).toMatchObject({
      activeEnrichments: 0,
      outstandingEnrichments: 2,
      retiredEnrichments: 2,
      pendingEnrichments: 1,
      limits: { maxOutstandingEnrichments: 2 },
    });

    await watcher.start("/new", { context: { generation: "new" } });
    nativeWatchers[1].emit("add", "/new/current.mp4");
    expect(createVideoFileObject).toHaveBeenCalledTimes(2);
    expect(watcher.getSnapshot()).toMatchObject({
      currentFolder: "/new",
      outstandingEnrichments: 2,
      retiredEnrichments: 2,
      pendingEnrichments: 1,
    });

    // Settling one retired promise creates exactly one unit of admission for
    // the current session while the other retired promise remains counted.
    enrichments[0].deferred.resolve({ id: "late-old-one" });
    await flushPromises();
    expect(createVideoFileObject).toHaveBeenCalledTimes(3);
    expect(enrichments[2].filePath).toBe("/new/current.mp4");
    expect(watcher.getSnapshot()).toMatchObject({
      activeEnrichments: 1,
      outstandingEnrichments: 2,
      retiredEnrichments: 1,
      pendingEnrichments: 0,
    });

    enrichments[2].deferred.resolve({ id: "current" });
    await flushPromises();
    expect(added).toHaveBeenCalledTimes(1);
    expect(added.mock.calls[0][0]).toEqual({ id: "current" });
    expect(watcher.getSnapshot()).toMatchObject({
      outstandingEnrichments: 1,
      retiredEnrichments: 1,
    });

    enrichments[1].deferred.resolve({ id: "late-old-two" });
    await flushPromises();
    expect(added).toHaveBeenCalledTimes(1);
    expect(watcher.getSnapshot()).toMatchObject({
      outstandingEnrichments: 0,
      retiredEnrichments: 0,
      totals: { rawStarted: 3, rawSettled: 3 },
    });
    await watcher.stop();
  });

  it("keeps overflow reconciliation dirty until a retry succeeds", async () => {
    vi.useFakeTimers();
    const scanError = new Error("temporary reconciliation failure");
    const scanFolderForChanges = vi
      .fn()
      .mockRejectedValueOnce(scanError)
      .mockResolvedValueOnce(undefined);
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject: vi.fn(),
      scanFolderForChanges,
      logger,
      maxPendingEnrichments: 0,
      reconciliationRetryBaseMs: 10,
      maxReconciliationRetries: 2,
    });
    const errors = vi.fn();
    watcher.on("error", errors);
    await watcher.start("/library");

    nativeWatchers[0].emit("add", "/library/overflow.mp4");
    await flushPromises();
    expect(scanFolderForChanges).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(
      scanError,
      expect.objectContaining({ folderPath: "/library" })
    );
    expect(watcher.getSnapshot()).toMatchObject({
      reconciliationNeeded: true,
      reconciliationRetryScheduled: true,
      totals: { reconciliationFailures: 1 },
    });

    vi.advanceTimersByTime(10);
    await flushPromises();
    expect(scanFolderForChanges).toHaveBeenCalledTimes(2);
    expect(watcher.getSnapshot()).toMatchObject({
      reconciliationNeeded: false,
      reconciliationInFlight: false,
      reconciliationRetryScheduled: false,
      totals: { reconciliationRetries: 1 },
    });
    await watcher.stop();
  });

  it("disposes pending state and prevents watcher reuse", async () => {
    const watcher = createFolderWatcher({
      isVideoFile: (filePath) => filePath.endsWith(".mp4"),
      createVideoFileObject: vi.fn(),
      scanFolderForChanges: vi.fn(),
      logger,
    });
    await watcher.start("/library");
    nativeWatchers[0].emit("change", "/library/pending.mp4");

    await watcher.dispose();

    expect(watcher.getSnapshot()).toMatchObject({
      disposed: true,
      pendingChangeDebouncers: 0,
      pendingEnrichments: 0,
      mode: "stopped",
      limits: {
        maxChangeDebouncers: 2048,
        enrichmentConcurrency: 2,
        maxPendingEnrichments: 2048,
        maxOutstandingEnrichments: 8,
        maxInitializationEvents: 16384,
      },
    });
    await expect(watcher.start("/library")).rejects.toThrow("disposed");
  });
});
