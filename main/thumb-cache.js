const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class ThumbnailCache {
  constructor(options = {}) {
    const {
      maxMemoryEntries = 500,
      maxDiskEntries = 5000,
      diskFolderName = "thumbs",
      indexFileName = "index.json",
    } = options;

    this.maxMemoryEntries = Math.max(1, maxMemoryEntries);
    this.maxDiskEntries = Math.max(1, maxDiskEntries);
    this.diskFolderName = diskFolderName;
    this.indexFileName = indexFileName;

    this.memoryStore = new Map(); // signature -> { image, lastUsed }
    this.signatureToEntry = new Map(); // signature -> { path, hash, lastUsed }
    this.pathToSignature = new Map();

    this.initialized = false;
    this.persistTimer = null;
    this.baseDir = null;
    this.indexPath = null;
    this.profileRoot = null;
  }

  init(app, profilePath = null) {
    if (!app || typeof app.getPath !== "function") {
      throw new Error("ThumbnailCache.init requires electron app instance");
    }

    const root =
      (typeof profilePath === "string" && profilePath.trim().length > 0
        ? profilePath.trim()
        : null) || app.getPath("userData");

    if (this.initialized) {
      if (this.profileRoot === root) {
        return;
      }
      this.reset();
    }

    this.profileRoot = root;
    this.baseDir = path.join(root, this.diskFolderName);
    this.indexPath = path.join(this.baseDir, this.indexFileName);

    fs.mkdirSync(this.baseDir, { recursive: true });
    this.#loadIndexSync();
    this.initialized = true;
  }

  shutdown() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.indexPath) {
      try {
        this.#persistIndexSync();
      } catch (error) {
        console.warn("[thumb-cache] Failed to persist index during shutdown", error);
      }
    }
  }

  reset() {
    this.shutdown();
    this.memoryStore.clear();
    this.signatureToEntry.clear();
    this.pathToSignature.clear();
    this.initialized = false;
    this.baseDir = null;
    this.indexPath = null;
    this.profileRoot = null;
  }

  has(pathKey, signatureHint = null) {
    if (!this.initialized) {
      return { ok: false, error: "NOT_INITIALIZED" };
    }
    if (!pathKey || typeof pathKey !== "string") {
      return { ok: false, error: "INVALID_PATH" };
    }

    const mappedSignature = this.pathToSignature.get(pathKey);
    if (!mappedSignature) {
      return { ok: true, available: false };
    }
    if (signatureHint && mappedSignature !== signatureHint) {
      return { ok: true, available: false };
    }

    const entry = this.signatureToEntry.get(mappedSignature);
    if (!entry) {
      this.pathToSignature.delete(pathKey);
      return { ok: true, available: false };
    }

    const diskPath = this.#filePathForHash(entry.hash);
    if (!diskPath || !fs.existsSync(diskPath)) {
      this.signatureToEntry.delete(mappedSignature);
      this.pathToSignature.delete(pathKey);
      return { ok: true, available: false };
    }

    entry.lastUsed = Date.now();
    this.#schedulePersist();
    return { ok: true, available: true, signature: mappedSignature };
  }

  put(nativeImage, payload) {
    if (!this.initialized) {
      return { ok: false, error: "NOT_INITIALIZED" };
    }
    if (!nativeImage) {
      return { ok: false, error: "NO_NATIVE_IMAGE" };
    }

    const { path: pathKey, signature, base64 } = payload || {};
    if (!pathKey || typeof pathKey !== "string") {
      return { ok: false, error: "INVALID_PATH" };
    }
    const effectiveSignature =
      typeof signature === "string" && signature.length > 0
        ? signature
        : pathKey;

    if (!base64 || typeof base64 !== "string") {
      return { ok: false, error: "INVALID_IMAGE" };
    }

    let dataString = base64.trim();
    const commaIndex = dataString.indexOf(",");
    if (dataString.startsWith("data:")) {
      dataString = commaIndex >= 0 ? dataString.slice(commaIndex + 1) : "";
    }

    if (!dataString) {
      return { ok: false, error: "EMPTY_IMAGE_DATA" };
    }

    let buffer;
    try {
      buffer = Buffer.from(dataString, "base64");
    } catch (error) {
      return { ok: false, error: "BASE64_DECODE_FAILED" };
    }

    if (!buffer || !buffer.length) {
      return { ok: false, error: "EMPTY_BUFFER" };
    }

    let image;
    try {
      image = nativeImage.createFromBuffer(buffer);
    } catch (error) {
      return { ok: false, error: "NATIVE_IMAGE_FAILED" };
    }

    if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
      return { ok: false, error: "EMPTY_NATIVE_IMAGE" };
    }

    const now = Date.now();
    const hash = crypto.createHash("sha1").update(effectiveSignature).digest("hex");
    const diskPath = this.#filePathForHash(hash);

    try {
      fs.writeFileSync(diskPath, buffer);
    } catch (error) {
      return { ok: false, error: "DISK_WRITE_FAILED" };
    }

    const previousSignature = this.pathToSignature.get(pathKey);
    if (previousSignature && previousSignature !== effectiveSignature) {
      this.memoryStore.delete(previousSignature);
      const previousEntry = this.signatureToEntry.get(previousSignature);
      if (previousEntry && previousEntry.hash) {
        this.signatureToEntry.delete(previousSignature);
        if (previousEntry.hash !== hash) {
          const previousPath = this.#filePathForHash(previousEntry.hash);
          try {
            if (previousPath && fs.existsSync(previousPath)) {
              fs.unlinkSync(previousPath);
            }
          } catch (error) {
            console.warn("[thumb-cache] Failed to remove stale thumbnail", error);
          }
        }
      }
    }

    this.pathToSignature.set(pathKey, effectiveSignature);
    this.signatureToEntry.set(effectiveSignature, {
      path: pathKey,
      hash,
      lastUsed: now,
    });
    this.#remember(effectiveSignature, image, now);
    this.#schedulePersist();
    this.#pruneDisk();

    return { ok: true };
  }

  getForDrag(nativeImage, pathKey) {
    if (!this.initialized) {
      return null;
    }
    if (!pathKey || typeof pathKey !== "string") {
      return null;
    }

    const mappedSignature = this.pathToSignature.get(pathKey);
    if (!mappedSignature) {
      return null;
    }

    const inMemory = this.memoryStore.get(mappedSignature);
    if (inMemory && inMemory.image) {
      this.memoryStore.delete(mappedSignature);
      this.memoryStore.set(mappedSignature, {
        image: inMemory.image,
        lastUsed: Date.now(),
      });
      const entry = this.signatureToEntry.get(mappedSignature);
      if (entry) {
        entry.lastUsed = Date.now();
        this.#schedulePersist();
      }
      return inMemory.image;
    }

    const entry = this.signatureToEntry.get(mappedSignature);
    if (!entry) {
      this.pathToSignature.delete(pathKey);
      return null;
    }

    const diskPath = this.#filePathForHash(entry.hash);
    if (!diskPath || !fs.existsSync(diskPath)) {
      this.signatureToEntry.delete(mappedSignature);
      this.pathToSignature.delete(pathKey);
      return null;
    }

    let image = null;
    try {
      image = nativeImage.createFromPath(diskPath);
    } catch (error) {
      console.warn("[thumb-cache] Failed to load cached thumbnail", error);
      image = null;
    }

    if (!image || (typeof image.isEmpty === "function" && image.isEmpty())) {
      this.signatureToEntry.delete(mappedSignature);
      this.pathToSignature.delete(pathKey);
      try {
        fs.unlinkSync(diskPath);
      } catch {}
      return null;
    }

    entry.lastUsed = Date.now();
    this.#remember(mappedSignature, image, entry.lastUsed);
    this.#schedulePersist();
    return image;
  }

  #remember(signature, image, lastUsed) {
    if (!signature || !image) return;
    this.memoryStore.delete(signature);
    this.memoryStore.set(signature, {
      image,
      lastUsed,
    });

    while (this.memoryStore.size > this.maxMemoryEntries) {
      const oldestKey = this.memoryStore.keys().next().value;
      if (!oldestKey) break;
      this.memoryStore.delete(oldestKey);
    }
  }

  #pruneDisk() {
    if (this.signatureToEntry.size <= this.maxDiskEntries) {
      return;
    }

    const entries = Array.from(this.signatureToEntry.entries());
    entries.sort((a, b) => {
      const aTime = a[1]?.lastUsed ?? 0;
      const bTime = b[1]?.lastUsed ?? 0;
      return aTime - bTime;
    });

    while (this.signatureToEntry.size > this.maxDiskEntries && entries.length) {
      const [signature, entry] = entries.shift();
      if (!signature || !entry) continue;
      this.signatureToEntry.delete(signature);
      if (entry.path) {
        const currentSignature = this.pathToSignature.get(entry.path);
        if (currentSignature === signature) {
          this.pathToSignature.delete(entry.path);
        }
      }
      const diskPath = this.#filePathForHash(entry.hash);
      if (diskPath && fs.existsSync(diskPath)) {
        try {
          fs.unlinkSync(diskPath);
        } catch (error) {
          console.warn("[thumb-cache] Failed to remove LRU thumbnail", error);
        }
      }
    }

    this.#schedulePersist();
  }

  #filePathForHash(hash) {
    if (!hash) return null;
    return path.join(this.baseDir, `${hash}.png`);
  }

  #loadIndexSync() {
    this.pathToSignature.clear();
    this.signatureToEntry.clear();

    if (!this.indexPath || !fs.existsSync(this.indexPath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.indexPath, "utf8");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const entries = parsed?.entries || {};
      const now = Date.now();
      for (const [pathKey, descriptor] of Object.entries(entries)) {
        if (!descriptor || typeof descriptor.signature !== "string") continue;
        const signature = descriptor.signature;
        const hash = descriptor.hash || crypto.createHash("sha1").update(signature).digest("hex");
        const diskPath = this.#filePathForHash(hash);
        if (!diskPath || !fs.existsSync(diskPath)) {
          continue;
        }
        const lastUsed = Number.isFinite(descriptor.lastUsed)
          ? descriptor.lastUsed
          : now;
        this.pathToSignature.set(pathKey, signature);
        this.signatureToEntry.set(signature, {
          path: pathKey,
          hash,
          lastUsed,
        });
      }
    } catch (error) {
      console.warn("[thumb-cache] Failed to load cache index", error);
      this.pathToSignature.clear();
      this.signatureToEntry.clear();
    }
  }

  #persistIndexSync() {
    if (!this.indexPath) return;
    const entries = {};
    for (const [pathKey, signature] of this.pathToSignature.entries()) {
      const entry = this.signatureToEntry.get(signature);
      if (!entry) continue;
      entries[pathKey] = {
        signature,
        hash: entry.hash,
        lastUsed: entry.lastUsed ?? Date.now(),
      };
    }

    const payload = {
      version: 1,
      entries,
    };

    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(payload), "utf8");
    } catch (error) {
      console.warn("[thumb-cache] Failed to write cache index", error);
    }
  }

  #schedulePersist() {
    if (!this.indexPath) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.#persistIndexSync();
      } catch (error) {
        console.warn("[thumb-cache] Failed to persist cache index", error);
      }
    }, 250);
    if (typeof this.persistTimer.unref === "function") {
      this.persistTimer.unref();
    }
  }
}

const thumbnailCache = new ThumbnailCache();

module.exports = {
  ThumbnailCache,
  thumbnailCache,
};
