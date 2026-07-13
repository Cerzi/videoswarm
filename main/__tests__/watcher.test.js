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
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
});
