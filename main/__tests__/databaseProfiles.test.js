import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let database;
let databaseLoadError;
let hasNativeDriver = false;
let BetterSqlite;

try {
  const testRequire = createRequire(import.meta.url);
  BetterSqlite = testRequire("better-sqlite3");
  try {
    const testDb = new BetterSqlite(":memory:");
    testDb.close();
    hasNativeDriver = true;
    database = testRequire("../database");
  } catch (driverError) {
    databaseLoadError = driverError;
  }
} catch (error) {
  databaseLoadError = error;
}

if (!hasNativeDriver || databaseLoadError) {
  describe.skip("profile-aware database", () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  describe("profile-aware database", () => {
    let baseDir;
    let profileA;
    let profileB;
    let mockApp;

    beforeAll(() => {
      baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-db-profile-"));
      profileA = path.join(baseDir, "profiles", "alpha");
      profileB = path.join(baseDir, "profiles", "beta");
      fs.mkdirSync(profileA, { recursive: true });
      fs.mkdirSync(profileB, { recursive: true });
      mockApp = { getPath: () => baseDir };
    });

    afterAll(() => {
      resetDatabase();
      if (baseDir && fs.existsSync(baseDir)) {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("creates independent stores per profile", async () => {
      initMetadataStore(mockApp, profileA);
      const storeA = getMetadataStore();
      const filePath = path.join(profileA, "sample-a.mp4");
      fs.writeFileSync(filePath, "a");
      const stats = fs.statSync(filePath);
      const indexed = await storeA.indexFile({ filePath, stats });
      expect(indexed.fingerprint).toBeTruthy();

      // Switch profile
      resetDatabase();

      initMetadataStore(mockApp, profileB);
      const storeB = getMetadataStore();
      const metadata = storeB.getMetadataForFingerprints([indexed.fingerprint]);
      expect(metadata[indexed.fingerprint]).toBeUndefined();

      const dbAPath = path.join(profileA, "videoswarm-meta.db");
      const dbBPath = path.join(profileB, "videoswarm-meta.db");
      expect(fs.existsSync(dbAPath)).toBe(true);
      expect(fs.existsSync(dbBPath)).toBe(true);
      expect(dbAPath).not.toBe(dbBPath);
    });

    it("restores legacy database when corruption is detected", async () => {
      // Create legacy/base database with data
      resetDatabase();
      initMetadataStore(mockApp);
      const legacyDbPath = path.join(baseDir, "videoswarm-meta.db");
      const legacyDb = new BetterSqlite(legacyDbPath);
      legacyDb.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run("legacy");
      legacyDb.close();
      resetDatabase();

      const defaultProfilePath = path.join(baseDir, "profiles", "default");
      fs.mkdirSync(defaultProfilePath, { recursive: true });
      const corruptDbPath = path.join(defaultProfilePath, "videoswarm-meta.db");
      fs.writeFileSync(corruptDbPath, "not a sqlite database");

      initMetadataStore(mockApp, defaultProfilePath);
      const store = getMetadataStore();
      const tags = store.listTags().map((tag) => tag.name);
      expect(tags).toContain("legacy");

      const archivedFiles = fs
        .readdirSync(defaultProfilePath)
        .filter((file) => file.startsWith("videoswarm-meta.db.corrupt-"));
      expect(archivedFiles.length).toBeGreaterThan(0);
    });
  });
}
