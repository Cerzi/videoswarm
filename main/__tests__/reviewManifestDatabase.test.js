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
  sqliteDescribe('bounded review-manifest database reads', () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  sqliteDescribe('bounded review-manifest database reads', () => {
    let tempDir;
    let rootPath;
    let store;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-manifest-db-'));
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

    it('queries exact present instances for folder, subtree, and root scopes', async () => {
      const rootClip = createFile('root.mp4');
      const direct = createFile('batch%_one/direct.mp4');
      const deep = createFile('batch%_one/nested/deep.mp4');
      const wildcardLookalike = createFile('batchXXone/lookalike.mp4');
      const prefixLookalike = createFile('batch%_oneish/not-descendant.mp4');
      const missing = createFile('batch%_one/missing.mp4');
      const entries = [
        rootClip,
        direct,
        deep,
        wildcardLookalike,
        prefixLookalike,
        missing,
      ];
      const indexed = await indexAndComplete(entries, {
        seen: entries.filter((entry) => entry !== missing),
      });
      const byPath = Object.fromEntries(
        entries.map((entry, index) => [
          path.relative(rootPath, entry.filePath).split(path.sep).join('/'),
          indexed[index],
        ])
      );
      store.assignTags([byPath['batch%_one/direct.mp4'].fingerprint], ['inside']);
      store.assignTags(
        [byPath['batchXXone/lookalike.mp4'].fingerprint],
        ['outside-one', 'outside-two']
      );
      store.setRating([byPath['batch%_one/direct.mp4'].fingerprint], 4);
      store.setReviewState([byPath['batch%_one/nested/deep.mp4'].fingerprint], 'pick');

      const directSnapshot = store.getReviewManifestSnapshot(rootPath, {
        directory: './batch%_one/',
        scope: 'current-folder',
        maxTagRows: 1,
      });
      expect(directSnapshot.directory).toBe('batch%_one');
      expect(directSnapshot.records).toEqual([
        expect.objectContaining({
          relativePath: 'batch%_one/direct.mp4',
          rating: 4,
          reviewState: 'reviewed',
          tags: ['inside'],
        }),
      ]);
      expect(directSnapshot.records[0]).not.toHaveProperty('absolutePath');

      const subtree = store.getReviewManifestSnapshot(rootPath, {
        directory: 'batch%_one',
        scope: 'current-subtree',
      });
      expect(subtree.records.map((record) => record.relativePath)).toEqual([
        'batch%_one/direct.mp4',
        'batch%_one/nested/deep.mp4',
      ]);
      expect(subtree.records.at(-1).reviewState).toBe('pick');

      const all = store.getReviewManifestSnapshot(rootPath, {
        directory: 'ignored',
        scope: 'all-descendants',
      });
      expect(all.directory).toBe('');
      expect(all.records.map((record) => record.relativePath)).toEqual([
        'batch%_one/direct.mp4',
        'batch%_one/nested/deep.mp4',
        'batch%_oneish/not-descendant.mp4',
        'batchXXone/lookalike.mp4',
        'root.mp4',
      ]);
      expect(all.records.some((record) => record.relativePath.endsWith('missing.mp4')))
        .toBe(false);
    });

    it('requires idle authoritative coverage and completed-scan evidence', async () => {
      const direct = createFile('direct.mp4');
      await store.indexFiles({ rootPath, entries: [direct], recursive: false });

      expect(() => store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'current-folder',
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_MANIFEST_INCOMPLETE_INDEX',
      }));

      store.reconcileLibraryRoot(rootPath, [direct.filePath], { recursive: false });
      expect(store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'current-folder',
      }).records).toHaveLength(1);
      expect(() => store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_MANIFEST_INCOMPLETE_INDEX',
      }));

      store.registerLibraryRoot(rootPath, { refreshState: 'scanning' });
      expect(() => store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'current-folder',
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_MANIFEST_INDEX_NOT_READY',
      }));
    });

    it('rejects more than 20,000 scoped records before reading tags', () => {
      store.registerLibraryRoot(rootPath, { recursive: true });
      const raw = new BetterSqlite(path.join(tempDir, 'videoswarm-meta.db'));
      raw.pragma('foreign_keys = ON');
      const root = raw.prepare(
        'SELECT id FROM library_roots WHERE root_path = ?'
      ).get(rootPath);
      const directory = raw.prepare(
        "SELECT id FROM directories WHERE root_id = ? AND relative_path = ''"
      ).get(root.id);
      const insertContent = raw.prepare(`
        INSERT INTO media_content (
          fingerprint, size, created_ms, created_at, updated_at
        ) VALUES (?, 1, 1, 1, 1);
      `);
      const insertInstance = raw.prepare(`
        INSERT INTO file_instances (
          root_id, directory_id, relative_path, absolute_path, size, mtime_ms,
          fingerprint, is_present, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 1, 1, ?, 1, 1, 1);
      `);
      raw.transaction(() => {
        for (let index = 0; index < 20_001; index += 1) {
          const fingerprint = `fp-${String(index).padStart(5, '0')}`;
          const relativePath = `clip-${String(index).padStart(5, '0')}.mp4`;
          insertContent.run(fingerprint);
          insertInstance.run(
            root.id,
            directory.id,
            relativePath,
            path.join(rootPath, relativePath),
            fingerprint
          );
        }
        raw.prepare(`
          INSERT INTO files (
            fingerprint, last_known_path, size, created_ms, updated_at
          ) VALUES ('fp-00000', 'first', 1, 1, 1);
        `).run();
        raw.prepare("INSERT INTO tags (name) VALUES ('one'), ('two');").run();
        raw.prepare(`
          INSERT INTO file_tags (fingerprint, tag_id, added_at)
          SELECT 'fp-00000', id, 1 FROM tags;
        `).run();
        raw.prepare(`
          UPDATE library_roots
          SET recursive = 1, refresh_state = 'idle',
              last_scan_started_at = 1, last_scan_completed_at = 2
          WHERE id = ?;
        `).run(root.id);
      })();
      raw.close();

      expect(() => store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
        maxTagRows: 1,
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_MANIFEST_TOO_MANY_RECORDS',
      }));
    }, 20_000);

    it('bounds expanded tag rows and UTF-8 bytes across duplicate instances', async () => {
      const first = createFile('one.mp4', 'same bytes');
      const secondPath = path.join(rootPath, 'nested', 'two.mp4');
      fs.mkdirSync(path.dirname(secondPath), { recursive: true });
      fs.linkSync(first.filePath, secondPath);
      const second = { filePath: secondPath, stats: fs.statSync(secondPath) };
      const indexed = await indexAndComplete([first, second]);
      expect(indexed[0].fingerprint).toBe(indexed[1].fingerprint);
      store.assignTags([indexed[0].fingerprint], ['éé', 'plain']);

      expect(() => store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
        maxTagRows: 3,
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_MANIFEST_TOO_MANY_TAGS',
      }));

      expect(() => store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
        maxTagRows: 10,
        maxTagBytes: 17,
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_MANIFEST_TAGS_TOO_LARGE',
      }));

      const snapshot = store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
        maxTagRows: 10,
        maxTagBytes: 18,
      });
      expect(snapshot.records.map((record) => record.tags)).toEqual([
        ['plain', 'éé'],
        ['plain', 'éé'],
      ]);
    });

    it('stops record materialization at the aggregate query-byte budget', async () => {
      const clip = createFile('long-name-clip.mp4');
      await indexAndComplete([clip]);

      expect(() => store.getReviewManifestSnapshot(rootPath, {
        directory: '',
        scope: 'all-descendants',
        maxQueryBytes: 8,
      })).toThrowError(expect.objectContaining({
        code: 'REVIEW_MANIFEST_QUERY_TOO_LARGE',
      }));
    });
  });
}
