const { spawn: defaultSpawn } = require("child_process");

const DEFAULTS = Object.freeze({
  concurrency: 1,
  maxPending: 4,
  timeoutMs: 30_000,
  maxStdoutBytes: 64 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  killGraceMs: 500,
});

function finiteInteger(value, fallback, minimum = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.floor(numeric));
}

function normalizeOwnerId(ownerId) {
  if (ownerId === null || ownerId === undefined || ownerId === "") return null;
  return String(ownerId);
}

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

class ChildProcessRunError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ChildProcessRunError";
    this.code = code;
    Object.assign(this, details);
  }
}

function createRunError(code, message, job = null, details = {}) {
  return new ChildProcessRunError(code, message, {
    ...(job
      ? {
          jobId: job.id,
          ownerId: job.ownerId,
          command: job.command,
        }
      : {}),
    ...details,
  });
}

class ChildProcessRunner {
  constructor(options = {}) {
    this.spawn = typeof options.spawn === "function" ? options.spawn : defaultSpawn;
    this.clock = options.clock || defaultClock();
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
    this.killGraceMs = finiteInteger(
      options.killGraceMs,
      DEFAULTS.killGraceMs,
      0
    );

    this.sequence = 0;
    this.pending = [];
    this.active = new Map();
    this.closed = false;
    this.shutdownPromise = null;
    this.totals = {
      accepted: 0,
      rejected: 0,
      started: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      timedOut: 0,
      outputLimited: 0,
    };
  }

  run(command, args = [], options = {}) {
    if (this.closed) {
      this.totals.rejected += 1;
      return Promise.reject(
        createRunError("RUNNER_SHUTDOWN", "Child-process runner is shut down")
      );
    }
    if (typeof command !== "string" || command.trim().length === 0) {
      this.totals.rejected += 1;
      return Promise.reject(
        createRunError("INVALID_COMMAND", "A non-empty child-process command is required")
      );
    }
    if (this.active.size >= this.concurrency && this.pending.length >= this.maxPending) {
      this.totals.rejected += 1;
      return Promise.reject(
        createRunError("QUEUE_FULL", "Child-process queue is full", null, {
          maxPending: this.maxPending,
        })
      );
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const job = {
      id: ++this.sequence,
      command: command.trim(),
      args: Array.isArray(args) ? args.slice() : [],
      ownerId: normalizeOwnerId(options.ownerId),
      spawnOptions: options.spawnOptions || {},
      timeoutMs: finiteInteger(options.timeoutMs, this.timeoutMs, 1),
      maxStdoutBytes: finiteInteger(
        options.maxStdoutBytes,
        this.maxStdoutBytes,
        0
      ),
      maxStderrBytes: finiteInteger(
        options.maxStderrBytes,
        this.maxStderrBytes,
        0
      ),
      rejectOnNonZero: options.rejectOnNonZero !== false,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
      acceptedAt: this.clock.now(),
      startedAt: null,
      process: null,
      settled: false,
      terminationError: null,
      timeoutTimer: null,
      killTimer: null,
      stdoutChunks: [],
      stderrChunks: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      listeners: null,
    };

    this.pending.push(job);
    this.totals.accepted += 1;
    this.#pump();
    return promise;
  }

  cancelOwner(ownerId, reason = "Child-process owner was cancelled") {
    const normalizedOwnerId = normalizeOwnerId(ownerId);
    if (normalizedOwnerId === null) return 0;
    const errorFor = (job) =>
      createRunError("OWNER_CANCELLED", reason, job, { cancelled: true });
    return this.#cancelMatching(
      (job) => job.ownerId === normalizedOwnerId,
      errorFor
    );
  }

  cancelAll(reason = "Child-process work was cancelled") {
    const errorFor = (job) =>
      createRunError("RUNNER_CANCELLED", reason, job, { cancelled: true });
    return this.#cancelMatching(() => true, errorFor);
  }

  shutdown(reason = "Child-process runner is shutting down") {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    const activePromises = Array.from(this.active.values(), (job) => job.promise);
    const pendingPromises = this.pending.map((job) => job.promise);
    this.cancelAll(reason);
    this.shutdownPromise = Promise.allSettled([
      ...activePromises,
      ...pendingPromises,
    ]).then(() => this.getSnapshot());
    return this.shutdownPromise;
  }

  getSnapshot() {
    const owners = {};
    const countOwner = (job, state) => {
      const key = job.ownerId ?? "<unowned>";
      if (!owners[key]) owners[key] = { active: 0, pending: 0 };
      owners[key][state] += 1;
    };
    for (const job of this.active.values()) countOwner(job, "active");
    for (const job of this.pending) countOwner(job, "pending");

    return {
      closed: this.closed,
      concurrency: this.concurrency,
      maxPending: this.maxPending,
      active: this.active.size,
      pending: this.pending.length,
      owners,
      totals: { ...this.totals },
    };
  }

  #pump() {
    if (this.closed) return;
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job || job.settled) continue;
      this.#start(job);
    }
  }

  #start(job) {
    job.startedAt = this.clock.now();
    this.active.set(job.id, job);
    this.totals.started += 1;

    let child;
    try {
      child = this.spawn(job.command, job.args, job.spawnOptions);
      job.process = child;
    } catch (cause) {
      this.#settle(
        job,
        createRunError("SPAWN_ERROR", `Failed to spawn ${job.command}`, job, {
          cause,
        })
      );
      return;
    }

    const handleStdout = (chunk) => this.#handleOutput(job, "stdout", chunk);
    const handleStderr = (chunk) => this.#handleOutput(job, "stderr", chunk);
    const handleError = (cause) => {
      const error =
        job.terminationError ||
        createRunError("SPAWN_ERROR", `Failed to run ${job.command}`, job, {
          cause,
        });
      this.#settle(job, error);
    };
    const handleClose = (code, signal) => {
      if (job.terminationError) {
        this.#settle(job, job.terminationError, { code, signal });
        return;
      }
      if (job.rejectOnNonZero && Number(code) !== 0) {
        this.#settle(
          job,
          createRunError(
            "PROCESS_EXIT",
            `${job.command} exited with code ${code}`,
            job,
            { exitCode: code, signal }
          ),
          { code, signal }
        );
        return;
      }
      this.#settle(job, null, { code, signal });
    };

    job.listeners = {
      handleStdout,
      handleStderr,
      handleError,
      handleClose,
    };
    child?.stdout?.on?.("data", handleStdout);
    child?.stderr?.on?.("data", handleStderr);
    child?.once?.("error", handleError);
    child?.once?.("close", handleClose);

    job.timeoutTimer = this.clock.setTimeout(() => {
      const error = createRunError(
        "PROCESS_TIMEOUT",
        `${job.command} exceeded its ${job.timeoutMs}ms timeout`,
        job,
        { timeoutMs: job.timeoutMs }
      );
      this.#terminate(job, error);
    }, job.timeoutMs);
    job.timeoutTimer?.unref?.();
  }

  #handleOutput(job, streamName, chunk) {
    if (job.settled || job.terminationError) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
    const isStdout = streamName === "stdout";
    const bytesKey = isStdout ? "stdoutBytes" : "stderrBytes";
    const chunksKey = isStdout ? "stdoutChunks" : "stderrChunks";
    const limit = isStdout ? job.maxStdoutBytes : job.maxStderrBytes;
    const nextSize = job[bytesKey] + buffer.length;
    if (nextSize > limit) {
      const error = createRunError(
        isStdout ? "STDOUT_LIMIT" : "STDERR_LIMIT",
        `${job.command} exceeded its ${streamName} limit`,
        job,
        { limitBytes: limit }
      );
      this.#terminate(job, error);
      return;
    }
    job[bytesKey] = nextSize;
    job[chunksKey].push(buffer);
  }

  #terminate(job, error) {
    if (!job || job.settled) return false;
    if (!job.terminationError) job.terminationError = error;
    if (!job.process) {
      this.#settle(job, job.terminationError);
      return true;
    }

    try {
      job.process.kill?.("SIGTERM");
    } catch {}

    if (!job.killTimer) {
      job.killTimer = this.clock.setTimeout(() => {
        if (job.settled) return;
        try {
          job.process?.kill?.("SIGKILL");
        } catch {}
        // A broken or mocked child may never emit close. Once SIGKILL has been
        // requested, release the queue slot and reject deterministically.
        this.#settle(job, job.terminationError);
      }, this.killGraceMs);
      job.killTimer?.unref?.();
    }
    return true;
  }

  #cancelMatching(predicate, errorFactory) {
    let cancelled = 0;
    const retained = [];
    for (const job of this.pending) {
      if (job.settled || !predicate(job)) {
        retained.push(job);
        continue;
      }
      cancelled += 1;
      this.#rejectQueued(job, errorFactory(job));
    }
    this.pending = retained;

    for (const job of this.active.values()) {
      if (job.settled || !predicate(job)) continue;
      cancelled += 1;
      this.#terminate(job, errorFactory(job));
    }
    return cancelled;
  }

  #rejectQueued(job, error) {
    if (job.settled) return;
    job.settled = true;
    this.#recordFailure(error);
    job.reject(error);
  }

  #settle(job, error = null, result = {}) {
    if (!job || job.settled) return false;
    job.settled = true;
    if (job.timeoutTimer) this.clock.clearTimeout(job.timeoutTimer);
    if (job.killTimer) this.clock.clearTimeout(job.killTimer);
    job.timeoutTimer = null;
    job.killTimer = null;

    const child = job.process;
    const listeners = job.listeners;
    if (listeners) {
      child?.stdout?.removeListener?.("data", listeners.handleStdout);
      child?.stderr?.removeListener?.("data", listeners.handleStderr);
      child?.removeListener?.("error", listeners.handleError);
      child?.removeListener?.("close", listeners.handleClose);
    }
    job.listeners = null;
    this.active.delete(job.id);

    const stdout = Buffer.concat(job.stdoutChunks, job.stdoutBytes);
    const stderr = Buffer.concat(job.stderrChunks, job.stderrBytes);
    const finishedAt = this.clock.now();
    const common = {
      jobId: job.id,
      ownerId: job.ownerId,
      command: job.command,
      exitCode: result.code ?? null,
      signal: result.signal ?? null,
      stdout,
      stderr,
      durationMs: Math.max(0, finishedAt - (job.startedAt ?? job.acceptedAt)),
    };

    job.stdoutChunks = [];
    job.stderrChunks = [];
    job.process = null;

    if (error) {
      Object.assign(error, common);
      this.#recordFailure(error);
      job.reject(error);
    } else {
      this.totals.completed += 1;
      job.resolve({ ...common, code: common.exitCode });
    }

    queueMicrotask(() => this.#pump());
    return true;
  }

  #recordFailure(error) {
    this.totals.failed += 1;
    if (error?.code === "OWNER_CANCELLED" || error?.code === "RUNNER_CANCELLED") {
      this.totals.cancelled += 1;
    }
    if (error?.code === "PROCESS_TIMEOUT") this.totals.timedOut += 1;
    if (error?.code === "STDOUT_LIMIT" || error?.code === "STDERR_LIMIT") {
      this.totals.outputLimited += 1;
    }
  }
}

function createChildProcessRunner(options) {
  return new ChildProcessRunner(options);
}

module.exports = {
  ChildProcessRunError,
  ChildProcessRunner,
  createChildProcessRunner,
  DEFAULT_CHILD_PROCESS_LIMITS: DEFAULTS,
};
