const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  createProductionAppWorkspace,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");

const FIXTURE_COUNT = 1_000;

async function waitForVideoTotal(page, expected) {
  await page.waitForFunction(
    (count) =>
      document.querySelector(".debug-info")?.textContent?.includes(
        `🎬 ${count} videos`
      ),
    expected
  );
}

async function observeFolderOpen(page) {
  await page.evaluate(() => {
    window.__continueReviewFolderMetrics = [];
    window.addEventListener("videoswarm:folder-performance", (event) => {
      window.__continueReviewFolderMetrics.push(event.detail);
    });
  });
}

async function folderMilestones(page, rootPath) {
  return page.evaluate(
    (expectedRoot) =>
      (window.__continueReviewFolderMetrics || [])
        .filter((metric) => metric.rootPath === expectedRoot)
        .map((metric) => metric.milestone),
    rootPath
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

test("continues a flushed review session after restart from the cached first grid", async ({ browserName: _browserName }, testInfo) => {
  test.slow();

  const workspace = createProductionAppWorkspace();
  const folderPath = createVideoFolder(workspace.tempRoot, FIXTURE_COUNT);
  const firstMainOutput = [];
  const secondMainOutput = [];
  const firstRendererErrors = [];
  const secondRendererErrors = [];
  let firstContext = null;
  let secondContext = null;
  let firstClosed = false;
  let secondClosed = false;

  try {
    firstContext = await launchProductionApp({ workspace });
    captureDiagnostics(firstContext, firstMainOutput, firstRendererErrors);
    const firstPage = firstContext.page;

    await expect(
      firstPage.locator(".app").getByText("Welcome to Video Swarm")
    ).toBeVisible();
    const recursiveToggle = firstPage.getByRole("checkbox", {
      name: "Subfolders",
    });
    if (!(await recursiveToggle.isChecked())) await recursiveToggle.check();
    await observeFolderOpen(firstPage);
    await chooseFolderThroughNativeDialog(
      firstContext.electronApp,
      firstPage,
      folderPath
    );
    await waitForVideoTotal(firstPage, FIXTURE_COUNT);
    await expect
      .poll(() => folderMilestones(firstPage, folderPath))
      .toContain("scan-complete");

    await firstPage
      .getByRole("button", { name: "Pin current library root" })
      .click();
    await expect(
      firstPage.getByRole("button", { name: "Unpin current library root" })
    ).toBeVisible();

    const firstClip = firstPage.locator(
      '.video-item[data-filename="clip-0000.mp4"]'
    );
    const pendingCursorClip = firstPage.locator(
      '.video-item[data-filename="clip-0002.mp4"]'
    );
    await firstClip.click();
    const selectionDetails = firstPage.getByRole("complementary", {
      name: "Selection details",
    });
    await selectionDetails
      .getByRole("button", { name: /^Accept\b/ })
      .click();

    await expect
      .poll(() =>
        firstPage.evaluate(async (rootPath) => {
          const result = await window.electronAPI?.review?.sessions?.get?.(
            rootPath
          );
          return Boolean(
            result?.checkpoint?.anchorInstanceId &&
              result?.checkpoint?.anchorFingerprint
          );
        }, folderPath)
      )
      .toBe(true);

    // The floating Details panel may cover the next grid card at smaller CI
    // viewport sizes. Dismiss it through the user-facing control so this smoke
    // continues to exercise a real pointer selection rather than a forced DOM
    // click through an overlapping surface.
    const closeSelectionDetails = selectionDetails.getByRole("button", {
      name: "Close selection details",
    });
    await expect(closeSelectionDetails).toBeVisible();
    await closeSelectionDetails.click();

    // The navigation save is deliberately still inside the 400 ms debounce.
    // VideoCard waits 300 ms to distinguish a double click, so first wait only
    // until the application has actually committed this single-click cursor.
    // BrowserWindow close must then request, await, and persist the newest
    // still-debounced draft.
    await pendingCursorClip.click();
    await pendingCursorClip.evaluate(
      (node) =>
        new Promise((resolve) => {
          if (node.classList.contains("selected")) {
            resolve();
            return;
          }
          const observer = new MutationObserver(() => {
            if (!node.classList.contains("selected")) return;
            observer.disconnect();
            resolve();
          });
          observer.observe(node, { attributeFilter: ["class"] });
        })
    );
    await firstContext.electronApp.close();
    firstClosed = true;

    secondContext = await launchProductionApp({ workspace });
    captureDiagnostics(secondContext, secondMainOutput, secondRendererErrors);
    const secondPage = secondContext.page;

    await expect(
      secondPage.locator(".app").getByText("Welcome to Video Swarm")
    ).toBeVisible();
    await observeFolderOpen(secondPage);

    const librarySidebar = secondPage.getByRole("complementary", {
      name: "Library and folders",
    });
    await librarySidebar.getByRole("button", { name: /^video-library / }).click();
    await waitForVideoTotal(secondPage, FIXTURE_COUNT);
    const continueReview = secondPage.getByRole("button", {
      name: /^Find next Unreviewed from saved position/,
    });
    await expect(continueReview).toBeVisible();
    await continueReview.click();

    const resumedClip = secondPage.locator(".video-item.selected");
    await expect(resumedClip).toHaveAttribute(
      "data-filename",
      "clip-0002.mp4"
    );
    await expect
      .poll(() =>
        resumedClip.evaluate((node) => document.activeElement === node)
      )
      .toBe(true);

    await expect
      .poll(() => folderMilestones(secondPage, folderPath))
      .toEqual(
        expect.arrayContaining([
          "cached-preview",
          "first-usable-grid",
          "scan-complete",
        ])
      );
    const milestones = await folderMilestones(secondPage, folderPath);
    expect(milestones.indexOf("cached-preview")).toBeLessThan(
      milestones.indexOf("first-usable-grid")
    );
    expect(milestones.indexOf("first-usable-grid")).toBeLessThan(
      milestones.indexOf("scan-complete")
    );

    await secondContext.electronApp.close();
    secondClosed = true;

    const fatalMainPattern =
      /Uncaught Exception|Unable to load preload|Startup failure|Object has been destroyed|RENDERER PROCESS CRASHED/i;
    expect(firstMainOutput.join("")).not.toMatch(fatalMainPattern);
    expect(secondMainOutput.join("")).not.toMatch(fatalMainPattern);
    expect(firstRendererErrors).toEqual([]);
    expect(secondRendererErrors).toEqual([]);
  } finally {
    await testInfo.attach("continue-review-first-main-output", {
      body: Buffer.from(firstMainOutput.join("")),
      contentType: "text/plain",
    });
    await testInfo.attach("continue-review-second-main-output", {
      body: Buffer.from(secondMainOutput.join("")),
      contentType: "text/plain",
    });
    await testInfo.attach("continue-review-first-renderer-errors", {
      body: Buffer.from(firstRendererErrors.join("\n")),
      contentType: "text/plain",
    });
    await testInfo.attach("continue-review-second-renderer-errors", {
      body: Buffer.from(secondRendererErrors.join("\n")),
      contentType: "text/plain",
    });
    if (firstContext && !firstClosed) {
      await firstContext.electronApp.close().catch(() => {});
    }
    if (secondContext && !secondClosed) {
      await secondContext.electronApp.close().catch(() => {});
    }
    workspace.cleanup();
  }
});
