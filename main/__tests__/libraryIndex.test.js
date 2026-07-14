import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { requireSqliteSuite } from './sqliteTestGate';

const require = createRequire(import.meta.url);

let database;
let BetterSqlite;
let databaseLoadError;

try {
  BetterSqlite = require('better-sqlite3');
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
  sqliteDescribe('persistent library index', () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  describe('persistent library index', () => {
    let tempDir;
    let rootPath;
    let store;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-library-'));
      rootPath = path.join(tempDir, 'library');
      fs.mkdirSync(rootPath, { recursive: true });
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
    });

    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function createFile(relativePath, content) {
      const filePath = path.join(rootPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return { filePath, stats: fs.statSync(filePath) };
    }

    it('indexes a batch transactionally while preserving distinct instances', async () => {
      const first = createFile('run-a/clip.mp4', 'identical-content');
      const secondPath = path.join(rootPath, 'run-b/clip.mp4');
      fs.mkdirSync(path.dirname(secondPath), { recursive: true });
      fs.linkSync(first.filePath, secondPath);
      const second = { filePath: secondPath, stats: fs.statSync(secondPath) };

      const indexed = await store.indexFiles({
        rootPath,
        entries: [first, second],
      });

      expect(indexed.map((entry) => entry.filePath)).toEqual([
        first.filePath,
        second.filePath,
      ]);
      expect(indexed[0].fingerprint).toBe(indexed[1].fingerprint);
      expect(indexed.map((entry) => entry.instance.relativePath)).toEqual([
        'run-a/clip.mp4',
        'run-b/clip.mp4',
      ]);
      expect(store.getFileInstances(rootPath)).toHaveLength(2);
    });

    it('preserves caller order with bounded concurrent fingerprint preparation', async () => {
      const entries = [
        createFile('bounded/three.mp4', 'three'),
        createFile('bounded/one.mp4', 'one'),
        createFile('bounded/two.mp4', 'two'),
      ];

      const indexed = await store.indexFiles({
        rootPath,
        entries,
        concurrency: 2,
      });

      expect(indexed.map((entry) => entry.filePath)).toEqual(
        entries.map((entry) => entry.filePath)
      );
      expect(store.getFileInstances(rootPath)).toHaveLength(3);
    });

    it('reports monotonic indexing and persisted fingerprint reuse progress', async () => {
      const first = createFile('progress/first.mp4', 'first');
      const second = createFile('progress/second.mp4', 'second');
      await store.indexFiles({ rootPath, entries: [first, second] });
      const updates = [];

      const indexed = await store.indexFiles({
        rootPath,
        entries: [first, second],
        onProgress: (update) => updates.push(update),
      });

      expect(indexed).toHaveLength(2);
      expect(updates.map((update) => update.indexedFiles)).toEqual([0, 1, 2]);
      expect(updates.map((update) => update.totalFiles)).toEqual([2, 2, 2]);
      expect(updates.map((update) => update.fingerprintsReused)).toEqual([
        0,
        1,
        2,
      ]);
      expect(updates.at(-1)).toMatchObject({
        filePath: 'progress/second.mp4',
        indexedFiles: 2,
        fingerprintsReused: 2,
      });
    });

    it('does not let progress observers fail catalog indexing', async () => {
      const entry = createFile('progress/observer.mp4', 'observer');

      await expect(
        store.indexFiles({
          rootPath,
          entries: [entry],
          onProgress: () => {
            throw new Error('telemetry failed');
          },
        })
      ).resolves.toHaveLength(1);
    });

    it('preserves ordinary copied files as distinct filesystem instances', async () => {
      const source = createFile('copies/source.mp4', 'byte-identical-content');
      const copyPath = path.join(rootPath, 'copies/copy.mp4');
      fs.copyFileSync(source.filePath, copyPath);
      const copy = { filePath: copyPath, stats: fs.statSync(copyPath) };

      const indexed = await store.indexFiles({
        rootPath,
        entries: [source, copy],
      });

      expect(indexed).toHaveLength(2);
      expect(indexed[0].instance.id).not.toBe(indexed[1].instance.id);
      expect(indexed.map((entry) => entry.instance.relativePath)).toEqual([
        'copies/source.mp4',
        'copies/copy.mp4',
      ]);
      expect(
        store.getFileInstances(rootPath).map((entry) => entry.absolutePath)
      ).toEqual([copyPath, source.filePath].sort((left, right) =>
        left.localeCompare(right, undefined, { sensitivity: 'base' })
      ));
    });

    it('does not commit partial instances when cancellation arrives during fingerprinting', async () => {
      const first = createFile(
        'cancel/first.mp4',
        Buffer.alloc(256 * 1024, 0x61)
      );
      const second = createFile(
        'cancel/second.mp4',
        Buffer.alloc(256 * 1024, 0x62)
      );
      const cancellation = Object.assign(new Error('scan cancelled'), {
        code: 'DIRECTORY_SCAN_CANCELLED',
      });
      let cancelled = false;

      const indexing = store.indexFiles({
        rootPath,
        entries: [first, second],
        assertActive: () => {
          if (cancelled) throw cancellation;
        },
      });
      queueMicrotask(() => {
        cancelled = true;
      });

      await expect(indexing).rejects.toBe(cancellation);
      expect(store.getFileInstances(rootPath)).toEqual([]);
    });

    it('reuses an unchanged instance fingerprint after reopening the profile', async () => {
      const original = createFile('clip.mp4', 'aaaa');
      const first = await store.indexFile({ rootPath, ...original });

      resetDatabase();
      fs.writeFileSync(original.filePath, 'bbbb');
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();

      // Supplying the same enumerated size/mtime simulates an unchanged scan
      // record. If the persisted instance were ignored, the changed sample
      // bytes would produce a different fingerprint.
      const second = await store.indexFile({ rootPath, ...original });

      expect(second.fingerprint).toBe(first.fingerprint);
      expect(second.fingerprintReused).toBe(true);
    });

    it('only marks files missing inside directories successfully scanned', async () => {
      const rootFile = createFile('root.mp4', 'root');
      const scannedFile = createFile('scanned/missing.mp4', 'missing');
      const inaccessibleFile = createFile('inaccessible/kept.mp4', 'kept');
      await store.indexFiles({
        rootPath,
        entries: [rootFile, scannedFile, inaccessibleFile],
      });

      const result = store.reconcileLibraryRoot(rootPath, [rootFile.filePath], {
        recursive: true,
        scannedDirectories: [rootPath, path.join(rootPath, 'scanned')],
      });

      expect(result.markedMissing).toBe(1);
      const byPath = Object.fromEntries(
        store.getFileInstances(rootPath).map((entry) => [entry.relativePath, entry])
      );
      expect(byPath['root.mp4'].present).toBe(true);
      expect(byPath['scanned/missing.mp4'].present).toBe(false);
      expect(byPath['inaccessible/kept.mp4'].present).toBe(true);
    });

    it('reconciles wholly deleted directories only when recursive coverage is complete', async () => {
      const deleted = createFile('deleted/clip.mp4', 'deleted');
      const unscanned = createFile('unscanned/kept.mp4', 'kept');
      await store.indexFiles({
        rootPath,
        entries: [deleted, unscanned],
      });
      fs.rmSync(path.dirname(deleted.filePath), { recursive: true, force: true });

      const partial = store.reconcileLibraryRoot(rootPath, [], {
        recursive: true,
        scannedDirectories: [rootPath],
      });
      expect(partial.markedMissing).toBe(0);
      expect(
        Object.fromEntries(
          store.getFileInstances(rootPath).map((entry) => [
            entry.relativePath,
            entry.present,
          ])
        )
      ).toMatchObject({
        'deleted/clip.mp4': true,
        'unscanned/kept.mp4': true,
      });

      const complete = store.reconcileLibraryRoot(
        rootPath,
        [unscanned.filePath],
        { recursive: true }
      );
      expect(complete.markedMissing).toBe(1);
      expect(
        Object.fromEntries(
          store.getFileInstances(rootPath).map((entry) => [
            entry.relativePath,
            entry.present,
          ])
        )
      ).toMatchObject({
        'deleted/clip.mp4': false,
        'unscanned/kept.mp4': true,
      });
    });

    it('persists empty directories and aggregate counts across restart', async () => {
      const reviewed = createFile('batch/reviewed.mp4', 'reviewed');
      const missing = createFile('batch/missing.mp4', 'missing');
      const [reviewedEntry] = await store.indexFiles({
        rootPath,
        entries: [reviewed, missing],
      });
      store.setRating([reviewedEntry.fingerprint], 4);
      store.registerLibraryRoot(rootPath, { pinned: true });
      store.registerDirectory(rootPath, path.join(rootPath, 'empty'));
      store.reconcileLibraryRoot(rootPath, [reviewed.filePath], {
        recursive: true,
        scannedDirectories: [
          rootPath,
          path.join(rootPath, 'batch'),
          path.join(rootPath, 'empty'),
        ],
      });

      resetDatabase();
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();

      expect(store.getLibraryRoots()).toEqual([
        expect.objectContaining({ rootPath, pinned: true }),
      ]);
      const summaries = Object.fromEntries(
        store.getDirectorySummaries(rootPath).map((entry) => [entry.relativePath, entry])
      );
      expect(summaries['']).toMatchObject({
        instanceCount: 2,
        presentCount: 1,
        missingCount: 1,
        reviewedCount: 1,
      });
      expect(summaries.batch).toMatchObject({
        directInstanceCount: 2,
        directPresentCount: 1,
        directMissingCount: 1,
        directReviewedCount: 1,
      });
      expect(summaries.empty).toMatchObject({
        instanceCount: 0,
        presentCount: 0,
        present: true,
      });
    });

    it('hydrates present renderer records from SQLite without filesystem reads', async () => {
      const direct = createFile('direct.mp4', 'direct');
      const nested = createFile('batch/nested.mp4', 'nested');
      const removed = createFile('batch/removed.mp4', 'removed');
      const indexed = await store.indexFiles({
        rootPath,
        entries: [
          { ...direct, dimensions: { width: 512, height: 288 } },
          { ...nested, dimensions: { width: 720, height: 1280 } },
          removed,
        ],
      });
      store.assignTags([indexed[0].fingerprint], ['favorite', 'wan']);
      store.setRating([indexed[0].fingerprint], 5);
      store.setReviewState([indexed[1].fingerprint], 'pick');
      store.reconcileLibraryRoot(rootPath, [direct.filePath, nested.filePath], {
        recursive: true,
        scannedDirectories: [rootPath, path.join(rootPath, 'batch')],
        completeCoverage: true,
      });

      resetDatabase();
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();

      const recursiveSnapshot = store.getCachedLibrarySnapshot(rootPath, {
        recursive: true,
      });
      expect(recursiveSnapshot.root).toMatchObject({
        rootPath,
        presentCount: 2,
      });
      expect(recursiveSnapshot.records).toEqual([
        expect.objectContaining({
          absolutePath: nested.filePath,
          relativePath: 'batch/nested.mp4',
          rating: null,
          reviewState: 'pick',
          dimensions: { width: 720, height: 1280, aspectRatio: 0.5625 },
        }),
        expect.objectContaining({
          absolutePath: direct.filePath,
          relativePath: 'direct.mp4',
          tags: ['favorite', 'wan'],
          rating: 5,
          reviewState: 'reviewed',
          dimensions: { width: 512, height: 288, aspectRatio: 512 / 288 },
        }),
      ]);
      expect(
        recursiveSnapshot.records.some(
          (record) => record.absolutePath === removed.filePath
        )
      ).toBe(false);

      const directSnapshot = store.getCachedLibrarySnapshot(rootPath, {
        recursive: false,
      });
      expect(directSnapshot.records.map((record) => record.relativePath)).toEqual([
        'direct.mp4',
      ]);
    });

    it('lists root summaries and toggles pin state without deleting catalog data', async () => {
      const entry = createFile('batch/clip.mp4', 'clip');
      await store.indexFiles({ rootPath, entries: [entry] });
      store.registerDirectory(rootPath, path.join(rootPath, 'empty'));
      store.reconcileLibraryRoot(rootPath, [entry.filePath], {
        recursive: true,
        scannedDirectories: [
          rootPath,
          path.join(rootPath, 'batch'),
          path.join(rootPath, 'empty'),
        ],
        completeCoverage: true,
      });

      expect(store.listLibraryRoots({ pinnedOnly: true })).toEqual([]);
      expect(store.setLibraryRootPinned(rootPath, true)).toMatchObject({
        rootPath,
        pinned: true,
        presentCount: 1,
        subdirectoryCount: 2,
      });
      expect(store.listLibraryRoots({ pinnedOnly: true })).toEqual([
        expect.objectContaining({ rootPath, pinned: true, presentCount: 1 }),
      ]);

      expect(store.setLibraryRootPinned(rootPath, false)).toMatchObject({
        rootPath,
        pinned: false,
      });
      expect(store.getFileInstances(rootPath, { includeMissing: false })).toHaveLength(1);
      expect(store.getLibraryTree(rootPath).directories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ relativePath: 'empty', present: true }),
        ])
      );
      expect(() =>
        store.setLibraryRootPinned(path.join(tempDir, 'not-indexed'), true)
      ).toThrow(/has not been indexed/i);
    });

    it('retires deleted directories only after complete recursive coverage', () => {
      const keptPath = path.join(rootPath, 'kept-empty');
      const uncertainPath = path.join(rootPath, 'uncertain-empty');
      store.registerDirectories(rootPath, [rootPath, keptPath, uncertainPath]);

      const partial = store.reconcileLibraryRoot(rootPath, [], {
        recursive: true,
        scannedDirectories: [rootPath, keptPath],
        completeCoverage: false,
      });
      expect(partial.markedDirectoriesMissing).toBe(0);
      expect(
        store
          .getLibraryTree(rootPath)
          .directories.map((directory) => directory.relativePath)
      ).toContain('uncertain-empty');

      const complete = store.reconcileLibraryRoot(rootPath, [], {
        recursive: true,
        scannedDirectories: [rootPath, keptPath],
        completeCoverage: true,
      });
      expect(complete.markedDirectoriesMissing).toBe(1);
      expect(
        store
          .getLibraryTree(rootPath)
          .directories.map((directory) => directory.relativePath)
      ).not.toContain('uncertain-empty');
      expect(
        store
          .getLibraryTree(rootPath, { includeMissing: true })
          .directories.find(
            (directory) => directory.relativePath === 'uncertain-empty'
          )
      ).toMatchObject({ present: false, missingSince: expect.any(Number) });

      store.registerDirectory(rootPath, uncertainPath);
      expect(
        store
          .getLibraryTree(rootPath)
          .directories.find(
            (directory) => directory.relativePath === 'uncertain-empty'
          )
      ).toMatchObject({ present: true, missingSince: null });
    });

    it('migrates legacy file metadata into media content', () => {
      resetDatabase();
      fs.rmSync(path.join(tempDir, 'videoswarm-meta.db'), { force: true });
      const legacy = new BetterSqlite(path.join(tempDir, 'videoswarm-meta.db'));
      legacy.exec(`
        CREATE TABLE files (
          fingerprint TEXT PRIMARY KEY,
          last_known_path TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_ms INTEGER,
          updated_at INTEGER NOT NULL
        );
      `);
      legacy.prepare(`
        INSERT INTO files (
          fingerprint, last_known_path, size, created_ms, updated_at
        ) VALUES (?, ?, ?, ?, ?);
      `).run('legacy-fingerprint', '/old/clip.mp4', 42, 10, 20);
      legacy.close();

      initMetadataStore({ getPath: () => tempDir }, tempDir);
      resetDatabase();
      const migrated = new BetterSqlite(path.join(tempDir, 'videoswarm-meta.db'), {
        readonly: true,
      });
      const content = migrated
        .prepare('SELECT * FROM media_content WHERE fingerprint = ?')
        .get('legacy-fingerprint');
      const columns = migrated.prepare('PRAGMA table_info(files)').all();
      migrated.close();

      expect(content).toMatchObject({
        fingerprint: 'legacy-fingerprint',
        size: 42,
        created_ms: 10,
      });
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['width', 'height'])
      );
    });

    it('keeps library roots isolated between profiles', async () => {
      const profileA = path.join(tempDir, 'profile-a');
      const profileB = path.join(tempDir, 'profile-b');
      fs.mkdirSync(profileA, { recursive: true });
      fs.mkdirSync(profileB, { recursive: true });

      resetDatabase();
      initMetadataStore({ getPath: () => tempDir }, profileA);
      getMetadataStore().registerLibraryRoot(rootPath, { recursive: true });

      resetDatabase();
      initMetadataStore({ getPath: () => tempDir }, profileB);
      expect(getMetadataStore().getLibraryRoots()).toEqual([]);
    });

    it('limits non-recursive reconciliation to direct children', async () => {
      const direct = createFile('direct.mp4', 'direct');
      const nested = createFile('nested/kept.mp4', 'nested');
      await store.indexFiles({ rootPath, entries: [direct, nested] });

      const result = store.reconcileLibraryRoot(rootPath, [], {
        recursive: false,
        scannedDirectories: [rootPath],
      });

      expect(result.markedMissing).toBe(1);
      const byPath = Object.fromEntries(
        store.getFileInstances(rootPath).map((entry) => [entry.relativePath, entry])
      );
      expect(byPath['direct.mp4'].present).toBe(false);
      expect(byPath['nested/kept.mp4'].present).toBe(true);
    });

    it('marks a watcher removal missing and refreshes directory counts', async () => {
      const entry = createFile('watch/removed.mp4', 'removed');
      await store.indexFile({ rootPath, ...entry });

      const result = store.markFileMissing(entry.filePath, { rootPath });

      expect(result.markedMissing).toBe(1);
      expect(result.instances).toHaveLength(1);
      expect(result.instances[0].present).toBe(false);
      const watchDirectory = store
        .getDirectorySummaries(rootPath)
        .find((directory) => directory.relativePath === 'watch');
      expect(watchDirectory).toMatchObject({
        directPresentCount: 0,
        directMissingCount: 1,
      });
    });

    it('defers per-file directory aggregates until an explicit root refresh', async () => {
      const entry = createFile('deferred/clip.mp4', 'deferred');
      await store.indexFile({
        rootPath,
        ...entry,
        refreshDirectoryCounts: false,
      });

      let deferredDirectory = store
        .getDirectorySummaries(rootPath)
        .find((directory) => directory.relativePath === 'deferred');
      expect(deferredDirectory).toMatchObject({
        directPresentCount: 0,
        directMissingCount: 0,
      });

      store.refreshDirectoryCounts(rootPath);
      deferredDirectory = store
        .getDirectorySummaries(rootPath)
        .find((directory) => directory.relativePath === 'deferred');
      expect(deferredDirectory).toMatchObject({
        directPresentCount: 1,
        directMissingCount: 0,
      });

      store.markFileMissing(entry.filePath, {
        rootPath,
        refreshDirectoryCounts: false,
      });
      deferredDirectory = store
        .getDirectorySummaries(rootPath)
        .find((directory) => directory.relativePath === 'deferred');
      expect(deferredDirectory).toMatchObject({
        directPresentCount: 1,
        directMissingCount: 0,
      });

      store.refreshDirectoryCounts(rootPath);
      deferredDirectory = store
        .getDirectorySummaries(rootPath)
        .find((directory) => directory.relativePath === 'deferred');
      expect(deferredDirectory).toMatchObject({
        directPresentCount: 0,
        directMissingCount: 1,
      });
    });
  });
}
