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
 * View feeds in the real app (docs/architecture/view-feeds.md), read from
 * this test process the way a follower would: the switch, the shared views,
 * a view's clips in pages, a rating moving a clip in, and each refusal.
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

test("view feeds: an app follows a saved view", async () => {
  test.setTimeout(90_000);
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const folderPath = createVideoFolder(tempRoot, 3, "feed-clips");
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));

  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(3);

    const port = await freePort();
    const setting = await page.evaluate((chosen) => window.electronAPI.localApi.set({ enabled: true, port: chosen }), port);
    const { token } = JSON.parse(fs.readFileSync(setting.filePath, "utf8"));

    // Off until switched on, apart from the read API.
    const off = await call(port, token, "views");
    expect(off).toMatchObject({ status: 403, body: { error: { code: "LOCAL_API_FEEDS_OFF" } } });
    const on = await page.evaluate((chosen) => window.electronAPI.localApi.set({ enabled: true, port: chosen, feeds: true }), port);
    expect(on.feeds).toBe(true);
    expect((await call(port, token, "describe")).body.feeds).toBe(true);

    // The user rates two clips and saves "4 stars or more".
    const paths = [0, 1, 2].map((index) => path.join(folderPath, `clip-000${index}.mp4`));
    const known = await call(port, token, "clips", { paths });
    const ids = paths.map((clipPath) => known.body.clips[clipPath].contentId);
    const view = await page.evaluate(async ([first, second]) => {
      await window.electronAPI.metadata.setRating([first], 5);
      await window.electronAPI.metadata.setRating([second], 4);
      const created = await window.electronAPI.library.createSavedView("Keepers", {
        version: 1,
        filters: { minRating: 4 },
        searchScope: "library",
      });
      return created.view;
    }, ids);

    const listed = await call(port, token, "views");
    expect(listed.body.views).toEqual([expect.objectContaining({ id: view.id, name: "Keepers" })]);
    const profile = listed.body.profile;

    // Two pages of one snapshot.
    const first = await call(port, token, "views/clips", { view: view.id, profile, limit: 1 });
    expect(first.body).toMatchObject({ total: 2, view: { id: view.id, name: "Keepers" }, ignored: [] });
    const second = await call(port, token, "views/clips", { view: view.id, profile, limit: 1, after: first.body.next });
    expect(second.body.next).toBeNull();
    expect([...first.body.clips, ...second.body.clips].map((clip) => clip.path).sort()).toEqual(paths.slice(0, 2).sort());
    expect(first.body.clips[0]).toMatchObject({ available: true, review: expect.any(String), tags: [] });

    // Nothing changed: unchanged. Rated in: the third clip joins.
    const same = await call(port, token, "views/clips", { view: view.id, unless: first.body.etag });
    expect(same.body.unchanged).toBe(true);
    await page.evaluate((third) => window.electronAPI.metadata.setRating([third], 4), ids[2]);
    const grown = await call(port, token, "views/clips", { view: view.id, unless: first.body.etag });
    expect(grown.body).toMatchObject({ unchanged: false, total: 3 });

    // Refusals, each with its own code.
    expect((await call(port, token, "views/clips", { view: view.id, profile: "p-other" })).body.error.code).toBe(
      "LOCAL_API_PROFILE_CHANGED"
    );
    await page.evaluate((id) => window.electronAPI.library.updateSavedView(id, { shared: false }), view.id);
    expect((await call(port, token, "views/clips", { view: view.id })).body.error.code).toBe("LOCAL_API_VIEW_NOT_SHARED");
    expect((await call(port, token, "views")).body.views).toEqual([]);
    await page.evaluate((id) => window.electronAPI.library.deleteSavedView(id), view.id);
    expect((await call(port, token, "views/clips", { view: view.id })).body.error.code).toBe("LOCAL_API_VIEW_NOT_FOUND");
    expect(rendererErrors).toEqual([]);
  } finally {
    await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
