const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect, test } = require("@playwright/test");

const installedExecutable = "/usr/bin/video-swarm";
const sandboxHelper = "/opt/VideoSwarm/chrome-sandbox";

test.describe("installed Linux Debian package", () => {
  test.skip(
    process.platform !== "linux" || process.env.VIDEOSWARM_DEB_SMOKE !== "1",
    "Only runs after CI installs the release .deb"
  );

  test("starts the packaged app with its Chromium sandbox enabled", async () => {
    expect(process.getuid()).not.toBe(0);
    expect(fs.existsSync(installedExecutable)).toBe(true);
    expect(fs.existsSync(sandboxHelper)).toBe(true);
    expect(fs.realpathSync(installedExecutable)).toBe(
      "/opt/VideoSwarm/video-swarm"
    );

    const sandboxStat = fs.statSync(sandboxHelper);
    expect(sandboxStat.uid).toBe(0);
    expect(sandboxStat.gid).toBe(0);
    expect(sandboxStat.mode & 0o7777).toBe(0o4755);

    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "videoswarm-deb-smoke-")
    );
    const homeDir = path.join(tempRoot, "home");
    const configDir = path.join(tempRoot, "config");
    const cacheDir = path.join(tempRoot, "cache");
    const dataDir = path.join(tempRoot, "data");
    const stateDir = path.join(tempRoot, "state");
    const runtimeDir = path.join(tempRoot, "runtime");
    for (const directory of [
      homeDir,
      configDir,
      cacheDir,
      dataDir,
      stateDir,
      runtimeDir,
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.chmodSync(runtimeDir, 0o700);

    const env = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      XDG_STATE_HOME: stateDir,
      XDG_RUNTIME_DIR: runtimeDir,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VIDEOSWARM_DISABLE_SANDBOX;

    let electronApp;
    try {
      electronApp = await electron.launch({
        executablePath: installedExecutable,
        chromiumSandbox: true,
        cwd: homeDir,
        env,
        timeout: 30_000,
      });

      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page).toHaveTitle(/Video Swarm/);
      await expect(
        page.locator(".app").getByText("Welcome to Video Swarm")
      ).toBeVisible();

      const runtime = await electronApp.evaluate(({ app }) => ({
        isPackaged: app.isPackaged,
        noSandbox: app.commandLine.hasSwitch("no-sandbox"),
        disableSetuidSandbox: app.commandLine.hasSwitch(
          "disable-setuid-sandbox"
        ),
        argv: process.argv,
        execPath: process.execPath,
      }));

      expect(runtime.isPackaged).toBe(true);
      expect(runtime.noSandbox).toBe(false);
      expect(runtime.disableSetuidSandbox).toBe(false);
      expect(runtime.argv).not.toContain("--no-sandbox");
      expect(runtime.argv).not.toContain("--disable-setuid-sandbox");
      expect(runtime.execPath).toBe("/opt/VideoSwarm/video-swarm-bin");
      await expect
        .poll(() =>
          page.evaluate(() => ({
            isElectron: window.electronAPI?.isElectron,
            hasDirectoryBridge:
              typeof window.electronAPI?.readDirectory === "function",
          }))
        )
        .toEqual({ isElectron: true, hasDirectoryBridge: true });
    } finally {
      await electronApp?.close().catch(() => {});
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
