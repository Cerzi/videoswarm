import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  applyPortableMode,
  detectPortableRoot,
  portableEnvironment,
  portablePaths,
} = require("../portable-mode");

describe("portable mode", () => {
  let base;
  afterEach(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
    base = null;
  });
  const folder = () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-portable-"));
    return base;
  };

  it("is off for an installed copy", () => {
    const root = folder();
    expect(detectPortableRoot({ env: {}, execPath: path.join(root, "video-swarm-bin"), platform: "linux" })).toBeNull();
  });

  it("finds the portable folder from a launcher, a Windows portable build, an AppImage or a marker", () => {
    const root = folder();
    const exe = path.join(root, "video-swarm-bin");
    expect(detectPortableRoot({ env: { VIDEOSWARM_PORTABLE_DIR: root }, execPath: exe, platform: "linux" })).toEqual({
      root,
      source: "environment",
    });
    expect(
      detectPortableRoot({ env: { PORTABLE_EXECUTABLE_DIR: root }, execPath: "C:/Temp/x/VideoSwarm.exe", platform: "win32" })
    ).toEqual({ root: path.resolve(root), source: "windows-portable" });
    // Only on Windows, and only for a real folder.
    expect(detectPortableRoot({ env: { PORTABLE_EXECUTABLE_DIR: root }, execPath: exe, platform: "linux" })).toBeNull();
    const image = path.join(root, "VideoSwarm.AppImage");
    fs.writeFileSync(image, "");
    expect(detectPortableRoot({ env: { APPIMAGE: image }, execPath: "/tmp/.mount_x/video-swarm", platform: "linux" })).toEqual({
      root,
      source: "appimage",
    });
    fs.writeFileSync(path.join(root, "portable"), "");
    expect(detectPortableRoot({ env: {}, execPath: exe, platform: "linux" })).toEqual({ root, source: "marker" });
    // On macOS the marker sits beside the .app, not inside it.
    const macExe = path.join(root, "VideoSwarm.app", "Contents", "MacOS", "VideoSwarm");
    expect(detectPortableRoot({ env: {}, execPath: macExe, platform: "darwin" })).toEqual({ root, source: "marker" });
  });

  it("moves every folder and the processes' environment into the portable folder", () => {
    const root = folder();
    const paths = portablePaths(root);
    const app = { setPath: vi.fn() };
    const env = { TMPDIR: "/tmp", XDG_CACHE_HOME: "/home/someone/.cache" };
    applyPortableMode(app, paths, { env, platform: "linux" });
    const set = Object.fromEntries(app.setPath.mock.calls);
    expect(set).toEqual({
      appData: path.join(root, "VideoSwarmData"),
      userData: path.join(root, "VideoSwarmData", "user-data"),
      sessionData: path.join(root, "VideoSwarmData", "user-data"),
      temp: path.join(root, "VideoSwarmData", "temp"),
      logs: path.join(root, "VideoSwarmData", "logs"),
      crashDumps: path.join(root, "VideoSwarmData", "crash-dumps"),
    });
    expect(env).toEqual({ ...env, ...portableEnvironment(paths, "linux") });
    expect(env.XDG_CACHE_HOME).toBe(path.join(root, "VideoSwarmData", "xdg", "cache"));
    expect(env.TMPDIR).toBe(path.join(root, "VideoSwarmData", "temp"));
    for (const dir of [paths.userData, paths.temp, paths.xdgConfig, paths.xdgCache, paths.xdgData]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
    // Every folder is inside the portable one.
    expect(Object.values(portableEnvironment(paths, "linux")).every((value) => value.startsWith(root))).toBe(true);
    // Windows has no XDG folders to move.
    expect(Object.keys(portableEnvironment(paths, "win32")).sort()).toEqual(["TEMP", "TMP", "TMPDIR"]);
  });

  it("refuses a folder it cannot write rather than writing elsewhere", () => {
    const root = folder();
    const app = { setPath: vi.fn() };
    const fsApi = { ...fs, mkdirSync: vi.fn(), accessSync: vi.fn(() => { throw Object.assign(new Error("read-only"), { code: "EROFS" }); }) };
    expect(() => applyPortableMode(app, portablePaths(root), { env: {}, platform: "linux", fsApi })).toThrow(/read-only/u);
    expect(app.setPath).not.toHaveBeenCalled();
  });
});
