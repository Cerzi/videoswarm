import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { DataLocationManager } = require("../data-location-manager");

describe("data location persistence", () => {
  let basePath;
  let defaultPath;
  let app;
  let dialog;

  beforeEach(() => {
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-data-location-"));
    defaultPath = path.join(basePath, "user-data");
    fs.mkdirSync(defaultPath);
    let currentUserDataPath = defaultPath;
    app = {
      isPackaged: false,
      getAppPath: vi.fn(() => basePath),
      getPath: vi.fn((name) => {
        if (name !== "userData") throw new Error(`Unexpected path: ${name}`);
        return currentUserDataPath;
      }),
      setPath: vi.fn((_name, value) => {
        currentUserDataPath = value;
      }),
      relaunch: vi.fn(),
      exit: vi.fn(),
    };
    dialog = {
      showMessageBox: vi.fn(async () => ({ response: 1 })),
      showOpenDialog: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(basePath, { recursive: true, force: true });
  });

  it("atomically persists a bounded bootstrap document", async () => {
    const manager = new DataLocationManager({ app, dialog, homeDir: basePath });
    manager.bootstrap([]);
    manager.config.preferredDataDir = path.join(basePath, "chosen");

    const configPath = await manager.saveConfig();
    const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));

    expect(stored.preferredDataDir).toBe(path.join(basePath, "chosen"));
    expect(stored.revision).toBe(1);
    expect(
      fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith(".tmp"))
    ).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it("prefers a newer home fallback when the app-folder config is stale", async () => {
    const manager = new DataLocationManager({ app, dialog, homeDir: basePath });
    manager.bootstrap([]);
    manager.config.preferredDataDir = path.join(basePath, "first");
    const appConfigPath = await manager.saveConfig();

    manager.config.preferredDataDir = path.join(basePath, "second");
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, "rename").mockImplementation(
      async (from, to) => {
        if (to === appConfigPath) {
          const error = new Error("app folder is read only");
          error.code = "EACCES";
          throw error;
        }
        return originalRename(from, to);
      }
    );
    const fallbackPath = await manager.saveConfig();
    rename.mockRestore();

    expect(fallbackPath).not.toBe(appConfigPath);
    expect(JSON.parse(fs.readFileSync(appConfigPath, "utf8"))).toMatchObject({
      preferredDataDir: path.join(basePath, "first"),
      revision: 1,
    });
    expect(JSON.parse(fs.readFileSync(fallbackPath, "utf8"))).toMatchObject({
      preferredDataDir: path.join(basePath, "second"),
      revision: 2,
      supersedesBootstrap: {
        path: appConfigPath,
        signature: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const restarted = new DataLocationManager({ app, dialog, homeDir: basePath });
    const bootstrap = restarted.bootstrap([]);
    expect(bootstrap).toMatchObject({
      effectivePath: path.join(basePath, "second"),
      source: "config",
    });
    expect(restarted.configPath).toBe(fallbackPath);
  });

  it("keeps an explicit app-folder config ahead of an unrelated home config", async () => {
    const manager = new DataLocationManager({ app, dialog, homeDir: basePath });
    manager.bootstrap([]);
    const appChoice = path.join(basePath, "portable-choice");
    manager.config.preferredDataDir = appChoice;
    const appConfigPath = await manager.saveConfig();

    const homeConfigPath = path.join(
      basePath,
      ".videoswarm",
      "videoswarm-bootstrap.json"
    );
    fs.mkdirSync(path.dirname(homeConfigPath), { recursive: true });
    fs.writeFileSync(
      homeConfigPath,
      JSON.stringify({
        preferredDataDir: path.join(basePath, "unrelated-home-choice"),
        revision: 999,
        version: 1,
      })
    );

    const restarted = new DataLocationManager({ app, dialog, homeDir: basePath });
    expect(restarted.bootstrap([])).toMatchObject({
      effectivePath: appChoice,
      source: "config",
    });
    expect(restarted.configPath).toBe(appConfigPath);
  });

  it("does not relaunch or retain an in-memory selection when persistence fails", async () => {
    const manager = new DataLocationManager({ app, dialog, homeDir: basePath });
    manager.bootstrap([]);
    const chosen = path.join(basePath, "chosen");
    fs.mkdirSync(chosen);
    const previousConfig = { ...manager.config };
    const previousSource = manager.source;
    vi.spyOn(manager, "saveConfig").mockRejectedValue(
      new Error("simulated durable write failure")
    );

    await expect(
      manager.applySelection(
        { useDefault: false, customPath: chosen },
        null,
        { beforeRestart: vi.fn() }
      )
    ).rejects.toThrow("simulated durable write failure");

    expect(manager.config).toEqual(previousConfig);
    expect(manager.source).toBe(previousSource);
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });

  it("shows the exact destination before committing a restart", async () => {
    const manager = new DataLocationManager({ app, dialog, homeDir: basePath });
    manager.bootstrap([]);
    const chosen = path.join(basePath, "chosen");
    fs.mkdirSync(chosen);
    const beforeRestart = vi.fn(async () => {});

    await expect(
      manager.applySelection(
        { useDefault: false, customPath: chosen },
        null,
        { beforeRestart }
      )
    ).resolves.toMatchObject({ status: "relaunching" });

    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ detail: `New data folder:\n${chosen}` })
    );
    expect(beforeRestart).toHaveBeenCalledOnce();
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(0);
  });
});
