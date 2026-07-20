import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  EMBEDDED_METADATA_PROBE_LIMITS,
  createEmbeddedMetadataProbe,
  createFfprobeMetadataArgs,
  parseFfprobeMetadataOutput,
} = require("../embedded-metadata-probe");

function createRunner(overrides = {}) {
  return {
    run: vi.fn(async () => ({ stdout: Buffer.from('{"format":{"tags":{}}}') })),
    cancelOwner: vi.fn(() => 0),
    cancelAll: vi.fn(() => 0),
    shutdown: vi.fn(async () => ({ closed: true })),
    getSnapshot: vi.fn(() => ({ active: 0, pending: 0 })),
    ...overrides,
  };
}

describe("embedded metadata ffprobe boundary", () => {
  it("constructs a one-worker, bounded child-process runner", () => {
    const runner = createRunner();
    const runnerFactory = vi.fn(() => runner);
    createEmbeddedMetadataProbe({ runnerFactory });

    expect(runnerFactory).toHaveBeenCalledWith({
      concurrency: 1,
      maxPending: 16,
      timeoutMs: 5_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
      killGraceMs: 500,
    });
  });

  it("passes even option-looking paths as a final ffprobe argv value", async () => {
    const filePath = "-untrusted video.mp4";
    expect(createFfprobeMetadataArgs(filePath)).toEqual([
      "-v",
      "error",
      "-show_entries",
      "format_tags:stream_tags",
      "-of",
      "json=compact=1",
      "-i",
      filePath,
    ]);

    const runner = createRunner();
    const probe = createEmbeddedMetadataProbe({ runner });
    await expect(probe.probe(filePath, { ownerId: "selection-1" })).resolves
      .toMatchObject({ status: "not-found", available: true, found: false });
    expect(runner.run).toHaveBeenCalledWith(
      "ffprobe",
      createFfprobeMetadataArgs(filePath),
      {
        ownerId: "selection-1",
        timeoutMs: EMBEDDED_METADATA_PROBE_LIMITS.timeoutMs,
        maxStdoutBytes: EMBEDDED_METADATA_PROBE_LIMITS.maxStdoutBytes,
        maxStderrBytes: EMBEDDED_METADATA_PROBE_LIMITS.maxStderrBytes,
        spawnOptions: {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      }
    );
  });

  it("normalizes case-insensitive format and stream prompt/workflow tags", () => {
    const prompt = '{"1":{"class_type":"CLIPTextEncode"}}';
    const workflow = '{"nodes":[{"id":1}]}';
    const result = parseFfprobeMetadataOutput(JSON.stringify({
      format: { tags: { PrOmPt: prompt } },
      streams: [
        { tags: { encoder: "ignored" } },
        { tags: { WORKFLOW: workflow } },
      ],
    }));

    expect(result).toEqual({
      status: "found",
      available: true,
      found: true,
      payload: { prompt, workflow },
      sources: {
        prompt: { scope: "format", streamIndex: null, key: "PrOmPt" },
        workflow: { scope: "stream", streamIndex: 1, key: "WORKFLOW" },
      },
      issues: [],
      error: null,
    });
  });

  it("extracts direct tags before comment and description JSON envelopes", () => {
    const directPrompt = '{"direct":true}';
    const envelopeWorkflow = { nodes: [{ id: 9 }] };
    const streamEnvelope = JSON.stringify(JSON.stringify({
      PROMPT: { shouldNotReplace: true },
      WorkFlow: envelopeWorkflow,
    }));
    const result = parseFfprobeMetadataOutput(JSON.stringify({
      format: {
        tags: {
          prompt: directPrompt,
          description: JSON.stringify({ prompt: { fallback: true } }),
        },
      },
      streams: [{ tags: { CoMmEnT: streamEnvelope } }],
    }));

    expect(result).toMatchObject({
      status: "found",
      payload: {
        prompt: directPrompt,
        workflow: JSON.stringify(envelopeWorkflow),
      },
      sources: {
        prompt: { scope: "format", key: "prompt" },
        workflow: { scope: "stream", streamIndex: 0, key: "CoMmEnT" },
      },
    });
  });

  it("distinguishes absent metadata from an empty recognized direct field", () => {
    expect(parseFfprobeMetadataOutput(JSON.stringify({
      format: { tags: { encoder: "Lavf" } },
    }))).toMatchObject({ status: "not-found", found: false });

    expect(parseFfprobeMetadataOutput(JSON.stringify({
      format: { tags: { PROMPT: " " } },
    }))).toMatchObject({
      status: "unrecognized",
      found: false,
      issues: [{ code: "EMPTY_FIELD", field: "prompt" }],
    });
  });

  it("rejects malformed and oversized ffprobe JSON without retaining it", async () => {
    expect(() => parseFfprobeMetadataOutput("not json")).toThrowError(
      expect.objectContaining({ code: "FFPROBE_INVALID_JSON" })
    );
    expect(() => parseFfprobeMetadataOutput("x".repeat(65), {
      maxStdoutBytes: 64,
    })).toThrowError(expect.objectContaining({
      code: "FFPROBE_OUTPUT_TOO_LARGE",
    }));

    const runner = createRunner({
      run: vi.fn(async () => ({ stdout: Buffer.from("not json") })),
    });
    const probe = createEmbeddedMetadataProbe({ runner });
    await expect(probe.probe("clip.mp4")).resolves.toMatchObject({
      status: "error",
      available: true,
      found: false,
      payload: null,
      error: { code: "FFPROBE_INVALID_JSON" },
    });
    expect(probe.getSnapshot().availability).toBe("available");
  });

  it("memoizes a missing executable and avoids repeated spawn attempts", async () => {
    const missing = Object.assign(new Error("spawn ffprobe ENOENT"), {
      code: "SPAWN_ERROR",
      cause: Object.assign(new Error("missing"), { code: "ENOENT" }),
    });
    const runner = createRunner({
      run: vi.fn(async () => {
        throw missing;
      }),
    });
    const probe = createEmbeddedMetadataProbe({ runner });

    await expect(probe.probe("first.mp4")).resolves.toMatchObject({
      status: "unavailable",
      available: false,
      error: { code: "FFPROBE_UNAVAILABLE" },
    });
    await expect(probe.probe("second.webm")).resolves.toMatchObject({
      status: "unavailable",
      available: false,
    });
    expect(runner.run).toHaveBeenCalledOnce();
    expect(probe.getSnapshot().availability).toBe("unavailable");
  });

  it("lets an explicit re-read recover after ffprobe becomes available", async () => {
    const missing = Object.assign(new Error("spawn ffprobe ENOENT"), {
      code: "SPAWN_ERROR",
      cause: Object.assign(new Error("missing"), { code: "ENOENT" }),
    });
    const runner = createRunner({
      run: vi.fn()
        .mockRejectedValueOnce(missing)
        .mockResolvedValueOnce({
          stdout: Buffer.from(JSON.stringify({ format: { tags: {} } })),
        }),
    });
    const probe = createEmbeddedMetadataProbe({ runner });

    await expect(probe.probe("first.mp4")).resolves.toMatchObject({
      status: "unavailable",
      available: false,
    });
    await expect(probe.probe("second.mp4", { force: true })).resolves.toMatchObject({
      status: "not-found",
      available: true,
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(probe.getSnapshot().availability).toBe("available");
  });

  it.each([
    ["PROCESS_TIMEOUT", "timeout"],
    ["STDOUT_LIMIT", "output-limit"],
    ["STDERR_LIMIT", "output-limit"],
    ["OWNER_CANCELLED", "cancelled"],
    ["RUNNER_CANCELLED", "cancelled"],
    ["PROCESS_EXIT", "error"],
  ])("maps %s into a structured %s result", async (code, status) => {
    const runner = createRunner({
      run: vi.fn(async () => {
        throw Object.assign(new Error(`failed: ${code}`), { code });
      }),
    });
    const probe = createEmbeddedMetadataProbe({ runner });
    await expect(probe.probe("clip.mov")).resolves.toMatchObject({
      status,
      found: false,
      error: { code },
    });
  });

  it("delegates owner/all cancellation and provides an awaitable shutdown", async () => {
    const runner = createRunner({
      cancelOwner: vi.fn(() => 2),
      cancelAll: vi.fn(() => 3),
      getSnapshot: vi.fn(() => ({ active: 1, pending: 2 })),
    });
    const probe = createEmbeddedMetadataProbe({ runner });

    expect(probe.cancelOwner("window:request")).toBe(2);
    expect(runner.cancelOwner).toHaveBeenCalledWith(
      "window:request",
      "Embedded metadata probe owner was cancelled"
    );
    expect(probe.cancelAll("profile changed")).toBe(3);
    expect(runner.cancelAll).toHaveBeenCalledWith("profile changed");
    expect(probe.getSnapshot()).toEqual({
      closed: false,
      availability: "unknown",
      runner: { active: 1, pending: 2 },
    });

    await expect(probe.shutdown()).resolves.toEqual({ closed: true });
    expect(runner.shutdown).toHaveBeenCalledWith(
      "Embedded metadata probe is shutting down"
    );
    await expect(probe.probe("after.mp4")).resolves.toMatchObject({
      status: "shutdown",
      error: { code: "EMBEDDED_METADATA_PROBE_SHUTDOWN" },
    });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
