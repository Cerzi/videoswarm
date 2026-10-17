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

    it('matches a tag through the tags under it, counting each requested tag once', async () => {
      const belly = await indexInto('alpha', 'belly.mp4', 'belly');
      const tap = await indexInto('alpha', 'tap.mp4', 'tap');
      const outdoor = await indexInto('beta', 'outdoor-belly.mp4', 'outdoor-belly');
      const plain = await indexInto('beta', 'plain.mp4', 'plain');
      store.assignTags([belly.indexed.fingerprint], ['dance/bellydance']);
      store.assignTags([tap.indexed.fingerprint], ['dance/tap']);
      store.assignTags([outdoor.indexed.fingerprint], ['bellydance', 'tap', 'outdoor']);
      store.assignTags([plain.indexed.fingerprint], ['outdoor']);

      const dance = store.getTaggedLibrarySnapshot({ tagNames: ['Dance'] });
      expect(dance.records.map((record) => record.relativePath).sort()).toEqual([
        'belly.mp4',
        'outdoor-belly.mp4',
        'tap.mp4',
      ]);
      // Two tags under "dance" still satisfy only the "dance" half of an "all".
      const both = store.getTaggedLibrarySnapshot({ tagNames: ['dance', 'outdoor'] });
      expect(both.records.map((record) => record.relativePath)).toEqual([
        'outdoor-belly.mp4',
      ]);
      const either = store.getTaggedLibrarySnapshot({
        tagNames: ['tap', 'outdoor'],
        matchMode: 'any',
      });
      expect(either.records).toHaveLength(3);
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

    it('leaves out roots the caller reports as unavailable', async () => {
      // A folder moved away is never rescanned, so its rows still read as
      // present. Only the caller can see that the folder itself is gone.
      const moved = await indexInto('alpha', 'moved.mp4', 'moved');
      const kept = await indexInto('beta', 'kept.mp4', 'kept');
      store.assignTags(
        [moved.indexed.fingerprint, kept.indexed.fingerprint],
        ['keeper']
      );

      const snapshot = store.getTaggedLibrarySnapshot({
        tagNames: ['keeper'],
        unavailableRootPaths: [moved.rootPath],
      });

      expect(snapshot.records.map((record) => record.absolutePath)).toEqual([
        kept.filePath,
      ]);
      expect(snapshot.rootPaths).toEqual([kept.rootPath]);
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

    it('keeps the newest clips when a search passes the record cap', async () => {
      const rootPath = path.join(tempDir, 'dated');
      fs.mkdirSync(rootPath, { recursive: true });
      const entries = ['old.mp4', 'newest.mp4', 'middle.mp4'].map((name, index) => {
        const filePath = path.join(rootPath, name);
        fs.writeFileSync(filePath, `body-${name}`);
        const seconds = [1_000_000, 3_000_000, 2_000_000][index];
        fs.utimesSync(filePath, seconds, seconds);
        return { filePath, stats: fs.statSync(filePath) };
      });
      await store.indexFiles({ rootPath, entries });
      store.reconcileLibraryRoot(
        rootPath,
        entries.map((entry) => entry.filePath),
        { recursive: true, completeCoverage: true }
      );
      const bounded = store.getTaggedLibrarySnapshot({ maxRecords: 2 });
      expect(bounded.truncated).toBe(true);
      expect(bounded.records.map((record) => record.relativePath).sort()).toEqual([
        'middle.mp4',
        'newest.mp4',
      ]);
    });

    it('unions tags in any mode and intersects them by default', async () => {
      const both = await indexInto('alpha', 'both.mp4', 'both');
      const oneOnly = await indexInto('beta', 'one.mp4', 'one');
      const neither = await indexInto('beta', 'other.mp4', 'other');
      store.assignTags([both.indexed.fingerprint], ['keeper', 'hero']);
      store.assignTags([oneOnly.indexed.fingerprint], ['keeper']);
      store.assignTags([neither.indexed.fingerprint], ['unrelated']);

      const all = store.getTaggedLibrarySnapshot({
        tagNames: ['keeper', 'hero'],
      });
      expect(all.matchMode).toBe('all');
      expect(all.records.map((record) => record.relativePath)).toEqual([
        'both.mp4',
      ]);

      const any = store.getTaggedLibrarySnapshot({
        tagNames: ['keeper', 'hero'],
        matchMode: 'any',
      });
      expect(any.matchMode).toBe('any');
      expect(
        any.records.map((record) => record.relativePath).sort()
      ).toEqual(['both.mp4', 'one.mp4']);
    });

    it('searches by rating alone, or narrows tags by it, across roots', async () => {
      const five = await indexInto('alpha', 'five.mp4', 'five');
      const four = await indexInto('beta', 'four.mp4', 'four');
      const two = await indexInto('beta', 'two.mp4', 'two');
      await indexInto('beta', 'unrated.mp4', 'unrated');
      store.setRating([five.indexed.fingerprint], 5);
      store.setRating([four.indexed.fingerprint], 4);
      store.setRating([two.indexed.fingerprint], 2);
      store.assignTags([four.indexed.fingerprint, two.indexed.fingerprint], ['keeper']);

      const names = (snapshot) => snapshot.records.map((record) => record.relativePath).sort();
      expect(names(store.getTaggedLibrarySnapshot({ minRating: 4 }))).toEqual(['five.mp4', 'four.mp4']);
      expect(names(store.getTaggedLibrarySnapshot({ exactRating: 2 }))).toEqual(['two.mp4']);
      expect(
        names(store.getTaggedLibrarySnapshot({ tagNames: ['keeper'], minRating: 3 }))
      ).toEqual(['four.mp4']);
      // Out-of-range ratings are no constraint, never "unrated".
      expect(store.getTaggedLibrarySnapshot({ minRating: 0 }).records).toHaveLength(4);
    });

    it('narrows the library to clips whose prompt keys matched a prompt search', async () => {
      const pk = (letter) => `pk2-${letter.repeat(32)}`;
      const gk = (letter) => `gk3-${letter.repeat(32)}`;
      const a = await indexInto('alpha', 'a.mp4', 'alpha-a');
      const b = await indexInto('beta', 'b.mp4', 'beta-b');
      await indexInto('beta', 'plain.mp4', 'beta-plain');
      store.setGenerationKeys([
        { fingerprint: a.indexed.fingerprint, generationKey: gk('a'), promptKey: pk('a') },
        { fingerprint: b.indexed.fingerprint, generationKey: gk('b'), promptKey: pk('b') },
      ]);
      expect(store.listLibraryPromptKeys().sort()).toEqual([pk('a'), pk('b')]);
      const names = (snapshot) => snapshot.records.map((record) => record.relativePath);
      expect(names(store.getTaggedLibrarySnapshot({ promptKeys: [pk('b')] }))).toEqual(['b.mp4']);
      expect(store.getTaggedLibrarySnapshot({ promptKeys: [] }).records).toEqual([]);
      expect(store.getTaggedLibrarySnapshot({}).records).toHaveLength(3);
    });

    it('treats an empty tag set as no tag constraint', async () => {
      const tagged = await indexInto('alpha', 'a.mp4', 'a');
      await indexInto('beta', 'b.mp4', 'b');
      store.assignTags([tagged.indexed.fingerprint], ['keeper']);

      // "Entire library" with no tag selected means everything, which is what
      // the count predicate already yields at zero.
      const everything = store.getTaggedLibrarySnapshot({ tagNames: [] });
      expect(everything.records).toHaveLength(2);
      expect(everything.rootPaths).toHaveLength(2);
    });

    it('rejects an oversized tag set', async () => {
      const entry = await indexInto('alpha', 'a.mp4', 'a');
      store.assignTags([entry.indexed.fingerprint], ['keeper']);

      expect(() =>
        store.getTaggedLibrarySnapshot({
          tagNames: Array.from({ length: 17 }, (_, index) => `tag-${index}`),
        })
      ).toThrow(/limited to 16 tags/);
    });

  });
}
