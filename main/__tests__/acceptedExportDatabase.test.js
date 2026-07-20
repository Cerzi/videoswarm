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
  sqliteDescribe('bounded Accepted-copy database reads', () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  sqliteDescribe('bounded Accepted-copy database reads', () => {
    let tempDir;
    let rootPath;
    let store;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-accepted-db-'));
      rootPath = path.join(tempDir, 'library');
      fs.mkdirSync(rootPath, { recursive: true });
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
    });

    afterEach(() => {
      resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function createFile(relativePath, contents = relativePath) {
      const filePath = path.join(rootPath, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
      return { filePath, stats: fs.statSync(filePath) };
    }

    async function indexAndComplete(entries, { recursive = true, seen = entries } = {}) {
      const indexed = await store.indexFiles({ rootPath, entries, recursive });
      store.reconcileLibraryRoot(
        rootPath,
        seen.map((entry) => entry.filePath),
        { recursive, completeCoverage: recursive }
      );
      return indexed;
    }

    it('returns only present Accepted instances in exact folder scopes', async () => {
      const rootClip = createFile('root.mp4');
      const direct = createFile('batch%_one/direct.mp4');
      const deep = createFile('batch%_one/nested/deep.mp4');
      const outside = createFile('batchXXone/outside.mp4');
      const missing = createFile('batch%_one/missing.mp4');
      const entries = [rootClip, direct, deep, outside, missing];
      const indexed = await indexAndComplete(entries, {
        seen: entries.filter((entry) => entry !== missing),
      });

      store.setReviewState(
        [indexed[0].fingerprint, indexed[1].fingerprint, indexed[2].fingerprint],
        'pick'
      );
      store.setReviewState([indexed[3].fingerprint], 'reviewed');
      store.setReviewState([indexed[4].fingerprint], 'pick');

      const directSnapshot = store.getAcceptedExportSnapshot(rootPath, {
        directory: './batch%_one/',
        scope: 'current-folder',
      });
      expect(directSnapshot.directory).toBe('batch%_one');
      expect(directSnapshot.records).toEqual([
        expect.objectContaining({
          absolutePath: direct.filePath,
          relativePath: 'batch%_one/direct.mp4',
          fingerprint: indexed[1].fingerprint,
        }),
      ]);

      const subtree = store.getAcceptedExportSnapshot(rootPath, {
        directory: 'batch%_one',
        scope: 'current-subtree',
      });
      expect(subtree.records.map((record) => record.relativePath)).toEqual([
        'batch%_one/direct.mp4',
        'batch%_one/nested/deep.mp4',
      ]);

      const all = store.getAcceptedExportSnapshot(rootPath, {
        directory: 'ignored',
        scope: 'all-descendants',
      });
      expect(all.directory).toBe('');
      expect(all.records.map((record) => record.relativePath)).toEqual([
        'batch%_one/direct.mp4',
        'batch%_one/nested/deep.mp4',
        'root.mp4',
      ]);
    });

    it('returns every concrete instance of Accepted duplicate content', async () => {
      const first = createFile('one.mp4', 'same bytes');
      const secondPath = path.join(rootPath, 'nested', 'two.mp4');
      fs.mkdirSync(path.dirname(secondPath), { recursive: true });
      fs.linkSync(first.filePath, secondPath);
      const second = { filePath: secondPath, stats: fs.statSync(secondPath) };
      const indexed = await indexAndComplete([first, second]);
      expect(indexed[0].fingerprint).toBe(indexed[1].fingerprint);
      store.setReviewState([indexed[0].fingerprint], 'pick');

      const snapshot = store.getAcceptedExportSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
      });
      expect(snapshot.records.map((record) => record.relativePath)).toEqual([
        'nested/two.mp4',
        'one.mp4',
      ]);
    });

    it('requires idle completed coverage for the requested scope', async () => {
      const direct = createFile('direct.mp4');
      const [indexed] = await store.indexFiles({
        rootPath,
        entries: [direct],
        recursive: false,
      });
      store.setReviewState([indexed.fingerprint], 'pick');

      expect(() => store.getAcceptedExportSnapshot(rootPath, {
        directory: '',
        scope: 'current-folder',
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_EXPORT_INCOMPLETE_INDEX',
      }));

      store.reconcileLibraryRoot(rootPath, [direct.filePath], { recursive: false });
      expect(store.getAcceptedExportSnapshot(rootPath, {
        directory: '',
        scope: 'current-folder',
      }).records).toHaveLength(1);
      expect(() => store.getAcceptedExportSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_EXPORT_INCOMPLETE_INDEX',
      }));

      store.registerLibraryRoot(rootPath, { refreshState: 'scanning' });
      expect(() => store.getAcceptedExportSnapshot(rootPath, {
        directory: '',
        scope: 'current-folder',
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_EXPORT_INDEX_NOT_READY',
      }));
    });

    it('bounds record and aggregate path materialization', async () => {
      const clips = [
        createFile('one.mp4'),
        createFile('two-with-a-longer-name.mp4'),
        createFile('three.mp4'),
      ];
      const indexed = await indexAndComplete(clips);
      store.setReviewState(indexed.map((entry) => entry.fingerprint), 'pick');

      expect(() => store.getAcceptedExportSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
        maxRecords: 2,
      })).toThrowError(expect.objectContaining({
        code: 'ACCEPTED_COPY_TOO_MANY_MEDIA',
      }));
      expect(() => store.getAcceptedExportSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
        maxPathBytes: 8,
      })).toThrowError(expect.objectContaining({
        code: 'ACCEPTED_COPY_PATHS_TOO_LARGE',
      }));
    });
  });
}
