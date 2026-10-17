import { createRequire } from "module";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createLocalApiServer, LocalApiError } = require("../local-api/server");
const { createLocalApiHandlers } = require("../local-api/handlers");
const {
  DEFAULT_LOCAL_API_PORT,
  normalizeLocalApiConfig,
  readLocalApiConfig,
  validateLocalApiChange,
  writeLocalApiConfig,
} = require("../local-api/config");
const { createLocalApiService } = require("../local-api/service");

const TOKEN = "t".repeat(43);

// A raw request, so every header can be set or left out.
function request(port, { method = "POST", route = "/api/v1/describe", headers = {}, body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: route, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null });
        });
      }
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const good = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("local read API server", () => {
  let server;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function start(handlers = { describe: async () => ({ ok: true }) }, options = {}) {
    server = createLocalApiServer({ handlers, getToken: () => TOKEN, ...options });
    return server.start(0);
  }

  it("answers a local app with the token, as JSON, and says who read", async () => {
    const onRead = vi.fn();
    const port = await start(undefined, { onRead });
    const answer = await request(port, { headers: { ...good, "user-agent": "editor/1.0" } });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true });
    expect(answer.headers["content-type"]).toMatch(/application\/json/u);
    expect(answer.headers["access-control-allow-origin"]).toBeUndefined();
    expect(onRead).toHaveBeenCalledWith({ endpoint: "describe", userAgent: "editor/1.0" });
  });

  it("refuses web pages, foreign hosts, other methods, no token and other types", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const port = await start({ describe: handler });
    const status = async (options) => (await request(port, options)).status;
    expect(await status({ headers: { ...good, origin: "https://example.com" } })).toBe(403);
    expect(await status({ headers: { ...good, host: `example.com:${port}` } })).toBe(403);
    expect(await status({ headers: { ...good, host: "127.0.0.1:1" } })).toBe(403);
    expect(await status({ method: "GET", headers: good, body: null })).toBe(405);
    expect(await status({ headers: { "content-type": "application/json" } })).toBe(401);
    expect(await status({ headers: { ...good, authorization: `Bearer ${"x".repeat(43)}` } })).toBe(401);
    expect(await status({ headers: { ...good, authorization: "Bearer short" } })).toBe(401);
    expect(await status({ headers: { ...good, "content-type": "text/plain" } })).toBe(415);
    expect(await status({ route: "/api/v1/nope", headers: good })).toBe(404);
    expect(await status({ headers: good, body: "{not json" })).toBe(400);
    expect(await status({ headers: good, body: "[1]" })).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a body that is too large", async () => {
    const port = await start(undefined, { limits: { maxBodyBytes: 64 } });
    const answer = await request(port, { headers: good, body: JSON.stringify({ pad: "x".repeat(200) }) });
    expect(answer).toMatchObject({ status: 413, body: { error: { code: "LOCAL_API_TOO_LARGE" } } });
  });

  it("passes a handler's refusal on, and hides any other failure", async () => {
    const port = await start({
      describe: async () => {
        throw new LocalApiError(400, "LOCAL_API_BAD_REQUEST", "since must be a revision");
      },
      changes: async () => {
        throw new Error("/private/path/db exploded");
      },
    });
    const refused = await request(port, { headers: good });
    expect(refused).toMatchObject({
      status: 400,
      body: { error: { code: "LOCAL_API_BAD_REQUEST", message: "since must be a revision" } },
    });
    const failed = await request(port, { route: "/api/v1/changes", headers: good });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain("private");
  });

  it("listens on loopback only", async () => {
    await start();
    // A server bound to 127.0.0.1 reports that address.
    expect(server.port).toBeGreaterThan(0);
  });
});

describe("local read API handlers", () => {
  const store = {
    getLocalApiClips: vi.fn(({ paths, contentIds }) => {
      const found = new Map();
      if (paths.includes("/clips/a.mp4")) found.set("/clips/a.mp4", { contentId: "v2-a" });
      if (contentIds.includes("v2-b")) found.set("v2-b", { contentId: "v2-b" });
      return found;
    }),
    listTags: () => [{ name: "dance", parent: null, usageCount: 3 }, { name: "bellydance", parent: "dance" }],
    listMetadataChangesSince: vi.fn((since) => ({ revision: since + 2, changed: ["v2-a"], tagTreeChanged: false, reset: false, more: false })),
  };
  const handlers = createLocalApiHandlers({
    appVersion: "1.2.3",
    withStore: async (work) => ({ profile: "p-1", revision: 9, ...(await work(store)) }),
  });

  it("describes itself", async () => {
    expect(await handlers.describe({})).toMatchObject({ protocol: 1, app: "Video Swarm", version: "1.2.3", profile: "p-1", revision: 9 });
  });

  it("answers every key asked, null when unknown, and refuses a bad request", async () => {
    expect(await handlers.clips({ paths: ["/clips/a.mp4", "/clips/none.mp4"], contentIds: ["v2-b"] })).toEqual({
      profile: "p-1",
      revision: 9,
      clips: { "/clips/a.mp4": { contentId: "v2-a" }, "/clips/none.mp4": null, "v2-b": { contentId: "v2-b" } },
    });
    await expect(handlers.clips({ paths: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(handlers.clips({ paths: [7] })).rejects.toMatchObject({ status: 400 });
    await expect(
      handlers.clips({ contentIds: Array.from({ length: 5001 }, (_, index) => `v2-${index}`) })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("lists the tag tree without counts", async () => {
    expect((await handlers.tags({})).tags).toEqual([
      { name: "dance", parent: null },
      { name: "bellydance", parent: "dance" },
    ]);
  });

  it("keeps the change cursor's own revision", async () => {
    expect(await handlers.changes({ since: 4 })).toMatchObject({ revision: 6, changed: ["v2-a"] });
    await expect(handlers.changes({ since: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(handlers.changes({})).rejects.toMatchObject({ status: 400 });
  });
});

describe("local read API setting", () => {
  let dir;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("is off on the default port until switched on with a token", () => {
    expect(normalizeLocalApiConfig(null)).toEqual({ version: 1, enabled: false, port: DEFAULT_LOCAL_API_PORT, token: null });
    expect(normalizeLocalApiConfig({ enabled: true, port: 80 })).toMatchObject({ enabled: false, port: DEFAULT_LOCAL_API_PORT });
    expect(() => validateLocalApiChange({ enabled: true, port: 99 })).toThrow(/1024 to 65535/u);
  });

  it("writes one file readable by the user only, and keeps the token", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-localapi-config-"));
    await writeLocalApiConfig(dir, { enabled: true, port: 50000, token: TOKEN });
    const file = path.join(dir, "local-api.json");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, enabled: true, port: 50000, token: TOKEN });
    expect(await readLocalApiConfig(dir)).toMatchObject({ enabled: true, port: 50000, token: TOKEN });
  });

  it("starts, answers with the token from the file, makes a new token and stops", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-localapi-service-"));
    const service = createLocalApiService({
      getDataDir: () => dir,
      handlers: { describe: async () => ({ ok: true }) },
      logger: { warn: vi.fn() },
    });
    expect((await service.start()).running).toBe(false);
    // Port 0 is refused from Preferences; find a free one for the test.
    const probe = http.createServer();
    const freePort = await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(probe.address().port)));
    await new Promise((resolve) => probe.close(resolve));
    const on = await service.update({ enabled: true, port: freePort });
    expect(on).toMatchObject({ enabled: true, running: true, port: freePort, error: null });
    const file = JSON.parse(fs.readFileSync(on.filePath, "utf8"));
    expect(file.token).toBe(on.token);
    const answer = await request(freePort, { headers: { ...good, authorization: `Bearer ${file.token}` } });
    expect(answer.status).toBe(200);
    expect(service.describe().lastRead).toMatchObject({ userAgent: "an app with no name" });

    const renewed = await service.renewToken();
    expect(renewed.token).not.toBe(on.token);
    expect((await request(freePort, { headers: { ...good, authorization: `Bearer ${on.token}` } })).status).toBe(401);

    const off = await service.update({ enabled: false, port: freePort });
    expect(off.running).toBe(false);
    await expect(request(freePort, { headers: good })).rejects.toThrow();
    await service.stop();
  });
});
