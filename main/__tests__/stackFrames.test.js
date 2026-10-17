import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  StackFrameService,
  differenceHash,
  fingerprintArgs,
  isFrameFingerprint,
  stillArgs,
} = require("../stack-frames");
const { writeVideo } = require("../../tests/electron/helpers/videoFixture.cjs");

const row = (instanceId, fingerprint, name = `${fingerprint}.mp4`) => ({
  instanceId,
  fingerprint,
  absolutePath: `/library/${name}`,
  rootPath: "/library",
});

function service({ stdout = Buffer.alloc(72, 1), fail = null } = {}) {
  const runner = {
    run: vi.fn(async () => {
      if (fail) throw fail;
      return { stdout };
    }),
    cancelOwner: vi.fn(),
    cancelAll: vi.fn(),
    shutdown: vi.fn(),
  };
  const fsPromises = { realpath: vi.fn(async (target) => target) };
  return { runner, fsPromises, frames: new StackFrameService({ runner, fsPromises }) };
}

describe("differenceHash", () => {
  it("sets a bit where a pixel is brighter than its right neighbour", () => {
    const gray = Buffer.alloc(72, 0);
    // Row 0: every pixel brighter than the next, so all 8 bits are set.
    for (let x = 0; x < 9; x += 1) gray[x] = 200 - x * 10;
    // Row 7: only the first pair differs.
    gray[63] = 50;
    const hash = differenceHash(gray);
    expect(hash).toBe("ff00000000000080");
    expect(isFrameFingerprint(hash)).toBe(true);
    expect(() => differenceHash(Buffer.alloc(10))).toThrow(/too few pixels/u);
  });
});

describe("ffmpeg arguments", () => {
  it("reads one first frame, as 9x8 greys or a small JPEG, to stdout", () => {
    expect(fingerprintArgs("/a.mp4")).toEqual(expect.arrayContaining(["-frames:v", "1", "scale=9:8:flags=area,format=gray", "rawvideo", "pipe:1"]));
    expect(stillArgs("/a.mp4", 240)).toEqual(expect.arrayContaining(["scale=240:-2", "mjpeg", "pipe:1"]));
    expect(fingerprintArgs("/a.mp4")[fingerprintArgs("/a.mp4").indexOf("-i") + 1]).toBe("/a.mp4");
  });
});

describe("StackFrameService", () => {
  it("grabs each content once, however many rows name it", async () => {
    const { runner, frames } = service();
    const onResult = vi.fn();
    await frames.fingerprintRows([row(1, "f1"), row(2, "f1", "copy.mp4"), row(3, "f2")], { onResult, ownerId: 7 });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls.map(([fingerprint]) => fingerprint).sort()).toEqual(["f1", "f2"]);
    expect(runner.run.mock.calls[0][2]).toMatchObject({ ownerId: 7 });
  });

  it("refuses a file that resolves outside its root", async () => {
    const { runner, fsPromises, frames } = service();
    fsPromises.realpath.mockImplementation(async (target) =>
      target === "/library/f1.mp4" ? "/elsewhere/f1.mp4" : target
    );
    const onResult = vi.fn();
    await frames.fingerprintRows([row(1, "f1")], { onResult });
    expect(runner.run).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it("stops asking once ffmpeg is missing", async () => {
    const missing = Object.assign(new Error("Failed to spawn ffmpeg"), { code: "SPAWN_ERROR", cause: { code: "ENOENT" } });
    const { runner, frames } = service({ fail: missing });
    await frames.fingerprintRows([row(1, "f1")], {});
    await frames.fingerprintRows([row(2, "f2")], {});
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(frames.ffmpegAvailable).toBe(false);
    expect(await frames.still(row(3, "f3"))).toBeNull();
  });

  it("keeps stills in memory and reuses them", async () => {
    const { runner, frames } = service({ stdout: Buffer.from([0xff, 0xd8, 0xff]) });
    const first = await frames.still(row(1, "f1"));
    expect(first).toBe("data:image/jpeg;base64,/9j/");
    expect(await frames.still(row(2, "f1", "copy.mp4"))).toBe(first);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasFfmpeg)("StackFrameService with the real ffmpeg", () => {
  let tempDir;
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("fingerprints and stills a real clip", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-frames-"));
    const clip = path.join(tempDir, "clip.mp4");
    writeVideo(clip);
    const frames = new StackFrameService();
    const target = { instanceId: 1, fingerprint: "f1", absolutePath: clip, rootPath: tempDir };
    const results = [];
    await frames.fingerprintRows([target], { onResult: (fingerprint, hash) => results.push(hash) });
    expect(results).toHaveLength(1);
    expect(isFrameFingerprint(results[0])).toBe(true);
    expect(await frames.still(target)).toMatch(/^data:image\/jpeg;base64,\/9j\//u);
    await frames.shutdown();
  });
});
