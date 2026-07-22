import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createProxyManager, sourceSignature } = require("../proxy-manager");

const fsPromises = fs.promises;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFsApi(stat) {
  return new Proxy(fsPromises, {
    get(target, property) {
      if (property === "stat") return stat;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached");
}

function cancellationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class FakeRunner {
  constructor({ outputBytes = 6, deferred = false, missing = false } = {}) {
    this.outputBytes = outputBytes;
    this.deferred = deferred;
    this.missing = missing;
    this.jobs = [];
    this.run = vi.fn(this.run.bind(this));
    this.cancelOwner = vi.fn(this.cancelOwner.bind(this));
    this.cancelAll = vi.fn(this.cancelAll.bind(this));
    this.shutdown = vi.fn(this.shutdown.bind(this));
  }

  run(_command, args, options = {}) {
    const outputPath = args[args.length - 1];
    const inputIndex = args.indexOf("-i");
    const sourcePath = inputIndex >= 0 ? args[inputIndex + 1] : "source";
    let resolveJob;
    let rejectJob;
    const job = {
      ownerId: options.ownerId,
      outputPath,
      sourcePath,
      settled: false,
      promise: new Promise((resolve, reject) => {
        resolveJob = resolve;
        rejectJob = reject;
      }),
      resolve: (value) => {
        if (job.settled) return;
        job.settled = true;
        resolveJob(value);
      },
      reject: (error) => {
        if (job.settled) return;
        job.settled = true;
        rejectJob(error);
      },
    };
    this.jobs.push(job);

    if (this.missing) {
      queueMicrotask(() => {
        const error = cancellationError("SPAWN_ERROR", "spawn ffmpeg ENOENT");
        error.cause = { code: "ENOENT" };
        job.reject(error);
      });
    } else if (!this.deferred) {
      void this.#complete(job);
    }
    return job.promise;
  }

  async #complete(job) {
    if (job.settled) return;
    await fsPromises.writeFile(
      job.outputPath,
      Buffer.alloc(this.outputBytes, path.basename(job.sourcePath).charCodeAt(0) || 1)
    );
    job.resolve({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
  }

  async completeAll() {
    await Promise.all(this.jobs.filter((job) => !job.settled).map((job) => this.#complete(job)));
  }

  cancelOwner(ownerId) {
    let count = 0;
    for (const job of this.jobs) {
      if (!job.settled && job.ownerId === ownerId) {
        count += 1;
        job.reject(cancellationError("OWNER_CANCELLED", "owner cancelled"));
      }
    }
    return count;
  }

  cancelAll() {
    let count = 0;
    for (const job of this.jobs) {
      if (!job.settled) {
        count += 1;
        job.reject(cancellationError("RUNNER_CANCELLED", "all cancelled"));
      }
    }
    return count;
  }

  async shutdown() {
    this.cancelAll();
    return this.getSnapshot();
  }

  getSnapshot() {
    return {
      active: this.jobs.filter((job) => !job.settled).length,
      pending: 0,
    };
  }
}

async function waitForIdle(manager) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getSnapshot().inFlight === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Proxy manager did not become idle");
}

describe("ProxyManager", () => {
  const tempRoots = [];

  async function makeFixture() {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "videoswarm-proxy-"));
    tempRoots.push(root);
    const profilePath = path.join(root, "profile");
    await fsPromises.mkdir(profilePath, { recursive: true });
    return { root, profilePath };
  }

  async function makeSource(root, name, contents = "original") {
    const filePath = path.join(root, name);
    await fsPromises.writeFile(filePath, contents);
    return filePath;
  }

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) =>
        fsPromises.rm(root, { recursive: true, force: true })
      )
    );
  });

  it("returns originals when disabled and deduplicates enabled generation", async () => {
    const { root, profilePath } = await makeFixture();
    const sourcePath = await makeSource(root, "clip.mp4", "untouched-original");
    const runner = new FakeRunner({ deferred: true, outputBytes: 8 });
    const manager = createProxyManager({ runner, persistDelayMs: 1 });
    await manager.init(profilePath);

    const disabled = await manager.resolveSource({
      filePath: sourcePath,
      enabled: false,
      ownerId: "window-1",
    });
    expect(disabled).toMatchObject({
      status: "disabled",
      path: path.resolve(sourcePath),
      usingProxy: false,
    });
    expect(runner.run).not.toHaveBeenCalled();

    const first = await manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "window-1",
    });
    const duplicate = await manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "window-2",
    });
    expect(first).toMatchObject({ status: "queued", pending: true });
    expect(duplicate).toMatchObject({ status: "pending", pending: true });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run.mock.calls[0][1]).toContain(
      "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2"
    );

    await runner.completeAll();
    await waitForIdle(manager);
    const cached = await manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "window-1",
    });
    expect(cached).toMatchObject({
      status: "cached",
      usingProxy: true,
      proxyPath: expect.stringMatching(/\.mp4$/),
    });
    await expect(manager.resolveProtocolProxy(cached.signature)).resolves.toEqual({
      path: await fsPromises.realpath(cached.proxyPath),
      present: true,
      signature: cached.signature,
    });
    await expect(manager.resolveProtocolProxy("../proxy.mp4")).resolves.toBeNull();
    expect(await fsPromises.readFile(sourcePath, "utf8")).toBe("untouched-original");
    expect((await fsPromises.stat(cached.proxyPath)).size).toBe(8);
    await manager.shutdown();
  });

  it("refuses a protocol proxy symlink that escapes the profile cache", async () => {
    const { root, profilePath } = await makeFixture();
    const sourcePath = await makeSource(root, "escape-source.mp4", "source");
    const outsidePath = await makeSource(root, "outside.mp4", "outside");
    const runner = new FakeRunner({ outputBytes: 8 });
    const manager = createProxyManager({ runner, persistDelayMs: 1 });
    await manager.init(profilePath);

    const queued = await manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "window-1",
    });
    await waitForIdle(manager);
    const cached = await manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "window-1",
    });
    expect(queued.signature).toBe(cached.signature);
    expect(cached.status).toBe("cached");

    await fsPromises.rm(cached.proxyPath);
    await fsPromises.symlink(outsidePath, cached.proxyPath);

    await expect(manager.resolveProtocolProxy(cached.signature)).resolves.toBeNull();
    await manager.shutdown();
  });

  it("evicts least-recently-used proxies by both entries and bytes", async () => {
    const { root, profilePath } = await makeFixture();
    const sources = await Promise.all([
      makeSource(root, "a.mp4", "a"),
      makeSource(root, "b.mp4", "b"),
      makeSource(root, "c.mp4", "c"),
    ]);
    let now = 1;
    const runner = new FakeRunner({ outputBytes: 6 });
    const manager = createProxyManager({
      runner,
      maxEntries: 2,
      maxDiskBytes: 12,
      persistDelayMs: 1,
      clock: {
        now: () => now,
        setTimeout,
        clearTimeout,
      },
    });
    await manager.init(profilePath);

    await manager.resolveSource({ filePath: sources[0], enabled: true });
    await waitForIdle(manager);
    now += 1;
    const cachedA = await manager.resolveSource({ filePath: sources[0], enabled: true });

    now += 1;
    await manager.resolveSource({ filePath: sources[1], enabled: true });
    await waitForIdle(manager);
    const cachedB = await manager.resolveSource({ filePath: sources[1], enabled: true });

    now += 1;
    await manager.resolveSource({ filePath: sources[0], enabled: true });
    now += 1;
    await manager.resolveSource({ filePath: sources[2], enabled: true });
    await waitForIdle(manager);
    const cachedC = await manager.resolveSource({ filePath: sources[2], enabled: true });

    expect(manager.getSnapshot()).toMatchObject({ entries: 2, diskBytes: 12 });
    await expect(fsPromises.stat(cachedA.proxyPath)).resolves.toBeTruthy();
    await expect(fsPromises.stat(cachedC.proxyPath)).resolves.toBeTruthy();
    await expect(fsPromises.stat(cachedB.proxyPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await manager.shutdown();
  });

  it("cancels stale generation work before switching profile scope", async () => {
    const { root, profilePath } = await makeFixture();
    const secondProfile = path.join(root, "profile-b");
    await fsPromises.mkdir(secondProfile, { recursive: true });
    const sourcePath = await makeSource(root, "clip.mp4");
    const runner = new FakeRunner({ deferred: true });
    const manager = createProxyManager({ runner });
    await manager.init(profilePath);

    expect(
      await manager.resolveSource({
        filePath: sourcePath,
        enabled: true,
        ownerId: "window-1",
      })
    ).toMatchObject({ status: "queued" });
    await manager.reset(secondProfile);

    expect(runner.cancelAll).toHaveBeenCalled();
    expect(manager.getSnapshot()).toMatchObject({
      profilePath: path.resolve(secondProfile),
      inFlight: 0,
      entries: 0,
    });
    expect(await fsPromises.readFile(sourcePath, "utf8")).toBe("original");
    await manager.shutdown();
  });

  it("refuses new distinct work once active and pending capacity is full", async () => {
    const { root, profilePath } = await makeFixture();
    const sources = await Promise.all([
      makeSource(root, "one.mp4"),
      makeSource(root, "two.mp4"),
      makeSource(root, "three.mp4"),
    ]);
    const runner = new FakeRunner({ deferred: true });
    const manager = createProxyManager({
      runner,
      concurrency: 1,
      maxPending: 1,
    });
    await manager.init(profilePath);

    expect(
      await manager.resolveSource({ filePath: sources[0], enabled: true })
    ).toMatchObject({ status: "queued" });
    expect(
      await manager.resolveSource({ filePath: sources[1], enabled: true })
    ).toMatchObject({ status: "queued" });
    expect(
      await manager.resolveSource({ filePath: sources[2], enabled: true })
    ).toMatchObject({ status: "busy", pending: false });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot()).toMatchObject({
      inFlight: 2,
      totals: { busy: 1 },
    });
    await manager.shutdown();
  });

  it("keeps deduplicated work alive until its final owner becomes inactive", async () => {
    const { root, profilePath } = await makeFixture();
    const sourcePath = await makeSource(root, "shared.mp4");
    const runner = new FakeRunner({ deferred: true });
    const manager = createProxyManager({ runner });
    await manager.init(profilePath);

    await manager.resolveSource({ filePath: sourcePath, enabled: true, ownerId: "a" });
    await manager.resolveSource({ filePath: sourcePath, enabled: true, ownerId: "b" });
    expect(manager.cancelOwner("a")).toBe(1);
    expect(runner.cancelOwner).not.toHaveBeenCalled();

    manager.setOwnerActive("b", false);
    expect(runner.cancelOwner).toHaveBeenCalledTimes(1);
    await waitForIdle(manager);
    expect(
      await manager.resolveSource({
        filePath: sourcePath,
        enabled: true,
        ownerId: "b",
      })
    ).toMatchObject({ status: "owner-inactive" });
    await manager.shutdown();
  });

  it("invalidates a disposed owner while its source stat is pending", async () => {
    const { root, profilePath } = await makeFixture();
    const sourcePath = await makeSource(root, "slow-source.mp4");
    const sourceStats = await fsPromises.stat(sourcePath);
    const deferredStat = createDeferred();
    const stat = vi.fn((targetPath) =>
      path.resolve(targetPath) === path.resolve(sourcePath)
        ? deferredStat.promise
        : fsPromises.stat(targetPath)
    );
    const runner = new FakeRunner({ deferred: true });
    const manager = createProxyManager({ runner, fs: createFsApi(stat) });
    await manager.init(profilePath);

    const resolution = manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "retired-during-stat",
    });
    await waitFor(() => stat.mock.calls.some(([target]) =>
      path.resolve(target) === path.resolve(sourcePath)
    ));
    expect(manager.getSnapshot()).toMatchObject({ ownerResolutions: 1 });

    manager.disposeOwner("retired-during-stat");
    expect(manager.getSnapshot()).toMatchObject({
      ownerResolutions: 1,
      ownerTombstones: 1,
    });
    deferredStat.resolve(sourceStats);

    await expect(resolution).resolves.toMatchObject({
      status: "owner-inactive",
      ownerId: "retired-during-stat",
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toMatchObject({
      ownerResolutions: 0,
      ownerTombstones: 0,
      ownerStates: 0,
    });
    await manager.shutdown();
  });

  it("does not return or queue cached work after owner deactivation", async () => {
    const { root, profilePath } = await makeFixture();
    const sourcePath = await makeSource(root, "slow-cache.mp4");
    const sourceStats = await fsPromises.stat(sourcePath);
    const signature = sourceSignature(sourcePath, sourceStats);
    const proxyPath = path.join(profilePath, "proxy-cache", `${signature}.mp4`);
    await fsPromises.mkdir(path.dirname(proxyPath), { recursive: true });
    await fsPromises.writeFile(proxyPath, "cached proxy");
    const proxyStats = await fsPromises.stat(proxyPath);
    const deferredProxyStat = createDeferred();
    let deferProxyLookup = false;
    const stat = vi.fn((targetPath) =>
      deferProxyLookup && path.resolve(targetPath) === path.resolve(proxyPath)
        ? deferredProxyStat.promise
        : fsPromises.stat(targetPath)
    );
    const runner = new FakeRunner({ deferred: true });
    const manager = createProxyManager({ runner, fs: createFsApi(stat) });
    await manager.init(profilePath);
    deferProxyLookup = true;
    stat.mockClear();

    const resolution = manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "paused-during-cache",
    });
    await waitFor(() => stat.mock.calls.some(([target]) =>
      path.resolve(target) === path.resolve(proxyPath)
    ));
    manager.setOwnerActive("paused-during-cache", false);
    deferredProxyStat.resolve(proxyStats);

    await expect(resolution).resolves.toMatchObject({
      status: "owner-inactive",
      ownerId: "paused-during-cache",
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toMatchObject({
      ownerResolutions: 0,
      inactiveOwners: 1,
      totals: { cacheHits: 0, queued: 0, deduplicated: 0 },
    });
    manager.setOwnerActive("paused-during-cache", true);
    expect(manager.getSnapshot().ownerStates).toBe(0);
    await manager.shutdown();
  });

  it("hard-bounds outstanding source preflights and readmits after settlement", async () => {
    const { root, profilePath } = await makeFixture();
    const sources = await Promise.all([
      makeSource(root, "preflight-a.mp4"),
      makeSource(root, "preflight-b.mp4"),
      makeSource(root, "preflight-c.mp4"),
    ]);
    const sourceStats = await Promise.all(sources.map((filePath) =>
      fsPromises.stat(filePath)
    ));
    const deferredStats = new Map([
      [path.resolve(sources[0]), createDeferred()],
      [path.resolve(sources[1]), createDeferred()],
    ]);
    const stat = vi.fn((targetPath) =>
      deferredStats.get(path.resolve(targetPath))?.promise ||
      fsPromises.stat(targetPath)
    );
    const runner = new FakeRunner({ deferred: true });
    const manager = createProxyManager({
      runner,
      fs: createFsApi(stat),
      maxResolveInFlight: 2,
    });
    await manager.init(profilePath);

    const first = manager.resolveSource({
      filePath: sources[0],
      enabled: true,
      ownerId: "preflight-a",
    });
    const second = manager.resolveSource({
      filePath: sources[1],
      enabled: true,
      ownerId: "preflight-b",
    });
    expect(manager.getSnapshot()).toMatchObject({
      resolveInFlight: 2,
      limits: { maxResolveInFlight: 2 },
    });

    await expect(manager.resolveSource({
      filePath: sources[2],
      enabled: true,
      ownerId: "preflight-c",
    })).resolves.toMatchObject({
      status: "busy",
      busyReason: "resolve-capacity",
      limit: 2,
      pending: false,
    });
    expect(stat).not.toHaveBeenCalledWith(path.resolve(sources[2]));
    expect(manager.getSnapshot()).toMatchObject({
      resolveInFlight: 2,
      totals: { resolveBusy: 1 },
    });

    deferredStats.get(path.resolve(sources[0])).resolve(sourceStats[0]);
    await expect(first).resolves.toMatchObject({ status: "queued" });
    expect(manager.getSnapshot().resolveInFlight).toBe(1);
    await expect(manager.resolveSource({
      filePath: sources[2],
      enabled: true,
      ownerId: "preflight-c",
    })).resolves.toMatchObject({ status: "queued" });

    deferredStats.get(path.resolve(sources[1])).resolve(sourceStats[1]);
    await expect(second).resolves.toMatchObject({ status: "queued" });
    expect(manager.getSnapshot().resolveInFlight).toBe(0);
    await manager.shutdown();
  });

  it("retains cache-preflight admission across reset until old work settles", async () => {
    const { root, profilePath } = await makeFixture();
    const secondProfile = path.join(root, "profile-after-reset");
    await fsPromises.mkdir(secondProfile, { recursive: true });
    const sourcePath = await makeSource(root, "reset-cache-preflight.mp4");
    const sourceStats = await fsPromises.stat(sourcePath);
    const signature = sourceSignature(sourcePath, sourceStats);
    const proxyPath = path.join(profilePath, "proxy-cache", `${signature}.mp4`);
    await fsPromises.mkdir(path.dirname(proxyPath), { recursive: true });
    await fsPromises.writeFile(proxyPath, "cached proxy");
    const proxyStats = await fsPromises.stat(proxyPath);
    const deferredProxyStat = createDeferred();
    let deferProxyLookup = false;
    const stat = vi.fn((targetPath) =>
      deferProxyLookup && path.resolve(targetPath) === path.resolve(proxyPath)
        ? deferredProxyStat.promise
        : fsPromises.stat(targetPath)
    );
    const runner = new FakeRunner({ deferred: true });
    const manager = createProxyManager({
      runner,
      fs: createFsApi(stat),
      maxResolveInFlight: 1,
    });
    await manager.init(profilePath);
    deferProxyLookup = true;
    stat.mockClear();

    const staleResolution = manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "old-profile-owner",
    });
    await waitFor(() => stat.mock.calls.some(([target]) =>
      path.resolve(target) === path.resolve(proxyPath)
    ));
    await manager.reset(secondProfile);
    expect(manager.getSnapshot()).toMatchObject({
      profilePath: path.resolve(secondProfile),
      resolveInFlight: 1,
    });

    await expect(manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "new-profile-owner",
    })).resolves.toMatchObject({
      status: "busy",
      busyReason: "resolve-capacity",
      limit: 1,
    });

    deferredProxyStat.resolve(proxyStats);
    await expect(staleResolution).resolves.toMatchObject({ status: "stale" });
    expect(manager.getSnapshot().resolveInFlight).toBe(0);
    await expect(manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "new-profile-owner",
    })).resolves.toMatchObject({ status: "queued" });
    await manager.shutdown();
  });

  it("disposes owner tombstones and cancels only that owner's work", async () => {
    const { root, profilePath } = await makeFixture();
    const sourcePath = await makeSource(root, "disposed-owner.mp4");
    const runner = new FakeRunner({ deferred: true });
    const manager = createProxyManager({ runner });
    await manager.init(profilePath);

    manager.setOwnerActive("retired", false);
    expect(manager.getSnapshot().inactiveOwners).toBe(1);
    expect(manager.disposeOwner("retired")).toBe(0);
    expect(manager.getSnapshot().inactiveOwners).toBe(0);

    await manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "retired",
    });
    await manager.resolveSource({
      filePath: sourcePath,
      enabled: true,
      ownerId: "survivor",
    });

    expect(manager.disposeOwner("retired")).toBe(1);
    expect(runner.cancelOwner).not.toHaveBeenCalled();
    expect(manager.disposeOwner("survivor")).toBe(1);
    expect(runner.cancelOwner).toHaveBeenCalledTimes(1);
    await waitForIdle(manager);
    manager.setOwnerActive("shutdown-only", false);
    expect(manager.getSnapshot().inactiveOwners).toBe(1);
    await manager.shutdown();
    expect(manager.getSnapshot().inactiveOwners).toBe(0);
  });

  it("degrades gracefully and stops retrying when ffmpeg is unavailable", async () => {
    const { root, profilePath } = await makeFixture();
    const sourcePath = await makeSource(root, "clip.mp4");
    const runner = new FakeRunner({ missing: true });
    const manager = createProxyManager({ runner });
    await manager.init(profilePath);

    expect(
      await manager.resolveSource({ filePath: sourcePath, enabled: true })
    ).toMatchObject({ status: "queued", path: path.resolve(sourcePath) });
    await waitForIdle(manager);
    expect(manager.getSnapshot()).toMatchObject({
      ffmpegAvailable: false,
      inFlight: 0,
    });
    expect(
      await manager.resolveSource({ filePath: sourcePath, enabled: true })
    ).toMatchObject({ status: "unavailable", path: path.resolve(sourcePath) });
    expect(runner.run).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it("reloads a completed proxy from the profile-local index", async () => {
    const { root, profilePath } = await makeFixture();
    const sourcePath = await makeSource(root, "persisted.mp4");
    const firstRunner = new FakeRunner({ outputBytes: 7 });
    const firstManager = createProxyManager({ runner: firstRunner });
    await firstManager.init(profilePath);
    await firstManager.resolveSource({ filePath: sourcePath, enabled: true });
    await waitForIdle(firstManager);
    await firstManager.shutdown();

    const secondRunner = new FakeRunner();
    const secondManager = createProxyManager({ runner: secondRunner });
    await secondManager.init(profilePath);
    const cached = await secondManager.resolveSource({
      filePath: sourcePath,
      enabled: true,
    });
    expect(cached).toMatchObject({ status: "cached", usingProxy: true });
    expect(secondRunner.run).not.toHaveBeenCalled();
    await secondManager.shutdown();
  });

  it("adopts crash-orphaned proxy files into quota accounting on init", async () => {
    const { profilePath } = await makeFixture();
    const cacheDir = path.join(profilePath, "proxy-cache");
    await fsPromises.mkdir(cacheDir, { recursive: true });
    const firstName = `${"a".repeat(64)}.mp4`;
    const secondName = `${"b".repeat(64)}.mp4`;
    await fsPromises.writeFile(path.join(cacheDir, firstName), Buffer.alloc(6));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await fsPromises.writeFile(path.join(cacheDir, secondName), Buffer.alloc(6));

    const manager = createProxyManager({
      runner: new FakeRunner(),
      maxEntries: 1,
      maxDiskBytes: 6,
    });
    await manager.init(profilePath);

    expect(manager.getSnapshot()).toMatchObject({ entries: 1, diskBytes: 6 });
    const remaining = (await fsPromises.readdir(cacheDir)).filter((name) =>
      name.endsWith(".mp4")
    );
    expect(remaining).toHaveLength(1);
    await manager.shutdown();
  });
});
