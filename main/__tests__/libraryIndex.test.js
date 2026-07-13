import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

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

if (!database || databaseLoadError) {
  describe.skip('persistent library index', () => {});
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

    it('persists empty directories and aggregate counts across restart', async () => {
      const reviewed = createFile('batch/reviewed.mp4', 'reviewed');
      const missing = createFile('batch/missing.mp4', 'missing');
      const [reviewedEntry] = await store.indexFiles({
        rootPath,
        entries: [reviewed, missing],
      });
      store.setRating([reviewedEntry.fingerprint], 4);
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

      expect(store.getLibraryRoots()).toHaveLength(1);
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
      });
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
  });
}
