import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { requireSqliteSuite } from "./sqliteTestGate";

const require = createRequire(import.meta.url);

let database;
let BetterSqlite;
let databaseLoadError;

try {
  BetterSqlite = require("better-sqlite3");
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

if (!database || databaseLoadError) {
  sqliteDescribe("generation metadata quality", () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  describe("generation metadata quality", () => {
    let tempDir;
    let rootPath;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-quality-"));
      rootPath = path.join(tempDir, "library");
      fs.mkdirSync(rootPath, { recursive: true });
    });

    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    async function indexedClip(store) {
      const filePath = path.join(rootPath, "clip.mp4");
      fs.writeFileSync(filePath, "clip bytes");
      return store.indexFile({ rootPath, filePath, stats: fs.statSync(filePath) });
    }

    it("stores graph-derived evidence", async () => {
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      const store = getMetadataStore();
      const record = await indexedClip(store);
      store.setGenerationMetadata(record.instance.id, {
        sourceKind: "embedded",
        parserVersion: 5,
        prompt: "routed through a primitive",
        quality: "derived",
      });
      expect(store.getGenerationMetadata(record.instance.id)).toMatchObject({
        prompt: "routed through a primitive",
        quality: "derived",
      });
    });

    it("rebuilds a cache table whose quality check predates 'derived', keeping its rows", async () => {
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      let store = getMetadataStore();
      const record = await indexedClip(store);
      store.setGenerationMetadata(record.instance.id, {
        sourceKind: "embedded",
        parserVersion: 4,
        prompt: "cached by the previous parser",
        quality: "exact",
      });
      resetDatabase();

      // Put back the old column-level check, as older profiles have it.
      const raw = new BetterSqlite(path.join(tempDir, "videoswarm-meta.db"));
      const sql = raw
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'instance_generation_metadata'")
        .get().sql;
      raw.exec(`
        PRAGMA foreign_keys = OFF;
        ALTER TABLE instance_generation_metadata RENAME TO old_generation;
        ${sql.replace("'exact', 'derived', 'partial'", "'exact', 'partial'")};
        INSERT INTO instance_generation_metadata SELECT * FROM old_generation;
        DROP TABLE old_generation;
      `);
      expect(
        raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'instance_generation_metadata'").get().sql
      ).not.toContain("'derived'");
      raw.close();

      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
      // Rows survive the rebuild (the service still re-reads them, because
      // their parser version is older).
      expect(store.getGenerationMetadata(record.instance.id)).toMatchObject({
        prompt: "cached by the previous parser",
        quality: "exact",
      });
      const rebuilt = new BetterSqlite(path.join(tempDir, "videoswarm-meta.db"), { readonly: true });
      const tables = rebuilt.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
      rebuilt.close();
      expect(tables).not.toContain("instance_generation_metadata_before_derived");
      store.setGenerationMetadata(record.instance.id, {
        sourceKind: "embedded",
        parserVersion: 5,
        prompt: "recomputed",
        quality: "derived",
      });
      expect(store.getGenerationMetadata(record.instance.id).quality).toBe("derived");
    });
  });
}
