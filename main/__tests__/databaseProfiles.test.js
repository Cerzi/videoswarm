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

    it("deduplicates bounded fingerprint work and disposes it on profile changes", async () => {
      resetDatabase();
      initMetadataStore(mockApp, profileA);
      const storeA = getMetadataStore();
      const filePath = path.join(profileA, "cache-lifecycle.mp4");
      fs.writeFileSync(filePath, "shared fingerprint work");
      const stats = fs.statSync(filePath);

      const [first, second] = await Promise.all([
        storeA.indexFile({ filePath, stats }),
        storeA.indexFile({ filePath, stats }),
      ]);

      expect(first.fingerprint).toBe(second.fingerprint);
      expect(storeA.getResourceSnapshot()).toMatchObject({
        disposed: false,
        fingerprintCache: {
          entries: 1,
          inFlight: 0,
          maxEntries: database.FINGERPRINT_CACHE_MAX_ENTRIES,
          maxInFlight: database.FINGERPRINT_CACHE_MAX_IN_FLIGHT,
          totals: { deduplicated: 1 },
        },
      });

      // Switching profiles directly must dispose the prior store even when a
      // caller does not explicitly reset the singleton first.
      initMetadataStore(mockApp, profileB);
      const storeB = getMetadataStore();
      expect(storeB).not.toBe(storeA);
      expect(storeA.getResourceSnapshot()).toMatchObject({
        disposed: true,
        fingerprintCache: { entries: 0, inFlight: 0, disposed: true },
      });

      resetDatabase();
      expect(storeB.getResourceSnapshot()).toMatchObject({
        disposed: true,
        fingerprintCache: { entries: 0, inFlight: 0, disposed: true },
      });
    });

    it("prevents fingerprint work from resuming into a disposed store", async () => {
      resetDatabase();
      initMetadataStore(mockApp, profileA);
      const store = getMetadataStore();
      const filePath = path.join(profileA, "disposed-work.mp4");
      fs.writeFileSync(filePath, Buffer.alloc(1024, 7));
      const stats = fs.statSync(filePath);

      const indexing = store.indexFile({ filePath, stats });
      resetDatabase();

      await expect(indexing).rejects.toMatchObject({
        code: "METADATA_STORE_DISPOSED",
      });
      expect(store.getResourceSnapshot()).toMatchObject({
        disposed: true,
        fingerprintCache: { entries: 0, inFlight: 0, disposed: true },
      });
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
