const fs = require("fs");
const fsPromises = fs.promises;
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { writeFileAtomically } = require("./settings-writer");

const MAX_BOOTSTRAP_BYTES = 64 * 1024;

const DEFAULT_CONFIG = {
  preferredDataDir: null,
  migrationRequested: false,
  pendingMigration: null,
  lastKnownUserDataDir: null,
  version: 1,
  revision: 0,
  supersedesBootstrap: null,
};

function normalizePath(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return path.resolve(value.trim());
}

function unique(array) {
  return Array.from(new Set(array.filter(Boolean)));
}

function normalizeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function bootstrapSignature(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

function normalizeSupersedesBootstrap(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.path !== "string" ||
    !value.path.trim() ||
    typeof value.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.signature)
  ) {
    return null;
  }
  return {
    path: path.resolve(value.path.trim()),
    signature: value.signature,
  };
}

function readBootstrapConfig(candidate) {
  let handle = null;
  try {
    handle = fs.openSync(candidate, "r");
    const before = fs.fstatSync(handle);
    if (!before.isFile() || before.size > MAX_BOOTSTRAP_BYTES) {
      throw new Error("Bootstrap configuration is not a bounded regular file");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    const after = fs.fstatSync(handle);
    if (offset !== before.size || after.size !== before.size) {
      throw new Error("Bootstrap configuration changed while it was being read");
    }
    const raw = bytes.toString("utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Bootstrap configuration must be an object");
    }
    return {
      config: {
        ...DEFAULT_CONFIG,
        ...parsed,
        revision: normalizeRevision(parsed.revision),
        supersedesBootstrap: normalizeSupersedesBootstrap(
          parsed.supersedesBootstrap
        ),
      },
      revision: normalizeRevision(parsed.revision),
      signature: bootstrapSignature(raw),
    };
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

class DataLocationManager {
  constructor({ app, dialog, homeDir = os.homedir() }) {
    this.app = app;
    this.dialog = dialog;
    this.homeDir = path.resolve(homeDir);
    this.config = { ...DEFAULT_CONFIG };
    this.configPath = null;
    this.configSignature = null;
    this.defaultPath = null;
    this.commandLinePath = null;
    this.effectivePath = null;
    this.source = "default";
    this.portablePresetPath = null;
  }

  bootstrap(argv = []) {
    this.defaultPath = this.app.getPath("userData");
    this.commandLinePath = this.extractCommandLineOverride(argv);
    this.config = this.loadConfig();

    const preferred = normalizePath(this.config.preferredDataDir);
    const target = this.commandLinePath || preferred || this.defaultPath;
    const resolvedTarget = normalizePath(target) || this.defaultPath;
    this.effectivePath = resolvedTarget;

    if (this.commandLinePath) {
      this.source = "commandLine";
    } else if (preferred) {
      this.source = "config";
    } else {
      this.source = "default";
    }

    if (resolvedTarget !== this.defaultPath) {
      this.app.setPath("userData", resolvedTarget);
    }

    this.portablePresetPath = path.join(this.resolveAppFolder(), "VideoSwarmData");

    return {
      effectivePath: this.effectivePath,
      source: this.source,
    };
  }

  extractCommandLineOverride(argv = []) {
    if (!Array.isArray(argv)) {
      return null;
    }

    const inline = argv.find((arg) =>
      typeof arg === "string" && arg.startsWith("--user-data-dir=")
    );
    if (inline) {
      const value = inline.slice("--user-data-dir=".length);
      return normalizePath(value);
    }

    const index = argv.findIndex((arg) => arg === "--user-data-dir");
    if (index >= 0 && typeof argv[index + 1] === "string") {
      return normalizePath(argv[index + 1]);
    }

    return null;
  }

  getBootstrapCandidates() {
    const candidates = [];
    const appFolder = this.resolveAppFolder();
    candidates.push(path.join(appFolder, "videoswarm-bootstrap.json"));

    const homeFallback = path.join(this.homeDir, ".videoswarm");
    candidates.push(path.join(homeFallback, "videoswarm-bootstrap.json"));

    return unique(candidates);
  }

  resolveAppFolder() {
    try {
      if (this.app.isPackaged) {
        return path.dirname(process.execPath);
      }
      return path.resolve(this.app.getAppPath());
    } catch (error) {
      console.warn("[data-location] Failed to resolve app folder", error);
      return path.dirname(process.execPath);
    }
  }

  loadConfig() {
    const candidates = this.getBootstrapCandidates();
    let selected = null;
    for (const candidate of candidates) {
      try {
        if (!fs.existsSync(candidate)) {
          continue;
        }
        const loaded = readBootstrapConfig(candidate);
        const supersedes = loaded.config.supersedesBootstrap;
        const replacesSelected =
          selected &&
          supersedes?.path === path.resolve(selected.candidate) &&
          supersedes?.signature === selected.signature &&
          loaded.revision > selected.revision;
        if (!selected || replacesSelected) {
          selected = { ...loaded, candidate };
        }
      } catch (error) {
        console.warn("[data-location] Failed to read bootstrap config", error);
      }
    }

    if (selected) {
      this.configPath = selected.candidate;
      this.configSignature = selected.signature;
      return selected.config;
    }

    this.configPath = candidates[0];
    this.configSignature = null;
    return { ...DEFAULT_CONFIG };
  }

  async saveConfig() {
    const currentRevision = normalizeRevision(this.config.revision);
    if (currentRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Bootstrap configuration revision is exhausted");
    }
    const nextConfigBase = {
      ...this.config,
      version: 1,
      revision: currentRevision + 1,
    };
    const sourcePath = this.configPath ? path.resolve(this.configPath) : null;
    const sourceSignature = this.configSignature;
    const tried = new Set();
    const candidates = unique([this.configPath, ...this.getBootstrapCandidates()]);

    for (const candidate of candidates) {
      if (!candidate || tried.has(candidate)) {
        continue;
      }
      tried.add(candidate);
      try {
        const normalizedCandidate = path.resolve(candidate);
        const supersedesBootstrap =
          sourcePath &&
          sourceSignature &&
          normalizedCandidate !== sourcePath
            ? { path: sourcePath, signature: sourceSignature }
            : normalizeSupersedesBootstrap(
                nextConfigBase.supersedesBootstrap
              );
        const nextConfig = {
          ...nextConfigBase,
          supersedesBootstrap,
        };
        const payload = JSON.stringify(nextConfig, null, 2);
        await writeFileAtomically(candidate, payload, { fsApi: fsPromises });
        this.config = nextConfig;
        this.configPath = candidate;
        this.configSignature = bootstrapSignature(payload);
        return candidate;
      } catch (error) {
        console.warn("[data-location] Failed to save bootstrap config", {
          candidate,
          error: error?.message,
        });
      }
    }

    throw new Error("Unable to write bootstrap configuration");
  }

  async saveConfigSafe() {
    try {
      await this.saveConfig();
    } catch (error) {
      console.error("[data-location] Unable to persist bootstrap config", error);
    }
  }

  async ensureDirectoryWritable(targetPath) {
    const normalized = normalizePath(targetPath);
    if (!normalized) {
      return { ok: false, reason: "EMPTY" };
    }

    try {
      await fsPromises.mkdir(normalized, { recursive: true });
    } catch (error) {
      return { ok: false, reason: "CREATE_FAILED", error };
    }

    try {
      const probe = path.join(
        normalized,
        `.videoswarm-write-test-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`
      );
      await fsPromises.writeFile(probe, "ok", "utf8");
      await fsPromises.unlink(probe).catch(() => {});
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "WRITE_FAILED", error };
    }
  }

  async ensureReady() {
    if (this.commandLinePath) {
      await this.ensureReadyForCommandLine();
      return;
    }

    await this.ensureReadyForConfig();
  }

  async ensureReadyForCommandLine() {
    const target = this.commandLinePath;
    if (!target) {
      return;
    }

    while (true) {
      const check = await this.ensureDirectoryWritable(target);
      if (check.ok) {
        this.effectivePath = target;
        this.config.lastKnownUserDataDir = target;
        this.source = "commandLine";
        await this.saveConfigSafe();
        return;
      }

      const detail = check.error?.message || "";
      const { response } = await this.dialog.showMessageBox({
        type: "error",
        buttons: ["Retry", "Quit"],
        defaultId: 0,
        cancelId: 1,
        title: "VideoSwarm",
        message:
          "VideoSwarm cannot access the data folder specified by '--user-data-dir'.",
        detail: `${target}\n\n${detail}`.trim(),
        noLink: true,
      });

      if (response !== 0) {
        this.app.exit(1);
        return;
      }
    }
  }

  async ensureReadyForConfig() {
    while (true) {
      const target = this.app.getPath("userData");
      const check = await this.ensureDirectoryWritable(target);
      if (check.ok) {
        this.effectivePath = target;
        break;
      }

      const detail = check.error?.message || "";
      const { response } = await this.dialog.showMessageBox({
        type: "error",
        buttons: [
          "Choose another folder…",
          "Use default system location",
          "Quit",
        ],
        defaultId: 0,
        cancelId: 2,
        title: "VideoSwarm",
        message: "VideoSwarm cannot access the configured data folder.",
        detail: `${target}\n\n${detail}`.trim(),
        noLink: true,
      });

      if (response === 2 || response === -1) {
        this.app.exit(1);
        return;
      }

      if (response === 1) {
        this.config.preferredDataDir = null;
        this.config.migrationRequested = false;
        this.config.pendingMigration = null;
        this.effectivePath = this.defaultPath;
        this.app.setPath("userData", this.defaultPath);
        this.source = "default";
        await this.saveConfigSafe();
        continue;
      }

      const selection = await this.dialog.showOpenDialog({
        title: "Select VideoSwarm data folder",
        properties: ["openDirectory", "createDirectory"],
      });

      if (selection.canceled || !selection.filePaths?.length) {
        continue;
      }

      const chosen = normalizePath(selection.filePaths[0]);
      if (!chosen) {
        continue;
      }

      this.config.preferredDataDir = chosen;
      this.config.migrationRequested = false;
      this.config.pendingMigration = null;
      this.effectivePath = chosen;
      this.app.setPath("userData", chosen);
      this.source = "config";
      await this.saveConfigSafe();
    }

    if (this.config?.pendingMigration?.mode === "move") {
      await this.performPendingMigration();
    } else {
      this.config.migrationRequested = false;
      this.config.pendingMigration = null;
      await this.saveConfigSafe();
    }

    this.config.lastKnownUserDataDir = this.effectivePath;
    await this.saveConfigSafe();
  }

  async performPendingMigration() {
    const pending = this.config.pendingMigration;
    if (!pending || pending.mode !== "move") {
      this.config.migrationRequested = false;
      this.config.pendingMigration = null;
      await this.saveConfigSafe();
      return;
    }

    const source = normalizePath(pending.from);
    const destination = normalizePath(pending.to);

    if (!source || !destination || source === destination) {
      this.config.migrationRequested = false;
      this.config.pendingMigration = null;
      const fallbackTarget = destination || this.defaultPath;
      this.config.lastKnownUserDataDir = fallbackTarget;
      this.effectivePath = fallbackTarget;
      this.source =
        fallbackTarget === this.defaultPath ? "default" : "config";
      await this.saveConfigSafe();
      return;
    }

    while (true) {
      try {
        const sourceExists = await fsPromises
          .stat(source)
          .then(() => true)
          .catch(() => false);

        if (!sourceExists) {
          this.config.migrationRequested = false;
          this.config.pendingMigration = null;
          this.config.lastKnownUserDataDir = destination;
          this.effectivePath = destination;
          this.source = destination === this.defaultPath ? "default" : "config";
          await this.saveConfigSafe();
          return;
        }

        await fsPromises.mkdir(destination, { recursive: true });
        await fsPromises.cp(source, destination, {
          recursive: true,
          force: true,
        });
        await fsPromises.rm(source, { recursive: true, force: true });

        this.config.migrationRequested = false;
        this.config.pendingMigration = null;
        this.config.lastKnownUserDataDir = destination;
        this.effectivePath = destination;
        this.source = destination === this.defaultPath ? "default" : "config";
        this.app.setPath("userData", destination);
        await this.saveConfigSafe();
        return;
      } catch (error) {
        const { response } = await this.dialog.showMessageBox({
          type: "warning",
          buttons: ["Retry", "Revert to old folder", "Continue anyway"],
          defaultId: 0,
          cancelId: 2,
          title: "VideoSwarm",
          message: "Moving VideoSwarm data to the new folder failed.",
          detail: error?.message || "",
          noLink: true,
        });

        if (response === 0) {
          continue;
        }

        if (response === 1) {
          const revertPath = source;
          this.config.preferredDataDir =
            revertPath && revertPath === this.defaultPath ? null : revertPath;
          this.config.migrationRequested = false;
          this.config.pendingMigration = null;
          this.effectivePath = revertPath || this.defaultPath;
          this.config.lastKnownUserDataDir = this.effectivePath;
          this.source =
            this.effectivePath === this.defaultPath ? "default" : "config";
          this.app.setPath("userData", this.effectivePath);
          await this.saveConfigSafe();
          return;
        }

        this.config.migrationRequested = false;
        this.config.pendingMigration = null;
        this.config.lastKnownUserDataDir = destination;
        this.effectivePath = destination;
        this.source = destination === this.defaultPath ? "default" : "config";
        await this.saveConfigSafe();
        return;
      }
    }
  }

  getRendererState() {
    const preferredPath = normalizePath(this.config.preferredDataDir);
    const effectivePath = this.app.getPath("userData");
    return {
      defaultPath: this.defaultPath,
      effectivePath,
      preferredPath,
      isUsingDefault: !preferredPath,
      isCommandLineOverride: !!this.commandLinePath,
      commandLinePath: this.commandLinePath,
      portablePresetPath: this.portablePresetPath,
      migrationRequested: !!this.config.migrationRequested,
      source: this.source,
    };
  }

  async browseForDirectory(browserWindow) {
    const result = await this.dialog.showOpenDialog(browserWindow || null, {
      title: "Select VideoSwarm data folder",
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || !result.filePaths?.length) {
      return null;
    }

    return normalizePath(result.filePaths[0]);
  }

  async applySelection(payload = {}, browserWindow, options = {}) {
    if (this.commandLinePath) {
      return { status: "overridden" };
    }

    const useDefault = !!payload.useDefault;
    const requestedPath = normalizePath(payload.customPath);
    const targetPath = useDefault ? this.defaultPath : requestedPath;

    if (!useDefault && !requestedPath) {
      return { status: "invalid", reason: "missing-custom-path" };
    }

    const current = this.app.getPath("userData");
    if (normalizePath(current) === normalizePath(targetPath)) {
      return { status: "unchanged" };
    }

    const { response } = await this.dialog.showMessageBox(browserWindow || null, {
      type: "question",
      buttons: [
        "Move && Restart",
        "Use New Folder (Fresh Data) && Restart",
        "Cancel",
      ],
      defaultId: 0,
      cancelId: 2,
      title: "VideoSwarm",
      message:
        "VideoSwarm needs to restart to use the new data folder. Move your existing settings, profiles, thumbnails, and caches to the new location?",
      detail: `New data folder:\n${targetPath}`,
      noLink: true,
    });

    if (response === 2 || response === -1) {
      return { status: "cancelled" };
    }

    const shouldMove = response === 0;
    const check = await this.ensureDirectoryWritable(targetPath);
    if (!check.ok) {
      await this.dialog.showMessageBox(browserWindow || null, {
        type: "error",
        buttons: ["OK"],
        defaultId: 0,
        cancelId: 0,
        title: "VideoSwarm",
        message: "VideoSwarm cannot write to the selected data folder.",
        detail: check.error?.message || "",
        noLink: true,
      });
      return { status: "invalid", reason: "unwritable" };
    }

    const normalizedTarget = normalizePath(targetPath);
    const normalizedCurrent = normalizePath(current);

    const previousConfig = { ...this.config };
    const previousSource = this.source;
    try {
      this.config.preferredDataDir =
        normalizedTarget && normalizedTarget === this.defaultPath
          ? null
          : normalizedTarget;
      this.config.lastKnownUserDataDir = normalizedTarget;
      this.source = normalizedTarget === this.defaultPath ? "default" : "config";

      if (shouldMove) {
        this.config.migrationRequested = true;
        this.config.pendingMigration = {
          from: normalizedCurrent,
          to: normalizedTarget,
          mode: "move",
        };
      } else {
        this.config.migrationRequested = false;
        this.config.pendingMigration = null;
      }

      // A relaunch is only safe once the new bootstrap location is durable.
      await this.saveConfig();
    } catch (error) {
      this.config = previousConfig;
      this.source = previousSource;
      throw error;
    }

    if (typeof options.beforeRestart === "function") {
      await options.beforeRestart();
    }

    setImmediate(() => {
      try {
        this.app.relaunch();
      } finally {
        this.app.exit(0);
      }
    });

    return { status: "relaunching" };
  }
}

module.exports = { DataLocationManager };
