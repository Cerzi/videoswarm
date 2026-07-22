const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("@playwright/test");

const projectRoot = path.resolve(__dirname, "../../..");

function createProductionAppWorkspace() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "videoswarm-electron-test-")
  );
  const homeDir = path.join(tempRoot, "home");
  const configDir = path.join(tempRoot, "config");
  const cacheDir = path.join(tempRoot, "cache");
  const appShellDir = path.join(tempRoot, "app-shell");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(appShellDir, { recursive: true });
  fs.writeFileSync(
    path.join(appShellDir, "package.json"),
    JSON.stringify({
      name: "video-swarm-electron-test",
      version: "0.0.0",
      main: path.join(projectRoot, "main.js"),
    })
  );

  let cleaned = false;
  return {
    tempRoot,
    homeDir,
    configDir,
    cacheDir,
    appShellDir,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

async function launchProductionApp({
  extraArgs = [],
  extraEnv = {},
  workspace = null,
} = {}) {
  const appWorkspace = workspace || createProductionAppWorkspace();
  const {
    tempRoot,
    homeDir,
    configDir,
    cacheDir,
    appShellDir,
  } = appWorkspace;

  const windowsAppDataDir = path.join(homeDir, "AppData", "Roaming");
  const windowsLocalAppDataDir = path.join(homeDir, "AppData", "Local");
  if (process.platform === "win32") {
    fs.mkdirSync(windowsAppDataDir, { recursive: true });
    fs.mkdirSync(windowsLocalAppDataDir, { recursive: true });
  }

  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    ...(process.platform === "win32" ? {
      APPDATA: windowsAppDataDir,
      LOCALAPPDATA: windowsLocalAppDataDir,
    } : {}),
    XDG_CACHE_HOME: cacheDir,
    XDG_CONFIG_HOME: configDir,
    VIDEOSWARM_E2E: "1",
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const displayArgs = process.env.VIDEOSWARM_E2E_HEADLESS === "1"
    ? ["--headless", "--disable-gpu"]
    : [];

  const electronApp = await electron.launch({
    executablePath: require("electron"),
    args: [
      appShellDir,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      ...displayArgs,
      ...extraArgs,
    ],
    cwd: projectRoot,
    env,
    timeout: 30_000,
  });

  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  return {
    electronApp,
    page,
    projectRoot,
    tempRoot,
    workspace: appWorkspace,
    cleanupFiles() {
      appWorkspace.cleanup();
    },
  };
}

async function chooseFolderThroughNativeDialog(electronApp, page, folderPath) {
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selectedPath],
    });
  }, folderPath);
  await page.getByTitle("Select folder").click();
}

module.exports = {
  createProductionAppWorkspace,
  launchProductionApp,
  chooseFolderThroughNativeDialog,
};
