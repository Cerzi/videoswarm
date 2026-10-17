const fs = require("node:fs");
const path = require("node:path");
const { expect, test } = require("@playwright/test");
const {
  chooseFolderThroughNativeDialog,
  createProductionAppWorkspace,
  launchProductionApp,
} = require("./helpers/launchApp.cjs");
const { createVideoFolder } = require("./helpers/videoFixture.cjs");
const { portableEnvironment, portablePaths } = require("../../main/portable-mode");

// The graphics process on, drawing in software, so graphics drivers' shader
// caches are exercised too (the usual headless smoke runs switch it off).
const GPU_ARGS = ["--headless", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

function untouched(workspace, systemTemp) {
  return {
    home: filesUnder(workspace.homeDir),
    config: filesUnder(workspace.configDir),
    cache: filesUnder(workspace.cacheDir),
    temp: filesUnder(systemTemp),
  };
}
const NOTHING = { home: [], config: [], cache: [], temp: [] };

/**
 * Portable mode in the real app (docs/architecture/portable-mode.md): a
 * portable copy is used for real (a folder opened, thumbnails, the database,
 * settings), and afterwards the home, config, cache and temporary folders it
 * would otherwise use are still empty. Everything is in the portable folder.
 */

function filesUnder(root) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found;
}

test("portable: everything stays in the portable folder", async () => {
  test.setTimeout(90_000);
  const workspace = createProductionAppWorkspace();
  const systemTemp = path.join(workspace.tempRoot, "system-temp");
  // Deep enough that Chromium's single-instance socket would not fit in the
  // portable temporary folder.
  const portableRoot = path.join(
    workspace.tempRoot,
    "a-portable-copy-kept-quite-deep",
    "inside-several-folders-with-long-names",
    "VideoSwarm-portable"
  );
  const clips = path.join(workspace.tempRoot, "clips-elsewhere");
  fs.mkdirSync(systemTemp, { recursive: true });
  fs.mkdirSync(portableRoot, { recursive: true });
  const folderPath = createVideoFolder(clips, 3, "folder");
  // As the portable launcher starts it: its folders in the environment from
  // the start (what main.js would otherwise set too late for Chromium's own
  // startup).
  const headless = process.env.VIDEOSWARM_E2E_HEADLESS;
  delete process.env.VIDEOSWARM_E2E_HEADLESS;
  const context = await launchProductionApp({
    workspace,
    extraArgs: GPU_ARGS,
    extraEnv: {
      TMPDIR: systemTemp,
      TMP: systemTemp,
      TEMP: systemTemp,
      XDG_DATA_HOME: path.join(workspace.homeDir, ".local", "share"),
      XDG_STATE_HOME: path.join(workspace.homeDir, ".local", "state"),
      VIDEOSWARM_PORTABLE_DIR: portableRoot,
      ...portableEnvironment(portablePaths(portableRoot)),
    },
  }).finally(() => {
    if (headless !== undefined) process.env.VIDEOSWARM_E2E_HEADLESS = headless;
  });
  const { electronApp, page } = context;
  try {
    await chooseFolderThroughNativeDialog(electronApp, page, folderPath);
    await expect(page.locator(".video-item")).toHaveCount(3);
    const where = await page.evaluate(() => window.electronAPI.dataLocation.getState());
    expect(where).toMatchObject({ isPortable: true, source: "portable" });
    expect(where.effectivePath).toBe(path.join(portableRoot, "VideoSwarmData", "user-data"));
    await page.evaluate(() => window.electronAPI.saveSettingsPartial({ zoomLevel: 3 }));
    await page.waitForTimeout(1500);
  } finally {
    await electronApp.close().catch(() => {});
  }

  try {
    // What a normal copy would have used is untouched.
    expect(untouched(workspace, systemTemp)).toEqual(NOTHING);
    // The clips' folder gained nothing either.
    expect(filesUnder(clips).every((file) => file.endsWith(".mp4"))).toBe(true);
    // And the portable folder holds the profile's database and settings.
    const kept = filesUnder(portableRoot);
    expect(kept.some((file) => file.endsWith("videoswarm-meta.db"))).toBe(true);
    expect(kept.some((file) => /settings\.json$/u.test(file))).toBe(true);
    expect(kept.every((file) => file.startsWith("VideoSwarmData"))).toBe(true);
  } finally {
    workspace.cleanup();
  }
});
