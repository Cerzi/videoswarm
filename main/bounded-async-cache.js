class BoundedLruCache {
  constructor(maxEntries) {
    const normalized = Math.floor(Number(maxEntries));
    if (!Number.isFinite(normalized) || normalized < 1) {
      throw new TypeError("BoundedLruCache requires a positive maxEntries value");
    }
    this.maxEntries = normalized;
    this.entries = new Map();
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
    return this;
  }

  delete(key) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

class BoundedAsyncCache {
  constructor({ maxEntries, maxInFlight = maxEntries }) {
    this.cache = new BoundedLruCache(maxEntries);
    const normalizedMaxInFlight = Math.floor(Number(maxInFlight));
    if (!Number.isFinite(normalizedMaxInFlight) || normalizedMaxInFlight < 1) {
      throw new TypeError(
        "BoundedAsyncCache requires a positive maxInFlight value"
      );
    }
    this.maxInFlight = normalizedMaxInFlight;
    this.inFlight = new Map();
    this.outstanding = new Set();
    this.generation = 0;
    this.disposed = false;
    this.totals = {
      hits: 0,
      misses: 0,
      deduplicated: 0,
      resolved: 0,
      rejected: 0,
      overflowed: 0,
    };
  }

  getOrCreate(key, createValue) {
    if (this.disposed) {
      return Promise.reject(
        Object.assign(new Error("Bounded async cache is disposed"), {
          code: "CACHE_DISPOSED",
        })
      );
    }
    if (typeof createValue !== "function") {
      return Promise.reject(new TypeError("createValue must be a function"));
    }
    if (this.cache.has(key)) {
      this.totals.hits += 1;
      return Promise.resolve(this.cache.get(key));
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      this.totals.deduplicated += 1;
      return existing;
    }

    if (this.outstanding.size >= this.maxInFlight) {
      this.totals.overflowed += 1;
      return Promise.reject(
        Object.assign(
          new Error(
            `Bounded async cache has ${this.outstanding.size} outstanding operations`
          ),
          {
            name: "CacheCapacityError",
            code: "CACHE_IN_FLIGHT_LIMIT",
            maxInFlight: this.maxInFlight,
            inFlight: this.outstanding.size,
          }
        )
      );
    }

    this.totals.misses += 1;
    const generation = this.generation;
    const work = Promise.resolve()
      .then(() => {
        if (this.disposed || generation !== this.generation) {
          throw Object.assign(
            new Error("Bounded async cache generation was invalidated"),
            {
              name: "CacheInvalidatedError",
              code: "CACHE_INVALIDATED",
              generation,
              currentGeneration: this.generation,
              disposed: this.disposed,
            }
          );
        }
        return createValue();
      })
      .then(
        (value) => {
          this.totals.resolved += 1;
          if (!this.disposed && generation === this.generation) {
            this.cache.set(key, value);
          }
          return value;
        },
        (error) => {
          this.totals.rejected += 1;
          throw error;
        }
      );

    this.inFlight.set(key, work);
    this.outstanding.add(work);
    const removeWork = () => {
      if (this.inFlight.get(key) === work) {
        this.inFlight.delete(key);
      }
      this.outstanding.delete(work);
    };
    // Supply both handlers so cleanup itself cannot create an unhandled
    // rejection while the original promise remains owned by its callers.
    void work.then(removeWork, removeWork);
    return work;
  }

  clear() {
    this.generation += 1;
    this.cache.clear();
    this.inFlight.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }

  getSnapshot() {
    return {
      entries: this.cache.size,
      inFlight: this.outstanding.size,
      currentGenerationInFlight: this.inFlight.size,
      maxEntries: this.cache.maxEntries,
      maxInFlight: this.maxInFlight,
      generation: this.generation,
      disposed: this.disposed,
      totals: { ...this.totals },
    };
  }
}

module.exports = {
  BoundedAsyncCache,
  BoundedLruCache,
};
