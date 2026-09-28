import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireSqliteSuite } from "./sqliteTestGate";

const require = createRequire(import.meta.url);
const { describeComfyQueueStore } = require("./helpers/comfyQueueStoreContract.cjs");

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

if (!database || databaseLoadError) {
  sqliteDescribe("comfy queue store: SQLite", () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;
  let tempDir;
  describeComfyQueueStore({ describe, it, expect, beforeEach, afterEach }, "SQLite", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-comfy-queue-"));
    initMetadataStore({ getPath: () => tempDir }, tempDir);
    return {
      store: getMetadataStore().comfyQueue,
      dispose() {
        resetDatabase();
        fs.rmSync(tempDir, { recursive: true, force: true });
      },
    };
  });

  describe("comfy queue store: profile database", () => {
    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-comfy-queue-"));
    });
    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("survives reopening the profile, and rejects an unknown state in SQL too", () => {
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      const store = getMetadataStore().comfyQueue;
      const recipe = store.saveRecipe({ name: "Long-form", recipe: { ops: [] } });
      const item = store.addQueueItem({ fingerprint: "fp", draftPath: "/d.mp4", recipeId: recipe.id, knobs: {} });
      store.updateQueueItem(item.id, { state: "rendering", promptId: "p7" });
      resetDatabase();
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      const reopened = getMetadataStore().comfyQueue;
      expect(reopened.getQueueItem(item.id)).toMatchObject({ state: "rendering", promptId: "p7" });
      expect(reopened.getRecipe(recipe.id).name).toBe("Long-form");
      const BetterSqlite = require("better-sqlite3");
      const raw = new BetterSqlite(path.join(tempDir, "videoswarm-meta.db"));
      try {
        expect(() => raw.prepare("UPDATE comfy_queue_items SET state = 'lost'").run()).toThrow(/CHECK/);
      } finally {
        raw.close();
      }
    });
  });
}
