import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
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
    vi.restoreAllMocks();
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

    profileManager.setActiveProfile(profileManager.DEFAULT_PROFILE_ID);
    const removed = profileManager.deleteProfile(extra.id);
    expect(removed.id).toBe(extra.id);
    const remainingIds = profileManager.listProfiles().map((p) => p.id);
    expect(remainingIds).not.toContain(extra.id);
    expect(profileManager.getActiveProfile()).not.toBe(extra.id);

    const removedPath = path.join(tempDir, "profiles", extra.id);
    expect(fs.existsSync(removedPath)).toBe(false);
  });

  it("rejects path-like, malformed, and oversized profile ids", () => {
    const profilesRoot = path.join(tempDir, "profiles");
    const outsidePath = path.join(tempDir, "escape");
    const invalidIds = [
      "../escape",
      "/tmp/escape",
      "nested/profile",
      "with\\separator",
      "two--segments",
      "UPPERCASE",
      "a".repeat(profileManager.MAX_PROFILE_ID_LENGTH + 1),
    ];

    for (const invalidId of invalidIds) {
      expect(() => profileManager.resolveProfilePath(invalidId)).toThrow();
      expect(() => profileManager.setActiveProfile(invalidId)).toThrow();
      expect(() => profileManager.renameProfile(invalidId, "Name")).toThrow();
      expect(() => profileManager.deleteProfile(invalidId)).toThrow();
    }

    expect(fs.existsSync(outsidePath)).toBe(false);
    for (const entry of fs.readdirSync(profilesRoot)) {
      const relative = path.relative(profilesRoot, path.join(profilesRoot, entry));
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
  });

  it("sanitizes, deduplicates, and caps an untrusted on-disk catalog", () => {
    const catalogProfiles = [
      { id: "valid-one", name: "  Valid\u0000 One  " },
      { id: "valid-one", name: "Duplicate" },
      { id: "../escape", name: "Traversal" },
      { id: "UPPERCASE", name: "Unsafe on case-insensitive filesystems" },
      ...Array.from({ length: 80 }, (_, index) => ({
        id: `profile-${index}`,
        name: `Profile ${index}`,
      })),
    ];
    fs.writeFileSync(
      path.join(tempDir, "profiles.json"),
      JSON.stringify({
        profiles: catalogProfiles,
        activeProfileId: "../escape",
      })
    );
    profileManager.resetForTests();
    profileManager.initializeProfileManager(tempDir);

    const profiles = profileManager.listProfiles();
    expect(profiles).toHaveLength(profileManager.MAX_PROFILES);
    expect(new Set(profiles.map((profile) => profile.id)).size).toBe(
      profileManager.MAX_PROFILES
    );
    expect(profiles[0]).toEqual({ id: "default", name: "Default" });
    expect(profiles.find((profile) => profile.id === "valid-one")?.name).toBe(
      "Valid One"
    );
    expect(profiles.map((profile) => profile.id)).not.toContain("../escape");
    expect(profileManager.getActiveProfile()).toBe("default");
    expect(fs.existsSync(path.join(tempDir, "escape"))).toBe(false);
    expect(() => profileManager.createProfile("Over cap")).toThrow(
      /maximum of 64 profiles/i
    );
  });

  it("recovers safe profile directories when the catalog is corrupt", () => {
    const created = profileManager.createProfile("Recovered Work");
    const profilePath = profileManager.resolveProfilePath(created.id);
    fs.writeFileSync(path.join(profilePath, "metadata.db"), "keep profile data");
    fs.writeFileSync(path.join(tempDir, "profiles.json"), "{not valid json");

    profileManager.resetForTests();
    profileManager.initializeProfileManager(tempDir);

    expect(profileManager.listProfiles()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.id }),
        expect.objectContaining({ id: profileManager.DEFAULT_PROFILE_ID }),
      ])
    );
    expect(
      fs.readFileSync(path.join(profilePath, "metadata.db"), "utf8")
    ).toBe("keep profile data");
    expect(readConfig(tempDir).profiles.map((profile) => profile.id)).toContain(
      created.id
    );
  });

  it("bounds a profile catalog that grows while its open handle is read", () => {
    const created = profileManager.createProfile("Growing Catalog");
    const configPath = path.join(tempDir, "profiles.json");
    profileManager.resetForTests();
    const originalRead = fs.readSync.bind(fs);
    let expanded = false;
    vi.spyOn(fs, "readSync").mockImplementation(
      (fileHandle, buffer, offset, length, position) => {
        const bytesRead = originalRead(
          fileHandle,
          buffer,
          offset,
          length,
          position
        );
        if (!expanded && bytesRead > 0) {
          expanded = true;
          fs.appendFileSync(
            configPath,
            " ".repeat(profileManager.MAX_CONFIG_BYTES + 1)
          );
        }
        return bytesRead;
      }
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    profileManager.initializeProfileManager(tempDir);

    expect(expanded).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read config"),
      expect.objectContaining({
        message: expect.stringMatching(/storage limit|bounded/i),
      })
    );
    expect(profileManager.listProfiles()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.id })])
    );
    expect(fs.statSync(configPath).size).toBeLessThanOrEqual(
      profileManager.MAX_CONFIG_BYTES
    );
  });

  it("bounds generated ids while preserving collision suffixes", () => {
    const longName = "Very Long Profile Name ".repeat(10).slice(0, 128);
    const first = profileManager.createProfile(longName);
    const second = profileManager.createProfile(longName);

    expect(first.id.length).toBeLessThanOrEqual(
      profileManager.MAX_PROFILE_ID_LENGTH
    );
    expect(second.id.length).toBeLessThanOrEqual(
      profileManager.MAX_PROFILE_ID_LENGTH
    );
    expect(second.id).not.toBe(first.id);
    expect(second.id).toMatch(/-2$/);
  });

  it("atomically persists catalog changes and cleans a failed temp write", () => {
    const configPath = path.join(tempDir, "profiles.json");
    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === configPath && String(from).endsWith(".tmp")) {
        const error = new Error("simulated rename failure");
        error.code = "EIO";
        throw error;
      }
      return originalRename(from, to);
    });

    expect(() => profileManager.createProfile("Atomic Failure")).toThrow(
      /simulated rename failure/
    );
    expect(profileManager.listProfiles().map((profile) => profile.id)).not.toContain(
      "atomic-failure"
    );
    expect(
      fs.existsSync(path.join(tempDir, "profiles", "atomic-failure"))
    ).toBe(false);
    expect(
      fs.readdirSync(tempDir).filter((entry) => entry.endsWith(".tmp"))
    ).toEqual([]);
    rename.mockRestore();

    profileManager.createProfile("Atomic Success");
    expect(readConfig(tempDir).profiles.map((profile) => profile.id)).toContain(
      "atomic-success"
    );
    expect(
      fs.readdirSync(tempDir).filter((entry) => entry.endsWith(".tmp"))
    ).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it("restores a quarantined profile directory when catalog persistence fails", () => {
    const created = profileManager.createProfile("Rollback");
    const profilePath = profileManager.resolveProfilePath(created.id);
    fs.writeFileSync(path.join(profilePath, "data.txt"), "keep me");
    const configPath = path.join(tempDir, "profiles.json");
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === configPath && String(from).endsWith(".tmp")) {
        throw new Error("catalog unavailable");
      }
      return originalRename(from, to);
    });

    expect(() => profileManager.deleteProfile(created.id)).toThrow(
      /catalog unavailable/
    );
    expect(profileManager.listProfiles().map((profile) => profile.id)).toContain(
      created.id
    );
    expect(fs.readFileSync(path.join(profilePath, "data.txt"), "utf8")).toBe(
      "keep me"
    );
    expect(
      fs.readdirSync(path.join(tempDir, "profiles")).filter((entry) =>
        entry.startsWith(`.profile-delete-${created.id}-`)
      )
    ).toEqual([]);
  });

  it("durably removes the catalog entry and reports quarantine cleanup failure", () => {
    const created = profileManager.createProfile("Cleanup Failure");
    const profilePath = profileManager.resolveProfilePath(created.id);
    fs.writeFileSync(path.join(profilePath, "data.txt"), "temporary");
    const originalRemove = fs.rmSync.bind(fs);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const remove = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (path.basename(String(target)).startsWith(`.profile-delete-${created.id}-`)) {
        throw new Error("cleanup unavailable");
      }
      return originalRemove(target, options);
    });

    let thrown = null;
    try {
      profileManager.deleteProfile(created.id);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "PROFILE_DIRECTORY_CLEANUP_FAILED",
      profileDeleted: true,
    });
    expect(profileManager.listProfiles().map((profile) => profile.id)).not.toContain(
      created.id
    );
    expect(readConfig(tempDir).profiles.map((profile) => profile.id)).not.toContain(
      created.id
    );
    expect(fs.existsSync(profilePath)).toBe(false);
    expect(warn).toHaveBeenCalled();

    remove.mockRestore();
    expect(profileManager.removeProfileDirectory(created.id)).toBe(true);
  });

  it("supports catalog-only deletion followed by explicit directory cleanup", () => {
    const created = profileManager.createProfile("Deferred Cleanup");
    const profilePath = profileManager.resolveProfilePath(created.id);

    const removed = profileManager.deleteProfile(created.id, {
      removeFiles: false,
    });
    expect(removed.id).toBe(created.id);
    expect(fs.existsSync(profilePath)).toBe(true);
    expect(profileManager.removeProfileDirectory(created.id)).toBe(true);
    expect(fs.existsSync(profilePath)).toBe(false);
  });

  it("will not remove files for the currently active profile", () => {
    const created = profileManager.createProfile("Active");
    profileManager.setActiveProfile(created.id);

    expect(() => profileManager.deleteProfile(created.id)).toThrow(
      /switch away from the active profile/i
    );
    expect(fs.existsSync(profileManager.resolveProfilePath(created.id))).toBe(true);
    expect(profileManager.listProfiles().map((profile) => profile.id)).toContain(
      created.id
    );
  });

  it("recovers a staged directory after an interrupted pre-commit deletion", () => {
    const created = profileManager.createProfile("Interrupted");
    const profilePath = profileManager.resolveProfilePath(created.id);
    fs.writeFileSync(path.join(profilePath, "data.txt"), "recover me");
    const quarantinePath = path.join(
      tempDir,
      "profiles",
      `.profile-delete-${created.id}-0123456789abcdef`
    );
    fs.renameSync(profilePath, quarantinePath);

    profileManager.resetForTests();
    profileManager.initializeProfileManager(tempDir);

    expect(fs.readFileSync(path.join(profilePath, "data.txt"), "utf8")).toBe(
      "recover me"
    );
    expect(fs.existsSync(quarantinePath)).toBe(false);
  });
});
