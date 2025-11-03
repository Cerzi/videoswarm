import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { migrateLegacyProfileData } = require("../profile-migration");

describe("migrateLegacyProfileData", () => {
  let tempDir;
  let profileDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-profile-migration-"));
    profileDir = path.join(tempDir, "profiles", "default");
    fs.mkdirSync(profileDir, { recursive: true });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("copies known legacy files and directories into the default profile", async () => {
    const legacyDbPath = path.join(tempDir, "videoswarm-meta.db");
    const legacyWalPath = path.join(tempDir, "videoswarm-meta.db-wal");
    const legacyRecent = path.join(tempDir, "recent-folders.json");
    const legacyThumbs = path.join(tempDir, "thumbs");
    const nestedThumb = path.join(legacyThumbs, "nested", "thumb.bin");

    fs.writeFileSync(legacyDbPath, "db");
    fs.writeFileSync(legacyWalPath, "wal");
    fs.writeFileSync(legacyRecent, JSON.stringify({ items: ["/example"] }));
    fs.mkdirSync(path.dirname(nestedThumb), { recursive: true });
    fs.writeFileSync(nestedThumb, "thumb");

    await migrateLegacyProfileData({
      profileId: "default",
      profilePath: profileDir,
      userDataPath: tempDir,
      defaultProfileId: "default",
    });

    expect(fs.existsSync(path.join(profileDir, "videoswarm-meta.db"))).toBe(true);
    expect(fs.existsSync(path.join(profileDir, "videoswarm-meta.db-wal"))).toBe(true);
    expect(fs.existsSync(path.join(profileDir, "recent-folders.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(profileDir, "thumbs", "nested", "thumb.bin"))
    ).toBe(true);
  });

  it("skips migration for non-default profiles", async () => {
    const legacyDbPath = path.join(tempDir, "videoswarm-meta.db");
    fs.writeFileSync(legacyDbPath, "db");

    await migrateLegacyProfileData({
      profileId: "alt",
      profilePath: path.join(tempDir, "profiles", "alt"),
      userDataPath: tempDir,
      defaultProfileId: "default",
    });

    expect(fs.existsSync(path.join(tempDir, "profiles", "alt", "videoswarm-meta.db"))).toBe(
      false
    );
  });

  it("does not overwrite existing profile data", async () => {
    const legacyDbPath = path.join(tempDir, "videoswarm-meta.db");
    fs.writeFileSync(legacyDbPath, "db-old");

    const targetDb = path.join(profileDir, "videoswarm-meta.db");
    fs.writeFileSync(targetDb, "db-new");

    await migrateLegacyProfileData({
      profileId: "default",
      profilePath: profileDir,
      userDataPath: tempDir,
      defaultProfileId: "default",
    });

    expect(fs.readFileSync(targetDb, "utf8")).toBe("db-new");
  });
});
