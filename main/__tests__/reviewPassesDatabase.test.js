import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { requireSqliteSuite } from "./sqliteTestGate";

const require = createRequire(import.meta.url);

let database;
let databaseLoadError;
try {
  const BetterSqlite = require("better-sqlite3");
  const probe = new BetterSqlite(":memory:");
  probe.close();
  database = require("../database");
} catch (error) {
  databaseLoadError = error;
}

const sqliteDescribe = requireSqliteSuite(
  describe,
  !database || databaseLoadError ? databaseLoadError || new Error("better-sqlite3 probe failed") : null
);

// Review passes (docs/architecture/review-passes.md): a frozen, ordered list
// of clips by content, its progress and cursor, kept to resume.
if (!database || databaseLoadError) {
  sqliteDescribe("review passes", () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  describe("review passes", () => {
    let tempDir;
    let rootPath;
    let otherRoot;
    let store;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-passes-"));
      rootPath = path.join(tempDir, "A1");
      otherRoot = path.join(tempDir, "B1");
      fs.mkdirSync(rootPath, { recursive: true });
      fs.mkdirSync(otherRoot, { recursive: true });
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
    });

    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    async function indexClip(root, relativePath, content) {
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      const [entry] = await store.indexFiles({ rootPath: root, entries: [{ filePath, stats: fs.statSync(filePath) }] });
      return entry;
    }

    it("freezes clips in order, counts decisions and resumes where it was", async () => {
      const a = await indexClip(rootPath, "a.mp4", "a");
      const b = await indexClip(otherRoot, "b.mp4", "b");
      const c = await indexClip(rootPath, "c.mp4", "c");
      const pass = store.createReviewPass({
        name: "Rated clips",
        source: "results",
        definition: { version: 1, filters: { minRating: 4 }, sort: { key: "rating", dir: "desc" }, searchScope: "library" },
        location: { rootPath: null, directory: "" },
        clips: [
          { fingerprint: c.fingerprint, instanceId: c.instance.id },
          { fingerprint: a.fingerprint, instanceId: a.instance.id },
          { fingerprint: c.fingerprint, instanceId: c.instance.id },
          { fingerprint: b.fingerprint, instanceId: b.instance.id },
        ],
      });
      expect(pass).toMatchObject({ name: "Rated clips", source: "results", clipCount: 3, cursorPosition: 0 });
      expect(pass.definition).toMatchObject({ filters: { minRating: 4 }, searchScope: "library" });

      store.setRating([a.fingerprint], 4);
      store.setReviewState([b.fingerprint], "reject");
      expect(store.listReviewPasses()).toEqual([expect.objectContaining({ id: pass.id, decided: 2, clipCount: 3 })]);

      const opened = store.getReviewPassRecords(pass.id);
      expect(opened.records.map((record) => record.fingerprint)).toEqual([c.fingerprint, a.fingerprint, b.fingerprint]);
      expect(opened.records.map((record) => record.passPosition)).toEqual([0, 1, 2]);
      expect(opened.rootPaths.sort()).toEqual([otherRoot, rootPath].sort());

      expect(store.setReviewPassCursor(pass.id, 2)).toBe(true);
      expect(store.listReviewPasses()[0].cursorPosition).toBe(2);

      // A clip gone from the library drops out; one in a root that cannot be
      // opened is left out too.
      store.markFilesMissing([path.join(rootPath, "a.mp4")]);
      expect(store.getReviewPassRecords(pass.id).records.map((record) => record.fingerprint)).toEqual([
        c.fingerprint,
        b.fingerprint,
      ]);
      expect(
        store.getReviewPassRecords(pass.id, { unavailableRootPaths: [otherRoot] }).records.map((r) => r.fingerprint)
      ).toEqual([c.fingerprint]);

      expect(store.finishReviewPass(pass.id)).toBe(true);
      expect(store.listReviewPasses()[0].finishedAt).toEqual(expect.any(Number));
      expect(store.deleteReviewPass(pass.id)).toBe(true);
      expect(store.listReviewPasses()).toEqual([]);
      expect(store.getReviewPassRecords(pass.id)).toBeNull();
    });

    it("keeps ten passes, letting finished ones go first, and refuses empty or oversized ones", async () => {
      const a = await indexClip(rootPath, "a.mp4", "a");
      const make = (name) =>
        store.createReviewPass({ name, source: "selection", clips: [{ fingerprint: a.fingerprint, instanceId: a.instance.id }] });
      const first = make("first");
      store.finishReviewPass(first.id);
      for (let index = 0; index < 10; index += 1) make(`pass ${index}`);
      const names = store.listReviewPasses().map((pass) => pass.name);
      expect(names).toHaveLength(10);
      expect(names).not.toContain("first");

      expect(() => store.createReviewPass({ name: "x", source: "selection", clips: [] })).toThrow(RangeError);
      expect(() => store.createReviewPass({ name: "x", source: "elsewhere", clips: [{ fingerprint: "f" }] })).toThrow(TypeError);
      expect(() =>
        store.createReviewPass({
          name: "x",
          source: "selection",
          clips: Array.from({ length: 50_001 }, (_, index) => ({ fingerprint: `f${index}` })),
        })
      ).toThrow(/50,000/u);
    });
  });
}
