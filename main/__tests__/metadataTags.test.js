import { beforeAll, afterAll, describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { requireSqliteSuite } from "./sqliteTestGate";

let database;
let databaseLoadError;
let hasNativeDriver = false;

try {
  const testRequire = createRequire(import.meta.url);
  const BetterSqlite = testRequire("better-sqlite3");
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

const sqliteDescribe = requireSqliteSuite(
  describe,
  !hasNativeDriver || databaseLoadError
    ? databaseLoadError || new Error("better-sqlite3 probe failed")
    : null
);

if (!hasNativeDriver || databaseLoadError) {
  sqliteDescribe("metadata tag cleanup", () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  describe("metadata tag cleanup", () => {
    let tempDir;
    let store;

    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-meta-test-"));
      const mockApp = {
        getPath: () => tempDir,
      };
      initMetadataStore(mockApp, tempDir);
      store = getMetadataStore();
    });

    afterAll(() => {
      resetDatabase();
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    async function createIndexedFile(nameSuffix) {
      const filePath = path.join(tempDir, `file-${nameSuffix}.mp4`);
      fs.writeFileSync(filePath, `content-${nameSuffix}-${Date.now()}`);
      const stats = fs.statSync(filePath);
      // Indexed under a library root, as every scan does, so the clip is
      // present in the catalog and its tags count.
      const { fingerprint } = await store.indexFile({ filePath, stats, rootPath: tempDir });
      return fingerprint;
    }

    it("removes a tag when its final association is deleted", async () => {
      const tagName = `tag-${Date.now()}-unused`;
      const fingerprint = await createIndexedFile(`single-${Math.random()}`);

      store.assignTags([fingerprint], [tagName]);
      expect(store.listTags().some((tag) => tag.name === tagName)).toBe(true);

      store.removeTag([fingerprint], tagName);

      const remaining = store.listTags().map((tag) => tag.name);
      expect(remaining).not.toContain(tagName);
    });

    it("keeps a tag when other items still use it", async () => {
      const tagName = `tag-${Date.now()}-shared`;
      const fingerprintA = await createIndexedFile(`shared-a-${Math.random()}`);
      const fingerprintB = await createIndexedFile(`shared-b-${Math.random()}`);

      store.assignTags([fingerprintA, fingerprintB], [tagName]);

      store.removeTag([fingerprintA], tagName);

      const entry = store.listTags().find((tag) => tag.name === tagName);
      expect(entry).toBeTruthy();
      expect(Number(entry?.usageCount || 0)).toBeGreaterThan(0);
    });

    it("counts a tag only on clips whose file is present", async () => {
      const tagName = `tag-${Date.now()}-presence`;
      const keptPath = path.join(tempDir, `kept-${Math.random()}.mp4`);
      const gonePath = path.join(tempDir, `gone-${Math.random()}.mp4`);
      fs.writeFileSync(keptPath, `kept-${Math.random()}`);
      fs.writeFileSync(gonePath, `gone-${Math.random()}`);
      const kept = await store.indexFile({
        filePath: keptPath,
        stats: fs.statSync(keptPath),
        rootPath: tempDir,
      });
      const gone = await store.indexFile({
        filePath: gonePath,
        stats: fs.statSync(gonePath),
        rootPath: tempDir,
      });
      const usage = () =>
        store.listTags().find((tag) => tag.name === tagName)?.usageCount;

      store.assignTags([kept.fingerprint, gone.fingerprint], [tagName]);
      expect(usage()).toBe(2);

      store.markFileMissing(gonePath, { rootPath: tempDir });
      expect(usage()).toBe(1);
      // The tag itself stays; only the missing clip stops counting.
      expect(store.listTags().some((tag) => tag.name === tagName)).toBe(true);

      await store.indexFile({
        filePath: gonePath,
        stats: fs.statSync(gonePath),
        rootPath: tempDir,
      });
      expect(usage()).toBe(2);
    });
  });
}
