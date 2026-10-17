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

// The local read API's storage (local-read-api.md): clips by path or
// content id, and the change log every tag, rating and review write feeds.
if (!database || databaseLoadError) {
  sqliteDescribe('local read API storage', () => {});
} else {
  const { initMetadataStore, getMetadataStore, resetDatabase } = database;
  const pk = (letter) => `pk2-${letter.repeat(32)}`;
  const gk = (letter) => `gk3-${letter.repeat(32)}`;

  sqliteDescribe('local read API storage', () => {
    let tempDir;
    let store;
    let rootPath;
    let seen;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-localapi-'));
      initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = getMetadataStore();
      rootPath = path.join(tempDir, 'clips');
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

    it('answers by present path and by content id, with tag paths, rating, review and keys', async () => {
      const dancing = await clip('dancing.mp4');
      const plain = await clip('plain.mp4');
      store.assignTags([dancing.fingerprint], ['dance/bellydance', 'keeper']);
      store.setRating([dancing.fingerprint], 4);
      store.setReviewState([dancing.fingerprint], 'pick');
      store.setGenerationKeys([
        { fingerprint: dancing.fingerprint, generationKey: gk('a'), promptKey: pk('a') },
      ]);

      const found = store.getLocalApiClips({
        paths: [dancing.filePath, path.join(rootPath, 'missing.mp4'), '/elsewhere/x.mp4'],
        contentIds: [plain.fingerprint, 'v2-0-unknown'],
      });
      expect([...found.keys()].sort()).toEqual([dancing.filePath, plain.fingerprint].sort());
      expect(found.get(dancing.filePath)).toEqual({
        contentId: dancing.fingerprint,
        tags: [
          { name: 'bellydance', path: ['dance', 'bellydance'] },
          { name: 'keeper', path: ['keeper'] },
        ],
        rating: 4,
        review: 'pick',
        hasPrompt: true,
        promptKey: pk('a'),
        generationKey: gk('a'),
      });
      // Not read yet: whether it has a prompt is not known.
      expect(found.get(plain.fingerprint)).toMatchObject({
        contentId: plain.fingerprint,
        tags: [],
        rating: null,
        review: 'unreviewed',
        hasPrompt: null,
        promptKey: null,
      });
    });

    it('does not answer for a file that is gone', async () => {
      const gone = await clip('gone.mp4');
      seen = [];
      store.reconcileLibraryRoot(rootPath, seen, { recursive: true, completeCoverage: true });
      expect(store.getLocalApiClips({ paths: [gone.filePath] }).size).toBe(0);
    });

    it('logs every tag, rating and review change, and tag tree changes apart', async () => {
      const a = await clip('a.mp4');
      const b = await clip('b.mp4');
      const start = store.getMetadataRevision();

      store.assignTags([a.fingerprint], ['dance']);
      let changes = store.listMetadataChangesSince(start);
      expect(changes.changed).toEqual([a.fingerprint]);
      expect(changes.tagTreeChanged).toBe(true); // "dance" was new
      expect(changes.reset).toBe(false);

      let from = changes.revision;
      store.setRating([b.fingerprint], 3);
      store.setReviewState([a.fingerprint], 'reject');
      store.restoreReviewMetadata([{ fingerprint: b.fingerprint, reviewState: "unreviewed", rating: null }]);
      changes = store.listMetadataChangesSince(from);
      expect(changes.changed.sort()).toEqual([a.fingerprint, b.fingerprint].sort());
      expect(changes.tagTreeChanged).toBe(false);

      from = changes.revision;
      store.setTagParent('dance', 'movement');
      changes = store.listMetadataChangesSince(from);
      expect(changes.tagTreeChanged).toBe(true);
      expect(changes.changed).toEqual([]);

      // Removing a tag is a change too, and the last clip leaving a tag
      // removes it from the tree.
      from = changes.revision;
      store.removeTag([a.fingerprint], 'dance');
      changes = store.listMetadataChangesSince(from);
      expect(changes.changed).toEqual([a.fingerprint]);
      expect(changes.tagTreeChanged).toBe(true);

      // Nothing new: the same revision, nothing changed.
      expect(store.listMetadataChangesSince(changes.revision)).toEqual({
        revision: changes.revision,
        changed: [],
        tagTreeChanged: false,
        reset: false,
        more: false,
      });
    });

    it("asks a reader to start again when the revision is not this log's", async () => {
      const a = await clip('a.mp4');
      store.assignTags([a.fingerprint], ['dance']);
      const current = store.getMetadataRevision();
      expect(store.listMetadataChangesSince(current + 50)).toMatchObject({ reset: true, revision: current });
      expect(store.listMetadataChangesSince(-1)).toMatchObject({ reset: true });
    });
  });
}
