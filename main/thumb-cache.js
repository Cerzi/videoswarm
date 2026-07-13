const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_LIMITS = Object.freeze({
  maxMemoryEntries: 500,
  maxMemoryBytes: 32 * 1024 * 1024,
  maxDiskEntries: 5000,
  maxDiskBytes: 256 * 1024 * 1024,
  maxPayloadBytes: 512 * 1024,
  maxImagePixels: 65_536,
  maxIndexBytes: 8 * 1024 * 1024,
  writeConcurrency: 1,
  maxPendingWrites: 64,
  readConcurrency: 2,
  maxPendingReads: 64,
  persistDebounceMs: 250,
  maxPersistRetries: 3,
  persistRetryBaseMs: 500,
  persistRetryMaxMs: 4000,
  maxKeyChars: 32_768,
});

function positiveInteger(value, fallback, minimum = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.floor(numeric));
}

function safeUnref(timer) {
  timer?.unref?.();
  return timer;
}

class BoundedAsyncQueue {
  constructor({ concurrency, maxPending, overflowError }) {
    this.concurrency = positiveInteger(concurrency, 1);
    this.maxPending = positiveInteger(maxPending, 0, 0);
    this.overflowError = overflowError;
    this.pending = [];
    this.active = new Set();
    this.idleWaiters = [];
  }

  add(run, metadata = null) {
    if (this.active.size >= this.concurrency && this.pending.length >= this.maxPending) {
      return Promise.resolve({ ok: false, error: this.overflowError });
    }

    return new Promise((resolve) => {
      this.pending.push({ run, resolve, metadata });
      this.#pump();
    });
  }

  cancelPending(error = "CACHE_INVALIDATED") {
    const pending = this.pending.splice(0);
    for (const job of pending) {
      job.resolve({ ok: false, error });
    }
    this.#notifyIdle();
    return pending.length;
  }

  cancelPendingWhere(predicate, error = "OWNER_CANCELLED") {
    const retained = [];
    let cancelled = 0;
    for (const job of this.pending) {
      if (!predicate(job.metadata)) {
        retained.push(job);
        continue;
      }
      cancelled += 1;
      job.resolve({ ok: false, error });
    }
    this.pending = retained;
    this.#notifyIdle();
    return cancelled;
  }

  whenIdle() {
    if (this.active.size === 0 && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      maxPending: this.maxPending,
      active: this.active.size,
      pending: this.pending.length,
    };
  }

  #pump() {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      const operation = Promise.resolve()
        .then(job.run)
        .catch((error) => ({
          ok: false,
          error: error?.code || error?.message || "IO_FAILED",
        }))
        .then(job.resolve)
        .finally(() => {
          this.active.delete(operation);
          this.#pump();
          this.#notifyIdle();
        });
      this.active.add(operation);
    }
  }

  #notifyIdle() {
    if (this.active.size > 0 || this.pending.length > 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

function decodedBase64Size(value) {
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function normalizeBase64(value, maxBytes) {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "INVALID_IMAGE" };
  }
  const maxEncodedChars = Math.ceil(maxBytes / 3) * 4;
  // Reject before trim/replace can duplicate a hostile multi-megabyte string.
  if (value.length > maxEncodedChars + 256) {
    return { ok: false, error: "IMAGE_PAYLOAD_TOO_LARGE" };
  }
  let encoded = value.trim();
  if (encoded.startsWith("data:")) {
    const commaIndex = encoded.indexOf(",");
    encoded = commaIndex >= 0 ? encoded.slice(commaIndex + 1) : "";
  }
  encoded = encoded.replace(/\s+/gu, "");
  if (!encoded) return { ok: false, error: "EMPTY_IMAGE_DATA" };
  if (encoded.length > maxEncodedChars) {
    return { ok: false, error: "IMAGE_PAYLOAD_TOO_LARGE" };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
    return { ok: false, error: "BASE64_DECODE_FAILED" };
  }
  if (decodedBase64Size(encoded) > maxBytes) {
    return { ok: false, error: "IMAGE_PAYLOAD_TOO_LARGE" };
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length) return { ok: false, error: "EMPTY_BUFFER" };
  if (buffer.length > maxBytes) {
    return { ok: false, error: "IMAGE_PAYLOAD_TOO_LARGE" };
  }
  return { ok: true, buffer };
}

function inspectImage(image, maxPixels, fallbackBytes = 0) {
  if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
    return { ok: false, error: "EMPTY_NATIVE_IMAGE" };
  }
  let size = null;
  try {
    size = image.getSize?.() || null;
  } catch {
    size = null;
  }
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, error: "INVALID_IMAGE_DIMENSIONS" };
  }
  const pixels = Math.ceil(width) * Math.ceil(height);
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
    return { ok: false, error: "IMAGE_DIMENSIONS_TOO_LARGE" };
  }
  return {
    ok: true,
    width,
    height,
    pixels,
    memoryBytes: Math.max(fallbackBytes, pixels * 4),
  };
}

async function atomicWrite(io, destination, data, encoding = undefined) {
  const nonce = crypto.randomBytes(8).toString("hex");
  const temporary = `${destination}.${process.pid}.${nonce}.tmp`;
  try {
    await io.writeFile(temporary, data, encoding);
    await io.rename(temporary, destination);
  } catch (error) {
    try {
      await io.unlink(temporary);
    } catch {}
    throw error;
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await mapper(values[index], index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

class ThumbnailCache {
  constructor(options = {}) {
    this.limits = {
      maxMemoryEntries: positiveInteger(
        options.maxMemoryEntries,
        DEFAULT_LIMITS.maxMemoryEntries
      ),
      maxMemoryBytes: positiveInteger(
        options.maxMemoryBytes,
        DEFAULT_LIMITS.maxMemoryBytes
      ),
      maxDiskEntries: positiveInteger(
        options.maxDiskEntries,
        DEFAULT_LIMITS.maxDiskEntries
      ),
      maxDiskBytes: positiveInteger(
        options.maxDiskBytes,
        DEFAULT_LIMITS.maxDiskBytes
      ),
      maxPayloadBytes: positiveInteger(
        options.maxPayloadBytes,
        DEFAULT_LIMITS.maxPayloadBytes
      ),
      maxImagePixels: positiveInteger(
        options.maxImagePixels,
        DEFAULT_LIMITS.maxImagePixels
      ),
      maxIndexBytes: positiveInteger(
        options.maxIndexBytes,
        DEFAULT_LIMITS.maxIndexBytes
      ),
      persistDebounceMs: positiveInteger(
        options.persistDebounceMs,
        DEFAULT_LIMITS.persistDebounceMs,
        0
      ),
      maxPersistRetries: positiveInteger(
        options.maxPersistRetries,
        DEFAULT_LIMITS.maxPersistRetries,
        0
      ),
      persistRetryBaseMs: positiveInteger(
        options.persistRetryBaseMs,
        DEFAULT_LIMITS.persistRetryBaseMs,
        1
      ),
      persistRetryMaxMs: positiveInteger(
        options.persistRetryMaxMs,
        DEFAULT_LIMITS.persistRetryMaxMs,
        1
      ),
      maxKeyChars: positiveInteger(
        options.maxKeyChars,
        DEFAULT_LIMITS.maxKeyChars
      ),
    };
    this.diskFolderName = options.diskFolderName || "thumbs";
    this.indexFileName = options.indexFileName || "index.json";
    this.io = options.io || fs.promises;
    this.clock = options.clock || {
      now: () => Date.now(),
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    };

    this.readQueue = new BoundedAsyncQueue({
      concurrency: positiveInteger(
        options.readConcurrency,
        DEFAULT_LIMITS.readConcurrency
      ),
      maxPending: positiveInteger(
        options.maxPendingReads,
        DEFAULT_LIMITS.maxPendingReads,
        0
      ),
      overflowError: "READ_QUEUE_FULL",
    });
    this.writeQueue = new BoundedAsyncQueue({
      // A single writer also makes same-signature replacement/cancellation
      // deterministic: an invalidated job can never unlink a newer write.
      concurrency: DEFAULT_LIMITS.writeConcurrency,
      maxPending: positiveInteger(
        options.maxPendingWrites,
        DEFAULT_LIMITS.maxPendingWrites,
        0
      ),
      overflowError: "WRITE_QUEUE_FULL",
    });

    this.memoryStore = new Map();
    this.signatureToEntry = new Map();
    this.pathToSignature = new Map();
    this.readInFlight = new Map();
    this.ownerTokens = new Map();
    this.memoryBytes = 0;
    this.diskBytes = 0;
    this.closed = false;
    this.initialized = false;
    this.resetting = false;
    this.generation = 0;
    this.persistTimer = null;
    this.persistInFlight = null;
    this.persistDirty = false;
    this.persistRetryAttempts = 0;
    this.persistRetryExhausted = false;
    this.resetPromise = null;
    this.baseDir = null;
    this.indexPath = null;
    this.profileRoot = null;
  }

  async init(app, profilePath = null) {
    if (this.closed) {
      const error = new Error("Thumbnail cache is shut down");
      error.code = "CACHE_SHUTDOWN";
      throw error;
    }
    if (!app || typeof app.getPath !== "function") {
      throw new Error("ThumbnailCache.init requires electron app instance");
    }
    if (this.resetPromise) await this.resetPromise;

    const root =
      (typeof profilePath === "string" && profilePath.trim().length > 0
        ? profilePath.trim()
        : null) || app.getPath("userData");
    if (this.initialized && !this.resetting && this.profileRoot === root) {
      return this.getSnapshot();
    }
    if (this.initialized || this.profileRoot) await this.reset();

    const generation = ++this.generation;
    this.resetting = true;
    const baseDir = path.join(root, this.diskFolderName);
    const indexPath = path.join(baseDir, this.indexFileName);
    try {
      await this.io.mkdir(baseDir, { recursive: true });
      const loaded = await this.#loadIndex({ baseDir, indexPath });
      const removedOrphans = await this.#reconcileDirectory(
        baseDir,
        new Set(
          Array.from(loaded.signatureToEntry.values(), (entry) => entry.hash)
        ),
        generation
      );
      if (removedOrphans > 0) loaded.changed = true;
      if (generation !== this.generation) {
        throw Object.assign(new Error("Thumbnail cache initialization was invalidated"), {
          code: "CACHE_INVALIDATED",
        });
      }
      this.profileRoot = root;
      this.baseDir = baseDir;
      this.indexPath = indexPath;
      this.pathToSignature = loaded.pathToSignature;
      this.signatureToEntry = loaded.signatureToEntry;
      this.diskBytes = loaded.diskBytes;
      this.initialized = true;
      this.resetting = false;
      if (loaded.changed) this.#schedulePersist();
      return this.getSnapshot();
    } catch (error) {
      if (generation === this.generation) {
        this.initialized = false;
        this.resetting = false;
        this.profileRoot = null;
        this.baseDir = null;
        this.indexPath = null;
      }
      throw error;
    }
  }

  reset() {
    if (this.resetPromise) return this.resetPromise;
    const operation = this.#resetInternal().finally(() => {
      if (this.resetPromise === operation) this.resetPromise = null;
    });
    this.resetPromise = operation;
    return operation;
  }

  async shutdown() {
    this.closed = true;
    return this.reset();
  }

  async flush() {
    if (!this.initialized || this.resetting) return this.getSnapshot();
    await Promise.all([this.readQueue.whenIdle(), this.writeQueue.whenIdle()]);
    this.persistRetryAttempts = 0;
    this.persistRetryExhausted = false;
    this.persistDirty = true;
    let started = false;
    while (this.#isAvailable() && !started) {
      if (this.persistTimer) {
        this.clock.clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      if (this.persistInFlight) {
        await this.persistInFlight;
        continue;
      }
      if (!this.persistDirty) break;
      started = true;
      await this.#startPersist(this.generation);
    }
    return this.getSnapshot();
  }

  async has(pathKey, signatureHint = null, nativeImage = null, options = {}) {
    if (!this.#isAvailable()) return { ok: false, error: "NOT_INITIALIZED" };
    const pathError = this.#validateKey(pathKey, "INVALID_PATH");
    if (pathError) return pathError;

    const mappedSignature = this.pathToSignature.get(pathKey);
    if (!mappedSignature || (signatureHint && mappedSignature !== signatureHint)) {
      return { ok: true, available: false };
    }
    const mappedEntry = this.signatureToEntry.get(mappedSignature);
    if (!mappedEntry || mappedEntry.path !== pathKey) {
      this.pathToSignature.delete(pathKey);
      return { ok: true, available: false };
    }
    const memoryEntry = this.memoryStore.get(mappedSignature);
    if (memoryEntry?.image) {
      this.#touchMemory(mappedSignature, memoryEntry);
      this.#touchDiskEntry(mappedSignature);
      return { ok: true, available: true, signature: mappedSignature };
    }
    if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") {
      return { ok: false, error: "NO_NATIVE_IMAGE" };
    }

    const ownerId = this.#normalizeOwnerId(options.ownerId);
    const readKey = `${ownerId ?? "<unowned>"}:${mappedSignature}`;
    const existing = this.readInFlight.get(readKey);
    if (existing) return existing;
    const generation = this.generation;
    const ownerToken = this.#createOwnerToken(ownerId);
    const operation = this.readQueue
      .add(
        () =>
          this.#warmFromDisk(
            nativeImage,
            pathKey,
            mappedSignature,
            generation,
            ownerToken
          ),
        { ownerId }
      )
      .finally(() => {
        this.#releaseOwnerToken(ownerToken);
        if (this.readInFlight.get(readKey) === operation) {
          this.readInFlight.delete(readKey);
        }
      });
    this.readInFlight.set(readKey, operation);
    return operation;
  }

  async put(nativeImage, payload, options = {}) {
    if (!this.#isAvailable()) return { ok: false, error: "NOT_INITIALIZED" };
    const { path: pathKey, signature, base64 } = payload || {};
    const pathError = this.#validateKey(pathKey, "INVALID_PATH");
    if (pathError) return pathError;
    const effectiveSignature =
      typeof signature === "string" && signature.length > 0 ? signature : pathKey;
    const signatureError = this.#validateKey(
      effectiveSignature,
      "INVALID_SIGNATURE"
    );
    if (signatureError) return signatureError;

    const decoded = normalizeBase64(base64, this.limits.maxPayloadBytes);
    if (!decoded.ok) return decoded;
    let image;
    try {
      image = nativeImage?.createFromBuffer?.(decoded.buffer);
    } catch {
      return { ok: false, error: "NATIVE_IMAGE_FAILED" };
    }
    const imageInfo = inspectImage(
      image,
      this.limits.maxImagePixels,
      decoded.buffer.length
    );
    if (!imageInfo.ok) return imageInfo;

    const generation = this.generation;
    const ownerId = this.#normalizeOwnerId(options.ownerId);
    const ownerToken = this.#createOwnerToken(ownerId);
    return this.writeQueue
      .add(
        () =>
          this.#writeThumbnail({
            generation,
            ownerToken,
            pathKey,
            signature: effectiveSignature,
            buffer: decoded.buffer,
            image,
            imageInfo,
          }),
        { ownerId }
      )
      .finally(() => this.#releaseOwnerToken(ownerToken));
  }

  cancelOwner(ownerId) {
    const normalized = this.#normalizeOwnerId(ownerId);
    if (normalized === null) return 0;
    const tokens = this.ownerTokens.get(normalized);
    let cancelled = 0;
    if (tokens) {
      for (const token of tokens) {
        if (!token.cancelled) {
          token.cancelled = true;
          token.cancelError = "OWNER_CANCELLED";
          cancelled += 1;
        }
      }
    }
    this.readQueue.cancelPendingWhere(
      (metadata) => metadata?.ownerId === normalized
    );
    this.writeQueue.cancelPendingWhere(
      (metadata) => metadata?.ownerId === normalized
    );
    return cancelled;
  }

  getForDrag(_nativeImage, pathKey) {
    if (!this.#isAvailable() || typeof pathKey !== "string") return null;
    const signature = this.pathToSignature.get(pathKey);
    if (!signature) return null;
    const diskEntry = this.signatureToEntry.get(signature);
    if (!diskEntry || diskEntry.path !== pathKey) {
      this.pathToSignature.delete(pathKey);
      return null;
    }
    const memoryEntry = this.memoryStore.get(signature);
    if (!memoryEntry?.image) return null;
    this.#touchMemory(signature, memoryEntry);
    this.#touchDiskEntry(signature);
    return memoryEntry.image;
  }

  getSnapshot() {
    return {
      initialized: this.initialized,
      closed: this.closed,
      resetting: this.resetting,
      generation: this.generation,
      limits: {
        ...this.limits,
        readConcurrency: this.readQueue.concurrency,
        maxPendingReads: this.readQueue.maxPending,
        writeConcurrency: this.writeQueue.concurrency,
        maxPendingWrites: this.writeQueue.maxPending,
      },
      memory: {
        entries: this.memoryStore.size,
        bytes: this.memoryBytes,
      },
      disk: {
        entries: this.signatureToEntry.size,
        bytes: this.diskBytes,
      },
      mappings: {
        paths: this.pathToSignature.size,
        signatures: this.signatureToEntry.size,
      },
      reads: {
        ...this.readQueue.snapshot(),
        inFlight: this.readInFlight.size,
      },
      writes: this.writeQueue.snapshot(),
      persistence: {
        scheduled: Boolean(this.persistTimer),
        inFlight: Boolean(this.persistInFlight),
        dirty: this.persistDirty,
        attempts: this.persistRetryAttempts,
        exhausted: this.persistRetryExhausted,
      },
      owners: {
        active: this.ownerTokens.size,
        operations: Array.from(this.ownerTokens.values()).reduce(
          (total, tokens) => total + tokens.size,
          0
        ),
      },
    };
  }

  async #resetInternal() {
    this.generation += 1;
    this.initialized = false;
    this.resetting = true;
    if (this.persistTimer) {
      this.clock.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistDirty = false;
    this.persistRetryAttempts = 0;
    this.persistRetryExhausted = false;
    this.readQueue.cancelPending();
    this.writeQueue.cancelPending();
    for (const tokens of this.ownerTokens.values()) {
      for (const token of tokens) {
        token.cancelled = true;
        token.cancelError = "CACHE_INVALIDATED";
      }
    }
    await Promise.all([this.readQueue.whenIdle(), this.writeQueue.whenIdle()]);
    await this.persistInFlight?.catch(() => {});
    const snapshot = this.#captureSnapshot();
    if (snapshot.indexPath) {
      try {
        const excluded = await this.#persistSnapshot(snapshot);
        await this.#deleteSnapshotFiles(snapshot, excluded);
      } catch (error) {
        console.warn("[thumb-cache] Failed to persist index during reset", error);
      }
    }
    this.memoryStore.clear();
    this.signatureToEntry.clear();
    this.pathToSignature.clear();
    this.readInFlight.clear();
    this.ownerTokens.clear();
    this.memoryBytes = 0;
    this.diskBytes = 0;
    this.baseDir = null;
    this.indexPath = null;
    this.profileRoot = null;
    this.resetting = false;
    this.persistDirty = false;
    this.persistRetryAttempts = 0;
    this.persistRetryExhausted = false;
    return this.getSnapshot();
  }

  async #loadIndex({ baseDir, indexPath }) {
    const empty = {
      pathToSignature: new Map(),
      signatureToEntry: new Map(),
      diskBytes: 0,
      changed: false,
    };
    let raw;
    try {
      const indexStat = await this.io.stat(indexPath);
      if (!indexStat?.isFile?.() || indexStat.size <= 0) return empty;
      if (indexStat.size > this.limits.maxIndexBytes) {
        console.warn("[thumb-cache] Ignoring oversized cache index");
        return { ...empty, changed: true };
      }
      raw = await this.io.readFile(indexPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[thumb-cache] Failed to read cache index", error);
      }
      return empty;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn("[thumb-cache] Ignoring corrupt cache index", error);
      return { ...empty, changed: true };
    }
    const descriptors = parsed?.entries;
    if (!descriptors || typeof descriptors !== "object" || Array.isArray(descriptors)) {
      return { ...empty, changed: true };
    }

    const now = this.clock.now();
    const candidates = [];
    const descriptorEntries = Object.entries(descriptors).slice(
      0,
      this.limits.maxDiskEntries * 4
    );
    const inspected = await mapWithConcurrency(
      descriptorEntries,
      this.readQueue.concurrency,
      async ([pathKey, descriptor]) => {
        if (
          this.#validateKey(pathKey, "INVALID_PATH") ||
          !descriptor ||
          this.#validateKey(descriptor.signature, "INVALID_SIGNATURE")
        ) {
          return null;
        }
        const signature = descriptor.signature;
        const expectedHash = crypto.createHash("sha1").update(signature).digest("hex");
        const hash =
          typeof descriptor.hash === "string" && /^[a-f0-9]{40}$/u.test(descriptor.hash)
            ? descriptor.hash
            : expectedHash;
        if (hash !== expectedHash) return null;
        const diskPath = path.join(baseDir, `${hash}.png`);
        try {
          const stat = await this.io.stat(diskPath);
          if (
            !stat?.isFile?.() ||
            stat.size <= 0 ||
            stat.size > this.limits.maxPayloadBytes
          ) {
            return null;
          }
          return {
            path: pathKey,
            signature,
            hash,
            size: stat.size,
            lastUsed: Number.isFinite(descriptor.lastUsed)
              ? descriptor.lastUsed
              : now,
          };
        } catch {
          return null;
        }
      }
    );
    candidates.push(...inspected.filter(Boolean));
    candidates.sort((a, b) => b.lastUsed - a.lastUsed);

    const retainedSignatures = new Set();
    for (const candidate of candidates) {
      if (retainedSignatures.has(candidate.signature)) {
        empty.changed = true;
        continue;
      }
      if (
        empty.signatureToEntry.size >= this.limits.maxDiskEntries ||
        empty.diskBytes + candidate.size > this.limits.maxDiskBytes
      ) {
        empty.changed = true;
        continue;
      }
      retainedSignatures.add(candidate.signature);
      empty.pathToSignature.set(candidate.path, candidate.signature);
      empty.signatureToEntry.set(candidate.signature, {
        path: candidate.path,
        hash: candidate.hash,
        size: candidate.size,
        lastUsed: candidate.lastUsed,
      });
      empty.diskBytes += candidate.size;
    }
    if (candidates.length !== descriptorEntries.length) empty.changed = true;
    return empty;
  }

  async #reconcileDirectory(baseDir, retainedHashes, generation) {
    let removed = 0;
    const inspect = async (entry) => {
      if (generation !== this.generation) return;
      const name = typeof entry === "string" ? entry : entry?.name;
      if (!name || name === this.indexFileName) return;
      const isTemporary = name.includes(".tmp");
      const isThumbnail = name.toLowerCase().endsWith(".png");
      if (!isTemporary && !isThumbnail) return;
      const hash = isThumbnail ? name.slice(0, -4) : null;
      if (!isTemporary && retainedHashes.has(hash)) return;
      if (generation !== this.generation) return;
      try {
        await this.io.unlink(path.join(baseDir, name));
        removed += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn("[thumb-cache] Failed to remove orphan cache file", error);
        }
      }
    };

    try {
      if (typeof this.io.opendir === "function") {
        const directory = await this.io.opendir(baseDir);
        for await (const entry of directory) {
          if (generation !== this.generation) break;
          await inspect(entry);
        }
      } else {
        const entries = await this.io.readdir(baseDir, { withFileTypes: true });
        for (const entry of entries) {
          if (generation !== this.generation) break;
          await inspect(entry);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[thumb-cache] Failed to reconcile cache directory", error);
      }
    }
    return removed;
  }

  async #warmFromDisk(nativeImage, pathKey, signature, generation, ownerToken) {
    if (!this.#isOperationActive(generation, ownerToken)) {
      return { ok: false, error: this.#operationError(ownerToken) };
    }
    const entry = this.signatureToEntry.get(signature);
    if (!entry || this.pathToSignature.get(pathKey) !== signature) {
      return { ok: true, available: false };
    }
    const diskPath = this.#filePathForHash(entry.hash);
    let buffer;
    try {
      buffer = await this.#readBoundedFile(diskPath);
    } catch (error) {
      if (!this.#isOperationActive(generation, ownerToken)) {
        return { ok: false, error: this.#operationError(ownerToken) };
      }
      await this.#evictThroughWriteQueue(signature, entry.hash);
      return {
        ok: true,
        available: false,
        ...(error?.code === "ENOENT" ? {} : { error: "CORRUPT_CACHE_FILE" }),
      };
    }
    if (!this.#isOperationActive(generation, ownerToken)) {
      return { ok: false, error: this.#operationError(ownerToken) };
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > this.limits.maxPayloadBytes) {
      await this.#evictThroughWriteQueue(signature, entry.hash);
      return { ok: true, available: false };
    }

    let image;
    try {
      image = nativeImage.createFromBuffer(buffer);
    } catch {
      image = null;
    }
    const imageInfo = inspectImage(image, this.limits.maxImagePixels, buffer.length);
    if (!imageInfo.ok) {
      await this.#evictThroughWriteQueue(signature, entry.hash);
      return { ok: true, available: false };
    }
    if (!this.#isOperationActive(generation, ownerToken)) {
      return { ok: false, error: this.#operationError(ownerToken) };
    }
    this.#remember(signature, image, imageInfo.memoryBytes);
    this.#touchDiskEntry(signature);
    return { ok: true, available: true, signature };
  }

  async #readBoundedFile(filePath) {
    let handle = null;
    try {
      handle = await this.io.open(filePath, "r");
      const stat = await handle.stat();
      if (
        !stat?.isFile?.() ||
        !Number.isSafeInteger(stat.size) ||
        stat.size <= 0 ||
        stat.size > this.limits.maxPayloadBytes
      ) {
        const error = new Error("Cached thumbnail has an invalid size");
        error.code = "INVALID_CACHE_FILE_SIZE";
        throw error;
      }
      const buffer = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          stat.size - offset,
          offset
        );
        if (!bytesRead) {
          const error = new Error("Cached thumbnail was truncated while reading");
          error.code = "TRUNCATED_CACHE_FILE";
          throw error;
        }
        offset += bytesRead;
      }
      return buffer;
    } finally {
      try {
        await handle?.close();
      } catch {}
    }
  }

  async #writeThumbnail({
    generation,
    ownerToken,
    pathKey,
    signature,
    buffer,
    image,
    imageInfo,
  }) {
    if (!this.#isOperationActive(generation, ownerToken)) {
      return { ok: false, error: this.#operationError(ownerToken) };
    }
    const hash = crypto.createHash("sha1").update(signature).digest("hex");
    const diskPath = this.#filePathForHash(hash);
    try {
      await atomicWrite(this.io, diskPath, buffer);
    } catch (error) {
      console.warn("[thumb-cache] Failed to write thumbnail", error);
      return { ok: false, error: "DISK_WRITE_FAILED" };
    }
    if (!this.#isOperationActive(generation, ownerToken)) {
      try {
        await this.io.unlink(diskPath);
      } catch {}
      return { ok: false, error: this.#operationError(ownerToken) };
    }

    const previousSignature = this.pathToSignature.get(pathKey);
    if (previousSignature && previousSignature !== signature) {
      await this.#evictSignature(previousSignature, { deleteFile: true });
    }
    if (!this.#isOperationActive(generation, ownerToken)) {
      try {
        await this.io.unlink(diskPath);
      } catch {}
      return { ok: false, error: this.#operationError(ownerToken) };
    }
    const previousEntry = this.signatureToEntry.get(signature);
    if (previousEntry) this.diskBytes -= previousEntry.size || 0;
    if (
      previousEntry?.path &&
      previousEntry.path !== pathKey &&
      this.pathToSignature.get(previousEntry.path) === signature
    ) {
      this.pathToSignature.delete(previousEntry.path);
    }
    const now = this.clock.now();
    const commitToken = Symbol("thumbnail-write");
    this.pathToSignature.set(pathKey, signature);
    this.signatureToEntry.set(signature, {
      path: pathKey,
      hash,
      size: buffer.length,
      lastUsed: now,
      operationToken: commitToken,
    });
    this.diskBytes += buffer.length;
    this.#remember(signature, image, imageInfo.memoryBytes);
    await this.#pruneDisk();
    if (!this.#isOperationActive(generation, ownerToken)) {
      if (this.signatureToEntry.get(signature)?.operationToken === commitToken) {
        await this.#evictSignature(signature, { deleteFile: true });
      }
      return { ok: false, error: this.#operationError(ownerToken) };
    }
    const committedEntry = this.signatureToEntry.get(signature);
    if (committedEntry?.operationToken === commitToken) {
      delete committedEntry.operationToken;
    }
    this.#schedulePersist();
    return { ok: true };
  }

  #remember(signature, image, byteSize) {
    const existing = this.memoryStore.get(signature);
    if (existing) this.memoryBytes -= existing.byteSize || 0;
    this.memoryStore.delete(signature);
    this.memoryStore.set(signature, {
      image,
      byteSize,
      lastUsed: this.clock.now(),
    });
    this.memoryBytes += byteSize;
    while (
      this.memoryStore.size > this.limits.maxMemoryEntries ||
      this.memoryBytes > this.limits.maxMemoryBytes
    ) {
      const oldestKey = this.memoryStore.keys().next().value;
      if (!oldestKey) break;
      const removed = this.memoryStore.get(oldestKey);
      this.memoryStore.delete(oldestKey);
      this.memoryBytes = Math.max(0, this.memoryBytes - (removed?.byteSize || 0));
    }
  }

  #touchMemory(signature, entry) {
    this.memoryStore.delete(signature);
    entry.lastUsed = this.clock.now();
    this.memoryStore.set(signature, entry);
  }

  #touchDiskEntry(signature) {
    const entry = this.signatureToEntry.get(signature);
    if (!entry) return;
    entry.lastUsed = this.clock.now();
    this.#schedulePersist({ rearmRetries: false });
  }

  async #pruneDisk() {
    if (
      this.signatureToEntry.size <= this.limits.maxDiskEntries &&
      this.diskBytes <= this.limits.maxDiskBytes
    ) {
      return;
    }
    const entries = Array.from(this.signatureToEntry.entries()).sort(
      (a, b) => (a[1]?.lastUsed || 0) - (b[1]?.lastUsed || 0)
    );
    while (
      entries.length > 0 &&
      (this.signatureToEntry.size > this.limits.maxDiskEntries ||
        this.diskBytes > this.limits.maxDiskBytes)
    ) {
      const [signature] = entries.shift();
      await this.#evictSignature(signature, { deleteFile: true });
    }
  }

  async #evictSignature(signature, { deleteFile }) {
    const entry = this.signatureToEntry.get(signature);
    if (!entry) return;
    this.signatureToEntry.delete(signature);
    this.diskBytes = Math.max(0, this.diskBytes - (entry.size || 0));
    if (entry.path && this.pathToSignature.get(entry.path) === signature) {
      this.pathToSignature.delete(entry.path);
    }
    const memoryEntry = this.memoryStore.get(signature);
    if (memoryEntry) {
      this.memoryStore.delete(signature);
      this.memoryBytes = Math.max(
        0,
        this.memoryBytes - (memoryEntry.byteSize || 0)
      );
    }
    if (deleteFile) {
      try {
        await this.io.unlink(this.#filePathForHash(entry.hash));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          console.warn("[thumb-cache] Failed to remove thumbnail", error);
        }
      }
    }
    this.#schedulePersist();
  }

  #evictThroughWriteQueue(signature, expectedHash) {
    return this.writeQueue.add(async () => {
      const current = this.signatureToEntry.get(signature);
      if (!current || current.hash !== expectedHash) return { ok: true, stale: true };
      await this.#evictSignature(signature, { deleteFile: true });
      return { ok: true };
    });
  }

  #captureSnapshot() {
    return {
      indexPath: this.indexPath,
      baseDir: this.baseDir,
      pathToSignature: new Map(this.pathToSignature),
      signatureToEntry: new Map(
        Array.from(this.signatureToEntry, ([signature, entry]) => [
          signature,
          { ...entry },
        ])
      ),
    };
  }

  #schedulePersist({ rearmRetries = true } = {}) {
    if (!this.#isAvailable() || !this.indexPath) return;
    this.persistDirty = true;
    if (
      rearmRetries &&
      this.persistRetryExhausted &&
      !this.persistTimer &&
      !this.persistInFlight
    ) {
      this.persistRetryAttempts = 0;
      this.persistRetryExhausted = false;
    }
    if (
      this.persistRetryExhausted ||
      this.persistTimer ||
      this.persistInFlight
    ) {
      return;
    }
    this.#armPersistTimer(this.generation, this.limits.persistDebounceMs);
  }

  #armPersistTimer(generation, delayMs) {
    if (this.persistTimer || this.persistInFlight) return;
    this.persistTimer = safeUnref(
      this.clock.setTimeout(() => {
        this.persistTimer = null;
        if (!this.#isGenerationActive(generation)) return;
        void this.#startPersist(generation);
      }, delayMs)
    );
  }

  #startPersist(generation) {
    if (this.persistInFlight) return this.persistInFlight;
    if (!this.#isGenerationActive(generation) || !this.persistDirty) {
      return Promise.resolve();
    }
    this.persistDirty = false;
    const snapshot = this.#captureSnapshot();
    let failed = false;
    const operation = (async () => {
      try {
        const excluded = await this.#persistSnapshot(snapshot);
        if (this.#isGenerationActive(generation)) {
          this.persistRetryAttempts = 0;
          this.persistRetryExhausted = false;
        }
        if (
          this.#isGenerationActive(generation) &&
          snapshot.indexPath === this.indexPath
        ) {
          for (const { signature, entry } of excluded) {
            if (this.signatureToEntry.get(signature)?.hash !== entry.hash) {
              continue;
            }
            const result = await this.#evictThroughWriteQueue(
              signature,
              entry.hash
            );
            if (!result?.ok) this.persistDirty = true;
          }
        }
      } catch (error) {
        console.warn("[thumb-cache] Failed to persist cache index", error);
        if (this.#isGenerationActive(generation)) {
          failed = true;
          this.persistDirty = true;
          this.persistRetryAttempts += 1;
          if (
            this.persistRetryAttempts > this.limits.maxPersistRetries
          ) {
            this.persistRetryExhausted = true;
          }
        }
      }
    })().finally(() => {
      if (this.persistInFlight === operation) this.persistInFlight = null;
      if (!this.persistDirty || !this.#isGenerationActive(generation)) return;
      if (failed) {
        if (this.persistRetryExhausted) return;
        const exponent = Math.min(
          Math.max(0, this.persistRetryAttempts - 1),
          20
        );
        const retryDelay = Math.min(
          this.limits.persistRetryMaxMs,
          this.limits.persistRetryBaseMs * 2 ** exponent
        );
        this.#armPersistTimer(generation, retryDelay);
      } else {
        this.#schedulePersist({ rearmRetries: false });
      }
    });
    this.persistInFlight = operation;
    return operation;
  }

  async #persistSnapshot(snapshot) {
    if (!snapshot.indexPath || !snapshot.baseDir) return [];
    const ordered = Array.from(snapshot.pathToSignature.entries())
      .map(([pathKey, signature]) => [
        pathKey,
        signature,
        snapshot.signatureToEntry.get(signature),
      ])
      .filter((entry) => entry[2])
      .sort((a, b) => (b[2].lastUsed || 0) - (a[2].lastUsed || 0));

    const fragments = [];
    const excluded = [];
    let bytes = Buffer.byteLength('{"version":2,"entries":{}}', "utf8");
    for (const [pathKey, signature, entry] of ordered) {
      const fragment = `${JSON.stringify(pathKey)}:${JSON.stringify({
        signature,
        hash: entry.hash,
        size: entry.size || 0,
        lastUsed: entry.lastUsed || this.clock.now(),
      })}`;
      const fragmentBytes = Buffer.byteLength(fragment, "utf8") +
        (fragments.length > 0 ? 1 : 0);
      if (bytes + fragmentBytes > this.limits.maxIndexBytes) {
        excluded.push({ signature, entry });
        continue;
      }
      fragments.push(fragment);
      bytes += fragmentBytes;
    }
    const serialized = `{"version":2,"entries":{${fragments.join(",")}}}`;
    await this.io.mkdir(snapshot.baseDir, { recursive: true });
    await atomicWrite(this.io, snapshot.indexPath, serialized, "utf8");
    return excluded;
  }

  async #deleteSnapshotFiles(snapshot, excluded) {
    for (const { entry } of excluded) {
      try {
        await this.io.unlink(path.join(snapshot.baseDir, `${entry.hash}.png`));
      } catch {}
    }
  }

  #validateKey(value, error) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > this.limits.maxKeyChars ||
      /[\x00-\x1F\x7F]/u.test(value)
    ) {
      return { ok: false, error };
    }
    return null;
  }

  #isAvailable() {
    return (
      !this.closed &&
      this.initialized &&
      !this.resetting &&
      Boolean(this.baseDir)
    );
  }

  #isGenerationActive(generation) {
    return this.#isAvailable() && generation === this.generation;
  }

  #isOperationActive(generation, ownerToken) {
    return this.#isGenerationActive(generation) && !ownerToken?.cancelled;
  }

  #operationError(ownerToken) {
    return ownerToken?.cancelError || "CACHE_INVALIDATED";
  }

  #normalizeOwnerId(ownerId) {
    if (ownerId === null || ownerId === undefined || ownerId === "") return null;
    return String(ownerId);
  }

  #createOwnerToken(ownerId) {
    const token = { ownerId, cancelled: false, cancelError: null };
    if (ownerId === null) return token;
    let tokens = this.ownerTokens.get(ownerId);
    if (!tokens) {
      tokens = new Set();
      this.ownerTokens.set(ownerId, tokens);
    }
    tokens.add(token);
    return token;
  }

  #releaseOwnerToken(token) {
    if (!token || token.ownerId === null) return;
    const tokens = this.ownerTokens.get(token.ownerId);
    if (!tokens) return;
    tokens.delete(token);
    if (tokens.size === 0) this.ownerTokens.delete(token.ownerId);
  }

  #filePathForHash(hash) {
    if (!hash || !this.baseDir) return null;
    return path.join(this.baseDir, `${hash}.png`);
  }
}

const thumbnailCache = new ThumbnailCache();

module.exports = {
  DEFAULT_THUMBNAIL_CACHE_LIMITS: DEFAULT_LIMITS,
  ThumbnailCache,
  thumbnailCache,
};
