import http from "http";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  normalizeComfyConnection,
  parseComfyUrl,
  validateComfyConnection,
  isLoopbackAddress,
} = require("../comfy-connection");
const { createComfyClient } = require("../comfy-client");
const { createFakeComfyUi } = require("./helpers/fakeComfyUi.cjs");

describe("ComfyUI address setting", () => {
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

  it("keeps only a usable address, dropping the old queue's fields", () => {
    expect(normalizeComfyConnection(undefined)).toEqual({ url: "http://127.0.0.1:8188" });
    expect(normalizeComfyConnection({ url: "http://10.0.0.2:8188" })).toEqual({ url: "http://127.0.0.1:8188" });
    expect(
      normalizeComfyConnection({ enabled: true, url: "http://localhost:9000", outputDir: "/somewhere" })
    ).toEqual({ url: "http://localhost:9000" });
  });

  it("validates an address change", () => {
    expect(validateComfyConnection({ url: "http://127.0.0.1:8188/" })).toEqual({ url: "http://127.0.0.1:8188" });
    expect(validateComfyConnection({})).toEqual({ url: "http://127.0.0.1:8188" });
    expect(() => validateComfyConnection({ url: "http://8.8.8.8" })).toThrow(
      expect.objectContaining({ code: "COMFY_URL_NOT_LOOPBACK" })
    );
    expect(() => validateComfyConnection(null)).toThrow(expect.objectContaining({ code: "COMFY_SETTING_INVALID" }));
  });
});

describe("ComfyUI connection test", () => {
  let comfy;
  beforeEach(async () => {
    comfy = createFakeComfyUi({ info: { SaveVideo: { input: { required: {} }, output_node: true } } });
    await comfy.listen();
  });
  afterEach(() => comfy.close());

  it("refuses a non-loopback address before any request", () => {
    expect(() => createComfyClient({ url: "http://10.1.1.1:8188" })).toThrow(/this computer/);
  });

  it("reads the queue and a node definition, and nothing else", async () => {
    comfy.state.running = 1;
    comfy.state.pending = 2;
    expect(await createComfyClient({ url: comfy.url }).test()).toEqual({ running: 1, pending: 2 });
    expect(comfy.state.requests).toEqual(["GET /queue", "GET /object_info/SaveVideo"]);
  });

  it("says when the address answers but not as ComfyUI", async () => {
    comfy.state.info = {};
    await expect(createComfyClient({ url: comfy.url }).test()).rejects.toMatchObject({
      code: "COMFY_NOT_COMFYUI",
    });
  });

  it("reports ComfyUI down, slow or oversized as unavailable or bad", async () => {
    comfy.state.down = true;
    await expect(createComfyClient({ url: comfy.url }).test()).rejects.toMatchObject({
      code: "COMFY_UNAVAILABLE",
    });

    const slow = http.createServer(() => {});
    await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      const timing = createComfyClient({ url: `http://127.0.0.1:${slow.address().port}`, timeoutMs: 50 });
      await expect(timing.test()).rejects.toMatchObject({ code: "COMFY_UNAVAILABLE" });
    } finally {
      slow.closeAllConnections();
      slow.close();
    }

    comfy.state.down = false;
    comfy.state.padding = 4096;
    const small = createComfyClient({ url: comfy.url, maxResponseBytes: 1024 });
    await expect(small.test()).rejects.toMatchObject({ code: "COMFY_BAD_RESPONSE" });
  });
});
