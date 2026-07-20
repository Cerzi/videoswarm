const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const {
  createVideoFolder,
  writeVideo,
} = require("./helpers/videoFixture.cjs");

async function waitForVideoTotal(page, expected) {
  await page.waitForFunction(
    (count) =>
      document.querySelector(".debug-info")?.textContent?.includes(
        `🎬 ${count} videos`
      ),
    expected
  );
}

test("production app covers its critical Electron lifecycle", async ({ browserName: _browserName }, testInfo) => {
  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const fixtureCount = 120;
  const folderPath = createVideoFolder(tempRoot, fixtureCount);
  const mainOutput = [];
  const rendererErrors = [];
  let closed = false;

  electronApp.process().stdout?.on("data", (chunk) => {
    mainOutput.push(chunk.toString());
  });
  electronApp.process().stderr?.on("data", (chunk) => {
    mainOutput.push(chunk.toString());
  });
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });

  try {
    await expect(page.locator(".app").getByText("Welcome to Video Swarm")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          isElectron: window.electronAPI?.isElectron,
          hasDirectoryBridge:
            typeof window.electronAPI?.readDirectory === "function",
          hasProfileBridge:
            typeof window.electronAPI?.profiles?.getActive === "function",
        }))
      )
      .toEqual({
        isElectron: true,
        hasDirectoryBridge: true,
        hasProfileBridge: true,
      });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          requireType: typeof window.require,
          processType: typeof window.process,
          csp: document
            .querySelector('meta[http-equiv="Content-Security-Policy"]')
            ?.getAttribute("content"),
        }))
      )
      .toMatchObject({
        requireType: "undefined",
        processType: "undefined",
        csp: expect.stringContaining("videoswarm-media:"),
      });
    const productionCsp = await page.evaluate(() =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") || ""
    );
    expect(productionCsp).not.toContain("ws://");

    expect(
      await page.evaluate(() => window.open("https://example.invalid/") === null)
    ).toBe(true);
    await expect.poll(() => electronApp.windows().length).toBe(1);

    await page.evaluate(() => {
      window.__videoSwarmFolderMetrics = [];
      window.addEventListener("videoswarm:folder-performance", (event) => {
        window.__videoSwarmFolderMetrics.push(event.detail);
      });
    });

    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await waitForVideoTotal(page, fixtureCount);
    await expect(page.getByRole("region", { name: "Video gallery" })).toBeVisible();
    await expect(page.locator(".video-item").first()).toBeVisible();
    await expect
      .poll(() =>
        page.locator(".video-item video").first().evaluate((video) =>
          video.currentSrc || video.src || ""
        )
      )
      .toMatch(/^videoswarm-media:\/\/instance\/\d+\?v=/);
    const opaqueMediaUrl = await page
      .locator(".video-item video")
      .first()
      .evaluate((video) => video.currentSrc || video.src || "");
    expect(opaqueMediaUrl).not.toContain(folderPath);
    const rangeResponse = await page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Range: "bytes=0-3" } });
      return {
        status: response.status,
        contentRange: response.headers.get("content-range"),
        bytes: (await response.arrayBuffer()).byteLength,
      };
    }, opaqueMediaUrl);
    expect(rangeResponse).toMatchObject({
      status: 206,
      bytes: 4,
      contentRange: expect.stringMatching(/^bytes 0-3\//),
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__videoSwarmFolderMetrics.map((metric) => metric.milestone)
        )
      )
      .toEqual(
        expect.arrayContaining([
          "request",
          "first-batch",
          "first-usable-grid",
          "enrichment-complete",
          "scan-complete",
        ])
      );
    const folderMetrics = await page.evaluate(() =>
      window.__videoSwarmFolderMetrics.slice()
    );
    const firstGridMetric = folderMetrics.find(
      (metric) => metric.milestone === "first-usable-grid"
    );
    const firstBatchMetric = folderMetrics.find(
      (metric) => metric.milestone === "first-batch"
    );
    const completionMetric = folderMetrics.find(
      (metric) => metric.milestone === "scan-complete"
    );
    expect(firstGridMetric.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(firstBatchMetric.elapsedMs).toBeLessThanOrEqual(
      completionMetric.elapsedMs
    );

    const initialIds = await page
      .locator(".masonry-slot")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.masonryId));
    expect(initialIds.length).toBeGreaterThan(0);
    expect(initialIds.length).toBeLessThan(100);

    await expect
      .poll(async () => {
        await page.locator(".content-region__viewport").evaluate((viewport) => {
          viewport.scrollTop = viewport.scrollHeight;
          viewport.dispatchEvent(new Event("scroll"));
        });
        return page
          .locator(".masonry-slot")
          .evaluateAll((nodes) => nodes.map((node) => node.dataset.masonryId));
      })
      .not.toEqual(initialIds);
    expect(await page.locator(".masonry-slot").count()).toBeLessThan(100);

    await page.getByTitle("Open filters").click();
    const filters = page.getByRole("dialog", { name: "Video filters" });
    await filters.getByRole("button", { name: "Rejects", exact: true }).click();
    await expect(page.getByText("No videos match the active filters")).toBeVisible();
    await filters.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator(".video-item").first()).toBeVisible();
    await filters.getByRole("button", { name: "Close", exact: true }).click();

    await page.locator(".video-item").first().dblclick();
    await expect(page.locator(".fullscreen-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".fullscreen-modal")).toHaveCount(0);

    const watcherPath = path.join(folderPath, "watcher-added.mp4");
    writeVideo(watcherPath);
    await waitForVideoTotal(page, fixtureCount + 1);
    fs.unlinkSync(watcherPath);
    await waitForVideoTotal(page, fixtureCount);

    const createdProfile = await page.evaluate(() =>
      window.electronAPI.profiles.create("Electron Smoke Profile")
    );
    expect(createdProfile.success).toBe(true);
    const createdProfileId = createdProfile.profile.id;
    await expect
      .poll(() =>
        page.evaluate(() => window.electronAPI.profiles.getActive())
      )
      .toMatchObject({ profileId: createdProfileId });
    await expect(page.locator(".app").getByText("Welcome to Video Swarm")).toBeVisible();

    await electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options = {}) => ({
        response: options.title === "Delete Profile" ? 0 : 1,
        checkboxChecked: false,
      });
    });
    const deletedProfile = await page.evaluate((profileId) =>
      window.electronAPI.profiles.delete(profileId), createdProfileId
    );
    expect(deletedProfile).toMatchObject({ success: true });
    expect(deletedProfile.activeProfileId).toBe("default");
    expect(deletedProfile.profiles.map((profile) => profile.id)).not.toContain(
      createdProfileId
    );

    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.minimize();
    });
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.restore();
      window?.show();
      window?.focus();
    });
    await expect(page).toHaveTitle(/Video Swarm/);

    const userDataPath = await electronApp.evaluate(({ app }) =>
      app.getPath("userData")
    );
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({
        x: 40,
        y: 50,
        width: 1110,
        height: 780,
      });
    });
    await page.evaluate(() =>
      window.electronAPI.saveSettingsPartial({
        windowBounds: { x: 40, y: 50, width: 1110, height: 780 },
      })
    );

    await electronApp.close();
    closed = true;

    const persistedSettings = JSON.parse(
      fs.readFileSync(
        path.join(userDataPath, "profiles", "default", "settings.json"),
        "utf8"
      )
    );
    expect(persistedSettings.windowBounds).toMatchObject({
      width: 1110,
      height: 780,
    });

    const fatalMainPattern =
      /Uncaught Exception|Unable to load preload|Startup failure|Object has been destroyed|RENDERER PROCESS CRASHED/i;
    expect(mainOutput.join("")).not.toMatch(fatalMainPattern);
    expect(rendererErrors).toEqual([]);
  } finally {
    await testInfo.attach("electron-main-output", {
      body: Buffer.from(mainOutput.join("")),
      contentType: "text/plain",
    });
    await testInfo.attach("renderer-errors", {
      body: Buffer.from(rendererErrors.join("\n")),
      contentType: "text/plain",
    });
    if (!closed) {
      await electronApp.close().catch(() => {});
    }
    context.cleanupFiles();
  }
});
