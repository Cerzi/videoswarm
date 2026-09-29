import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { requireSqliteSuite } from './sqliteTestGate';

const require = createRequire(import.meta.url);
const {
  createSequenceRenumberCoordinator,
  recordRenumberInCatalog,
} = require('../sequence-renumber');
const { buildSequenceCopyRecords } = require('../sequence-export');

let database;
let databaseLoadError = null;
try {
  const BetterSqlite = require('better-sqlite3');
  const probe = new BetterSqlite(':memory:');
  probe.close();
  database = require('../database');
} catch (error) {
  database = null;
  databaseLoadError = error;
}

const maybeDescribe = requireSqliteSuite(
  describe,
  database ? null : databaseLoadError || new Error('better-sqlite3 probe failed')
);

maybeDescribe('renumbering against the real catalog', () => {
  let tempDir;
  let rootPath;
  let store;

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-renumber-catalog-'))
    );
    rootPath = path.join(tempDir, 'library');
    fs.mkdirSync(rootPath, { recursive: true });
    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();
  });

  afterEach(() => {
    database.resetDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function indexClips(names) {
    const entries = names.map((name) => {
      const filePath = path.join(rootPath, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `content-${name}`);
      return { filePath, stats: fs.statSync(filePath) };
    });
    await store.registerLibraryRoot?.(rootPath, { recursive: true });
    const indexed = await store.indexFiles({ rootPath, entries });
    return indexed.map((record) => record.fingerprint);
  }

  const entriesOf = (snapshot) =>
    snapshot.entries.map((entry) => ({
      absolutePath: entry.instance?.absolutePath || null,
      catalogPath: entry.instance?.absolutePath || null,
      rootPath: entry.instance?.rootPath || null,
    }));

  it('keeps tags, ratings, review state and the sequence through a renumber', async () => {
    const [a, b, c] = await indexClips(['shots/a.mp4', 'b.mp4', 'c.mp4']);
    store.assignTags([a], ['hero']);
    store.setRating([b], 4);
    store.setReviewState([c], 'reject');
    const sequence = store.createSequence('Act one');
    store.appendToSequence(sequence.id, [c, a, b]);
    const before = store.getMetadataForFingerprints([a, b, c]);

    const coordinator = createSequenceRenumberCoordinator();
    const snapshot = store.getSequenceSnapshot(sequence.id, { preferredRootPath: rootPath });
    const prepared = await coordinator.prepare({ ownerId: 1, entries: entriesOf(snapshot) });
    const applied = await coordinator.apply({ ownerId: 1, planId: prepared.planId });
    await recordRenumberInCatalog(store, applied.renamed);

    expect(fs.readdirSync(rootPath).sort()).toEqual(['010_c.mp4', '030_b.mp4', 'shots']);
    expect(fs.readdirSync(path.join(rootPath, 'shots'))).toEqual(['020_a.mp4']);

    const after = store.getMetadataForFingerprints([a, b, c]);
    for (const fingerprint of [a, b, c]) {
      expect(after[fingerprint].tags).toEqual(before[fingerprint].tags);
      expect(after[fingerprint].rating).toEqual(before[fingerprint].rating);
      expect(after[fingerprint].reviewState).toEqual(before[fingerprint].reviewState);
    }
    expect(after[a].tags).toEqual(['hero']);
    expect(after[b].rating).toBe(4);
    expect(after[c].reviewState).toBe('reject');

    // The sequence, keyed by fingerprint, now resolves to the new names in
    // the same order and with nothing missing.
    const renamed = store.getSequenceSnapshot(sequence.id, { preferredRootPath: rootPath });
    expect(renamed.missingCount).toBe(0);
    expect(renamed.entries.map((entry) => path.relative(rootPath, entry.instance.absolutePath)))
      .toEqual(['010_c.mp4', path.join('shots', '020_a.mp4'), '030_b.mp4']);
    // And an export numbers them the same way.
    expect(buildSequenceCopyRecords(renamed).map((record) => record.targetName)).toEqual([
      '010_c.mp4',
      '020_a.mp4',
      '030_b.mp4',
    ]);
  });
});
