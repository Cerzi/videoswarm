import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  LAST_FRAME_CAPTURE_LIMITS,
  LAST_FRAME_MAX_HEIGHT,
  LAST_FRAME_MAX_WIDTH,
  LAST_FRAME_SCALE_FILTER,
  createFfmpegLastFrameArgs,
  createLastFrameCaptureService,
} = require("../last-frame-capture");

function fakeRunner(stdout = Buffer.from("png")) {
  return {
    run: vi.fn(async () => ({ stdout, stderr: Buffer.alloc(0), code: 0 })),
    cancelOwner: vi.fn(() => 2),
    cancelAll: vi.fn(() => 3),
    shutdown: vi.fn(async () => ({ closed: true })),
    getSnapshot: vi.fn(() => ({ active: 0, pending: 0 })),
  };
}

describe("LastFrameCaptureService", () => {
  it("uses noninteractive ffmpeg arguments and owner-scoped bounded work", async () => {
    const runner = fakeRunner(Buffer.from("frame"));
    const service = createLastFrameCaptureService({ runner });
    const frame = await service.capture("/videos/clip with spaces.mp4", {
      ownerId: 41,
    });

    expect(frame).toEqual(Buffer.from("frame"));
    expect(runner.run).toHaveBeenCalledTimes(1);
    const [command, args, options] = runner.run.mock.calls[0];
    expect(command).toBe("ffmpeg");
    expect(args[0]).toBe("-nostdin");
    expect(args[args.indexOf("-i") + 1]).toBe("/videos/clip with spaces.mp4");
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "scale=w='min(iw,3840)':h='min(ih,2160)':" +
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    );
    expect(args.at(-1)).toBe("pipe:1");
    expect(options).toEqual({
      ownerId: 41,
      spawnOptions: {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });
  });

  it("defines the required concurrency, queue, timeout, and output limits", () => {
    expect(LAST_FRAME_CAPTURE_LIMITS).toEqual({
      concurrency: 1,
      maxPending: 2,
      timeoutMs: 30_000,
      maxStdoutBytes: 64 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
      killGraceMs: 500,
    });
    expect(LAST_FRAME_MAX_WIDTH).toBe(3840);
    expect(LAST_FRAME_MAX_HEIGHT).toBe(2160);
    expect(LAST_FRAME_SCALE_FILTER).toBe(
      "scale=w='min(iw,3840)':h='min(ih,2160)':" +
        "force_original_aspect_ratio=decrease:force_divisible_by=2"
    );
    expect(createFfmpegLastFrameArgs("clip.mp4")).toContain("-nostdin");
    // Without a timestamp the extractor still means "the final frame".
    expect(createFfmpegLastFrameArgs("clip.mp4")).toContain("-sseof");

    // A timestamp switches to input seeking, which ffmpeg decodes accurately.
    const seeked = createFfmpegLastFrameArgs("clip.mp4", 1.5);
    expect(seeked).not.toContain("-sseof");
    expect(seeked.slice(seeked.indexOf("-ss"), seeked.indexOf("-ss") + 2)).toEqual([
      "-ss",
      "1.500",
    ]);
    // The seek must precede the input for input-side seeking to apply.
    expect(seeked.indexOf("-ss")).toBeLessThan(seeked.indexOf("-i"));
    // Small offsets must not reach ffmpeg in exponential notation.
    expect(createFfmpegLastFrameArgs("clip.mp4", 0.0000001)).toContain("0.000");
    expect(() => createFfmpegLastFrameArgs("clip.mp4", -1)).toThrow(
      /non-negative/
    );
  });

  it("rejects empty output and delegates cancellation and shutdown", async () => {
    const runner = fakeRunner(Buffer.alloc(0));
    const service = createLastFrameCaptureService({ runner });

    await expect(service.capture("clip.mp4")).rejects.toMatchObject({
      code: "EMPTY_IMAGE",
    });
    expect(service.cancelOwner("renderer-1")).toBe(2);
    expect(service.cancelAll("profile switched")).toBe(3);
    await expect(service.shutdown()).resolves.toEqual({ closed: true });
    expect(runner.cancelOwner).toHaveBeenCalledWith(
      "renderer-1",
      "Frame-capture owner was destroyed"
    );
    expect(runner.cancelAll).toHaveBeenCalledWith("profile switched");
    expect(runner.shutdown).toHaveBeenCalledWith(
      "Frame-capture service is shutting down"
    );
  });
});
