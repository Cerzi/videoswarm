import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { requireSqliteSuite } from './sqliteTestGate';

const require = createRequire(import.meta.url);

let database;
let databaseLoadError;
try {
  const BetterSqlite = require('better-sqlite3');
  const probe = new BetterSqlite(':memory:');
  probe.close();
  database = require('../database');
} catch (error) {
  databaseLoadError = error;
}

const sqliteDescribe = requireSqliteSuite(
  describe,
  !database || databaseLoadError
    ? databaseLoadError || new Error('better-sqlite3 probe failed')
    : null
);

// View feeds over a real catalog (view-feeds.md): the pool, tags, sharing,
// and a view answered end to end.
if (!database || databaseLoadError) {
  sqliteDescribe('view feed storage', () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;
  const { ViewFeedService } = require('../view-feeds');

  sqliteDescribe('view feed storage', () => {
    let tempDir;
    let store;
    let rootPath;
    let seen;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-feeds-'));
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
      rootPath = path.join(tempDir, 'A1');
      seen = [];
    });

    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    async function clip(name) {
      const filePath = path.join(rootPath, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `content of ${name}`);
      const [indexed] = await store.indexFiles({
        rootPath,
        entries: [{ filePath, stats: fs.statSync(filePath) }],
      });
      seen.push(filePath);
      store.reconcileLibraryRoot(rootPath, seen, { recursive: true, completeCoverage: true });
      return { filePath, fingerprint: indexed.fingerprint };
    }

    it('reads the pool in chunks with ratings, review states and tags', async () => {
      const a = await clip('a.mp4');
      const b = await clip('b.mp4');
      store.setRating([a.fingerprint], 5);
      store.setReviewState([b.fingerprint], 'reject');
      store.assignTags([a.fingerprint], ['dance/bellydance']);

      const first = store.listFeedPoolChunk({ limit: 1 });
      expect(first.clips).toHaveLength(1);
      const second = store.listFeedPoolChunk({ afterId: first.lastId, limit: 5 });
      const all = [...first.clips, ...second.clips];
      expect(all.map((entry) => entry.absolutePath).sort()).toEqual([a.filePath, b.filePath].sort());
      expect(all.find((entry) => entry.fingerprint === a.fingerprint)).toMatchObject({ rating: 5, rootPath });
      expect(all.find((entry) => entry.fingerprint === b.fingerprint).reviewState).toBe('reject');
      expect(store.listFeedTagNames().get(a.fingerprint)).toEqual(['bellydance']);
    });

    it('shares saved views by default, and can stop sharing one', () => {
      const created = store.createSavedView('Dancing 3+', { version: 1, filters: { minRating: 3 } });
      expect(created.shared).toBe(true);
      const off = store.setSavedViewShared(created.id, false);
      expect(off.shared).toBe(false);
      expect(off.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
      expect(store.getSavedView(created.id).shared).toBe(false);
      expect(() => store.setSavedViewShared(999, true)).toThrow(/not found/u);
    });

    it('answers a view end to end, and follows a rating change', async () => {
      const a = await clip('a.mp4');
      const b = await clip('b.mp4');
      store.setRating([a.fingerprint], 5);
      store.setRating([b.fingerprint], 3);
      const created = store.createSavedView('Best', { version: 1, filters: { minRating: 4 } });
      const feeds = new ViewFeedService();
      const first = await feeds.clips({ store, scope: 'p', viewId: created.id });
      expect(first.clips.map((entry) => entry.path)).toEqual([a.filePath]);
      expect(first.clips[0]).toMatchObject({ contentId: a.fingerprint, available: true, rating: 5 });

      store.setRating([b.fingerprint], 4);
      const second = await feeds.clips({ store, scope: 'p', viewId: created.id, unless: first.etag });
      expect(second.unchanged).toBe(false);
      expect(second.clips.map((entry) => entry.path).sort()).toEqual([a.filePath, b.filePath].sort());
      const third = await feeds.clips({ store, scope: 'p', viewId: created.id, unless: second.etag });
      expect(third.unchanged).toBe(true);
    });
  });
}
