const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

/**
 * The local read API in the real app (docs/architecture/local-read-api.md),
 * read from this test process the way another app would: the port and token
 * from the file in the data folder, then clips, tags and changes.
 */

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function call(port, token, endpoint, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/api/v1/${endpoint}`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": "smoke-reader/1",
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      }
    );
    req.on("error", reject);
    req.end(text);
  });
}

test("local read API: another app reads clips, tags and changes", async () => {
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 2, "api-clips");
  const clipPath = path.join(folderPath, "clip-0000.mp4");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(2);

    const port = await freePort();
    const setting = await page.evaluate((chosen) => window.electronAPI.localApi.set({ enabled: true, port: chosen }), port);
    expect(setting).toMatchObject({ enabled: true, running: true, port, error: null });
    // A caller finds the port and token in the file, beside the profiles.
    expect(path.basename(setting.filePath)).toBe("local-api.json");
    const file = JSON.parse(fs.readFileSync(setting.filePath, "utf8"));
    expect(file).toMatchObject({ enabled: true, port, token: setting.token });

    const described = await call(port, file.token, "describe");
    expect(described.status).toBe(200);
    expect(described.body).toMatchObject({ protocol: 1, app: "Video Swarm", profile: expect.stringMatching(/^p-/u) });
    const start = described.body.revision;

    const before = await call(port, file.token, "clips", { paths: [clipPath, "/not/indexed.mp4"] });
    expect(before.body.clips["/not/indexed.mp4"]).toBeNull();
    const clip = before.body.clips[clipPath];
    expect(clip).toMatchObject({ tags: [], rating: null, review: "unreviewed", contentId: expect.stringMatching(/^v2-/u) });

    // The user tags and rates the clip in Video Swarm.
    await page.evaluate(async (fingerprint) => {
      await window.electronAPI.metadata.addTags([fingerprint], ["dance/bellydance"]);
      await window.electronAPI.metadata.setRating([fingerprint], 4);
    }, clip.contentId);

    const changes = await call(port, file.token, "changes", { since: start });
    expect(changes.body).toMatchObject({ changed: [clip.contentId], tagTreeChanged: true, reset: false });
    const after = await call(port, file.token, "clips", { contentIds: [clip.contentId] });
    expect(after.body.clips[clip.contentId]).toMatchObject({
      tags: [{ name: "bellydance", path: ["dance", "bellydance"] }],
      rating: 4,
    });
    const tags = await call(port, file.token, "tags");
    expect(tags.body.tags).toEqual(
      expect.arrayContaining([
        { name: "dance", parent: null },
        { name: "bellydance", parent: "dance" },
      ])
    );

    // Web pages and callers without the token are turned away.
    expect((await call(port, file.token, "describe", {}, { origin: "https://example.com" })).status).toBe(403);
    expect((await call(port, "x".repeat(43), "describe")).status).toBe(401);
    const shown = await page.evaluate(() => window.electronAPI.localApi.get());
    expect(shown.lastRead).toMatchObject({ userAgent: "smoke-reader/1" });

    // Switched off, nothing listens.
    await page.evaluate((chosen) => window.electronAPI.localApi.set({ enabled: false, port: chosen }), port);
    await expect(call(port, file.token, "describe")).rejects.toThrow();
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
