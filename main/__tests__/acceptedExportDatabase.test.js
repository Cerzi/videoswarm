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

    describe('selection snapshots', () => {
      it('resolves named instances regardless of review state', async () => {
        const first = createFile('batch/first.mp4');
        const second = createFile('batch/second.mp4');
        const third = createFile('other/third.mp4');
        const indexed = await indexAndComplete([first, second, third]);
        // Nothing is Accepted; an explicit selection must not care.
        expect(
          store.getAcceptedExportSnapshot(rootPath, {
            directory: '',
            scope: 'all-descendants',
          }).records
        ).toHaveLength(0);

        const snapshot = store.getSelectionExportSnapshot({
          instanceIds: [indexed[0].instance.id, indexed[2].instance.id],
        });

        expect(snapshot.records.map((record) => record.relativePath)).toEqual([
          'batch/first.mp4',
          'other/third.mp4',
        ]);
        expect(snapshot.requestedCount).toBe(2);
        expect(snapshot.unavailableCount).toBe(0);
      });

      it('reports ids that no longer resolve instead of failing', async () => {
        const clip = createFile('kept.mp4');
        const removed = createFile('gone.mp4');
        const indexed = await indexAndComplete([clip, removed]);
        store.markFileMissing(removed.filePath, { rootPath });

        const snapshot = store.getSelectionExportSnapshot({
          instanceIds: [
            indexed[0].instance.id,
            indexed[1].instance.id,
            9_999_999,
          ],
        });

        expect(snapshot.records).toHaveLength(1);
        expect(snapshot.records[0].relativePath).toBe('kept.mp4');
        // One absent instance plus one id that was never real.
        expect(snapshot.unavailableCount).toBe(2);
      });

      it('resolves instances from more than one root', async () => {
        const clip = createFile('mine.mp4');
        const indexed = await indexAndComplete([clip]);

        const otherRoot = path.join(tempDir, 'other-library');
        fs.mkdirSync(otherRoot, { recursive: true });
        const otherPath = path.join(otherRoot, 'theirs.mp4');
        fs.writeFileSync(otherPath, 'theirs');
        const [otherIndexed] = await store.indexFiles({
          rootPath: otherRoot,
          entries: [{ filePath: otherPath, stats: fs.statSync(otherPath) }],
        });

        const snapshot = store.getSelectionExportSnapshot({
          instanceIds: [indexed[0].instance.id, otherIndexed.instance.id],
        });

        // A selection gathered from a library-wide view spans roots, so both
        // resolve and each record names the root it came from.
        expect(snapshot.records).toHaveLength(2);
        expect(snapshot.unavailableCount).toBe(0);
        expect(snapshot.rootPaths.sort()).toEqual([otherRoot, rootPath].sort());
        expect(
          snapshot.records.map((record) => record.rootPath).sort()
        ).toEqual([otherRoot, rootPath].sort());
      });

      it('rejects an empty or malformed selection', async () => {
        const clip = createFile('clip.mp4');
        await indexAndComplete([clip]);

        expect(() =>
          store.getSelectionExportSnapshot({ instanceIds: [] })
        ).toThrowError(
          expect.objectContaining({ code: 'SELECTION_EXPORT_EMPTY' })
        );
        expect(() =>
          store.getSelectionExportSnapshot({ instanceIds: [0] })
        ).toThrowError(
          expect.objectContaining({ code: 'SELECTION_EXPORT_INVALID_ID' })
        );
        expect(() =>
          store.getSelectionExportSnapshot({
            instanceIds: ['not-an-id'],
          })
        ).toThrowError(
          expect.objectContaining({ code: 'SELECTION_EXPORT_INVALID_ID' })
        );
      });

      it('bounds a selection the same way as a review export', async () => {
        const entries = [
          createFile('a.mp4'),
          createFile('b.mp4'),
          createFile('c.mp4'),
        ];
        const indexed = await indexAndComplete(entries);
        const instanceIds = indexed.map((entry) => entry.instance.id);

        expect(() =>
          store.getSelectionExportSnapshot({
            instanceIds,
            maxRecords: 2,
          })
        ).toThrowError(
          expect.objectContaining({ code: 'ACCEPTED_COPY_TOO_MANY_MEDIA' })
        );
        expect(() =>
          store.getSelectionExportSnapshot({
            instanceIds,
            maxPathBytes: 8,
          })
        ).toThrowError(
          expect.objectContaining({ code: 'ACCEPTED_COPY_PATHS_TOO_LARGE' })
        );
      });
    });
  });
}
