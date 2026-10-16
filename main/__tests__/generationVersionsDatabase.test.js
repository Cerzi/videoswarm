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
  !database || databaseLoadError
    ? databaseLoadError || new Error("better-sqlite3 probe failed")
    : null
);

const KEY_A = `gk2-${"a".repeat(32)}`;
const KEY_B = `gk2-${"b".repeat(32)}`;
const PROMPT_A = `pk1-${"a".repeat(32)}`;
const PROMPT_B = `pk1-${"b".repeat(32)}`;

if (!database || databaseLoadError) {
  sqliteDescribe("generation version storage", () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  describe("generation version storage", () => {
    let tempDir;
    let rootPath;
    let otherRootPath;
    let store;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-versions-"));
      rootPath = path.join(tempDir, "drafts");
      otherRootPath = path.join(tempDir, "finals");
      fs.mkdirSync(rootPath, { recursive: true });
      fs.mkdirSync(otherRootPath, { recursive: true });
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
    });

    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    async function indexClip(root, relativePath, content, dimensions) {
      const filePath = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      const [entry] = await store.indexFiles({
        rootPath: root,
        entries: [{ filePath, stats: fs.statSync(filePath) }],
      });
      if (dimensions) store.setDimensions(entry.fingerprint, dimensions);
      return entry;
    }

    it("starts unevaluated and lists candidates by page and scope", async () => {
      const a = await indexClip(rootPath, "a.mp4", "content-a");
      const b = await indexClip(rootPath, "sub/b.mp4", "content-b");
      const copy = await indexClip(otherRootPath, "a-copy.mp4", "content-a");

      expect(a.generationKey).toBeUndefined();
      expect(a.generationKeyChecked).toBeUndefined();
      expect(store.countGenerationKeyCandidates({ instanceIds: null })).toBe(2);
      expect(
        store.countGenerationKeyCandidates({ instanceIds: [a.instance.id] })
      ).toBe(1);

      const firstPage = store.listGenerationKeyCandidates({ limit: 2 });
      expect(firstPage.map((row) => row.instanceId)).toEqual([
        a.instance.id,
        b.instance.id,
      ]);
      expect(firstPage[0]).toMatchObject({
        fingerprint: a.fingerprint,
        absolutePath: path.join(rootPath, "a.mp4"),
        rootPath,
      });
      const secondPage = store.listGenerationKeyCandidates({
        afterInstanceId: firstPage[1].instanceId,
        limit: 2,
      });
      expect(secondPage.map((row) => row.instanceId)).toEqual([copy.instance.id]);
      expect(
        store.listGenerationKeyCandidates({ instanceIds: [b.instance.id] })
      ).toHaveLength(1);
    });

    it("persists keys per content and delivers them with every record builder", async () => {
      const a = await indexClip(rootPath, "a.mp4", "content-a", { width: 640, height: 360 });
      const b = await indexClip(rootPath, "b.mp4", "content-b");
      expect(
        store.setGenerationKeys([
          { fingerprint: a.fingerprint, generationKey: KEY_A, promptKey: PROMPT_A },
          { fingerprint: b.fingerprint, generationKey: null, promptKey: null },
        ])
      ).toBe(2);

      expect(store.countGenerationKeyCandidates({ instanceIds: null })).toBe(0);
      expect(store.listEvaluatedGenerationKeys([a.instance.id, b.instance.id, 999])).toEqual(
        expect.arrayContaining([
          { fingerprint: a.fingerprint, generationKey: KEY_A, promptKey: PROMPT_A },
          { fingerprint: b.fingerprint, generationKey: null, promptKey: null },
        ])
      );
      const snapshot = store.getCachedLibrarySnapshot(rootPath);
      const byName = Object.fromEntries(
        snapshot.records.map((record) => [path.basename(record.absolutePath), record])
      );
      expect(byName["a.mp4"]).toMatchObject({
        generationKey: KEY_A,
        promptKey: PROMPT_A,
        generationKeyChecked: true,
      });
      expect(byName["b.mp4"].generationKeyChecked).toBe(true);
      expect(byName["b.mp4"].generationKey).toBeUndefined();
      expect(byName["b.mp4"].promptKey).toBeUndefined();

      const copy = await indexClip(otherRootPath, "copy.mp4", "content-a");
      expect(copy).toMatchObject({
        generationKey: KEY_A,
        promptKey: PROMPT_A,
        generationKeyChecked: true,
      });

      store.assignTags([a.fingerprint], ["draft"]);
      const tagged = store.getTaggedLibrarySnapshot({ tagNames: ["draft"] });
      expect(tagged.records.map((record) => record.generationKey)).toEqual([KEY_A, KEY_A]);
      expect(tagged.records.map((record) => record.promptKey)).toEqual([PROMPT_A, PROMPT_A]);
    });

    it("refuses malformed keys and oversized requests", async () => {
      const a = await indexClip(rootPath, "a.mp4", "content-a");
      expect(() =>
        store.setGenerationKeys([
          { fingerprint: a.fingerprint, generationKey: "raw prompt", promptKey: PROMPT_A },
        ])
      ).toThrow(TypeError);
      expect(() =>
        store.setGenerationKeys([
          { fingerprint: a.fingerprint, generationKey: KEY_A, promptKey: "raw prompt" },
        ])
      ).toThrow(TypeError);
      // The two keys come from one evaluation; one alone is never stored.
      expect(() =>
        store.setGenerationKeys([{ fingerprint: a.fingerprint, generationKey: KEY_A }])
      ).toThrow(TypeError);
      expect(() =>
        store.setGenerationKeys([
          { fingerprint: a.fingerprint, generationKey: null, promptKey: PROMPT_A },
        ])
      ).toThrow(TypeError);
      expect(store.countGenerationKeyCandidates({})).toBe(1);
      expect(() =>
        store.listGenerationKeyCandidates({
          instanceIds: Array.from({ length: 20_001 }, (_, index) => index + 1),
        })
      ).toThrow(RangeError);
      expect(() => store.listGenerationKeyCandidates({ limit: 257 })).toThrow(RangeError);
      expect(() =>
        store.getGenerationVersionSummaries(
          Array.from({ length: 4097 }, (_, index) => `gk2-${index.toString(16).padStart(32, "0")}`)
        )
      ).toThrow(RangeError);
    });

    it("summarizes and lists versions across roots, counting content once", async () => {
      const draft = await indexClip(rootPath, "draft.mp4", "draft", { width: 640, height: 360, durationMs: 5000 });
      const final = await indexClip(otherRootPath, "final.mp4", "final", { width: 1280, height: 720, durationMs: 5000 });
      const finalCopy = await indexClip(otherRootPath, "backup/final.mp4", "final");
      const other = await indexClip(rootPath, "other.mp4", "other", { width: 320, height: 240 });
      store.setGenerationKeys([
        { fingerprint: draft.fingerprint, generationKey: KEY_A, promptKey: PROMPT_A },
        { fingerprint: final.fingerprint, generationKey: KEY_A, promptKey: PROMPT_A },
        { fingerprint: other.fingerprint, generationKey: KEY_B, promptKey: PROMPT_B },
      ]);

      expect(store.getGenerationVersionSummaries([KEY_A, KEY_B, "junk"])).toEqual({
        [KEY_A]: { versionCount: 2, maxPixels: 1280 * 720 },
        [KEY_B]: { versionCount: 1, maxPixels: 320 * 240 },
      });

      const siblings = store.getGenerationVersionSiblings(draft.instance.id);
      expect(siblings).toMatchObject({ generationKey: KEY_A, truncated: false });
      expect(siblings.versions.map((version) => version.fingerprint)).toEqual([
        final.fingerprint,
        draft.fingerprint,
      ]);
      expect(siblings.versions[0]).toMatchObject({
        width: 1280,
        height: 720,
        durationMs: 5000,
        instanceCount: 2,
        isSelf: false,
        rootPath: otherRootPath,
      });
      expect(siblings.versions[1]).toMatchObject({
        instanceId: draft.instance.id,
        relativePath: "draft.mp4",
        isSelf: true,
      });

      const fromCopy = store.getGenerationVersionSiblings(finalCopy.instance.id);
      expect(fromCopy.versions[0]).toMatchObject({
        instanceId: finalCopy.instance.id,
        // The catalog stores relative paths with "/" on every platform.
        relativePath: "backup/final.mp4",
        isSelf: true,
      });
    });

    it("stops counting versions whose instances are all gone", async () => {
      const draft = await indexClip(rootPath, "draft.mp4", "draft", { width: 640, height: 360 });
      const final = await indexClip(otherRootPath, "final.mp4", "final", { width: 1280, height: 720 });
      store.setGenerationKeys([
        { fingerprint: draft.fingerprint, generationKey: KEY_A, promptKey: PROMPT_A },
        { fingerprint: final.fingerprint, generationKey: KEY_A, promptKey: PROMPT_A },
      ]);
      store.markFilesMissing([path.join(otherRootPath, "final.mp4")]);
      expect(store.getGenerationVersionSummaries([KEY_A])).toEqual({
        [KEY_A]: { versionCount: 1, maxPixels: 640 * 360 },
      });
      expect(
        store.getGenerationVersionSiblings(draft.instance.id).versions
      ).toHaveLength(1);
      expect(store.listGenerationKeyCandidates({})).toEqual([]);
    });

    it("reports an unkeyed or unevaluated clip without siblings", async () => {
      const a = await indexClip(rootPath, "a.mp4", "content-a");
      expect(store.getGenerationVersionSiblings(a.instance.id)).toEqual({
        generationKey: null,
        checked: false,
        versions: [],
        truncated: false,
      });
      store.setGenerationKeys([{ fingerprint: a.fingerprint, generationKey: null, promptKey: null }]);
      expect(store.getGenerationVersionSiblings(a.instance.id).checked).toBe(true);
      expect(store.getGenerationVersionSiblings(999_999).generationKey).toBeNull();
    });

    it("migrates a profile database that predates the columns", async () => {
      const a = await indexClip(rootPath, "a.mp4", "content-a", { width: 640, height: 360 });
      resetDatabase();
      const BetterSqlite = require("better-sqlite3");
      const dbPath = path.join(tempDir, "videoswarm-meta.db");
      let raw = new BetterSqlite(dbPath);
      raw.exec(`
        DROP INDEX idx_media_content_generation_key;
        DROP INDEX idx_media_content_prompt_key;
        ALTER TABLE media_content DROP COLUMN generation_key;
        ALTER TABLE media_content DROP COLUMN generation_key_version;
        ALTER TABLE media_content DROP COLUMN prompt_key;
        ALTER TABLE media_content DROP COLUMN prompt_key_version;
      `);
      raw.close();

      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
      const [record] = store.getCachedLibrarySnapshot(rootPath).records;
      expect(record).toMatchObject({ fingerprint: a.fingerprint, dimensions: { width: 640 } });
      expect(record.generationKeyChecked).toBeUndefined();
      expect(store.countGenerationKeyCandidates({})).toBe(1);

      resetDatabase();
      raw = new BetterSqlite(dbPath);
      const columns = raw.prepare("PRAGMA table_info(media_content);").all().map((row) => row.name);
      const indexes = raw.prepare("PRAGMA index_list(media_content);").all().map((row) => row.name);
      raw.close();
      expect(columns).toEqual(
        expect.arrayContaining([
          "generation_key",
          "generation_key_version",
          "prompt_key",
          "prompt_key_version",
        ])
      );
      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_media_content_generation_key",
          "idx_media_content_prompt_key",
        ])
      );
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
    });

    it("adds prompt keys to a database that only has generation keys", async () => {
      const keyed = await indexClip(rootPath, "keyed.mp4", "keyed-content");
      const unkeyed = await indexClip(rootPath, "unkeyed.mp4", "unkeyed-content");
      const pending = await indexClip(rootPath, "pending.mp4", "pending-content");
      store.setGenerationKeys([
        { fingerprint: keyed.fingerprint, generationKey: KEY_A, promptKey: PROMPT_A },
        { fingerprint: unkeyed.fingerprint, generationKey: null, promptKey: null },
      ]);
      resetDatabase();
      // The state an older build leaves: generation keys evaluated, no
      // prompt key columns at all.
      const BetterSqlite = require("better-sqlite3");
      const raw = new BetterSqlite(path.join(tempDir, "videoswarm-meta.db"));
      raw.exec(`
        DROP INDEX idx_media_content_prompt_key;
        ALTER TABLE media_content DROP COLUMN prompt_key;
        ALTER TABLE media_content DROP COLUMN prompt_key_version;
      `);
      raw.close();

      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
      const byName = Object.fromEntries(
        store
          .getCachedLibrarySnapshot(rootPath)
          .records.map((record) => [path.basename(record.absolutePath), record])
      );
      // A clip with no generation key cannot have a prompt key, so it is
      // settled without re-reading the file.
      expect(byName["unkeyed.mp4"].generationKeyChecked).toBe(true);
      // A keyed clip keeps its version badge while its prompt key is due.
      expect(byName["keyed.mp4"].generationKey).toBe(KEY_A);
      expect(byName["keyed.mp4"].promptKey).toBeUndefined();
      expect(byName["keyed.mp4"].generationKeyChecked).toBeUndefined();
      expect(
        store.listGenerationKeyCandidates({}).map((row) => row.fingerprint).sort()
      ).toEqual([keyed.fingerprint, pending.fingerprint].sort());
      expect(store.countGenerationKeyCandidates({})).toBe(2);
      expect(store.getGenerationVersionSummaries([KEY_A])).toEqual({
        [KEY_A]: { versionCount: 1, maxPixels: 0 },
      });

      store.setGenerationKeys([
        { fingerprint: keyed.fingerprint, generationKey: KEY_A, promptKey: PROMPT_A },
      ]);
      const [record] = store
        .getCachedLibrarySnapshot(rootPath)
        .records.filter((entry) => entry.fingerprint === keyed.fingerprint);
      expect(record).toMatchObject({
        generationKey: KEY_A,
        promptKey: PROMPT_A,
        generationKeyChecked: true,
      });
    });

    it("upgrades a version 1 database without re-reading unkeyable files", async () => {
      const keyed = await indexClip(rootPath, "keyed.mp4", "keyed-content");
      const unkeyed = await indexClip(rootPath, "unkeyed.mp4", "unkeyed-content");
      resetDatabase();
      // The state a build from before prompt stacks leaves: version 1 keys
      // and no prompt key columns.
      const BetterSqlite = require("better-sqlite3");
      const raw = new BetterSqlite(path.join(tempDir, "videoswarm-meta.db"));
      raw.exec(`
        DROP INDEX idx_media_content_prompt_key;
        ALTER TABLE media_content DROP COLUMN prompt_key;
        ALTER TABLE media_content DROP COLUMN prompt_key_version;
      `);
      raw
        .prepare("UPDATE media_content SET generation_key = ?, generation_key_version = 1 WHERE fingerprint = ?;")
        .run(`gk1-${"c".repeat(32)}`, keyed.fingerprint);
      raw
        .prepare("UPDATE media_content SET generation_key = NULL, generation_key_version = 1 WHERE fingerprint = ?;")
        .run(unkeyed.fingerprint);
      raw.close();

      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
      const byName = Object.fromEntries(
        store
          .getCachedLibrarySnapshot(rootPath)
          .records.map((record) => [path.basename(record.absolutePath), record])
      );
      // Unkeyable under version 1 means unkeyable now: settled, not re-read.
      expect(byName["unkeyed.mp4"].generationKeyChecked).toBe(true);
      // A version 1 key no longer groups anything; the clip is due again.
      expect(byName["keyed.mp4"].generationKey).toBeUndefined();
      expect(byName["keyed.mp4"].generationKeyChecked).toBeUndefined();
      expect(store.listGenerationKeyCandidates({}).map((row) => row.fingerprint)).toEqual([
        keyed.fingerprint,
      ]);
    });
  });
}
