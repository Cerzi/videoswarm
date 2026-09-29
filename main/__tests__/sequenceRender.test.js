import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  RENDER_CODES,
  analyzeSequenceClips,
  createSequenceRenderer,
  sanitizeOutputBaseName,
  summarizeProbe,
} = require("../sequence-render");

const fsp = fs.promises;
const temporaryDirectories = [];
const renderers = [];

async function temporaryDirectory(label) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), `${label}-`));
  const canonical = await fsp.realpath(directory);
  temporaryDirectories.push(canonical);
  return canonical;
}

afterEach(async () => {
  while (renderers.length) await renderers.pop().shutdown();
  while (temporaryDirectories.length) {
    await fsp.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

const clip = ({ codec = "h264", width = 320, height = 240, rate = "25/1", audio = null, durationMs = 1000 } = {}) => ({
  video: { codec, width, height, frameRate: rate, pixelFormat: "yuv420p" },
  audio,
  durationMs,
});

describe("analyzeSequenceClips", () => {
  it("copies streams when every clip matches", () => {
    const analysis = analyzeSequenceClips([clip(), clip(), clip({ durationMs: 1500 })]);
    expect(analysis).toMatchObject({
      mode: "copy",
      mismatches: [],
      totalDurationMs: 3500,
      target: { width: 320, height: 240, frameRate: 25, hasAudio: false },
    });
  });

  it("re-encodes on any mismatch and names what differs and where", () => {
    const stereo = { codec: "aac", sampleRate: 48000, channels: 2 };
    const analysis = analyzeSequenceClips([
      clip({ audio: stereo }),
      clip({ width: 1920, height: 1080, rate: "24000/1001", audio: stereo }),
      clip(),
    ]);
    expect(analysis.mode).toBe("reencode");
    expect(analysis.mismatches).toEqual([
      "Frame size differs: 320×240 (positions 1, 3); 1920×1080 (position 2)",
      "Frame rate differs: 25 fps (positions 1, 3); 23.976 fps (position 2)",
      "Audio differs: aac 48000 Hz 2 ch (positions 1, 2); none (position 3)",
    ]);
    // The most common format wins; silence fills clips without audio.
    expect(analysis.target).toEqual({
      width: 320,
      height: 240,
      frameRate: 25,
      frameRateExpression: "25/1",
      hasAudio: true,
    });
  });

  it("refuses a clip without a video stream", () => {
    expect(() => analyzeSequenceClips([clip(), { video: null, audio: null }])).toThrow(
      expect.objectContaining({ code: RENDER_CODES.PROBE_FAILED, message: expect.stringMatching(/position 2/) })
    );
  });

  it("reads ffprobe's JSON", () => {
    expect(
      summarizeProbe({
        streams: [
          { codec_type: "video", codec_name: "h264", width: 64, height: 48, r_frame_rate: "30/1", pix_fmt: "yuv420p" },
          { codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 1 },
        ],
        format: { duration: "2.500000" },
      })
    ).toEqual({
      video: { codec: "h264", width: 64, height: 48, frameRate: "30/1", pixelFormat: "yuv420p" },
      audio: { codec: "aac", sampleRate: 44100, channels: 1 },
      durationMs: 2500,
    });
  });

  it("makes a safe file name from a sequence name", () => {
    expect(sanitizeOutputBaseName('Act: one/two?')).toBe("Act_ one_two_");
    expect(sanitizeOutputBaseName("  ")).toBe("sequence");
    expect(sanitizeOutputBaseName("trailing. ")).toBe("trailing");
  });
});

describe("availability", () => {
  it("is unavailable, with a stated reason, when ffmpeg is not installed", async () => {
    const spawn = () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    };
    const renderer = createSequenceRenderer({ spawn });
    renderers.push(renderer);
    const state = await renderer.checkAvailability();
    expect(state).toMatchObject({ available: false, missing: true });
    expect(state.reason).toMatch(/FFmpeg was not found/);

    await expect(
      renderer.prepare({ ownerId: 1, entries: [{ absolutePath: "/x.mp4" }], destinationDirectory: "/tmp", name: "x" })
    ).rejects.toMatchObject({ code: RENDER_CODES.UNAVAILABLE });
  });
});

const hasFfmpeg =
  spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0 &&
  spawnSync("ffprobe", ["-hide_banner", "-version"]).status === 0;

function makeClip(filePath, { size = "320x240", rate = 25, seconds = 1, audio = false } = {}) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}:duration=${seconds}`,
  ];
  if (audio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(filePath);
  const result = spawnSync("ffmpeg", args);
  if (result.status !== 0) throw new Error(String(result.stderr));
  return filePath;
}

function probe(filePath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,width,height",
    "-of", "json", filePath,
  ]);
  return JSON.parse(String(result.stdout));
}

describe.skipIf(!hasFfmpeg)("exporting with the real ffmpeg", () => {
  async function setup() {
    const library = await temporaryDirectory("vs-render-library");
    const destination = await temporaryDirectory("vs-render-destination");
    const tempRoot = await temporaryDirectory("vs-render-temp");
    const renderer = createSequenceRenderer({ tempRoot });
    renderers.push(renderer);
    return { library, destination, tempRoot, renderer };
  }

  it("stream-copies uniform clips into one file as long as their sum, within one frame", async () => {
    const { library, destination, tempRoot, renderer } = await setup();
    const sources = [
      makeClip(path.join(library, "a.mp4"), { seconds: 1 }),
      makeClip(path.join(library, "b.mp4"), { seconds: 2 }),
      makeClip(path.join(library, "c.mp4"), { seconds: 1 }),
    ];
    const entries = [sources[1], sources[0], sources[2], sources[0]].map((absolutePath) => ({ absolutePath }));
    const expected = entries.reduce(
      (sum, entry) => sum + Number(probe(entry.absolutePath).format.duration),
      0
    );

    const plan = await renderer.prepare({ ownerId: 1, entries, destinationDirectory: destination, name: "Act one" });
    expect(plan).toMatchObject({ mode: "copy", mismatches: [], outputName: "Act one.mp4", clipCount: 4 });

    const progress = [];
    const result = await renderer.start({ ownerId: 1, planId: plan.planId, onProgress: (event) => progress.push(event.phase) });
    expect(result).toEqual({ cancelled: false, outputName: "Act one.mp4", mode: "copy" });
    expect(progress).toEqual(["joining", "complete"]);
    expect(await fsp.readdir(destination)).toEqual(["Act one.mp4"]);
    const duration = Number(probe(path.join(destination, "Act one.mp4")).format.duration);
    expect(Math.abs(duration - expected)).toBeLessThanOrEqual(1 / 25);
    // Intermediates are gone.
    expect(await fsp.readdir(tempRoot)).toEqual([]);
  }, 60_000);

  it("never replaces an existing file", async () => {
    const { library, destination, renderer } = await setup();
    const source = makeClip(path.join(library, "a.mp4"));
    await fsp.writeFile(path.join(destination, "Act one.mp4"), "keep me");

    const plan = await renderer.prepare({ ownerId: 1, entries: [{ absolutePath: source }], destinationDirectory: destination, name: "Act one" });
    expect(plan.outputName).toBe("Act one (2).mp4");
    // Someone takes that name too while the export waits.
    await fsp.writeFile(path.join(destination, "Act one (2).mp4"), "and me");
    const result = await renderer.start({ ownerId: 1, planId: plan.planId });

    expect(result.outputName).toBe("Act one (3).mp4");
    expect(await fsp.readFile(path.join(destination, "Act one.mp4"), "utf8")).toBe("keep me");
    expect(await fsp.readFile(path.join(destination, "Act one (2).mp4"), "utf8")).toBe("and me");
    expect((await fsp.readdir(destination)).sort()).toEqual([
      "Act one (2).mp4",
      "Act one (3).mp4",
      "Act one.mp4",
    ]);
  }, 60_000);

  it("reports mixed formats before running, then re-encodes to one format", async () => {
    const { library, destination, renderer } = await setup();
    const entries = [
      makeClip(path.join(library, "a.mp4"), { audio: true }),
      makeClip(path.join(library, "b.mp4"), { audio: true }),
      makeClip(path.join(library, "small.mp4"), { size: "160x120" }),
    ].map((absolutePath) => ({ absolutePath }));

    const plan = await renderer.prepare({ ownerId: 1, entries, destinationDirectory: destination, name: "Mixed" });
    expect(plan.mode).toBe("reencode");
    expect(plan.mismatches).toEqual(
      expect.arrayContaining([
        "Frame size differs: 320×240 (positions 1, 2); 160×120 (position 3)",
        expect.stringMatching(/^Audio differs: aac 48000 Hz \d ch \(positions 1, 2\); none \(position 3\)$/),
      ])
    );
    expect(plan.outputName).toBe("Mixed.mp4");

    const progress = [];
    const result = await renderer.start({ ownerId: 1, planId: plan.planId, onProgress: (event) => progress.push(`${event.phase}:${event.index ?? ""}`) });
    expect(result).toMatchObject({ cancelled: false, outputName: "Mixed.mp4", mode: "reencode" });
    expect(progress).toEqual(["encoding:1", "encoding:2", "encoding:3", "joining:3", "complete:"]);
    const output = probe(path.join(destination, "Mixed.mp4"));
    const video = output.streams.find((stream) => stream.codec_type === "video");
    expect([video.width, video.height]).toEqual([320, 240]);
    expect(output.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
    expect(Number(output.format.duration)).toBeGreaterThan(2.8);
  }, 120_000);

  it("leaves no partial output or intermediates when cancelled", async () => {
    const { library, destination, tempRoot, renderer } = await setup();
    const entries = [
      makeClip(path.join(library, "a.mp4"), { seconds: 3 }),
      makeClip(path.join(library, "b.mp4"), { seconds: 3, size: "640x480" }),
    ].map((absolutePath) => ({ absolutePath }));
    const plan = await renderer.prepare({ ownerId: 1, entries, destinationDirectory: destination, name: "Cancelled" });

    let cancelResult = null;
    const result = await renderer.start({
      ownerId: 1,
      planId: plan.planId,
      onProgress: (event) => {
        if (event.phase === "encoding" && !cancelResult) {
          cancelResult = renderer.cancel({ ownerId: 1, planId: plan.planId });
        }
      },
    });

    expect(cancelResult).toEqual({ cancelled: true });
    expect(result).toMatchObject({ cancelled: true, outputName: null });
    expect(await fsp.readdir(destination)).toEqual([]);
    expect(await fsp.readdir(tempRoot)).toEqual([]);
    // Another owner cannot start or cancel a plan it did not make.
    expect(renderer.cancel({ ownerId: 2, planId: plan.planId })).toEqual({ cancelled: false });
  }, 60_000);

  it("stops a running ffmpeg on cancel and removes what it had written", async () => {
    const { library, destination, tempRoot, renderer } = await setup();
    const entries = [
      makeClip(path.join(library, "long.mp4"), { seconds: 20, size: "1280x720" }),
      makeClip(path.join(library, "short.mp4"), { seconds: 1, size: "320x240" }),
    ].map((absolutePath) => ({ absolutePath }));
    const plan = await renderer.prepare({ ownerId: 1, entries, destinationDirectory: destination, name: "Stopped" });
    expect(plan.mode).toBe("reencode");

    const started = Date.now();
    const result = await renderer.start({
      ownerId: 1,
      planId: plan.planId,
      onProgress: (event) => {
        if (event.phase === "encoding" && event.index === 1) {
          setTimeout(() => renderer.cancel({ ownerId: 1, planId: plan.planId }), 150);
        }
      },
    });

    expect(result).toMatchObject({ cancelled: true, outputName: null });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(renderer.busy).toBe(false);
    expect(await fsp.readdir(destination)).toEqual([]);
    expect(await fsp.readdir(tempRoot)).toEqual([]);
  }, 60_000);

  it("binds a plan to its owner and uses it once", async () => {
    const { library, destination, renderer } = await setup();
    const source = makeClip(path.join(library, "a.mp4"));
    const plan = await renderer.prepare({ ownerId: 1, entries: [{ absolutePath: source }], destinationDirectory: destination, name: "Once" });

    await expect(renderer.start({ ownerId: 2, planId: plan.planId })).rejects.toMatchObject({
      code: RENDER_CODES.PLAN_NOT_FOUND,
    });
    await renderer.start({ ownerId: 1, planId: plan.planId });
    await expect(renderer.start({ ownerId: 1, planId: plan.planId })).rejects.toMatchObject({
      code: RENDER_CODES.PLAN_NOT_FOUND,
    });
  }, 60_000);
});
