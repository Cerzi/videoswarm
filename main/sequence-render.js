"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChildProcessRunner } = require("./child-process-runner");

/**
 * Single-file export of a sequence (clip-sequences.md, Section 6, tier 2).
 *
 * ffmpeg's concat demuxer joins the clips. When every clip shares codec,
 * frame size, frame rate and audio layout the streams are copied, which is
 * fast and lossless; otherwise each clip is first re-encoded to one common
 * format and the results are joined. Which of the two happens, and why, is
 * decided before anything runs, so the person sees the mismatch first.
 *
 * Bounded, cancellable work with a definite end, run through the same
 * child-process runner as proxy generation. Output is written to a hidden
 * partial file and only takes its final name when complete, never replacing
 * an existing file; a cancel or failure removes the partial and every
 * intermediate.
 */

const RENDER_CODES = Object.freeze({
  UNAVAILABLE: "SEQUENCE_RENDER_UNAVAILABLE",
  BUSY: "SEQUENCE_RENDER_BUSY",
  PLAN_NOT_FOUND: "SEQUENCE_RENDER_PLAN_NOT_FOUND",
  PLAN_EXPIRED: "SEQUENCE_RENDER_PLAN_EXPIRED",
  PROBE_FAILED: "SEQUENCE_RENDER_PROBE_FAILED",
  FAILED: "SEQUENCE_RENDER_FAILED",
  CANCELLED: "SEQUENCE_RENDER_CANCELLED",
});

const RENDER_LIMITS = Object.freeze({
  planTtlMs: 10 * 60 * 1000,
  probeTimeoutMs: 30_000,
  segmentTimeoutMs: 10 * 60 * 1000,
  joinTimeoutMs: 30 * 60 * 1000,
  maxStderrBytes: 256 * 1024,
  maxProbeStdoutBytes: 256 * 1024,
});

const MUXER_BY_EXTENSION = Object.freeze({
  ".mp4": "mp4",
  ".m4v": "mp4",
  ".mov": "mov",
  ".webm": "webm",
  ".mkv": "matroska",
});

class SequenceRenderError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SequenceRenderError";
    this.code = code;
    this.expose = true;
    Object.assign(this, details);
  }
}

const isMissingSpawn = (error) =>
  error?.code === "ENOENT" ||
  error?.cause?.code === "ENOENT" ||
  (error?.code === "SPAWN_ERROR" && /enoent/i.test(String(error?.message || "")));

const isCancelled = (error) =>
  error?.code === "OWNER_CANCELLED" || error?.code === "RUNNER_CANCELLED";

function parseRate(value) {
  if (typeof value !== "string" || !value) return null;
  const [numerator, denominator = "1"] = value.split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** The facts about one clip that decide whether streams can be copied. */
function summarizeProbe(json) {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const video = streams.find((stream) => stream?.codec_type === "video");
  const audio = streams.find((stream) => stream?.codec_type === "audio");
  const durationSeconds = Number(json?.format?.duration);
  return {
    video: video
      ? {
          codec: String(video.codec_name || "unknown"),
          width: Number(video.width) || 0,
          height: Number(video.height) || 0,
          frameRate: String(video.r_frame_rate || video.avg_frame_rate || ""),
          pixelFormat: String(video.pix_fmt || ""),
        }
      : null,
    audio: audio
      ? {
          codec: String(audio.codec_name || "unknown"),
          sampleRate: Number(audio.sample_rate) || 0,
          channels: Number(audio.channels) || 0,
        }
      : null,
    durationMs: Number.isFinite(durationSeconds)
      ? Math.round(durationSeconds * 1000)
      : null,
  };
}

function formatRate(value) {
  const rate = parseRate(value);
  if (!rate) return "unknown fps";
  return `${Number.isInteger(rate) ? rate : rate.toFixed(3).replace(/\.?0+$/u, "")} fps`;
}

function describeGroups(values) {
  const groups = new Map();
  values.forEach((value, index) => {
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(index + 1);
  });
  return [...groups.entries()]
    .map(([value, positions]) => {
      const shown = positions.slice(0, 6).join(", ");
      const more = positions.length > 6 ? ` +${positions.length - 6}` : "";
      return `${value} (${positions.length === 1 ? "position" : "positions"} ${shown}${more})`;
    })
    .join("; ");
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best = values[0];
  for (const value of values) {
    if (counts.get(value) > counts.get(best)) best = value;
  }
  return best;
}

const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/**
 * Decide stream copy or re-encode, and say why. Pure: takes the per-clip
 * summaries in sequence order.
 */
function analyzeSequenceClips(summaries) {
  const clips = Array.isArray(summaries) ? summaries : [];
  const noVideo = clips
    .map((clip, index) => (clip?.video ? null : index + 1))
    .filter(Boolean);
  if (!clips.length || noVideo.length) {
    throw new SequenceRenderError(
      noVideo.length
        ? `No video stream was found at position${noVideo.length === 1 ? "" : "s"} ${noVideo.join(", ")}`
        : "This sequence has no clips",
      RENDER_CODES.PROBE_FAILED
    );
  }
  const checks = [
    ["Codec", (clip) => clip.video.codec],
    ["Frame size", (clip) => `${clip.video.width}×${clip.video.height}`],
    ["Frame rate", (clip) => formatRate(clip.video.frameRate)],
    ["Pixel format", (clip) => clip.video.pixelFormat || "unknown"],
    [
      "Audio",
      (clip) =>
        clip.audio
          ? `${clip.audio.codec} ${clip.audio.sampleRate} Hz ${clip.audio.channels} ch`
          : "none",
    ],
  ];
  const mismatches = [];
  for (const [label, read] of checks) {
    const values = clips.map(read);
    if (new Set(values).size > 1) {
      mismatches.push(`${label} differs: ${describeGroups(values)}`);
    }
  }

  const sizes = clips.map((clip) => `${clip.video.width}x${clip.video.height}`);
  const [width, height] = mostCommon(sizes).split("x").map(Number);
  const rates = clips.map((clip) => clip.video.frameRate);
  const commonRate = mostCommon(rates);
  const frameRate = parseRate(commonRate) || 30;
  const hasAudio = clips.some((clip) => clip.audio);
  const knownDurations = clips.map((clip) => clip.durationMs);
  const totalDurationMs = knownDurations.every((value) => Number.isFinite(value))
    ? knownDurations.reduce((sum, value) => sum + value, 0)
    : null;

  return {
    mode: mismatches.length ? "reencode" : "copy",
    mismatches,
    totalDurationMs,
    target: {
      width: even(width || 1280),
      height: even(height || 720),
      frameRate: Math.round(frameRate * 1000) / 1000,
      // The exact rational (24000/1001, not 23.976) for ffmpeg's fps filter.
      frameRateExpression: parseRate(commonRate) ? commonRate : "30",
      hasAudio,
    },
  };
}

/** A file name from a sequence name, safe on every platform. */
function sanitizeOutputBaseName(name) {
  const cleaned = String(name || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/[. ]+$/u, "")
    .trim()
    .slice(0, 120);
  return cleaned || "sequence";
}

function concatListLine(filePath) {
  return `file '${String(filePath).replace(/'/gu, "'\\''")}'`;
}

function createSequenceRenderer(options = {}) {
  const fsPromises = options.fsPromises || fs.promises;
  const ffmpegPath = options.ffmpegPath || "ffmpeg";
  const ffprobePath = options.ffprobePath || "ffprobe";
  const tempRoot = options.tempRoot || os.tmpdir();
  const now = typeof options.now === "function" ? options.now : Date.now;
  const createId =
    typeof options.createId === "function"
      ? options.createId
      : () => crypto.randomBytes(8).toString("hex");
  const limits = { ...RENDER_LIMITS, ...(options.limits || {}) };
  const runner =
    options.runner ||
    createChildProcessRunner({
      spawn: options.spawn,
      concurrency: 1,
      maxPending: 2,
      timeoutMs: limits.segmentTimeoutMs,
      maxStderrBytes: limits.maxStderrBytes,
    });

  const plans = new Map();
  let active = null;
  let availability = null;

  const run = (command, args, { ownerId, timeoutMs, maxStdoutBytes } = {}) =>
    runner.run(command, args, {
      ownerId,
      timeoutMs,
      maxStdoutBytes: maxStdoutBytes ?? 64 * 1024,
      maxStderrBytes: limits.maxStderrBytes,
      spawnOptions: { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    });

  /**
   * Whether ffmpeg and ffprobe can be run, learned the way proxy generation
   * learns it: by running them. A missing binary is remembered; any other
   * answer is re-checked next time.
   */
  async function checkAvailability({ refresh = false } = {}) {
    if (availability?.available && !refresh) return availability;
    if (availability && availability.missing && !refresh) return availability;
    const probe = async (command) => {
      try {
        const result = await run(command, ["-hide_banner", "-version"], {
          ownerId: "sequence-render:availability",
          timeoutMs: limits.probeTimeoutMs,
        });
        return { ok: true, stdout: result.stdout };
      } catch (error) {
        return { ok: false, missing: isMissingSpawn(error), error };
      }
    };
    const ffmpeg = await probe(ffmpegPath);
    const ffprobe = ffmpeg.ok ? await probe(ffprobePath) : null;
    if (!ffmpeg.ok || !ffprobe?.ok) {
      const which = !ffmpeg.ok ? "FFmpeg" : "ffprobe";
      const missing = !ffmpeg.ok ? ffmpeg.missing : ffprobe.missing;
      availability = {
        available: false,
        missing,
        reason: missing
          ? `${which} was not found. Install FFmpeg (with ffprobe) and make sure it is on your PATH to export one video.`
          : `${which} could not be run, so one-video export is unavailable.`,
      };
      return availability;
    }
    let encoder = "libx264";
    try {
      const encoders = await run(ffmpegPath, ["-hide_banner", "-encoders"], {
        ownerId: "sequence-render:availability",
        timeoutMs: limits.probeTimeoutMs,
        maxStdoutBytes: 1024 * 1024,
      });
      if (!/\slibx264\s/u.test(String(encoders.stdout))) encoder = "mpeg4";
    } catch {
      encoder = "mpeg4";
    }
    availability = { available: true, missing: false, reason: null, encoder };
    return availability;
  }

  async function assertAvailable() {
    const state = await checkAvailability();
    if (!state.available) {
      throw new SequenceRenderError(state.reason, RENDER_CODES.UNAVAILABLE);
    }
    return state;
  }

  async function probeClip(filePath, position) {
    let result;
    try {
      result = await run(
        ffprobePath,
        [
          "-v", "error",
          "-show_entries",
          "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,pix_fmt,sample_rate,channels:format=duration",
          "-of", "json",
          filePath,
        ],
        {
          ownerId: "sequence-render:probe",
          timeoutMs: limits.probeTimeoutMs,
          maxStdoutBytes: limits.maxProbeStdoutBytes,
        }
      );
    } catch (error) {
      if (isMissingSpawn(error)) availability = null;
      throw new SequenceRenderError(
        `The clip at position ${position} (${path.basename(filePath)}) could not be read by ffprobe`,
        RENDER_CODES.PROBE_FAILED,
        { cause: error }
      );
    }
    let json;
    try {
      json = JSON.parse(String(result.stdout || ""));
    } catch (error) {
      throw new SequenceRenderError(
        `ffprobe gave an unreadable answer for position ${position}`,
        RENDER_CODES.PROBE_FAILED,
        { cause: error }
      );
    }
    return summarizeProbe(json);
  }

  async function freeOutputName(directory, baseName, extension) {
    for (let attempt = 1; attempt < 1000; attempt += 1) {
      const name = attempt === 1
        ? `${baseName}${extension}`
        : `${baseName} (${attempt})${extension}`;
      try {
        await fsPromises.lstat(path.join(directory, name));
      } catch (error) {
        if (error?.code === "ENOENT") return name;
        throw error;
      }
    }
    throw new SequenceRenderError(
      "Could not find a free output name",
      RENDER_CODES.FAILED
    );
  }

  /**
   * Probe every clip and decide how to join them. Nothing is written.
   * entries: [{ absolutePath }] in sequence order; destinationDirectory is
   * a folder the person chose in a native dialog.
   */
  async function prepare({ ownerId, entries, destinationDirectory, name, context = null }) {
    const state = await assertAvailable();
    const sources = entries.map((entry) => entry.absolutePath);
    const summaries = [];
    for (const [index, source] of sources.entries()) {
      summaries.push(await probeClip(source, index + 1));
    }
    const analysis = analyzeSequenceClips(summaries);
    const firstExtension = path.extname(sources[0] || "").toLowerCase();
    const sameExtension = sources.every(
      (source) => path.extname(source).toLowerCase() === firstExtension
    );
    const extension =
      analysis.mode === "copy" && sameExtension && MUXER_BY_EXTENSION[firstExtension]
        ? firstExtension === ".m4v" ? ".mp4" : firstExtension
        : analysis.mode === "copy"
          ? ".mkv"
          : ".mp4";
    const outputName = await freeOutputName(
      destinationDirectory,
      sanitizeOutputBaseName(name),
      extension
    );

    for (const [planId, plan] of plans) {
      if (plan.ownerId === ownerId) plans.delete(planId);
    }
    const planId = createId();
    const plan = {
      id: planId,
      ownerId,
      context,
      sources,
      summaries,
      analysis,
      encoder: state.encoder,
      destinationDirectory,
      baseName: sanitizeOutputBaseName(name),
      extension,
      outputName,
      expiresAt: now() + limits.planTtlMs,
    };
    plans.set(planId, plan);
    return {
      planId,
      mode: analysis.mode,
      mismatches: analysis.mismatches,
      target: analysis.target,
      totalDurationMs: analysis.totalDurationMs,
      clipCount: sources.length,
      outputName,
      destinationLabel: path.basename(destinationDirectory) || destinationDirectory,
      encoder: analysis.mode === "reencode" ? state.encoder : null,
    };
  }

  function segmentArgs(plan, index, outputPath) {
    const { width, height, frameRateExpression, hasAudio } = plan.analysis.target;
    const summary = plan.summaries[index];
    const video =
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${frameRateExpression},format=yuv420p`;
    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", plan.sources[index]];
    const addSilence = hasAudio && !summary.audio;
    if (addSilence) {
      args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    }
    args.push("-map", "0:v:0");
    if (hasAudio) args.push("-map", addSilence ? "1:a:0" : "0:a:0");
    args.push("-vf", video);
    if (plan.encoder === "libx264") {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18");
    } else {
      args.push("-c:v", "mpeg4", "-q:v", "2");
    }
    if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2");
    if (addSilence) args.push("-shortest");
    args.push("-f", "mp4", "-y", outputPath);
    return args;
  }

  async function removeQuietly(target, options = {}) {
    try {
      await fsPromises.rm(target, { force: true, ...options });
    } catch {
      // Best effort: nothing more can be done about a file that will not go.
    }
  }

  /**
   * Give the finished partial its final name without replacing anything.
   * A hard link fails if the name is taken; where links are unsupported the
   * name is checked immediately before the rename instead.
   */
  async function placeOutput(plan, partialPath) {
    let name = plan.outputName;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const finalPath = path.join(plan.destinationDirectory, name);
      try {
        await fsPromises.link(partialPath, finalPath);
        await removeQuietly(partialPath);
        return name;
      } catch (error) {
        if (error?.code === "EEXIST") {
          name = await freeOutputName(plan.destinationDirectory, plan.baseName, plan.extension);
          continue;
        }
        if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"].includes(error?.code)) {
          throw error;
        }
        try {
          await fsPromises.lstat(finalPath);
          name = await freeOutputName(plan.destinationDirectory, plan.baseName, plan.extension);
          continue;
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
        }
        await fsPromises.rename(partialPath, finalPath);
        return name;
      }
    }
    throw new SequenceRenderError("Could not place the finished video", RENDER_CODES.FAILED);
  }

  async function execute(plan, job, onProgress) {
    const workDirectory = await fsPromises.mkdtemp(path.join(tempRoot, "videoswarm-sequence-"));
    job.workDirectory = workDirectory;
    const partialPath = path.join(
      plan.destinationDirectory,
      `.${plan.outputName}.partial-${plan.id}`
    );
    job.partialPath = partialPath;
    const ownerId = job.runnerOwnerId;
    const assertLive = () => {
      if (job.cancelled) {
        throw new SequenceRenderError("Export cancelled", RENDER_CODES.CANCELLED);
      }
    };
    try {
      let inputs = plan.sources;
      if (plan.analysis.mode === "reencode") {
        inputs = [];
        for (const [index] of plan.sources.entries()) {
          assertLive();
          onProgress?.({ phase: "encoding", index: index + 1, total: plan.sources.length });
          assertLive();
          const segment = path.join(workDirectory, `segment-${String(index).padStart(4, "0")}.mp4`);
          await run(ffmpegPath, segmentArgs(plan, index, segment), {
            ownerId,
            timeoutMs: limits.segmentTimeoutMs,
          });
          inputs.push(segment);
        }
      }
      assertLive();
      onProgress?.({ phase: "joining", index: plan.sources.length, total: plan.sources.length });
      assertLive();
      const listPath = path.join(workDirectory, "concat.txt");
      await fsPromises.writeFile(
        listPath,
        `${inputs.map(concatListLine).join("\n")}\n`,
        "utf8"
      );
      const muxer = plan.analysis.mode === "copy"
        ? MUXER_BY_EXTENSION[plan.extension] || "matroska"
        : "mp4";
      const joinArgs = [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-map", "0:v", "-map", "0:a?",
        "-c", "copy",
      ];
      if (muxer === "mp4" || muxer === "mov") joinArgs.push("-movflags", "+faststart");
      joinArgs.push("-f", muxer, "-n", partialPath);
      await run(ffmpegPath, joinArgs, { ownerId, timeoutMs: limits.joinTimeoutMs });
      assertLive();
      const outputName = await placeOutput(plan, partialPath);
      return { outputName };
    } finally {
      await removeQuietly(workDirectory, { recursive: true });
      await removeQuietly(partialPath);
    }
  }

  function take(ownerId, planId) {
    const plan = plans.get(planId);
    if (!plan || plan.ownerId !== ownerId) {
      throw new SequenceRenderError(
        "This export is no longer available; start it again",
        RENDER_CODES.PLAN_NOT_FOUND
      );
    }
    plans.delete(planId);
    if (plan.expiresAt <= now()) {
      throw new SequenceRenderError(
        "This export expired; choose the folder again",
        RENDER_CODES.PLAN_EXPIRED
      );
    }
    return plan;
  }

  async function start({ ownerId, planId, onProgress, assertActive }) {
    if (active) {
      throw new SequenceRenderError("Another export is running", RENDER_CODES.BUSY);
    }
    const plan = take(ownerId, planId);
    assertActive?.(plan.context);
    const job = {
      planId,
      ownerId,
      runnerOwnerId: `sequence-render:${planId}`,
      cancelled: false,
    };
    active = job;
    try {
      const { outputName } = await execute(plan, job, (progress) =>
        onProgress?.({ planId, ...progress })
      );
      onProgress?.({ planId, phase: "complete" });
      return { cancelled: false, outputName, mode: plan.analysis.mode };
    } catch (error) {
      if (job.cancelled || isCancelled(error) || error?.code === RENDER_CODES.CANCELLED) {
        return { cancelled: true, outputName: null, mode: plan.analysis.mode };
      }
      if (isMissingSpawn(error)) availability = null;
      if (error instanceof SequenceRenderError) throw error;
      const detail = String(error?.stderr || "").trim().split("\n").pop();
      throw new SequenceRenderError(
        `ffmpeg could not export the sequence${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        RENDER_CODES.FAILED,
        { cause: error }
      );
    } finally {
      if (active === job) active = null;
    }
  }

  function cancel({ ownerId, planId }) {
    if (!active || active.planId !== planId || active.ownerId !== ownerId) {
      return { cancelled: false };
    }
    active.cancelled = true;
    runner.cancelOwner(active.runnerOwnerId, "Sequence export was cancelled");
    return { cancelled: true };
  }

  function cancelOwner(ownerId) {
    for (const [planId, plan] of plans) {
      if (plan.ownerId === ownerId) plans.delete(planId);
    }
    if (active && active.ownerId === ownerId) {
      active.cancelled = true;
      runner.cancelOwner(active.runnerOwnerId, "Sequence export owner went away");
    }
  }

  function shutdown() {
    plans.clear();
    if (active) {
      active.cancelled = true;
      runner.cancelOwner(active.runnerOwnerId, "Shutting down");
    }
    return runner.shutdown?.();
  }

  return {
    checkAvailability,
    prepare,
    start,
    cancel,
    cancelOwner,
    shutdown,
    get busy() {
      return Boolean(active);
    },
  };
}

module.exports = {
  RENDER_CODES,
  SequenceRenderError,
  analyzeSequenceClips,
  createSequenceRenderer,
  sanitizeOutputBaseName,
  summarizeProbe,
};
