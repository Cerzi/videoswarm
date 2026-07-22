import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  createMediaInstanceUrl,
  createMediaProxyUrl,
  createMediaProtocolService,
  parseMediaInstanceUrl,
  parseMediaRequestUrl,
  parseSingleByteRange,
  registerMediaScheme,
} = require("../media-protocol");

const temporaryDirectories = new Set();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createMediaFile(name = "clip.mp4", contents = "0123456789") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-media-"));
  temporaryDirectories.add(directory);
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
  temporaryDirectories.clear();
});

describe("media protocol URL and range parsing", () => {
  it("creates and parses opaque instance URLs", () => {
    const url = createMediaInstanceUrl(42, {
      version: "100-200",
      generation: 7,
    });
    expect(url).toBe("videoswarm-media://instance/42?v=100-200&g=7");
    expect(parseMediaInstanceUrl(url)).toEqual({
      instanceId: 42,
      version: "100-200",
      generation: 7,
    });
  });

  it("rejects malformed or duplicate profile generations", () => {
    expect(() => createMediaInstanceUrl(1, { generation: -1 })).toThrow(
      expect.objectContaining({ code: "INVALID_MEDIA_GENERATION" })
    );
    expect(() =>
      parseMediaRequestUrl("videoswarm-media://instance/1?g=1&g=2")
    ).toThrow(expect.objectContaining({ code: "INVALID_MEDIA_URL" }));
    expect(() =>
      parseMediaRequestUrl("videoswarm-media://instance/1?g=profile")
    ).toThrow(expect.objectContaining({ code: "INVALID_MEDIA_URL" }));
  });

  it("creates and parses proxy URLs without exposing the cache path", () => {
    const signature = "a".repeat(64);
    const url = createMediaProxyUrl(signature, { generation: 8 });
    expect(url).toBe(`videoswarm-media://proxy/${signature}?g=8`);
    expect(parseMediaRequestUrl(url)).toEqual({
      kind: "proxy",
      signature,
      generation: 8,
    });
    expect(() => createMediaProxyUrl("../cache/proxy.mp4")).toThrow(
      expect.objectContaining({ code: "INVALID_PROXY_SIGNATURE" })
    );
  });

  it.each([
    ["bytes=0-3", 10, { start: 0, end: 3, length: 4 }],
    ["bytes=6-", 10, { start: 6, end: 9, length: 4 }],
    ["bytes=-4", 10, { start: 6, end: 9, length: 4 }],
    ["bytes=0-100", 10, { start: 0, end: 9, length: 10 }],
  ])("parses %s", (header, size, expected) => {
    expect(parseSingleByteRange(header, size)).toEqual(expected);
  });

  it.each(["bytes=10-11", "bytes=4-2", "bytes=0-1,3-4", "items=0-1", "bytes=-0"])(
    "rejects unsupported or unsatisfiable range %s",
    (header) => {
      expect(() => parseSingleByteRange(header, 10)).toThrow(
        expect.objectContaining({ code: "RANGE_NOT_SATISFIABLE", status: 416 })
      );
    }
  );
});

describe("media protocol service", () => {
  it("streams a complete media file without exposing its path in the URL", async () => {
    const filePath = createMediaFile();
    const resolver = vi.fn(async (instanceId) => ({
      path: filePath,
      present: true,
      instanceId,
    }));
    const service = createMediaProtocolService({ resolveInstance: resolver });

    const response = await service.handle(
      new Request(createMediaInstanceUrl(7))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("10");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("0123456789");
    expect(resolver).toHaveBeenCalledWith(7, expect.any(Object));
    expect(response.url).not.toContain(filePath);
  });

  it("returns an exact single-range stream", async () => {
    const filePath = createMediaFile();
    const service = createMediaProtocolService({
      resolveInstance: async () => ({ path: filePath, present: true }),
    });
    const response = await service.handle(
      new Request(createMediaInstanceUrl(1), {
        headers: { Range: "bytes=3-6" },
      })
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 3-6/10");
    expect(response.headers.get("content-length")).toBe("4");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("3456");
  });

  it("streams a proxy only through its injected signature resolver", async () => {
    const proxyPath = createMediaFile("cached-proxy.mp4", "proxy-bytes");
    const signature = "b".repeat(64);
    const resolveProxy = vi.fn(async () => ({ path: proxyPath, present: true }));
    const service = createMediaProtocolService({
      resolveInstance: vi.fn(),
      resolveProxy,
    });
    const url = createMediaProxyUrl(signature);
    const response = await service.handle(new Request(url));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("proxy-bytes");
    expect(resolveProxy).toHaveBeenCalledWith(signature, expect.any(Object));
    expect(url).not.toContain(proxyPath);
  });

  it("rejects unknown or malformed proxy signatures", async () => {
    const service = createMediaProtocolService({
      resolveInstance: vi.fn(),
      resolveProxy: async () => null,
    });
    expect(
      (await service.handle(new Request(createMediaProxyUrl("c".repeat(64))))).status
    ).toBe(404);
    expect(
      (await service.handle(new Request("videoswarm-media://proxy/not-a-signature"))).status
    ).toBe(400);
  });

  it("supports HEAD without opening a file stream", async () => {
    const filePath = createMediaFile();
    const createReadStream = vi.fn();
    const service = createMediaProtocolService({
      resolveInstance: async () => ({ path: filePath, present: true }),
      createReadStream,
    });
    const response = await service.handle(
      new Request(createMediaInstanceUrl(2), { method: "HEAD" })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it("reports unsatisfiable ranges with the complete size", async () => {
    const filePath = createMediaFile();
    const service = createMediaProtocolService({
      resolveInstance: async () => ({ path: filePath, present: true }),
    });
    const response = await service.handle(
      new Request(createMediaInstanceUrl(3), {
        headers: { Range: "bytes=20-30" },
      })
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  it("rejects missing instances, unsupported extensions, and methods", async () => {
    const textPath = createMediaFile("not-media.txt");
    const missing = createMediaProtocolService({ resolveInstance: async () => null });
    expect((await missing.handle(new Request(createMediaInstanceUrl(4)))).status).toBe(404);

    const unsupported = createMediaProtocolService({
      resolveInstance: async () => ({ path: textPath, present: true }),
    });
    expect((await unsupported.handle(new Request(createMediaInstanceUrl(4)))).status).toBe(415);
    expect(
      (await unsupported.handle(new Request(createMediaInstanceUrl(4), { method: "POST" }))).status
    ).toBe(405);
  });

  it("authorizes the canonical path before opening it", async () => {
    const filePath = createMediaFile();
    const authorizePath = vi.fn(async () => {});
    const service = createMediaProtocolService({
      resolveInstance: async () => ({ path: filePath, present: true }),
      authorizePath,
    });
    const response = await service.handle(new Request(createMediaInstanceUrl(5)));
    await response.body.cancel();
    const canonicalFilePath = await fs.promises.realpath(filePath);

    expect(authorizePath).toHaveBeenCalledWith(
      canonicalFilePath,
      expect.objectContaining({ instanceId: 5 })
    );
  });

  it("destroys an in-flight stream when the request is aborted", async () => {
    const filePath = createMediaFile();
    const stream = new PassThrough();
    const destroy = vi.spyOn(stream, "destroy");
    const controller = new AbortController();
    const service = createMediaProtocolService({
      resolveInstance: async () => ({ path: filePath, present: true }),
      createReadStream: () => stream,
    });
    const response = await service.handle(
      new Request(createMediaInstanceUrl(6), { signal: controller.signal })
    );

    expect(response.status).toBe(200);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroy).toHaveBeenCalled();
    expect(stream.destroyed).toBe(true);
  });

  it("cancels every active stream during a profile transition", async () => {
    const filePath = createMediaFile();
    const streams = [new PassThrough(), new PassThrough()];
    const service = createMediaProtocolService({
      resolveInstance: async () => ({ path: filePath, present: true }),
      createReadStream: () => streams.shift(),
    });
    const firstStream = streams[0];
    const secondStream = streams[1];
    await service.handle(new Request(createMediaInstanceUrl(10)));
    await service.handle(new Request(createMediaInstanceUrl(11)));

    expect(service.getSnapshot().activeStreams).toBe(2);
    expect(service.cancelActiveStreams()).toBe(2);
    expect(firstStream.destroyed).toBe(true);
    expect(secondStream.destroyed).toBe(true);
    expect(service.getSnapshot().activeStreams).toBe(0);
  });

  it("prevents a pre-transition resolver from opening a stream afterward", async () => {
    const filePath = createMediaFile();
    const pendingResolution = deferred();
    const createReadStream = vi.fn(() => new PassThrough());
    const service = createMediaProtocolService({
      resolveInstance: () => pendingResolution.promise,
      createReadStream,
    });

    const responsePromise = service.handle(
      new Request(createMediaInstanceUrl(12, { generation: 1 }))
    );
    service.cancelActiveStreams();
    pendingResolution.resolve({ path: filePath, present: true });

    await expect(responsePromise).resolves.toMatchObject({ status: 410 });
    expect(createReadStream).not.toHaveBeenCalled();
    expect(service.getSnapshot().activeStreams).toBe(0);
  });

  it("destroys every outstanding stream when the service is disposed", async () => {
    const filePath = createMediaFile();
    const stream = new PassThrough();
    const service = createMediaProtocolService({
      resolveInstance: async () => ({ path: filePath, present: true }),
      createReadStream: () => stream,
    });
    const response = await service.handle(new Request(createMediaInstanceUrl(8)));

    expect(response.status).toBe(200);
    expect(service.getSnapshot()).toEqual({ disposed: false, activeStreams: 1 });
    service.dispose();
    expect(stream.destroyed).toBe(true);
    expect(service.getSnapshot()).toEqual({ disposed: true, activeStreams: 0 });
  });

  it("registers privileged streaming semantics and disposes its handler", () => {
    const protocolApi = {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn(),
      unhandle: vi.fn(),
      isProtocolHandled: vi.fn(() => false),
    };
    registerMediaScheme(protocolApi);
    expect(protocolApi.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({
        scheme: "videoswarm-media",
        privileges: expect.objectContaining({
          standard: true,
          secure: true,
          corsEnabled: true,
          stream: true,
        }),
      }),
    ]);

    const service = createMediaProtocolService({ resolveInstance: vi.fn() });
    expect(service.register(protocolApi)).toBe(true);
    expect(service.register(protocolApi)).toBe(false);
    expect(protocolApi.handle).toHaveBeenCalledWith("videoswarm-media", service.handle);
    expect(service.dispose()).toBe(true);
    expect(protocolApi.unhandle).toHaveBeenCalledWith("videoswarm-media");
  });
});
// @vitest-environment node
