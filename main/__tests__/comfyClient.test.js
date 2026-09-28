import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  normalizeComfyConnection,
  parseComfyUrl,
  validateComfyConnection,
  isLoopbackAddress,
} = require("../comfy-connection");
const { classifyHistoryEntry, createComfyClient } = require("../comfy-client");
const { createFakeComfyUi, historyEntry } = require("./helpers/fakeComfyUi.cjs");

describe("ComfyUI connection setting", () => {
  it("accepts only loopback addresses", () => {
    expect(parseComfyUrl("http://127.0.0.1:8188")).toBe("http://127.0.0.1:8188");
    expect(parseComfyUrl(" http://localhost:8188/ ")).toBe("http://localhost:8188");
    expect(parseComfyUrl("http://[::1]:8188")).toBe("http://[::1]:8188");
    for (const url of [
      "http://192.168.1.5:8188",
      "http://comfy.example.com",
      "http://127.0.0.1.example.com:8188",
      "http://0.0.0.0:8188",
    ]) {
      expect(() => parseComfyUrl(url)).toThrow(expect.objectContaining({ code: "COMFY_URL_NOT_LOOPBACK" }));
    }
    for (const url of ["ftp://127.0.0.1", "http://user:pw@127.0.0.1:8188", "http://127.0.0.1:8188/api", "nope", ""]) {
      expect(() => parseComfyUrl(url)).toThrow(expect.objectContaining({ code: "COMFY_URL_INVALID" }));
    }
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
  });

  it("is off by default and turns off when the stored setting is unusable", () => {
    expect(normalizeComfyConnection(undefined)).toEqual({ enabled: false, url: "http://127.0.0.1:8188", outputDir: null });
    expect(normalizeComfyConnection({ enabled: true, url: "http://10.0.0.2:8188", outputDir: "/tmp" }).enabled).toBe(false);
    expect(normalizeComfyConnection({ enabled: true, url: "http://localhost:9000", outputDir: "relative" })).toEqual({
      enabled: true,
      url: "http://localhost:9000",
      outputDir: null,
    });
  });

  it("requires an existing output folder to switch on", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-comfy-out-"));
    try {
      await expect(validateComfyConnection({ enabled: true, url: "http://127.0.0.1:8188" })).rejects.toMatchObject({
        code: "COMFY_OUTPUT_DIR_REQUIRED",
      });
      await expect(
        validateComfyConnection({ enabled: true, url: "http://127.0.0.1:8188", outputDir: path.join(folder, "gone") })
      ).rejects.toMatchObject({ code: "COMFY_OUTPUT_DIR_MISSING" });
      const value = await validateComfyConnection({ enabled: true, url: "http://127.0.0.1:8188/", outputDir: folder });
      expect(value).toEqual({ enabled: true, url: "http://127.0.0.1:8188", outputDir: fs.realpathSync(folder) });
      await expect(validateComfyConnection({ enabled: false, url: "http://8.8.8.8" })).rejects.toMatchObject({
        code: "COMFY_URL_NOT_LOOPBACK",
      });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("ComfyUI client", () => {
  let comfy;
  beforeEach(async () => {
    comfy = createFakeComfyUi({ info: { SaveVideo: { input: { required: {} }, output_node: true } } });
    await comfy.listen();
  });
  afterEach(() => comfy.close());

  it("refuses a non-loopback address before any request", () => {
    expect(() => createComfyClient({ url: "http://10.1.1.1:8188" })).toThrow(/this computer/);
  });

  it("caches node definitions per class for a minute", async () => {
    let clock = 0;
    const client = createComfyClient({ url: comfy.url, now: () => clock });
    expect(await client.getNodeInfo(["SaveVideo", "Missing Node"])).toEqual({
      SaveVideo: { input: { required: {} }, output_node: true },
      "Missing Node": null,
    });
    await client.getNodeInfo(["SaveVideo"]);
    expect(comfy.state.requests.filter((entry) => entry.startsWith("GET /object_info/SaveVideo"))).toHaveLength(1);
    clock = 61_000;
    await client.getNodeInfo(["SaveVideo"]);
    expect(comfy.state.requests.filter((entry) => entry.startsWith("GET /object_info/SaveVideo"))).toHaveLength(2);
    expect(comfy.state.requests).toContain("GET /object_info/Missing%20Node");
  });

  it("submits without a client id, keeping 64-bit seeds exact, and withdraws", async () => {
    const client = createComfyClient({ url: comfy.url });
    const prompt = { 1: { class_type: "KSampler", inputs: { seed: 18446744073709551615n } } };
    const id = await client.submitPrompt({ prompt, extraPnginfo: { requeue: { a: 1 } } });
    expect(id).toBe("p1");
    expect(Object.keys(comfy.state.posted[0])).toEqual(["prompt", "extra_data"]);
    expect(comfy.state.posted[0].extra_data).toEqual({ extra_pnginfo: { requeue: { a: 1 } } });
    const queue = await client.getQueue();
    expect(queue.pending.map((entry) => entry.promptId)).toEqual(["p1"]);
    await client.deleteQueued(["p1"]);
    expect(comfy.state.deleted).toEqual(["p1"]);
    await client.free();
    expect(comfy.state.freed).toBe(1);
  });

  it("reads history, and a refusal with ComfyUI's reason", async () => {
    const client = createComfyClient({ url: comfy.url });
    comfy.state.history.p9 = historyEntry({ ok: true });
    expect((await client.getHistory("p9")).status.status_str).toBe("success");
    expect(await client.getHistory("nope")).toBeNull();
    expect(Object.keys(await client.getRecentHistory(5))).toEqual(["p9"]);
    comfy.state.refuse = {
      error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
      node_errors: { 3: { class_type: "LoraLoaderModelOnly", errors: [{ message: "Value not in list", details: "lora_name: 'x.safetensors'" }] } },
    };
    await expect(client.submitPrompt({ prompt: {} })).rejects.toMatchObject({
      code: "COMFY_REFUSED",
      message: expect.stringContaining("LoraLoaderModelOnly: Value not in list (lora_name: 'x.safetensors')"),
    });
    expect(await client.test()).toEqual({ running: 0, pending: 0 });
  });

  it("reports ComfyUI down, slow or oversized as unavailable or bad", async () => {
    comfy.state.down = true;
    const client = createComfyClient({ url: comfy.url });
    await expect(client.getQueue()).rejects.toMatchObject({ code: "COMFY_UNAVAILABLE" });

    const slow = http.createServer(() => {});
    await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      const timing = createComfyClient({ url: `http://127.0.0.1:${slow.address().port}`, timeoutMs: 50 });
      await expect(timing.getQueue()).rejects.toMatchObject({ code: "COMFY_UNAVAILABLE" });
    } finally {
      slow.closeAllConnections();
      slow.close();
    }

    comfy.state.down = false;
    comfy.state.history.big = { status: { messages: ["x".repeat(4096)] } };
    const small = createComfyClient({ url: comfy.url, maxResponseBytes: 1024 });
    await expect(small.getRecentHistory(1)).rejects.toMatchObject({ code: "COMFY_BAD_RESPONSE" });
  });
});

describe("classifyHistoryEntry", () => {
  it("classifies ok, oom, errors and interruptions, with seconds and output files", () => {
    const ok = classifyHistoryEntry(historyEntry({ file: { filename: "a_final_00001_.mp4", subfolder: "H3" } }));
    expect(ok).toMatchObject({ state: "ok", seconds: 60, outputs: [{ filename: "a_final_00001_.mp4", subfolder: "H3" }] });
    expect(classifyHistoryEntry(historyEntry({ ok: false, message: "CUDA error: out of memory" }))).toMatchObject({
      state: "oom",
      nodeType: "KSamplerAdvanced",
      message: "CUDA error: out of memory",
    });
    expect(classifyHistoryEntry(historyEntry({ ok: false, message: "Allocation on device 0 would exceed" })).state).toBe("oom");
    expect(classifyHistoryEntry(historyEntry({ ok: false, nodeType: "VAEDecode", message: "shape mismatch" }))).toMatchObject({
      state: "error",
      nodeType: "VAEDecode",
      message: "shape mismatch",
      seconds: 60,
    });
    expect(classifyHistoryEntry(historyEntry({ interrupted: true }))).toMatchObject({ state: "interrupted", seconds: 30 });
    expect(classifyHistoryEntry(null)).toMatchObject({ state: "error", outputs: [] });
    // Previews (`temp`) are not finals.
    const preview = historyEntry();
    preview.outputs = { 5: { images: [{ filename: "ComfyUI_temp_1.png", subfolder: "", type: "temp" }] } };
    expect(classifyHistoryEntry(preview).outputs).toEqual([]);
  });
});
