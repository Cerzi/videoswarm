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

// The rating arena's storage (docs/architecture/rating-arena.md, Section 6):
// the pool, ratings as they stand, the history of rounds and a round's
// records.
if (!database || databaseLoadError) {
  sqliteDescribe("rating arena storage", () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  describe("rating arena storage", () => {
    let tempDir;
    let rootPath;
    let otherRoot;
    let store;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-arena-"));
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

    it("pools each present content once, library-wide or from the rows shown", async () => {
      const a = await indexClip(rootPath, "a.mp4", "a");
      const b = await indexClip(otherRoot, "b.mp4", "b");
      const copy = await indexClip(otherRoot, "copy-of-a.mp4", "a");
      expect(copy.fingerprint).toBe(a.fingerprint);

      const pool = store.getArenaPool();
      expect(pool.map((clip) => clip.fingerprint).sort()).toEqual([a.fingerprint, b.fingerprint].sort());
      expect(pool.every((clip) => Number.isSafeInteger(clip.instanceId) && "promptKey" in clip)).toBe(true);

      expect(store.getArenaPool({ instanceIds: [b.instance.id] }).map((clip) => clip.fingerprint)).toEqual([b.fingerprint]);
      expect(
        store.getArenaPool({ unavailableRootPaths: [otherRoot] }).map((clip) => clip.instanceId)
      ).toEqual([a.instance.id]);
    });

    it("keeps only the best version of a generation", async () => {
      const KEY = `gk4-${"a".repeat(32)}`;
      const PROMPT = `pk3-${"a".repeat(32)}`;
      const small = await indexClip(rootPath, "small.mp4", "small");
      const large = await indexClip(otherRoot, "large.mp4", "large");
      const alone = await indexClip(rootPath, "alone.mp4", "alone");
      store.setDimensions(small.fingerprint, { width: 640, height: 360 });
      store.setDimensions(large.fingerprint, { width: 1920, height: 1080 });
      store.setGenerationKeys([
        { fingerprint: small.fingerprint, generationKey: KEY, promptKey: PROMPT },
        { fingerprint: large.fingerprint, generationKey: KEY, promptKey: PROMPT },
      ]);
      const pool = store.getArenaPool();
      expect(pool.map((clip) => clip.fingerprint).sort()).toEqual([large.fingerprint, alone.fingerprint].sort());
      expect(pool.find((clip) => clip.fingerprint === large.fingerprint).promptKey).toBe(PROMPT);
      // Ratings overrule size: the small one rated higher is the best.
      store.setRating([small.fingerprint], 5);
      store.setRating([large.fingerprint], 2);
      expect(store.getArenaPool().map((clip) => clip.fingerprint).sort()).toEqual(
        [small.fingerprint, alone.fingerprint].sort()
      );
    });

    it("reads ratings and rejections as they stand", async () => {
      const a = await indexClip(rootPath, "a.mp4", "a");
      const b = await indexClip(rootPath, "b.mp4", "b");
      await indexClip(rootPath, "c.mp4", "c");
      store.setRating([a.fingerprint], 4);
      store.setReviewState([b.fingerprint], "reject");
      const { ratings, rejects } = store.getArenaJudgements();
      expect([...ratings]).toEqual([[a.fingerprint, 4]]);
      expect([...rejects]).toEqual([b.fingerprint]);
    });

    it("records rounds, replaces a round that comes back, keeps the newest and ignores unknown clips", async () => {
      const a = await indexClip(rootPath, "a.mp4", "a");
      const b = await indexClip(rootPath, "b.mp4", "b");
      const first = store.recordArenaChecks(
        [
          { fingerprint: a.fingerprint, kind: "place", outcome: "placed", ratingBefore: null, ratingAfter: 3 },
          { fingerprint: "not-in-the-library", kind: "tier", outcome: "held" },
          { fingerprint: b.fingerprint, kind: "nonsense", outcome: "held" },
        ],
        { now: 1000 }
      );
      expect(first).toHaveLength(1);
      expect(store.listArenaChecks()).toEqual([
        { id: first[0], fingerprint: a.fingerprint, checkedAt: 1000, kind: "place", outcome: "placed" },
      ]);

      const again = store.recordArenaChecks(
        [{ fingerprint: a.fingerprint, kind: "place", outcome: "placed", ratingAfter: 4 }],
        { now: 2000, replaceIds: first }
      );
      expect(store.listArenaChecks().map((row) => row.id)).toEqual(again);

      store.recordArenaChecks(
        [
          { fingerprint: b.fingerprint, kind: "tier", outcome: "held" },
          { fingerprint: a.fingerprint, kind: "border", outcome: "raised" },
        ],
        { now: 3000, keep: 2 }
      );
      expect(store.listArenaChecks().map((row) => row.outcome).sort()).toEqual(["held", "raised"]);
    });

    it("returns a round's clips as playable records, in the order asked", async () => {
      const a = await indexClip(rootPath, "a.mp4", "a");
      const b = await indexClip(otherRoot, "b.mp4", "b");
      store.setRating([b.fingerprint], 5);
      const found = store.getArenaRecords([b.instance.id, a.instance.id, 999_999]);
      expect(found.records.map((record) => [record.fingerprint, record.rating])).toEqual([
        [b.fingerprint, 5],
        [a.fingerprint, null],
      ]);
      expect(found.rootPaths.sort()).toEqual([otherRoot, rootPath].sort());
      expect(store.getArenaRecords([b.instance.id], { unavailableRootPaths: [otherRoot] }).records).toEqual([]);
    });
  });
}
