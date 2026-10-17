const fs = require("fs");
const path = require("path");

// Portable mode (docs/architecture/portable-mode.md): a copy of Video Swarm
// that keeps everything it writes in one folder beside itself and leaves
// nothing anywhere else on the computer, so it never mixes with an installed
// copy or another portable one.
//
// Decided before anything touches a system location, at the very top of
// main.js: Electron's folders, the single-instance lock, Chromium's and
// child processes' temporary, cache and config folders all move into the
// portable folder.

const PORTABLE_DATA_DIR = "VideoSwarmData";
// A file of this name beside the executable makes a copy portable.
const PORTABLE_MARKER = "portable";

function isDirectory(fsApi, candidate) {
  try {
    return fsApi.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(fsApi, candidate) {
  try {
    return fsApi.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// The folder a copy's executable lives in, as the user sees it: on macOS the
// one holding the .app bundle, not the bundle's insides.
function executableFolder(execPath, platform) {
  const folder = path.dirname(execPath);
  if (platform === "darwin") {
    const bundle = folder.match(/^(.*)\/[^/]+\.app\/Contents\/MacOS$/u);
    if (bundle) return bundle[1];
  }
  return folder;
}

/**
 * Whether this copy runs portable, and where its folder is:
 * `{ root, source }` or null. In order:
 * - `VIDEOSWARM_PORTABLE_DIR`, for a launcher or for testing;
 * - Windows' single-file portable build (`PORTABLE_EXECUTABLE_DIR`, the
 *   folder of the .exe the user ran, not where it unpacks itself);
 * - a Linux AppImage (`APPIMAGE`, the folder holding it);
 * - a `portable` file beside the executable (an unpacked zip or folder).
 */
function detectPortableRoot({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  fsApi = fs,
} = {}) {
  const explicit = typeof env.VIDEOSWARM_PORTABLE_DIR === "string" ? env.VIDEOSWARM_PORTABLE_DIR.trim() : "";
  if (explicit) return { root: path.resolve(explicit), source: "environment" };
  const windowsPortable = platform === "win32" ? String(env.PORTABLE_EXECUTABLE_DIR || "").trim() : "";
  if (windowsPortable && isDirectory(fsApi, windowsPortable)) {
    return { root: path.resolve(windowsPortable), source: "windows-portable" };
  }
  const appImage = platform === "linux" ? String(env.APPIMAGE || "").trim() : "";
  if (appImage && isFile(fsApi, appImage)) {
    return { root: path.dirname(path.resolve(appImage)), source: "appimage" };
  }
  const folder = executableFolder(execPath, platform);
  if (isFile(fsApi, path.join(folder, PORTABLE_MARKER))) {
    return { root: folder, source: "marker" };
  }
  return null;
}

/** Every folder a portable copy uses, all inside `<root>/VideoSwarmData`. */
function portablePaths(root) {
  const dataDir = path.join(root, PORTABLE_DATA_DIR);
  return {
    root,
    dataDir,
    userData: path.join(dataDir, "user-data"),
    temp: path.join(dataDir, "temp"),
    logs: path.join(dataDir, "logs"),
    crashDumps: path.join(dataDir, "crash-dumps"),
    xdgConfig: path.join(dataDir, "xdg", "config"),
    xdgCache: path.join(dataDir, "xdg", "cache"),
    xdgData: path.join(dataDir, "xdg", "data"),
    xdgState: path.join(dataDir, "xdg", "state"),
  };
}

/**
 * The environment a portable copy's processes need from birth: the temporary
 * folder and, on Linux, the XDG folders, where graphics drivers keep shader
 * caches (Mesa, NVIDIA), fontconfig its cache and GTK its list of recently
 * used files. Chromium starts its helper processes and touches its default
 * folders before main.js runs, so for nothing at all to land outside the
 * portable folder these must be set before Electron starts: by the portable
 * launcher (docs/architecture/portable-mode.md). main.js sets them again
 * for whatever starts later.
 */
function portableEnvironment(paths, platform = process.platform) {
  return {
    TMPDIR: paths.temp,
    TMP: paths.temp,
    TEMP: paths.temp,
    ...(platform === "linux"
      ? {
          XDG_CONFIG_HOME: paths.xdgConfig,
          XDG_CACHE_HOME: paths.xdgCache,
          XDG_DATA_HOME: paths.xdgData,
          XDG_STATE_HOME: paths.xdgState,
        }
      : {}),
  };
}

/**
 * Moves every location into the portable folder: Electron's own paths, and,
 * for this process and every process it starts (Chromium's helpers, ffmpeg),
 * the temporary folder and the XDG cache, config, data and state folders,
 * which is where GPU shader caches, font caches and GTK's list of recently
 * used files would otherwise go. Throws when the folder cannot be written.
 */
function applyPortableMode(app, paths, { env = process.env, platform = process.platform, fsApi = fs } = {}) {
  for (const folder of [
    paths.userData,
    paths.temp,
    paths.logs,
    paths.crashDumps,
    ...(platform === "linux" ? [paths.xdgConfig, paths.xdgCache, paths.xdgData, paths.xdgState] : []),
  ]) {
    fsApi.mkdirSync(folder, { recursive: true });
  }
  // A read-only folder (a locked USB stick, a mounted image) cannot hold a
  // portable copy's data; say so rather than writing elsewhere.
  fsApi.accessSync(paths.dataDir, fs.constants.W_OK);

  app.setPath("appData", paths.dataDir);
  app.setPath("userData", paths.userData);
  app.setPath("sessionData", paths.userData);
  app.setPath("temp", paths.temp);
  app.setPath("logs", paths.logs);
  app.setPath("crashDumps", paths.crashDumps);

  // For what this process starts from now on (ffmpeg, Chromium's later
  // helpers), when the launcher did not already set them.
  Object.assign(env, portableEnvironment(paths, platform));
  return paths;
}

module.exports = {
  PORTABLE_DATA_DIR,
  PORTABLE_MARKER,
  applyPortableMode,
  detectPortableRoot,
  portableEnvironment,
  portablePaths,
};
