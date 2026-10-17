const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron, expect, test } = require("@playwright/test");

/**
 * The Linux portable build as shipped (docs/architecture/portable-mode.md):
 * an extracted VideoSwarm-*-portable folder, started through its launcher.
 * It keeps everything in VideoSwarmData/ beside itself and leaves the home,
 * XDG and temporary folders it was given empty. In CI the sandbox helper is
 * set up first (`sudo setup-sandbox.sh`) and the sandbox must be on.
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

test.describe("Linux portable build", () => {
  test.skip(
    process.platform !== "linux" || process.env.VIDEOSWARM_PORTABLE_SMOKE !== "1",
    "Runs against an extracted portable folder (VIDEOSWARM_PORTABLE_FOLDER)"
  );

  test("starts through its launcher and writes nothing outside its folder", async () => {
    test.setTimeout(90_000);
    const folder = process.env.VIDEOSWARM_PORTABLE_FOLDER;
    expect(folder && fs.existsSync(path.join(folder, "portable"))).toBeTruthy();
    const launcher = path.join(folder, "video-swarm");
    const helper = fs.statSync(path.join(folder, "chrome-sandbox"));
    const sandboxed = helper.uid === 0 && (helper.mode & 0o7777) === 0o4755;
    // Unsandboxed only when asked for explicitly (a machine without sudo).
    expect(sandboxed || process.env.VIDEOSWARM_DISABLE_SANDBOX === "1").toBe(true);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-portable-package-"));
    const dirs = Object.fromEntries(
      ["home", "config", "cache", "data", "state", "runtime", "temp"].map((name) => [name, path.join(tempRoot, name)])
    );
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dirs.runtime, 0o700);
    const env = {
      ...process.env,
      HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_CACHE_HOME: dirs.cache,
      XDG_DATA_HOME: dirs.data,
      XDG_STATE_HOME: dirs.state,
      XDG_RUNTIME_DIR: dirs.runtime,
      TMPDIR: dirs.temp,
      VIDEOSWARM_NO_DIALOG: "1",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VIDEOSWARM_PORTABLE_DIR;

    let electronApp;
    try {
      electronApp = await electron.launch({
        executablePath: launcher,
        args: process.env.VIDEOSWARM_E2E_HEADLESS === "1" ? ["--headless", "--disable-gpu"] : [],
        chromiumSandbox: sandboxed,
        cwd: dirs.home,
        env,
        timeout: 30_000,
      });
      const page = await electronApp.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator(".app").getByText("Welcome to Video Swarm")).toBeVisible();
      const runtime = await electronApp.evaluate(({ app }) => ({
        isPackaged: app.isPackaged,
        noSandbox: app.commandLine.hasSwitch("no-sandbox"),
        userData: app.getPath("userData"),
      }));
      expect(runtime.isPackaged).toBe(true);
      if (sandboxed) expect(runtime.noSandbox).toBe(false);
      expect(runtime.userData).toBe(path.join(folder, "VideoSwarmData", "user-data"));
      const where = await page.evaluate(() => window.electronAPI.dataLocation.getState());
      expect(where).toMatchObject({ isPortable: true, source: "portable" });
      await page.evaluate(() => window.electronAPI.saveSettingsPartial({ zoomLevel: 3 }));
      await page.waitForTimeout(1500);
    } finally {
      await electronApp?.close().catch(() => {});
    }
    try {
      for (const name of ["home", "config", "cache", "data", "state", "temp"]) {
        expect({ [name]: filesUnder(dirs[name]) }).toEqual({ [name]: [] });
      }
      expect(filesUnder(path.join(folder, "VideoSwarmData")).some((file) => file.endsWith("settings.json"))).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
