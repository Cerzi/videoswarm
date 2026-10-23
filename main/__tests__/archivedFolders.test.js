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

// Archived folders (library-archive.md): library-wide surfaces leave their
// clips out; the folder itself still opens.
if (!database || databaseLoadError) {
  sqliteDescribe('archived folders', () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;

  sqliteDescribe('archived folders', () => {
    let tempDir;
    let store;
    let rootPath;
    let seen;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-archive-'));
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

    const feedPaths = () => store.listFeedPoolChunk({ limit: 50 }).clips.map((entry) => entry.absolutePath).sort();
    const searchPaths = () => store.getTaggedLibrarySnapshot({ tagNames: [] }).records.map((record) => record.absolutePath).sort();
    const arenaPrints = (options) => store.getArenaPool(options).map((entry) => entry.fingerprint).sort();

    it('leaves an archived folder out of feeds, library search and the arena', async () => {
      const kept = await clip('new/a.mp4');
      const old = await clip('old/b.mp4');
      const older = await clip('old/deep/c.mp4');
      // A sibling whose name starts the same is not under it.
      const sibling = await clip('older/d.mp4');

      const allIds = store.listFeedPoolChunk({ limit: 50 }).clips.map((entry) => entry.instanceId);
      expect(store.setFolderArchived(path.join(rootPath, 'old'), true)).toEqual([
        { folderPath: path.join(rootPath, 'old'), archivedAt: expect.any(Number) },
      ]);
      expect(feedPaths()).toEqual([kept.filePath, sibling.filePath].sort());
      expect(searchPaths()).toEqual([kept.filePath, sibling.filePath].sort());
      expect(arenaPrints()).toEqual([kept.fingerprint, sibling.fingerprint].sort());

      // The grid's clips: archived ones stay out, unless that is all there is.
      expect(arenaPrints({ instanceIds: allIds })).toEqual(
        [kept.fingerprint, sibling.fingerprint].sort()
      );

      store.setFolderArchived(path.join(rootPath, 'old'), false);
      expect(store.listArchivedFolders()).toEqual([]);
      expect(feedPaths()).toEqual([kept.filePath, old.filePath, older.filePath, sibling.filePath].sort());
    });

    it('leaves out a copy of an archived clip kept in another folder', async () => {
      const kept = await clip('new/a.mp4');
      const old = await clip('old/b.mp4');
      const copyPath = path.join(rootPath, 'picks', 'b-copy.mp4');
      fs.mkdirSync(path.dirname(copyPath), { recursive: true });
      fs.copyFileSync(old.filePath, copyPath);
      await store.indexFiles({ rootPath, entries: [{ filePath: copyPath, stats: fs.statSync(copyPath) }] });
      seen.push(copyPath);
      store.reconcileLibraryRoot(rootPath, seen, { recursive: true, completeCoverage: true });
      expect(feedPaths()).toContain(copyPath);

      store.setFolderArchived(path.join(rootPath, 'old'), true);
      expect(feedPaths()).toEqual([kept.filePath]);
      expect(searchPaths()).toEqual([kept.filePath]);
      expect(arenaPrints()).toEqual([kept.fingerprint]);
    });

    it('rates an archived folder when only its clips are asked for', async () => {
      await clip('new/a.mp4');
      const old = await clip('old/b.mp4');
      const oldId = store.listFeedPoolChunk({ limit: 50 }).clips.find((entry) => entry.fingerprint === old.fingerprint).instanceId;
      store.setFolderArchived(path.join(rootPath, 'old'), true);
      expect(arenaPrints({ instanceIds: [oldId] })).toEqual([old.fingerprint]);
    });

    it('takes in folders archived under one, and keeps a folder under an archived one', async () => {
      store.setFolderArchived(path.join(rootPath, 'old', 'deep'), true);
      store.setFolderArchived(path.join(rootPath, 'old'), true);
      expect(store.listArchivedFolders().map((entry) => entry.folderPath)).toEqual([path.join(rootPath, 'old')]);
      store.setFolderArchived(path.join(rootPath, 'old', 'other'), true);
      expect(store.listArchivedFolders().map((entry) => entry.folderPath)).toEqual([path.join(rootPath, 'old')]);
      expect(() => store.setFolderArchived('relative/path', true)).toThrow(/absolute/u);
    });
  });
}
