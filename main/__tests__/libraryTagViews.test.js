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

if (!database || databaseLoadError) {
  sqliteDescribe('library-wide tag views', () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  sqliteDescribe('library-wide tag views', () => {
    let tempDir;
    let store;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-tagview-'));
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
      filesByRoot = new Map();
    });

    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    // Reconciliation is authoritative for a whole root, so every file indexed
    // into a root has to be present in its seen-list or the earlier ones are
    // retired and the query correctly stops returning them.
    let filesByRoot;

    async function indexInto(rootName, relativePath, contents) {
      const rootPath = path.join(tempDir, rootName);
      const filePath = path.join(rootPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
      const [indexed] = await store.indexFiles({
        rootPath,
        entries: [{ filePath, stats: fs.statSync(filePath) }],
      });
      const seen = filesByRoot.get(rootPath) || [];
      seen.push(filePath);
      filesByRoot.set(rootPath, seen);
      store.reconcileLibraryRoot(rootPath, seen, {
        recursive: true,
        completeCoverage: true,
      });
      return { rootPath, filePath, indexed };
    }

    it('returns tagged clips from every root, not just one', async () => {
      const first = await indexInto('alpha', 'a.mp4', 'alpha-a');
      const second = await indexInto('beta', 'nested/b.mp4', 'beta-b');
      await indexInto('beta', 'nested/c.mp4', 'beta-c');
      store.assignTags(
        [first.indexed.fingerprint, second.indexed.fingerprint],
        ['keeper']
      );

      const snapshot = store.getTaggedLibrarySnapshot({ tagNames: ['keeper'] });

      expect(snapshot.records).toHaveLength(2);
      expect(snapshot.rootPaths).toHaveLength(2);
      expect(snapshot.records.map((record) => record.relativePath).sort()).toEqual([
        'a.mp4',
        'nested/b.mp4',
      ]);
      // Each record names its owning root so the renderer needs no second read.
      expect(snapshot.records.every((record) => record.rootPath)).toBe(true);
    });

    it('matches tags case-insensitively and requires all of them', async () => {
      const both = await indexInto('alpha', 'both.mp4', 'both');
      const one = await indexInto('alpha', 'one.mp4', 'one');
      store.assignTags([both.indexed.fingerprint], ['Keeper', 'Hero']);
      store.assignTags([one.indexed.fingerprint], ['keeper']);

      const intersection = store.getTaggedLibrarySnapshot({
        tagNames: ['KEEPER', 'hero'],
      });
      expect(intersection.records).toHaveLength(1);
      expect(intersection.records[0].relativePath).toBe('both.mp4');

      const single = store.getTaggedLibrarySnapshot({ tagNames: ['keeper'] });
      expect(single.records).toHaveLength(2);
    });

    it('carries the same projection a folder view would produce', async () => {
      const entry = await indexInto('alpha', 'rated.mp4', 'rated');
      store.assignTags([entry.indexed.fingerprint], ['keeper']);
      store.setRating([entry.indexed.fingerprint], 4);
      store.setReviewState([entry.indexed.fingerprint], 'pick');

      const [record] = store.getTaggedLibrarySnapshot({
        tagNames: ['keeper'],
      }).records;

      expect(record).toMatchObject({
        rating: 4,
        reviewState: 'pick',
        instanceId: entry.indexed.instance.id,
        fingerprint: entry.indexed.fingerprint,
      });
      expect(record.tags).toContain('keeper');
      expect(record.absolutePath).toBe(entry.filePath);
    });

    it('omits instances that are absent or deliberately removed', async () => {
      const kept = await indexInto('alpha', 'kept.mp4', 'kept');
      const removed = await indexInto('alpha', 'removed.mp4', 'removed');
      store.assignTags(
        [kept.indexed.fingerprint, removed.indexed.fingerprint],
        ['keeper']
      );
      store.markFilesMissing([removed.filePath], { reason: 'trashed' });

      const snapshot = store.getTaggedLibrarySnapshot({ tagNames: ['keeper'] });
      expect(snapshot.records.map((record) => record.relativePath)).toEqual([
        'kept.mp4',
      ]);
    });

    it('reports truncation rather than silently clipping the library', async () => {
      const entries = [];
      for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) {
        entries.push(await indexInto('alpha', name, `body-${name}`));
      }
      store.assignTags(
        entries.map((entry) => entry.indexed.fingerprint),
        ['keeper']
      );

      const bounded = store.getTaggedLibrarySnapshot({
        tagNames: ['keeper'],
        maxRecords: 2,
      });
      expect(bounded.records).toHaveLength(2);
      expect(bounded.truncated).toBe(true);
      expect(bounded.recordLimit).toBe(2);

      const complete = store.getTaggedLibrarySnapshot({ tagNames: ['keeper'] });
      expect(complete.truncated).toBe(false);
    });

    it('rejects an empty or oversized tag set', async () => {
      const entry = await indexInto('alpha', 'a.mp4', 'a');
      store.assignTags([entry.indexed.fingerprint], ['keeper']);

      expect(() => store.getTaggedLibrarySnapshot({ tagNames: [] })).toThrow(
        /At least one tag/
      );
      expect(() =>
        store.getTaggedLibrarySnapshot({
          tagNames: Array.from({ length: 17 }, (_, index) => `tag-${index}`),
        })
      ).toThrow(/limited to 16 tags/);
    });

    it('lists tags with the number of clips a user would actually see', async () => {
      const kept = await indexInto('alpha', 'kept.mp4', 'kept');
      const gone = await indexInto('beta', 'gone.mp4', 'gone');
      store.assignTags([kept.indexed.fingerprint], ['keeper', 'hero']);
      store.assignTags([gone.indexed.fingerprint], ['keeper']);

      expect(store.listTagCatalog()).toEqual([
        { name: 'hero', instanceCount: 1 },
        { name: 'keeper', instanceCount: 2 },
      ]);

      store.markFilesMissing([gone.filePath], { reason: 'moved' });
      // A removed clip stops counting even though its tag row is retained.
      expect(store.listTagCatalog()).toEqual([
        { name: 'hero', instanceCount: 1 },
        { name: 'keeper', instanceCount: 1 },
      ]);
    });
  });
}
