// Background work a user may notice (docs/architecture/background-activity.md).
// Jobs report what they are doing under a fixed kind; the window shows one
// quiet line for it, and a pause holds the work that can wait. Only kinds and
// counts leave this module: never a path, file name or prompt.

// In the order the window lists them. Pausable work waits while background
// work is paused; tag learning runs because someone is waiting for it.
const ACTIVITY_KINDS = Object.freeze([
  Object.freeze({ kind: "prompts", pausable: true }),
  Object.freeze({ kind: "playback-proxies", pausable: true }),
  Object.freeze({ kind: "stack-frames", pausable: true }),
  Object.freeze({ kind: "tag-suggestions", pausable: false }),
]);

const KNOWN_KINDS = new Map(ACTIVITY_KINDS.map((entry, order) => [entry.kind, { ...entry, order }]));

const BACKGROUND_ACTIVITY_LIMITS = Object.freeze({
  // Snapshots go out at most this often; the first change after a quiet
  // spell goes out at once.
  publishIntervalMs: 500,
});

function count(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

class BackgroundActivity {
  constructor(options = {}) {
    this.limits = { ...BACKGROUND_ACTIVITY_LIMITS, ...(options.limits || {}) };
    this.clock = options.clock || defaultClock();
    // kind -> { jobs: Set<{ done, total }>, pending, settled, startedAt }
    this.kinds = new Map();
    this.paused = false;
    this.resume = null; // { promise, resolve } while paused and awaited
    this.listeners = new Set();
    this.pauseListeners = new Set();
    this.timer = null;
    this.lastPublishedAt = -Infinity;
  }

  #entry(kind) {
    if (!KNOWN_KINDS.has(kind)) throw new TypeError(`Unknown background activity: ${kind}`);
    let entry = this.kinds.get(kind);
    if (!entry) {
      entry = { jobs: new Set(), pending: 0, settled: 0, startedAt: this.clock.now() };
      this.kinds.set(kind, entry);
    }
    return entry;
  }

  // A kind with nothing left forgets what it did, so its next batch counts
  // from zero.
  #settle(kind, entry) {
    if (entry.jobs.size === 0 && entry.pending === 0) this.kinds.delete(kind);
  }

  /**
   * A job of known size, such as reading a collection's files. Returns
   * `{ progress(done, total?), finish() }`; finishing twice is harmless.
   */
  begin(kind, { total = 0 } = {}) {
    const entry = this.#entry(kind);
    const job = { done: 0, total: count(total) };
    entry.jobs.add(job);
    this.#changed();
    let finished = false;
    return {
      progress: (done, total = job.total) => {
        if (finished) return;
        job.total = count(total);
        job.done = Math.min(count(done), job.total || count(done));
        this.#changed();
      },
      finish: () => {
        if (finished) return;
        finished = true;
        entry.jobs.delete(job);
        this.#settle(kind, entry);
        this.#changed();
      },
    };
  }

  /** Items of a queue that come and go one at a time (proxies, frames). */
  queued(kind, items = 1) {
    const entry = this.#entry(kind);
    entry.pending += count(items);
    this.#changed();
  }

  settled(kind, items = 1) {
    const entry = this.kinds.get(kind);
    if (!entry) return;
    const settled = Math.min(entry.pending, count(items));
    entry.pending -= settled;
    entry.settled += settled;
    this.#settle(kind, entry);
    this.#changed();
  }

  isPaused() {
    return this.paused;
  }

  /** Holds pausable work until resumed. Lasts until resumed or restarted. */
  setPaused(value) {
    const next = value === true;
    if (next === this.paused) return this.snapshot();
    this.paused = next;
    if (!next && this.resume) {
      this.resume.resolve();
      this.resume = null;
    }
    for (const listener of [...this.pauseListeners]) {
      try {
        listener(next);
      } catch {
        // One producer failing to pause must not stop the others.
      }
    }
    this.#changed();
    return this.snapshot();
  }

  /** Resolves at once while running, or when paused work may continue. */
  whenRunnable() {
    if (!this.paused) return Promise.resolve();
    if (!this.resume) {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      this.resume = { promise, resolve };
    }
    return this.resume.promise;
  }

  onPauseChange(listener) {
    this.pauseListeners.add(listener);
    return () => this.pauseListeners.delete(listener);
  }

  snapshot() {
    const activities = [];
    for (const [kind, entry] of this.kinds) {
      let done = entry.settled;
      let total = entry.settled + entry.pending;
      for (const job of entry.jobs) {
        done += job.done;
        total += Math.max(job.total, job.done);
      }
      const { pausable, order } = KNOWN_KINDS.get(kind);
      activities.push({ kind, pausable, done, total, startedAt: entry.startedAt, order });
    }
    activities.sort((a, b) => a.order - b.order);
    return {
      paused: this.paused,
      activities: activities.map(({ order: _order, ...activity }) => activity),
    };
  }

  /** `listener(snapshot)` on changes, at most every publishIntervalMs. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #changed() {
    if (this.timer) return;
    const wait = this.lastPublishedAt + this.limits.publishIntervalMs - this.clock.now();
    if (wait <= 0) {
      this.#publish();
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.#publish();
    }, wait);
    this.timer?.unref?.();
  }

  #publish() {
    this.lastPublishedAt = this.clock.now();
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A closed window is cleaned up by its own lifecycle.
      }
    }
  }

  shutdown() {
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
    this.pauseListeners.clear();
    if (this.resume) {
      this.resume.resolve();
      this.resume = null;
    }
  }
}

function createBackgroundActivity(options) {
  return new BackgroundActivity(options);
}

module.exports = {
  ACTIVITY_KINDS,
  BACKGROUND_ACTIVITY_LIMITS,
  BackgroundActivity,
  createBackgroundActivity,
};
