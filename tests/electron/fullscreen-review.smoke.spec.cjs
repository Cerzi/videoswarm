const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  launchProductionApp,
  chooseFolderThroughNativeDialog,
} = require("./helpers/launchApp.cjs");
const {
  createVideoFolder,
  writePortraitVideo,
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

function captureDiagnostics(context, output, rendererErrors) {
  context.electronApp.process().stdout?.on("data", (chunk) => {
    output.push(chunk.toString());
  });
  context.electronApp.process().stderr?.on("data", (chunk) => {
    output.push(chunk.toString());
  });
  context.page.on("pageerror", (error) => rendererErrors.push(error.message));
  context.page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
}

async function openFullscreen(page, filename) {
  const card = page.locator(`.video-item[data-filename="${filename}"]`);
  await expect(card).toBeVisible();
  await card.dblclick();

  const modal = page.locator(".fullscreen-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".fullscreen-review__title")).toHaveText(filename);
  await expect(
    modal.getByRole("button", { name: /^Accept\b/ })
  ).toBeEnabled();
  await expect
    .poll(() =>
      modal.locator(".fullscreen-review__video").evaluate(
        (video) => video.currentSrc || video.getAttribute("src") || ""
      )
    )
    .toMatch(/^videoswarm-media:\/\/instance\/\d+\?v=/);
  expect(await modal.locator(".fullscreen-review__video").count()).toBe(1);
  return { card, modal };
}

async function retainFullscreenMedia(page, referenceName) {
  return page.evaluate((name) => {
    const video = document.querySelector(".fullscreen-review__video");
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error("Fullscreen media element was not available");
    }
    window.__fullscreenSmokeMedia ||= Object.create(null);
    window.__fullscreenSmokeMedia[name] = video;
    return {
      source: video.currentSrc || video.getAttribute("src") || "",
      muted: video.muted,
      paused: video.paused,
      identity: video.dataset.mediaIdentity || "",
    };
  }, referenceName);
}

async function expectRetainedMediaReleased(page, referenceName) {
  await expect
    .poll(() =>
      page.evaluate((name) => {
        const video = window.__fullscreenSmokeMedia?.[name];
        return {
          retained: video instanceof HTMLVideoElement,
          connected: Boolean(video?.isConnected),
          stillInDocument: Array.from(document.querySelectorAll("video")).includes(
            video
          ),
          paused: Boolean(video?.paused),
          muted: Boolean(video?.muted),
          hasSourceAttribute: Boolean(video?.hasAttribute("src")),
          sourceObjectCleared: video?.srcObject == null,
          networkStateEmpty:
            video?.networkState === HTMLMediaElement.NETWORK_EMPTY,
          readyStateEmpty: video?.readyState === HTMLMediaElement.HAVE_NOTHING,
          hasMediaIdentity: Boolean(video?.hasAttribute("data-media-identity")),
          hasFilePath: Boolean(video?.hasAttribute("data-file-path")),
          fullscreenPlayers: document.querySelectorAll(
            ".fullscreen-review__video"
          ).length,
        };
      }, referenceName)
    )
    .toEqual({
      retained: true,
      connected: false,
      stillInDocument: false,
      paused: true,
      muted: true,
      hasSourceAttribute: false,
      sourceObjectCleared: true,
      networkStateEmpty: true,
      readyStateEmpty: true,
      hasMediaIdentity: false,
      hasFilePath: false,
      fullscreenPlayers: 0,
    });
}

test("fullscreen review releases media and preserves review context across navigation and roots", async ({ browserName: _browserName }, testInfo) => {
  test.slow();

  const context = await launchProductionApp();
  const { electronApp, page, tempRoot } = context;
  const rootA = createVideoFolder(tempRoot, 3, "fullscreen-owner-a");
  writePortraitVideo(path.join(rootA, "portrait-9x16.mp4"));
  const rootB = path.join(tempRoot, "fullscreen-owner-b");
  fs.mkdirSync(rootB, { recursive: true });
  writeVideo(path.join(rootB, "owner-b-0000.mp4"), 100);
  writeVideo(path.join(rootB, "owner-b-0001.mp4"), 101);

  const mainOutput = [];
  const rendererErrors = [];
  let closed = false;
  captureDiagnostics(context, mainOutput, rendererErrors);

  try {
    await expect(page.locator(".app").getByText("Welcome to Video Swarm")).toBeVisible();
    await chooseFolderThroughNativeDialog(electronApp, page, rootA);
    await waitForVideoTotal(page, 4);

    const portraitFullscreen = await openFullscreen(page, "portrait-9x16.mp4");
    await expect
      .poll(() =>
        portraitFullscreen.modal
          .locator(".fullscreen-review__video")
          .evaluate((video) => ({
            width: video.videoWidth,
            height: video.videoHeight,
          }))
      )
      .toEqual({ width: 90, height: 160 });
    const portraitGeometry = await portraitFullscreen.modal.evaluate((modal) => {
      const wrapper = modal.querySelector(".fullscreen-review__media-wrap");
      const video = modal.querySelector(".fullscreen-review__video");
      if (!(wrapper instanceof HTMLElement) || !(video instanceof HTMLVideoElement)) {
        throw new Error("Fullscreen portrait media geometry was unavailable");
      }
      const wrapperRect = wrapper.getBoundingClientRect();
      const videoRect = video.getBoundingClientRect();
      return {
        objectFit: getComputedStyle(video).objectFit,
        wrapper: {
          left: wrapperRect.left,
          top: wrapperRect.top,
          right: wrapperRect.right,
          bottom: wrapperRect.bottom,
          clientHeight: wrapper.clientHeight,
          scrollHeight: wrapper.scrollHeight,
        },
        video: {
          left: videoRect.left,
          top: videoRect.top,
          right: videoRect.right,
          bottom: videoRect.bottom,
        },
      };
    });
    expect(portraitGeometry.objectFit).toBe("contain");
    expect(portraitGeometry.video.left).toBeGreaterThanOrEqual(
      portraitGeometry.wrapper.left - 1
    );
    expect(portraitGeometry.video.top).toBeGreaterThanOrEqual(
      portraitGeometry.wrapper.top - 1
    );
    expect(portraitGeometry.video.right).toBeLessThanOrEqual(
      portraitGeometry.wrapper.right + 1
    );
    expect(portraitGeometry.video.bottom).toBeLessThanOrEqual(
      portraitGeometry.wrapper.bottom + 1
    );
    expect(portraitGeometry.wrapper.scrollHeight).toBeLessThanOrEqual(
      portraitGeometry.wrapper.clientHeight + 1
    );
    await portraitFullscreen.modal
      .getByRole("button", { name: "Close fullscreen review" })
      .click();
    await expect(portraitFullscreen.modal).toHaveCount(0);

    const { modal } = await openFullscreen(page, "clip-0000.mp4");
    const playbackVideo = modal.locator(".fullscreen-review__video");
    await expect.poll(() => playbackVideo.evaluate((video) => video.paused)).toBe(
      false
    );
    await playbackVideo.focus();
    await expect
      .poll(() =>
        playbackVideo.evaluate((video) => {
          const style = getComputedStyle(video);
          return {
            focused: document.activeElement === video,
            borderTopWidth: style.borderTopWidth,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            boxShadow: style.boxShadow,
          };
        })
      )
      .toEqual({
        focused: true,
        borderTopWidth: "0px",
        outlineStyle: "none",
        outlineWidth: "0px",
        boxShadow: "none",
      });
    await page.keyboard.press("Space");
    await expect.poll(() => playbackVideo.evaluate((video) => video.paused)).toBe(
      true
    );
    await playbackVideo.evaluate((video) => {
      video.dispatchEvent(new Event("canplay"));
    });
    await page.waitForTimeout(200);
    expect(await playbackVideo.evaluate((video) => video.paused)).toBe(true);
    await page.keyboard.press("Space");
    await expect.poll(() => playbackVideo.evaluate((video) => video.paused)).toBe(
      false
    );
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(840, 820);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900);
    const narrowLayout = await page.evaluate(() => {
      const rect = (selector) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect();
        return bounds
          ? {
              left: bounds.left,
              top: bounds.top,
              right: bounds.right,
              bottom: bounds.bottom,
              width: bounds.width,
              height: bounds.height,
            }
          : null;
      };
      return {
        stage: rect(".fullscreen-review__stage"),
        review: rect(".fullscreen-review__review-rail"),
        details: rect(".fullscreen-review__details"),
        previous: rect(".fullscreen-review__nav--previous"),
        next: rect(".fullscreen-review__nav--next"),
      };
    });
    expect(narrowLayout.stage.height).toBeGreaterThan(80);
    expect(narrowLayout.review.top).toBeGreaterThanOrEqual(
      narrowLayout.stage.bottom - 1
    );
    expect(narrowLayout.details.top).toBeGreaterThanOrEqual(
      narrowLayout.review.bottom - 1
    );
    for (const navigation of [narrowLayout.previous, narrowLayout.next]) {
      expect(navigation.left).toBeGreaterThanOrEqual(narrowLayout.stage.left);
      expect(navigation.right).toBeLessThanOrEqual(narrowLayout.stage.right);
      expect(navigation.top).toBeGreaterThanOrEqual(narrowLayout.stage.top);
      expect(navigation.bottom).toBeLessThanOrEqual(narrowLayout.stage.bottom);
    }
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 900);
    });

    const accept = modal.getByRole("button", { name: /^Accept\b/ });
    const rateFour = modal.getByRole("button", { name: "Rate 4 stars" });
    const autoAdvance = modal.getByRole("checkbox", {
      name: /Advance after marking/,
    });
    await expect(autoAdvance).not.toBeChecked();

    await accept.click();
    await expect(accept).toHaveAttribute("aria-pressed", "true");
    await expect(
      modal.locator(".fullscreen-review-panel__state")
    ).toHaveText("Accept");

    await page.keyboard.press("z");
    await expect(accept).toHaveAttribute("aria-pressed", "false");
    await expect(
      modal.locator(".fullscreen-review-panel__state")
    ).toHaveText("Unreviewed");
    await accept.click();
    await expect(accept).toHaveAttribute("aria-pressed", "true");

    await rateFour.click();
    await expect(rateFour).toHaveAttribute("aria-pressed", "true");

    const tagInput = modal.getByPlaceholder("Add tag and press Enter");
    await tagInput.fill("smoke-tag");
    await tagInput.press("Enter");
    await expect(
      modal.locator(".metadata-panel__chip", { hasText: "#smoke-tag" })
    ).toBeVisible();

    // Tag entry deliberately owns printable keys; return focus to the loupe
    // controls before exercising its one-handed navigation shortcut.
    await modal.getByRole("button", { name: "Next clip" }).focus();
    await page.keyboard.press("e");
    await expect(modal.locator(".fullscreen-review__title")).toHaveText(
      "clip-0001.mp4"
    );
    await expect(modal.locator(".fullscreen-review__position")).toHaveText(
      "2 of 4"
    );
    await expect(page.locator(".video-item.selected")).toHaveAttribute(
      "data-filename",
      "clip-0001.mp4"
    );

    await page.keyboard.press("m");
    await expect
      .poll(() =>
        modal
          .locator(".fullscreen-review__video")
          .evaluate((video) => video.muted)
      )
      .toBe(false);
    const closingMedia = await retainFullscreenMedia(page, "normal-close");
    expect(closingMedia.source).toMatch(/^videoswarm-media:\/\/instance\/\d+\?v=/);
    expect(closingMedia.muted).toBe(false);

    await modal.getByRole("button", { name: "Close fullscreen review" }).click();
    await expect(modal).toHaveCount(0);
    await expectRetainedMediaReleased(page, "normal-close");

    const selectedAfterClose = page.locator(".video-item.selected");
    await expect(selectedAfterClose).toHaveAttribute(
      "data-filename",
      "clip-0001.mp4"
    );
    await expect
      .poll(() =>
        selectedAfterClose.evaluate((node) => document.activeElement === node)
      )
      .toBe(true);

    const reviewedCard = page.locator(
      '.video-item[data-filename="clip-0000.mp4"]'
    );
    await expect(
      reviewedCard.locator('.video-item-review[title="Review state: Accept"]')
    ).toBeVisible();
    await expect(
      reviewedCard.locator('.video-item-rating[title="Rated 4 / 5"]')
    ).toBeVisible();
    await expect(
      reviewedCard.locator('.video-item-tags[title="smoke-tag"]')
    ).toBeVisible();

    const reopened = await openFullscreen(page, "clip-0000.mp4");
    await expect(
      reopened.modal.getByRole("button", { name: /^Accept\b/ })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      reopened.modal.getByRole("button", { name: "Rate 4 stars" })
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      reopened.modal.locator(".metadata-panel__chip", {
        hasText: "#smoke-tag",
      })
    ).toBeVisible();

    const ownerMedia = await retainFullscreenMedia(page, "owner-replacement");
    await electronApp.evaluate(({ dialog }, nextRoot) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [nextRoot],
      });
    }, rootB);
    const rootSelection = await page.evaluate(() =>
      window.electronAPI.selectFolder()
    );
    expect(rootSelection).toMatchObject({ success: true, folderPath: rootB });
    await electronApp.evaluate(({ BrowserWindow }, nextRoot) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        "folder-selected",
        nextRoot
      );
    }, rootSelection.folderPath);

    await expect(reopened.modal).toHaveCount(0);
    await expectRetainedMediaReleased(page, "owner-replacement");
    await waitForVideoTotal(page, 2);
    await expect(
      page.locator('.video-item[data-filename="owner-b-0000.mp4"]')
    ).toBeVisible();
    await expect(reviewedCard).toHaveCount(0);

    const rootBFullscreen = await openFullscreen(page, "owner-b-0000.mp4");
    const rootBMedia = await retainFullscreenMedia(page, "second-owner-close");
    expect(rootBMedia.source).not.toBe(ownerMedia.source);
    await expect(
      rootBFullscreen.modal.getByRole("button", { name: /^Accept\b/ })
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      rootBFullscreen.modal.getByRole("button", { name: "Rate 4 stars" })
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      rootBFullscreen.modal.locator(".metadata-panel__chip", {
        hasText: "#smoke-tag",
      })
    ).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(rootBFullscreen.modal).toHaveCount(0);
    await expectRetainedMediaReleased(page, "second-owner-close");

    const profileFullscreen = await openFullscreen(page, "owner-b-0001.mp4");
    await retainFullscreenMedia(page, "profile-replacement");
    const createdProfile = await page.evaluate(() =>
      window.electronAPI.profiles.create("Fullscreen Smoke Profile")
    );
    expect(createdProfile.success).toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.electronAPI.profiles.getActive()))
      .toMatchObject({ profileId: createdProfile.profile.id });
    await expect(profileFullscreen.modal).toHaveCount(0);
    await expectRetainedMediaReleased(page, "profile-replacement");
    await expect(
      page.locator(".app").getByText("Welcome to Video Swarm")
    ).toBeVisible();

    expect(
      await page.evaluate(() => {
        const retained = window.__fullscreenSmokeMedia;
        return (
          retained["normal-close"] !== retained["owner-replacement"] &&
          retained["owner-replacement"] !== retained["second-owner-close"] &&
          retained["second-owner-close"] !== retained["profile-replacement"]
        );
      })
    ).toBe(true);

    await electronApp.close();
    closed = true;

    const fatalMainPattern =
      /Uncaught Exception|Unable to load preload|Startup failure|Object has been destroyed|RENDERER PROCESS CRASHED/i;
    expect(mainOutput.join("")).not.toMatch(fatalMainPattern);
    expect(rendererErrors).toEqual([]);
  } finally {
    await testInfo.attach("fullscreen-review-main-output", {
      body: Buffer.from(mainOutput.join("")),
      contentType: "text/plain",
    });
    await testInfo.attach("fullscreen-review-renderer-errors", {
      body: Buffer.from(rendererErrors.join("\n")),
      contentType: "text/plain",
    });
    if (!closed) await electronApp.close().catch(() => {});
    context.cleanupFiles();
  }
});
