const fs = require("fs");
const path = require("path");
const { computeGenerationKey } = require("./generation-key");
const { isIsoBmffPath, readIsoBmffEmbeddedPayload } = require("./container-tags");
const { createEmbeddedMetadataProbe } = require("./embedded-metadata-probe");

// Background evaluation of generation keys for catalogued content. One job
// per renderer owner, latest wins; one file at a time; results are written
// in small transactions and published per written batch. See
// docs/architecture/generation-versions.md, Section 4.

const GENERATION_KEY_INDEXER_LIMITS = Object.freeze({
  pageSize: 256,
  writeBatch: 64,
  publishIntervalMs: 250,
  drainTimeoutMs: 2_000,
  maxJobs: 8,
});

// Outcomes that say something permanent about the content. Anything else is
// transient and leaves the row for a later request.
const DEFINITIVE_PROBE_STATUSES = new Set(["found", "not-found", "unrecognized", "output-limit"]);

class GenerationKeyIndexerCancelled extends Error {
  constructor(message = "Generation key indexing was cancelled") {
    super(message);
    this.name = "GenerationKeyIndexerCancelled";
    this.code = "GENERATION_KEY_INDEX_CANCELLED";
  }
}

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sameSignature(stats, candidate) {
  return (
    Number(stats.size) === Number(candidate.size) &&
    Math.abs(Number(stats.mtimeMs) - Number(candidate.mtimeMs)) < 1
  );
}

function defaultYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

class GenerationKeyIndexer {
  constructor(options = {}) {
    this.limits = { ...GENERATION_KEY_INDEXER_LIMITS, ...(options.limits || {}) };
    this.fsPromises = options.fsPromises || fs.promises;
    this.readIsoPayload = options.readIsoPayload || readIsoBmffEmbeddedPayload;
    this.computeKey = options.computeKey || computeGenerationKey;
    this.probeFactory =
      options.probeFactory ||
      (() => createEmbeddedMetadataProbe({ limits: { maxPending: 2 } }));
    this.probe = options.probe || null;
    this.now = options.now || (() => Date.now());
    this.yieldToEventLoop = options.yieldToEventLoop || defaultYield;
    this.jobs = new Map();
    // Cancelled jobs stay here until their current file settles, so a drain
    // can wait for them before the profile generation advances.
    this.draining = new Set();
    this.nextJobId = 1;
    this.closed = false;
    this.shutdownPromise = null;
  }

  _getProbe() {
    if (!this.probe) this.probe = this.probeFactory();
    return this.probe;
  }

  /**
   * Starts a job for `ownerId`, cancelling that owner's previous one.
   *
   * - `context.metadataStore` is the profile store captured by the caller,
   *   and `context.assertActive()` throws once that profile generation is no
   *   longer current.
   * - `scope` is `{ instanceIds }` or `{ library: true }`.
   * - `publish(payload)` delivers progress to the owner.
   */
  start(ownerId, { context, scope, publish }) {
    if (this.closed) {
      throw new GenerationKeyIndexerCancelled("Generation key indexing is shut down");
    }
    if (!context?.metadataStore || typeof context.assertActive !== "function") {
      throw new TypeError("An active metadata context is required");
    }
    if (typeof publish !== "function") throw new TypeError("publish is required");
    const instanceIds = scope?.library === true ? null : scope?.instanceIds;
    if (instanceIds !== null && !Array.isArray(instanceIds)) {
      throw new TypeError("Scope must name instance ids or the library");
    }
    this.cancelOwner(ownerId);
    if (this.jobs.size >= this.limits.maxJobs) {
      throw new GenerationKeyIndexerCancelled("Too many generation key jobs are active");
    }

    const store = context.metadataStore;
    // Counting validates the scope bounds before any work is accepted.
    const total = store.countGenerationKeyCandidates({ instanceIds });
    const known =
      instanceIds === null ? [] : store.listEvaluatedGenerationKeys(instanceIds);
    const job = {
      id: `gk-${this.nextJobId++}`,
      ownerId,
      scope: instanceIds === null ? "library" : "collection",
      instanceIds,
      context,
      publish,
      total,
      initialUpdates: known.map((entry) => ({
        fingerprint: entry.fingerprint,
        generationKey: entry.generationKey,
        checked: true,
      })),
      cancelled: false,
      probeOwnerId: `generation-key:${ownerId}:${this.nextJobId}`,
      promise: null,
    };
    this.jobs.set(ownerId, job);
    job.promise = this._run(job)
      .catch(() => {})
      .finally(() => {
        if (this.jobs.get(ownerId) === job) this.jobs.delete(ownerId);
      });
    return { jobId: job.id, scope: job.scope, pending: total };
  }

  _assertActive(job) {
    if (job.cancelled) throw new GenerationKeyIndexerCancelled();
    job.context.assertActive();
  }

  _safePublish(job, payload) {
    try {
      job.publish({ jobId: job.id, scope: job.scope, ...payload });
    } catch {
      // A destroyed renderer is cancelled through its own lifecycle hook.
    }
  }

  async _run(job) {
    const store = job.context.metadataStore;
    const attempted = new Set();
    const rootRealPaths = new Map();
    let afterInstanceId = 0;
    let processed = 0;
    let keyed = 0;
    let pendingWrites = [];
    // Keys the renderer may not have yet go out with the first publish.
    let pendingUpdates = job.initialUpdates;
    job.initialUpdates = null;
    let lastPublishedAt = this.now();

    const flush = (done) => {
      this._assertActive(job);
      if (pendingWrites.length > 0) {
        store.setGenerationKeys(pendingWrites, {
          assertActive: () => this._assertActive(job),
        });
      }
      this._safePublish(job, {
        processed,
        total: job.total,
        keyed,
        updates: pendingUpdates,
        done,
      });
      pendingWrites = [];
      pendingUpdates = [];
      lastPublishedAt = this.now();
    };

    try {
      while (true) {
        this._assertActive(job);
        const page = store.listGenerationKeyCandidates({
          instanceIds: job.instanceIds,
          afterInstanceId,
          limit: this.limits.pageSize,
        });
        if (page.length === 0) break;
        afterInstanceId = page[page.length - 1].instanceId;
        for (const candidate of page) {
          this._assertActive(job);
          if (!candidate.fingerprint || attempted.has(candidate.fingerprint)) continue;
          attempted.add(candidate.fingerprint);
          const outcome = await this._evaluate(job, candidate, rootRealPaths);
          this._assertActive(job);
          processed += 1;
          if (outcome.definitive) {
            if (outcome.generationKey) keyed += 1;
            pendingWrites.push({
              fingerprint: candidate.fingerprint,
              generationKey: outcome.generationKey,
            });
          }
          pendingUpdates.push({
            fingerprint: candidate.fingerprint,
            generationKey: outcome.definitive ? outcome.generationKey : null,
            checked: outcome.definitive,
          });
          if (
            pendingUpdates.length >= this.limits.writeBatch ||
            this.now() - lastPublishedAt >= this.limits.publishIntervalMs
          ) {
            flush(false);
          }
          await this.yieldToEventLoop();
        }
      }
      flush(true);
    } catch (error) {
      if (!job.cancelled) {
        this._safePublish(job, {
          processed,
          total: job.total,
          keyed,
          updates: [],
          done: true,
          failed: true,
        });
      }
      throw error;
    }
  }

  async _rootRealPath(rootPath, cache) {
    if (!cache.has(rootPath)) {
      cache.set(
        rootPath,
        this.fsPromises.realpath(rootPath).then(
          (resolved) => path.resolve(resolved),
          () => null
        )
      );
    }
    return cache.get(rootPath);
  }

  // Returns `{ definitive, generationKey }`. Never throws for per-file
  // failures; only cancellation escapes.
  async _evaluate(job, candidate, rootRealPaths) {
    const transient = { definitive: false, generationKey: null };
    const filePath = candidate.absolutePath;
    if (typeof filePath !== "string" || !filePath) return transient;
    try {
      const [realRoot, realFile] = await Promise.all([
        this._rootRealPath(candidate.rootPath, rootRealPaths),
        this.fsPromises.realpath(filePath).then(path.resolve, () => null),
      ]);
      this._assertActive(job);
      if (!realRoot || !realFile || !isInside(realRoot, realFile)) return transient;

      if (isIsoBmffPath(filePath)) {
        const result = await this.readIsoPayload(filePath, {
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
        });
        if (result.status === "found") {
          return { definitive: true, generationKey: this.computeKey(result.payload?.prompt) };
        }
        if (result.status === "not-found") {
          return { definitive: true, generationKey: null };
        }
        return transient;
      }

      // Other containers go through ffprobe, which opens the path itself, so
      // the signature is checked on both sides of the probe.
      const before = await this.fsPromises.lstat(filePath);
      if (!before.isFile() || !sameSignature(before, candidate)) return transient;
      const result = await this._getProbe().probe(filePath, { ownerId: job.probeOwnerId });
      this._assertActive(job);
      const after = await this.fsPromises.lstat(filePath);
      if (!after.isFile() || !sameSignature(after, candidate)) return transient;
      if (!DEFINITIVE_PROBE_STATUSES.has(result?.status)) return transient;
      return {
        definitive: true,
        generationKey: result.status === "found" ? this.computeKey(result.payload?.prompt) : null,
      };
    } catch (error) {
      if (error instanceof GenerationKeyIndexerCancelled || job.cancelled) throw error;
      // Ownership failures must stop the job, not be swallowed per file.
      job.context.assertActive();
      return transient;
    }
  }

  cancelOwner(ownerId) {
    const job = this.jobs.get(ownerId);
    if (!job) return 0;
    job.cancelled = true;
    this.jobs.delete(ownerId);
    this.probe?.cancelOwner?.(job.probeOwnerId);
    this.draining.add(job.promise);
    job.promise.finally(() => this.draining.delete(job.promise));
    return 1;
  }

  cancelAll() {
    let cancelled = 0;
    for (const ownerId of [...this.jobs.keys()]) {
      cancelled += this.cancelOwner(ownerId);
    }
    return cancelled;
  }

  async drain({ timeoutMs = this.limits.drainTimeoutMs } = {}) {
    const pending = [
      ...this.draining,
      ...[...this.jobs.values()].map((job) => job.promise),
    ];
    if (pending.length === 0) return this.getSnapshot();
    let timer = null;
    const timedOut = await Promise.race([
      Promise.allSettled(pending).then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), Math.max(0, Number(timeoutMs) || 0));
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return timedOut ? { ...this.getSnapshot(), drainTimedOut: true } : this.getSnapshot();
  }

  async cancelAllAndDrain(options) {
    this.cancelAll();
    return this.drain(options);
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.cancelAll();
    this.shutdownPromise = Promise.allSettled([
      this.drain(),
      Promise.resolve(this.probe?.shutdown?.()),
    ]).then(() => this.getSnapshot());
    return this.shutdownPromise;
  }

  getSnapshot() {
    return {
      closed: this.closed,
      activeJobs: this.jobs.size,
      draining: this.draining.size,
      jobs: [...this.jobs.values()].map((job) => ({
        id: job.id,
        ownerId: job.ownerId,
        scope: job.scope,
        total: job.total,
      })),
    };
  }
}

function createGenerationKeyIndexer(options) {
  return new GenerationKeyIndexer(options);
}

module.exports = {
  GENERATION_KEY_INDEXER_LIMITS,
  GenerationKeyIndexer,
  GenerationKeyIndexerCancelled,
  createGenerationKeyIndexer,
};
