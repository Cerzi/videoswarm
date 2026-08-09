const { createChildProcessRunner } = require("./child-process-runner");

const LAST_FRAME_CAPTURE_LIMITS = Object.freeze({
  concurrency: 1,
  maxPending: 2,
  timeoutMs: 30_000,
  maxStdoutBytes: 64 * 1024 * 1024,
  maxStderrBytes: 256 * 1024,
  killGraceMs: 500,
});

// Bound decoded clipboard geometry before Electron's nativeImage decoder sees
// the PNG. The min() expressions prevent upscaling smaller source frames.
const LAST_FRAME_MAX_WIDTH = 3840;
const LAST_FRAME_MAX_HEIGHT = 2160;
const LAST_FRAME_SCALE_FILTER =
  `scale=w='min(iw,${LAST_FRAME_MAX_WIDTH})':` +
  `h='min(ih,${LAST_FRAME_MAX_HEIGHT})':` +
  "force_original_aspect_ratio=decrease:force_divisible_by=2";

function normalizeSeekSeconds(value) {
  if (value === null || value === undefined) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    const error = new Error("A frame timestamp must be a non-negative number");
    error.code = "INVALID_TIMESTAMP";
    throw error;
  }
  // Millisecond precision is finer than any real frame interval and keeps the
  // argument free of exponential notation, which ffmpeg will not parse.
  return seconds.toFixed(3);
}

/**
 * Without a timestamp this extracts the final frame, which is what the
 * clip-level "copy last frame" action wants. With one it extracts the frame at
 * that position: `-ss` before `-i` seeks on the input, and ffmpeg's default
 * accurate seek then decodes forward to the exact timestamp rather than
 * stopping at the preceding keyframe.
 */
function createFfmpegLastFrameArgs(filePath, atSeconds = null) {
  const seek = normalizeSeekSeconds(atSeconds);
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(seek === null ? ["-sseof", "-0.1"] : ["-ss", seek]),
    "-i",
    filePath,
    "-vf",
    LAST_FRAME_SCALE_FILTER,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "pipe:1",
  ];
}

class LastFrameCaptureService {
  constructor(options = {}) {
    this.command = options.command || "ffmpeg";
    this.runner =
      options.runner ||
      createChildProcessRunner({
        ...LAST_FRAME_CAPTURE_LIMITS,
        ...(options.spawn ? { spawn: options.spawn } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
      });
  }

  async capture(filePath, { ownerId = null, atSeconds = null } = {}) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      const error = new Error("A non-empty video path is required");
      error.code = "INVALID_PATH";
      throw error;
    }
    const result = await this.runner.run(
      this.command,
      createFfmpegLastFrameArgs(filePath, atSeconds),
      {
        ownerId,
        spawnOptions: {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      }
    );
    if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
      const error = new Error("ffmpeg returned an empty image");
      error.code = "EMPTY_IMAGE";
      throw error;
    }
    return result.stdout;
  }

  cancelOwner(ownerId) {
    return this.runner.cancelOwner(ownerId, "Frame-capture owner was destroyed");
  }

  cancelAll(reason = "Frame capture was invalidated") {
    return this.runner.cancelAll(reason);
  }

  shutdown() {
    return this.runner.shutdown("Frame-capture service is shutting down");
  }

  getSnapshot() {
    return this.runner.getSnapshot();
  }
}

function createLastFrameCaptureService(options) {
  return new LastFrameCaptureService(options);
}

module.exports = {
  LAST_FRAME_CAPTURE_LIMITS,
  LAST_FRAME_MAX_HEIGHT,
  LAST_FRAME_MAX_WIDTH,
  LAST_FRAME_SCALE_FILTER,
  LastFrameCaptureService,
  createFfmpegLastFrameArgs,
  createLastFrameCaptureService,
};
