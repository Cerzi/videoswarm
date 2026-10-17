const os = require("os");
const fs = require("fs");
const path = require("path");
const { createChildProcessRunner } = require("./child-process-runner");

// First frames for prompt stacks (docs/architecture/prompt-stacks.md,
// Section 8). Two things per clip, both from its first frame:
//
// - a fingerprint: the frame shrunk to 9x8 greys and reduced to 64 bits
//   (a difference hash), so the renderer can tell which clip in a stack is
//   most typical and which differ most. Stored per content, grabbed once.
// - a small still for the stack card's strip, kept in memory only.
//
// Only clips in stacks are asked for, never the whole library. ffmpeg runs
// at low priority, two at a time; without ffmpeg there are no fingerprints
// or stills and stacks look as they did before.

const FRAME_FINGERPRINT_VERSION = 1;

const STACK_FRAME_LIMITS = Object.freeze({
  concurrency: 2,
  maxPending: 10_000,
  timeoutMs: 20_000,
  maxStdoutBytes: 512 * 1024,
  maxStderrBytes: 64 * 1024,
  killGraceMs: 500,
  stillWidth: 240,
  maxCachedStills: 600,
  publishIntervalMs: 500,
});

const BASE_ARGS = ["-nostdin", "-hide_banner", "-loglevel", "error"];

function fingerprintArgs(filePath) {
  return [
    ...BASE_ARGS,
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    "scale=9:8:flags=area,format=gray",
    "-f",
    "rawvideo",
    "pipe:1",
  ];
}

function stillArgs(filePath, width = STACK_FRAME_LIMITS.stillWidth) {
  return [
    ...BASE_ARGS,
    "-i",
    filePath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:-2`,
    "-q:v",
    "6",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ];
}

/** A 9x8 grey frame as a 64-bit difference hash, in 16 hex digits. */
function differenceHash(gray) {
  if (!Buffer.isBuffer(gray) || gray.length < 72) {
    const error = new Error("ffmpeg returned too few pixels for a fingerprint");
    error.code = "BAD_FRAME";
    throw error;
  }
  let hex = "";
  for (let row = 0; row < 8; row += 1) {
    let byte = 0;
    for (let column = 0; column < 8; column += 1) {
      const at = row * 9 + column;
      byte = (byte << 1) | (gray[at] > gray[at + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

const isFrameFingerprint = (value) => typeof value === "string" && /^[0-9a-f]{16}$/u.test(value);

function isInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isMissingCommand(error) {
  return error?.code === "ENOENT" || error?.cause?.code === "ENOENT" || /ENOENT/u.test(String(error?.message));
}

class StackFrameService {
  constructor(options = {}) {
    this.limits = { ...STACK_FRAME_LIMITS, ...(options.limits || {}) };
    this.command = options.command || "ffmpeg";
    this.fsPromises = options.fsPromises || fs.promises;
    this.runner =
      options.runner ||
      createChildProcessRunner({
        concurrency: this.limits.concurrency,
        maxPending: this.limits.maxPending,
        timeoutMs: this.limits.timeoutMs,
        maxStdoutBytes: this.limits.maxStdoutBytes,
        maxStderrBytes: this.limits.maxStderrBytes,
        killGraceMs: this.limits.killGraceMs,
      });
    // Reports each fingerprint grab (main/background-activity.js).
    this.activity = options.activity || null;
    this.ffmpegAvailable = null;
    this.inFlight = new Map(); // content fingerprint -> Promise<hash|null>
    this.stills = new Map(); // content fingerprint -> data URL, oldest first
    this.stillsInFlight = new Map();
  }

  async _contained(row) {
    const [realRoot, realFile] = await Promise.all([
      this.fsPromises.realpath(row.rootPath).then(path.resolve, () => null),
      this.fsPromises.realpath(row.absolutePath).then(path.resolve, () => null),
    ]);
    return Boolean(realRoot && realFile && isInside(realRoot, realFile));
  }

  async _run(args, ownerId, { holdWhilePaused = true } = {}) {
    if (this.ffmpegAvailable === false) return null;
    try {
      const result = await this.runner.run(this.command, args, {
        ownerId,
        holdWhilePaused,
        priority: os.constants.priority.PRIORITY_BELOW_NORMAL,
        spawnOptions: { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      });
      this.ffmpegAvailable = true;
      return result.stdout;
    } catch (error) {
      if (isMissingCommand(error)) this.ffmpegAvailable = false;
      throw error;
    }
  }

  /**
   * Fingerprints for catalog rows `{ fingerprint, absolutePath, rootPath }`
   * that have none yet. Each content is grabbed once, however many rows name
   * it. `onResult(fingerprint, hash)` follows each grab; failures are skipped.
   */
  fingerprintRows(rows, { ownerId = null, onResult } = {}) {
    const work = [];
    for (const row of rows) {
      if (!row?.fingerprint || !row.absolutePath) continue;
      if (!this.inFlight.has(row.fingerprint)) {
        this.activity?.queued("stack-frames");
        const task = (async () => {
          if (!(await this._contained(row))) return null;
          const gray = await this._run(fingerprintArgs(row.absolutePath), ownerId);
          return gray ? differenceHash(gray) : null;
        })()
          .catch(() => null)
          .finally(() => {
            this.inFlight.delete(row.fingerprint);
            this.activity?.settled("stack-frames");
          });
        this.inFlight.set(row.fingerprint, task);
        work.push(
          task.then((hash) => {
            if (hash) onResult?.(row.fingerprint, hash);
          })
        );
      }
    }
    return Promise.all(work);
  }

  _rememberStill(fingerprint, dataUrl) {
    this.stills.delete(fingerprint);
    this.stills.set(fingerprint, dataUrl);
    while (this.stills.size > this.limits.maxCachedStills) {
      this.stills.delete(this.stills.keys().next().value);
    }
  }

  /** A small JPEG still of a row's first frame, as a data URL, or null. */
  async still(row, { ownerId = null } = {}) {
    if (!row?.fingerprint || !row.absolutePath) return null;
    if (this.stills.has(row.fingerprint)) {
      const cached = this.stills.get(row.fingerprint);
      this._rememberStill(row.fingerprint, cached);
      return cached;
    }
    if (!this.stillsInFlight.has(row.fingerprint)) {
      const task = (async () => {
        if (!(await this._contained(row))) return null;
        const jpeg = await this._run(stillArgs(row.absolutePath, this.limits.stillWidth), ownerId, {
          holdWhilePaused: false,
        });
        if (!jpeg || jpeg.length === 0) return null;
        const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
        this._rememberStill(row.fingerprint, dataUrl);
        return dataUrl;
      })()
        .catch(() => null)
        .finally(() => this.stillsInFlight.delete(row.fingerprint));
      this.stillsInFlight.set(row.fingerprint, task);
    }
    return this.stillsInFlight.get(row.fingerprint);
  }

  /**
   * Paused, queued fingerprints wait and running ones finish. A strip's
   * stills are for a card on screen, so they still come.
   */
  setPaused(paused) {
    this.runner.setPaused?.(paused === true);
  }

  cancelOwner(ownerId) {
    return this.runner.cancelOwner(ownerId, "Stack frame owner was destroyed");
  }

  cancelAll(reason = "Stack frames were invalidated") {
    this.stills.clear();
    return this.runner.cancelAll(reason);
  }

  shutdown() {
    return this.runner.shutdown("Stack frame service is shutting down");
  }
}

function createStackFrameService(options) {
  return new StackFrameService(options);
}

module.exports = {
  FRAME_FINGERPRINT_VERSION,
  STACK_FRAME_LIMITS,
  StackFrameService,
  createStackFrameService,
  differenceHash,
  fingerprintArgs,
  isFrameFingerprint,
  stillArgs,
};
