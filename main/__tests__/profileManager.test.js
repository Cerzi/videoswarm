import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const profileManager = require("../profile-manager");

function readConfig(basePath) {
  const configPath = path.join(basePath, "profiles.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

describe("profile manager", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-profile-test-"));
    profileManager.resetForTests();
    profileManager.initializeProfileManager(tempDir);
  });

  afterEach(() => {
    profileManager.resetForTests();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("initializes with a default profile", () => {
    const profiles = profileManager.listProfiles();
    expect(profiles.length).toBeGreaterThan(0);
    const active = profileManager.getActiveProfile();
    const config = readConfig(tempDir);
    expect(config.activeProfileId).toBe(active);
    expect(fs.existsSync(profileManager.resolveProfilePath(active))).toBe(true);
  });

  it("exposes the userData path after initialization", () => {
    expect(profileManager.getUserDataPath()).toBe(tempDir);
  });

  it("creates, activates, and resolves new profiles", () => {
    const created = profileManager.createProfile("Artist Cuts");
    expect(created.name).toBe("Artist Cuts");
    expect(created.id).toMatch(/artist-cuts/);

    const newPath = profileManager.resolveProfilePath(created.id);
    expect(newPath.startsWith(path.join(tempDir, "profiles"))).toBe(true);
    expect(fs.existsSync(newPath)).toBe(true);

    profileManager.setActiveProfile(created.id);
    expect(profileManager.getActiveProfile()).toBe(created.id);

    const config = readConfig(tempDir);
    expect(config.activeProfileId).toBe(created.id);
  });

  it("renames and deletes profiles while maintaining a valid active profile", () => {
    const extra = profileManager.createProfile("Editor");
    profileManager.setActiveProfile(extra.id);

    const renamed = profileManager.renameProfile(extra.id, "Editorial");
    expect(renamed.name).toBe("Editorial");

    const removed = profileManager.deleteProfile(extra.id);
    expect(removed.id).toBe(extra.id);
    const remainingIds = profileManager.listProfiles().map((p) => p.id);
    expect(remainingIds).not.toContain(extra.id);
    expect(profileManager.getActiveProfile()).not.toBe(extra.id);

    const removedPath = path.join(tempDir, "profiles", extra.id);
    expect(fs.existsSync(removedPath)).toBe(false);
  });
});
