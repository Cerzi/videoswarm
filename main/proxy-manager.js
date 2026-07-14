const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createChildProcessRunner } = require("./child-process-runner");

const DEFAULTS = Object.freeze({
  cacheFolderName: "proxy-cache",
  indexFileName: "index.json",
  maxDiskBytes: 1024 * 1024 * 1024,
  maxEntries: 512,
  concurrency: 1,
  maxPending: 4,
  maxResolveInFlight: 64,
  timeoutMs: 120_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  persistDelayMs: 500,
});

function finiteInteger(value, fallback, minimum = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.floor(numeric));
}

function normalizeOwnerId(ownerId) {
  if (ownerId === null || ownerId === undefined || ownerId === "") {
    return "<global>";
  }
  return String(ownerId);
}

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function isMissingError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function sourceSignature(filePath, stats) {
  const size = Math.max(0, Number(stats?.size) || 0);
  const mtimeMs = Math.max(0, Number(stats?.mtimeMs) || 0);
  return crypto
    .createHash("sha256")
    .update(path.resolve(filePath))
    .update("\0")
    .update(String(size))
    .update("\0")
    .update(String(mtimeMs))
    .digest("hex");
}

function defaultProxyArguments(sourcePath, outputPath) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-vf",
    "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "30",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

class ProxyManager {
  constructor(options = {}) {
    this.fs = options.fs || fs.promises;
    this.clock = options.clock || defaultClock();
    this.ffmpegPath = options.ffmpegPath || "ffmpeg";
    this.buildArguments =
      typeof options.buildArguments === "function"
        ? options.buildArguments
        : defaultProxyArguments;
    this.cacheFolderName = options.cacheFolderName || DEFAULTS.cacheFolderName;
    this.indexFileName = options.indexFileName || DEFAULTS.indexFileName;
    this.maxDiskBytes = finiteInteger(
      options.maxDiskBytes,
      DEFAULTS.maxDiskBytes,
      1
    );
    this.maxEntries = finiteInteger(options.maxEntries, DEFAULTS.maxEntries, 1);
    this.concurrency = finiteInteger(
      options.concurrency,
      DEFAULTS.concurrency,
      1
    );
    this.maxPending = finiteInteger(
      options.maxPending,
      DEFAULTS.maxPending,
      0
    );
    this.maxResolveInFlight = finiteInteger(
      options.maxResolveInFlight,
      DEFAULTS.maxResolveInFlight,
      1
    );
    this.timeoutMs = finiteInteger(options.timeoutMs, DEFAULTS.timeoutMs, 1);
    this.maxStdoutBytes = finiteInteger(
      options.maxStdoutBytes,
      DEFAULTS.maxStdoutBytes,
      0
    );
    this.maxStderrBytes = finiteInteger(
      options.maxStderrBytes,
      DEFAULTS.maxStderrBytes,
      0
    );
    this.persistDelayMs = finiteInteger(
      options.persistDelayMs,
      DEFAULTS.persistDelayMs,
      0
    );

    this.runner =
      options.runner ||
      createChildProcessRunner({
        spawn: options.spawn,
        clock: this.clock,
        concurrency: this.concurrency,
        maxPending: this.maxPending,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes,
        killGraceMs: options.killGraceMs,
      });

    this.profilePath = null;
    this.cacheDir = null;
    this.indexPath = null;
    this.initialized = false;
    this.closed = false;
    this.generation = 0;
    this.sequence = 0;
    this.entries = new Map();
    this.diskBytes = 0;
    this.inFlight = new Map();
    this.ownerStates = new Map();
    this.ownerResolutionCount = 0;
    this.ffmpegAvailable = null;
    this.persistTimer = null;
    this.persistTail = Promise.resolve();
    this.indexDirty = false;
    this.totals = {
      queued: 0,
      deduplicated: 0,
      cacheHits: 0,
      generated: 0,
      failed: 0,
      cancelled: 0,
      evicted: 0,
      busy: 0,
      resolveBusy: 0,
    };
    this.lastError = null;
  }

  async init(profilePath) {
    if (this.closed) {
      throw new Error("ProxyManager is shut down");
    }
    const normalized = this.#normalizeProfilePath(profilePath);
    if (this.initialized && this.profilePath === normalized) {
      return this.getSnapshot();
    }
    if (this.initialized) {
      return this.reset(normalized);
    }
    return this.#initialize(normalized);
  }

  async resolveSource({ filePath, enabled = false, ownerId = null } = {}) {
    const originalPath =
      typeof filePath === "string" && filePath.trim().length > 0
        ? path.resolve(filePath.trim())
        : null;
    if (!originalPath) {
      return this.#resolution(null, "invalid-source");
    }
    if (!enabled) {
      return this.#resolution(originalPath, "disabled");
    }
    if (this.closed) {
      return this.#resolution(originalPath, "shutdown");
    }
    if (!this.initialized) {
      return this.#resolution(originalPath, "uninitialized");
    }

    const owner = normalizeOwnerId(ownerId);
    const existingOwnerState = this.ownerStates.get(owner);
    if (
      existingOwnerState &&
      (!existingOwnerState.active || existingOwnerState.disposed)
    ) {
      return this.#resolution(originalPath, "owner-inactive", { ownerId: owner });
    }
    if (this.ownerResolutionCount >= this.maxResolveInFlight) {
      this.totals.resolveBusy += 1;
      return this.#resolution(originalPath, "busy", {
        busyReason: "resolve-capacity",
        limit: this.maxResolveInFlight,
      });
    }
    const ownership = this.#beginOwnerResolution(owner);
    if (!ownership) {
      return this.#resolution(originalPath, "owner-inactive", { ownerId: owner });
    }

    try {
      const requestGeneration = this.generation;
      let stats;
      try {
        stats = await this.fs.stat(originalPath);
      } catch (error) {
        if (requestGeneration !== this.generation || !this.initialized) {
          return this.#resolution(originalPath, "stale");
        }
        if (!this.#isOwnerResolutionCurrent(ownership)) {
          return this.#resolution(originalPath, "owner-inactive", {
            ownerId: owner,
          });
        }
        return this.#resolution(originalPath, "source-error", {
          error: error?.message || String(error),
        });
      }
      if (requestGeneration !== this.generation || !this.initialized) {
        return this.#resolution(originalPath, "stale");
      }
      if (!this.#isOwnerResolutionCurrent(ownership)) {
        return this.#resolution(originalPath, "owner-inactive", {
          ownerId: owner,
        });
      }

      const signature = sourceSignature(originalPath, stats);
      const cached = await this.#resolveCachedEntry(signature, {
        originalPath,
        stats,
        generation: requestGeneration,
        isActive: () => this.#isOwnerResolutionCurrent(ownership),
      });
      if (requestGeneration !== this.generation || !this.initialized) {
        return this.#resolution(originalPath, "stale");
      }
      if (!this.#isOwnerResolutionCurrent(ownership)) {
        return this.#resolution(originalPath, "owner-inactive", {
          ownerId: owner,
        });
      }
      if (cached) {
        this.totals.cacheHits += 1;
        return this.#resolution(originalPath, "cached", {
          signature,
          proxyPath: cached.proxyPath,
          usingProxy: true,
        });
      }

      if (this.ffmpegAvailable === false) {
        return this.#resolution(originalPath, "unavailable", { signature });
      }

      // No asynchronous boundary may occur between this ownership check and
      // adding the owner to existing work or creating a new task.
      if (!this.#isOwnerResolutionCurrent(ownership)) {
        return this.#resolution(originalPath, "owner-inactive", {
          ownerId: owner,
        });
      }
      const existingTask = this.inFlight.get(signature);
      if (existingTask && existingTask.generation === requestGeneration) {
        existingTask.owners.add(owner);
        this.totals.deduplicated += 1;
        return this.#resolution(originalPath, "pending", {
          signature,
          pending: true,
        });
      }

      if (this.inFlight.size >= this.concurrency + this.maxPending) {
        this.totals.busy += 1;
        return this.#resolution(originalPath, "busy", { signature });
      }

      this.#queueGeneration({
        signature,
        originalPath,
        stats,
        owner,
        generation: requestGeneration,
      });
      return this.#resolution(originalPath, "queued", {
        signature,
        pending: true,
      });
    } finally {
      this.#finishOwnerResolution(ownership);
    }
  }

  async resolveProtocolProxy(signature) {
    const normalizedSignature = String(signature || "").toLowerCase();
    if (
      !/^[a-f0-9]{64}$/.test(normalizedSignature) ||
      this.closed ||
      !this.initialized
    ) {
      return null;
    }
    const requestGeneration = this.generation;
    const entry = this.entries.get(normalizedSignature);
    if (!entry?.proxyPath) return null;
    try {
      // Protocol requests may only resolve the exact filename derived from the
      // current cache signature. Resolve both paths so a replaced cache entry
      // cannot use a symlink to escape the profile-local proxy directory.
      const expectedPath = this.#proxyPath(normalizedSignature);
      if (path.resolve(entry.proxyPath) !== path.resolve(expectedPath)) {
        return null;
      }
      const [canonicalCacheDir, canonicalProxyPath] = await Promise.all([
        this.fs.realpath(this.cacheDir),
        this.fs.realpath(expectedPath),
      ]);
      const relativePath = path.relative(canonicalCacheDir, canonicalProxyPath);
      if (
        !relativePath ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      const stats = await this.fs.stat(canonicalProxyPath);
      if (
        requestGeneration !== this.generation ||
        !this.initialized ||
        this.entries.get(normalizedSignature) !== entry ||
        !stats?.isFile?.()
      ) {
        return null;
      }
      return {
        path: canonicalProxyPath,
        present: true,
        signature: normalizedSignature,
      };
    } catch (error) {
      if (isMissingError(error) && this.entries.get(normalizedSignature) === entry) {
        this.entries.delete(normalizedSignature);
        this.diskBytes = Math.max(0, this.diskBytes - (entry.bytes || 0));
        this.#schedulePersist();
      }
      return null;
    }
  }

  setOwnerActive(ownerId, active) {
    const owner = normalizeOwnerId(ownerId);
    const normalizedActive = Boolean(active);
    let state = this.ownerStates.get(owner);
    if (!state) {
      if (normalizedActive) return false;
      state = this.#createOwnerState(owner);
      this.ownerStates.set(owner, state);
    }
    const changed = state.active !== normalizedActive || state.disposed;
    state.epoch += 1;
    state.active = normalizedActive;
    state.disposed = false;
    if (!normalizedActive) {
      this.cancelOwner(owner);
    } else if (state.resolutions === 0) {
      this.ownerStates.delete(owner);
    }
    return changed;
  }

  cancelOwner(ownerId) {
    const owner = normalizeOwnerId(ownerId);
    let affected = 0;
    for (const task of this.inFlight.values()) {
      if (!task.owners.delete(owner)) continue;
      affected += 1;
      if (task.owners.size === 0) {
        this.totals.cancelled += 1;
        this.runner.cancelOwner?.(
          task.runnerOwnerId,
          "Proxy generation no longer has an active owner"
        );
      }
    }
    return affected;
  }

  disposeOwner(ownerId) {
    const owner = normalizeOwnerId(ownerId);
    let state = this.ownerStates.get(owner);
    if (!state) {
      state = this.#createOwnerState(owner);
      this.ownerStates.set(owner, state);
    }
    state.epoch += 1;
    state.active = false;
    state.disposed = true;
    const affected = this.cancelOwner(owner);
    if (state.resolutions === 0 && this.ownerStates.get(owner) === state) {
      this.ownerStates.delete(owner);
    }
    return affected;
  }

  async reset(profilePath = null) {
    if (this.closed) {
      throw new Error("ProxyManager is shut down");
    }
    const nextProfilePath =
      profilePath === null || profilePath === undefined
        ? null
        : this.#normalizeProfilePath(profilePath);
    this.generation += 1;
    this.#clearPersistTimer();
    const taskPromises = Array.from(this.inFlight.values(), (task) => task.promise);
    this.runner.cancelAll?.("Proxy profile scope was reset");
    await Promise.allSettled(taskPromises);
    await this.#flushIndex(true).catch(() => {});

    this.entries.clear();
    this.diskBytes = 0;
    this.inFlight.clear();
    this.ownerStates.clear();
    this.profilePath = null;
    this.cacheDir = null;
    this.indexPath = null;
    this.initialized = false;
    this.ffmpegAvailable = null;
    this.indexDirty = false;
    this.lastError = null;

    if (nextProfilePath) return this.#initialize(nextProfilePath);
    return this.getSnapshot();
  }

  async shutdown() {
    if (this.closed) return this.getSnapshot();
    this.closed = true;
    this.generation += 1;
    this.#clearPersistTimer();
    const taskPromises = Array.from(this.inFlight.values(), (task) => task.promise);
    const runnerShutdown = this.runner.shutdown?.("Proxy manager is shutting down");
    await Promise.allSettled([
      ...taskPromises,
      ...(runnerShutdown?.then ? [runnerShutdown] : []),
    ]);
    await this.#flushIndex(true).catch(() => {});
    this.inFlight.clear();
    this.ownerStates.clear();
    return this.getSnapshot();
  }

  getSnapshot() {
    let inactiveOwners = 0;
    let ownerTombstones = 0;
    for (const state of this.ownerStates.values()) {
      if (state.disposed) ownerTombstones += 1;
      else if (!state.active) inactiveOwners += 1;
    }
    return {
      initialized: this.initialized,
      closed: this.closed,
      generation: this.generation,
      profilePath: this.profilePath,
      cacheDir: this.cacheDir,
      entries: this.entries.size,
      diskBytes: this.diskBytes,
      inFlight: this.inFlight.size,
      inactiveOwners,
      ownerTombstones,
      ownerResolutions: this.ownerResolutionCount,
      resolveInFlight: this.ownerResolutionCount,
      ownerStates: this.ownerStates.size,
      ffmpegAvailable: this.ffmpegAvailable,
      limits: {
        maxDiskBytes: this.maxDiskBytes,
        maxEntries: this.maxEntries,
        concurrency: this.concurrency,
        maxPending: this.maxPending,
        maxResolveInFlight: this.maxResolveInFlight,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: this.maxStdoutBytes,
        maxStderrBytes: this.maxStderrBytes,
      },
      totals: { ...this.totals },
      lastError: this.lastError ? { ...this.lastError } : null,
      runner: this.runner.getSnapshot?.() || null,
    };
  }

  #createOwnerState(owner) {
    return {
      owner,
      epoch: 0,
      active: true,
      disposed: false,
      resolutions: 0,
    };
  }

  #beginOwnerResolution(owner) {
    let state = this.ownerStates.get(owner);
    if (state && (!state.active || state.disposed)) return null;
    if (!state) {
      state = this.#createOwnerState(owner);
      this.ownerStates.set(owner, state);
    }
    state.resolutions += 1;
    this.ownerResolutionCount += 1;
    return { owner, state, epoch: state.epoch };
  }

  #isOwnerResolutionCurrent(ownership) {
    const { owner, state, epoch } = ownership;
    return (
      this.ownerStates.get(owner) === state &&
      state.epoch === epoch &&
      state.active &&
      !state.disposed
    );
  }

  #finishOwnerResolution(ownership) {
    const { owner, state } = ownership;
    state.resolutions = Math.max(0, state.resolutions - 1);
    this.ownerResolutionCount = Math.max(0, this.ownerResolutionCount - 1);
    if (
      state.resolutions === 0 &&
      (state.active || state.disposed) &&
      this.ownerStates.get(owner) === state
    ) {
      this.ownerStates.delete(owner);
    }
  }

  async #initialize(profilePath) {
    this.generation += 1;
    this.profilePath = profilePath;
    this.cacheDir = path.join(profilePath, this.cacheFolderName);
    this.indexPath = path.join(this.cacheDir, this.indexFileName);
    await this.fs.mkdir(this.cacheDir, { recursive: true });
    this.initialized = true;
    await this.#loadIndex();
    await this.#removeAbandonedTemps();
    await this.#prune();
    return this.getSnapshot();
  }

  #normalizeProfilePath(profilePath) {
    if (typeof profilePath !== "string" || profilePath.trim().length === 0) {
      throw new TypeError("ProxyManager requires a non-empty profile path");
    }
    return path.resolve(profilePath.trim());
  }

  #resolution(originalPath, status, details = {}) {
    const proxyPath = details.proxyPath || null;
    const selectedPath = proxyPath || originalPath;
    return {
      status,
      path: selectedPath,
      sourcePath: selectedPath,
      originalPath,
      proxyPath,
      signature: details.signature || null,
      usingProxy: Boolean(details.usingProxy && proxyPath),
      pending: Boolean(details.pending),
      ...(details.ownerId ? { ownerId: details.ownerId } : {}),
      ...(details.busyReason ? { busyReason: details.busyReason } : {}),
      ...(Number.isFinite(details.limit) ? { limit: details.limit } : {}),
      ...(details.error ? { error: details.error } : {}),
    };
  }

  #proxyPath(signature) {
    return path.join(this.cacheDir, `${signature}.mp4`);
  }

  #tempProxyPath(signature) {
    return path.join(
      this.cacheDir,
      `${signature}.partial-${process.pid}-${++this.sequence}.mp4`
    );
  }

  async #resolveCachedEntry(signature, context) {
    if (
      context.generation !== this.generation ||
      context.isActive?.() === false
    ) {
      return null;
    }
    let entry = this.entries.get(signature) || null;
    const proxyPath = entry?.proxyPath || this.#proxyPath(signature);
    let proxyStats;
    try {
      proxyStats = await this.fs.stat(proxyPath);
    } catch (error) {
      if (
        context.generation !== this.generation ||
        context.isActive?.() === false
      ) {
        return null;
      }
      if (!isMissingError(error)) {
        this.#rememberError(error);
      }
      if (entry) {
        this.entries.delete(signature);
        this.diskBytes = Math.max(0, this.diskBytes - entry.bytes);
        this.#schedulePersist();
      }
      return null;
    }
    if (
      context.generation !== this.generation ||
      context.isActive?.() === false
    ) {
      return null;
    }

    const bytes = Math.max(0, Number(proxyStats.size) || 0);
    if (!entry) {
      entry = {
        signature,
        sourcePath: context.originalPath,
        sourceSize: Math.max(0, Number(context.stats?.size) || 0),
        sourceMtimeMs: Math.max(0, Number(context.stats?.mtimeMs) || 0),
        proxyPath,
        bytes,
        lastUsed: this.clock.now(),
      };
      this.entries.set(signature, entry);
      this.diskBytes += bytes;
      await this.#prune();
      if (
        context.generation !== this.generation ||
        context.isActive?.() === false
      ) {
        return null;
      }
    } else {
      const sizeDelta = bytes - entry.bytes;
      entry.bytes = bytes;
      entry.lastUsed = this.clock.now();
      this.diskBytes = Math.max(0, this.diskBytes + sizeDelta);
      this.entries.delete(signature);
      this.entries.set(signature, entry);
      this.#schedulePersist();
    }
    return this.entries.get(signature) || null;
  }

  #queueGeneration({ signature, originalPath, stats, owner, generation }) {
    const runnerOwnerId = `proxy:${generation}:${signature}:${++this.sequence}`;
    const tempPath = this.#tempProxyPath(signature);
    const task = {
      signature,
      originalPath,
      stats,
      generation,
      runnerOwnerId,
      tempPath,
      owners: new Set([owner]),
      promise: null,
    };
    this.inFlight.set(signature, task);
    this.totals.queued += 1;
    task.promise = this.#generate(task)
      .catch(async (error) => {
        await this.#removeFile(task.tempPath);
        if (this.#isMissingFfmpeg(error)) this.ffmpegAvailable = false;
        if (task.generation === this.generation) {
          if (error?.code === "OWNER_CANCELLED" || error?.code === "RUNNER_CANCELLED") {
            // Cancellation is an expected lifecycle result, not a generation failure.
          } else {
            this.totals.failed += 1;
            this.#rememberError(error);
          }
        }
      })
      .finally(() => {
        if (this.inFlight.get(signature) === task) {
          this.inFlight.delete(signature);
        }
      });
  }

  async #generate(task) {
    const outputPath = this.#proxyPath(task.signature);
    const args = this.buildArguments(task.originalPath, task.tempPath);
    await this.runner.run(this.ffmpegPath, args, {
      ownerId: task.runnerOwnerId,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: this.maxStdoutBytes,
      maxStderrBytes: this.maxStderrBytes,
      spawnOptions: {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });

    if (task.generation !== this.generation || task.owners.size === 0) {
      const error = new Error("Proxy generation became stale");
      error.code = "PROXY_STALE";
      throw error;
    }

    const temporaryStats = await this.fs.stat(task.tempPath);
    if (task.generation !== this.generation || task.owners.size === 0) {
      const error = new Error("Proxy generation became stale");
      error.code = "PROXY_STALE";
      throw error;
    }

    try {
      await this.fs.rename(task.tempPath, outputPath);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
      try {
        await this.fs.stat(outputPath);
        await this.#removeFile(task.tempPath);
      } catch {
        throw error;
      }
    }

    if (task.generation !== this.generation) {
      await this.#removeFile(outputPath);
      const error = new Error("Proxy generation became stale");
      error.code = "PROXY_STALE";
      throw error;
    }

    const outputStats = await this.fs.stat(outputPath);
    const bytes = Math.max(
      0,
      Number(outputStats.size) || Number(temporaryStats.size) || 0
    );
    const existing = this.entries.get(task.signature);
    if (existing) this.diskBytes = Math.max(0, this.diskBytes - existing.bytes);
    const entry = {
      signature: task.signature,
      sourcePath: task.originalPath,
      sourceSize: Math.max(0, Number(task.stats?.size) || 0),
      sourceMtimeMs: Math.max(0, Number(task.stats?.mtimeMs) || 0),
      proxyPath: outputPath,
      bytes,
      lastUsed: this.clock.now(),
    };
    this.entries.delete(task.signature);
    this.entries.set(task.signature, entry);
    this.diskBytes += bytes;
    this.ffmpegAvailable = true;
    this.totals.generated += 1;
    await this.#prune();
    this.#schedulePersist();
  }

  async #loadIndex() {
    this.entries.clear();
    this.diskBytes = 0;
    let parsed;
    try {
      const raw = await this.fs.readFile(this.indexPath, "utf8");
      parsed = JSON.parse(raw);
    } catch (error) {
      if (!isMissingError(error)) this.#rememberError(error);
      return;
    }

    const descriptors = Array.isArray(parsed?.entries) ? parsed.entries : [];
    let changed = false;
    for (const descriptor of descriptors) {
      const signature = descriptor?.signature;
      if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) {
        changed = true;
        continue;
      }
      const proxyPath = this.#proxyPath(signature);
      let proxyStats;
      try {
        proxyStats = await this.fs.stat(proxyPath);
      } catch {
        changed = true;
        continue;
      }
      const bytes = Math.max(0, Number(proxyStats.size) || 0);
      const entry = {
        signature,
        sourcePath:
          typeof descriptor.sourcePath === "string" ? descriptor.sourcePath : null,
        sourceSize: Math.max(0, Number(descriptor.sourceSize) || 0),
        sourceMtimeMs: Math.max(0, Number(descriptor.sourceMtimeMs) || 0),
        proxyPath,
        bytes,
        lastUsed: Math.max(0, Number(descriptor.lastUsed) || 0),
      };
      this.entries.set(signature, entry);
      this.diskBytes += bytes;
    }
    if (changed) this.#schedulePersist();
  }

  async #removeAbandonedTemps() {
    let names;
    try {
      names = await this.fs.readdir(this.cacheDir);
    } catch (error) {
      if (!isMissingError(error)) this.#rememberError(error);
      return;
    }
    const temporaryNames = names.filter((name) => {
      const value = String(name);
      return value.includes(".partial-") || value.startsWith(`${this.indexFileName}.tmp-`);
    });
    await Promise.all(
      temporaryNames.map((name) => this.#removeFile(path.join(this.cacheDir, name)))
    );

    // A crash can occur after an atomic proxy rename but before the batched
    // index write. Recover those files into the quota accounting on startup so
    // they can never accumulate outside the byte/entry limits.
    let adopted = false;
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.mp4$/.exec(String(name));
      if (!match || this.entries.has(match[1])) continue;
      const proxyPath = path.join(this.cacheDir, name);
      try {
        const stats = await this.fs.stat(proxyPath);
        const bytes = Math.max(0, Number(stats.size) || 0);
        this.entries.set(match[1], {
          signature: match[1],
          sourcePath: null,
          sourceSize: 0,
          sourceMtimeMs: 0,
          proxyPath,
          bytes,
          lastUsed: Math.max(0, Number(stats.mtimeMs) || 0),
        });
        this.diskBytes += bytes;
        adopted = true;
      } catch (error) {
        if (!isMissingError(error)) this.#rememberError(error);
      }
    }
    if (adopted) this.#schedulePersist();
  }

  async #prune() {
    if (
      this.entries.size <= this.maxEntries &&
      this.diskBytes <= this.maxDiskBytes
    ) {
      return;
    }
    const ordered = Array.from(this.entries.values()).sort(
      (left, right) => left.lastUsed - right.lastUsed
    );
    while (
      ordered.length > 0 &&
      (this.entries.size > this.maxEntries || this.diskBytes > this.maxDiskBytes)
    ) {
      const entry = ordered.shift();
      if (!entry || this.entries.get(entry.signature) !== entry) continue;
      this.entries.delete(entry.signature);
      this.diskBytes = Math.max(0, this.diskBytes - entry.bytes);
      await this.#removeFile(entry.proxyPath);
      this.totals.evicted += 1;
    }
    this.#schedulePersist();
  }

  #schedulePersist() {
    if (!this.indexPath || !this.initialized || this.closed) return;
    this.indexDirty = true;
    if (this.persistTimer) return;
    this.persistTimer = this.clock.setTimeout(() => {
      this.persistTimer = null;
      void this.#flushIndex().catch((error) => this.#rememberError(error));
    }, this.persistDelayMs);
    this.persistTimer?.unref?.();
  }

  #clearPersistTimer() {
    if (!this.persistTimer) return;
    this.clock.clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  async #flushIndex(force = false) {
    this.#clearPersistTimer();
    if (!this.indexPath || (!this.indexDirty && !force)) return this.persistTail;
    const indexPath = this.indexPath;
    const payload = JSON.stringify(
      {
        version: 1,
        entries: Array.from(this.entries.values(), (entry) => ({
          signature: entry.signature,
          sourcePath: entry.sourcePath,
          sourceSize: entry.sourceSize,
          sourceMtimeMs: entry.sourceMtimeMs,
          bytes: entry.bytes,
          lastUsed: entry.lastUsed,
        })),
      },
      null,
      2
    );
    const temporaryIndexPath = `${indexPath}.tmp-${process.pid}-${++this.sequence}`;
    this.indexDirty = false;
    const operation = this.persistTail
      .catch(() => {})
      .then(async () => {
        await this.fs.writeFile(temporaryIndexPath, payload, "utf8");
        await this.fs.rename(temporaryIndexPath, indexPath);
      })
      .catch(async (error) => {
        await this.#removeFile(temporaryIndexPath);
        throw error;
      });
    this.persistTail = operation.catch(() => {});
    return operation;
  }

  async #removeFile(filePath) {
    if (!filePath) return;
    try {
      if (typeof this.fs.rm === "function") {
        await this.fs.rm(filePath, { force: true });
      } else {
        await this.fs.unlink(filePath);
      }
    } catch (error) {
      if (!isMissingError(error)) this.#rememberError(error);
    }
  }

  #isMissingFfmpeg(error) {
    return (
      error?.code === "ENOENT" ||
      error?.cause?.code === "ENOENT" ||
      (error?.code === "SPAWN_ERROR" && /enoent/i.test(String(error?.message || "")))
    );
  }

  #rememberError(error) {
    this.lastError = {
      code: error?.code || "PROXY_ERROR",
      message: error?.message || String(error),
      at: this.clock.now(),
    };
  }
}

function createProxyManager(options) {
  return new ProxyManager(options);
}

module.exports = {
  DEFAULT_PROXY_LIMITS: DEFAULTS,
  ProxyManager,
  createProxyManager,
  defaultProxyArguments,
  sourceSignature,
};
