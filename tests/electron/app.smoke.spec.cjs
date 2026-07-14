const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");

// 16x16, three-frame H.264 MP4. Keeping the fixture inline makes the smoke
// suite independent of ffmpeg and exercises Chromium's real local-file path.
const TINY_MP4 = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANdbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAod0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAEAAABAAAAAAH/bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAABgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABqm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWpzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAL7iAAC+4gAAABhzdHRzAAAAAAAAAAEAAAADAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAKGN0dHMAAAAAAAAAAwAAAAEAAAQAAAAAAQAABgAAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAAsUAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAONAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2MC4xNi4xMDAAAAAIZnJlZQAAAuVtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAD2WIhAAz//727L4FNhTIwQAAAAhBmiJsQr/+wAAAAAgBnkF5Cv/EgQ==",
  "base64"
);

function writeVideo(filePath) {
  fs.writeFileSync(filePath, TINY_MP4);
}

function createVideoFolder(parentDir, count) {
  const folderPath = path.join(parentDir, "video-library");
  fs.mkdirSync(folderPath, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    writeVideo(path.join(folderPath, `clip-${String(index).padStart(4, "0")}.mp4`));
  }
  return folderPath;
}

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
