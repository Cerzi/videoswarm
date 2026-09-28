import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { requireSqliteSuite } from './sqliteTestGate';

const require = createRequire(import.meta.url);
let database;
let BetterSqlite;
let databaseLoadError = null;
try {
  BetterSqlite = require('better-sqlite3');
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

maybeDescribe('clip sequences', () => {
  let tempDir;
  let rootPath;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-sequence-'));
    rootPath = path.join(tempDir, 'library');
    fs.mkdirSync(rootPath, { recursive: true });
    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();
  });

  afterEach(() => {
    database.resetDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createFile(relativePath, content = relativePath) {
    const filePath = path.join(rootPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return { filePath, stats: fs.statSync(filePath) };
  }

  async function indexClips(names) {
    const entries = names.map((name) => createFile(name, `content-${name}`));
    const indexed = await store.indexFiles({ rootPath, entries });
    return indexed.map((record) => record.fingerprint);
  }

  function positions(entries) {
    return entries.map((entry) => entry.position);
  }

  it('creates named sequences and counts their entries', async () => {
    const [a, b] = await indexClips(['a.mp4', 'b.mp4']);
    const sequence = store.createSequence('  Opening reel  ');
    expect(sequence).toMatchObject({ name: 'Opening reel', entryCount: 0 });

    store.appendToSequence(sequence.id, [a, b]);
    expect(store.getSequence(sequence.id).entryCount).toBe(2);
    expect(store.listSequences()).toHaveLength(1);

    expect(store.renameSequence(sequence.id, 'Act one').name).toBe('Act one');
    expect(store.deleteSequence(sequence.id)).toBe(true);
    expect(store.listSequences()).toEqual([]);
    expect(store.getSequenceEntries(sequence.id)).toEqual([]);
  });

  it('appends in the given order and keeps positions dense', async () => {
    const fingerprints = await indexClips(['a.mp4', 'b.mp4', 'c.mp4']);
    const sequence = store.createSequence('story');

    const entries = store.appendToSequence(sequence.id, fingerprints);
    expect(positions(entries)).toEqual([0, 1, 2]);
    expect(entries.map((entry) => entry.fingerprint)).toEqual(fingerprints);

    const appended = store.appendToSequence(sequence.id, [fingerprints[0]]);
    expect(positions(appended)).toEqual([0, 1, 2, 3]);
    // The same clip may occupy two positions: a story can return to a shot.
    expect(appended[3].fingerprint).toBe(fingerprints[0]);
    expect(appended[0].id).not.toBe(appended[3].id);
  });

  it('reorders an arbitrary permutation without renumbering collisions', async () => {
    const fingerprints = await indexClips(['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
    const sequence = store.createSequence('story');
    const entries = store.appendToSequence(sequence.id, fingerprints);
    const [first, second, third, fourth] = entries.map((entry) => entry.id);

    // A straight swap is the case a one-at-a-time renumber cannot survive.
    const swapped = store.reorderSequenceEntries(sequence.id, [
      second,
      first,
      third,
      fourth,
    ]);
    expect(swapped.map((entry) => entry.id)).toEqual([
      second,
      first,
      third,
      fourth,
    ]);
    expect(positions(swapped)).toEqual([0, 1, 2, 3]);

    const reversed = store.reorderSequenceEntries(sequence.id, [
      fourth,
      third,
      first,
      second,
    ]);
    expect(reversed.map((entry) => entry.id)).toEqual([
      fourth,
      third,
      first,
      second,
    ]);
    expect(positions(reversed)).toEqual([0, 1, 2, 3]);
  });

  it('moves one entry and leaves every other relative order unchanged', async () => {
    const fingerprints = await indexClips(['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
    const sequence = store.createSequence('story');
    const ids = store
      .appendToSequence(sequence.id, fingerprints)
      .map((entry) => entry.id);

    const moved = store.moveSequenceEntry(sequence.id, ids[3], 1);
    expect(moved.map((entry) => entry.id)).toEqual([
      ids[0],
      ids[3],
      ids[1],
      ids[2],
    ]);

    // Out-of-range targets clamp rather than throwing at a drag's edge.
    const clamped = store.moveSequenceEntry(sequence.id, ids[0], 99);
    expect(clamped.map((entry) => entry.id)).toEqual([
      ids[3],
      ids[1],
      ids[2],
      ids[0],
    ]);
    expect(positions(clamped)).toEqual([0, 1, 2, 3]);
  });

  it('rejects a reorder that is not a permutation of the sequence', async () => {
    const fingerprints = await indexClips(['a.mp4', 'b.mp4']);
    const sequence = store.createSequence('story');
    const other = store.createSequence('other');
    const ids = store
      .appendToSequence(sequence.id, fingerprints)
      .map((entry) => entry.id);
    const foreign = store
      .appendToSequence(other.id, [fingerprints[0]])
      .map((entry) => entry.id);

    expect(() => store.reorderSequenceEntries(sequence.id, [ids[0]])).toThrow(
      /every entry/i
    );
    expect(() =>
      store.reorderSequenceEntries(sequence.id, [ids[0], ids[0]])
    ).toThrow(/more than once/i);
    expect(() =>
      store.reorderSequenceEntries(sequence.id, [ids[0], foreign[0]])
    ).toThrow(/not in sequence/i);

    expect(store.getSequenceEntries(sequence.id).map((entry) => entry.id)).toEqual(
      ids
    );
  });

  it('closes the gap after a removal', async () => {
    const fingerprints = await indexClips(['a.mp4', 'b.mp4', 'c.mp4']);
    const sequence = store.createSequence('story');
    const ids = store
      .appendToSequence(sequence.id, fingerprints)
      .map((entry) => entry.id);

    const remaining = store.removeSequenceEntries(sequence.id, [ids[1]]);
    expect(remaining.map((entry) => entry.id)).toEqual([ids[0], ids[2]]);
    expect(positions(remaining)).toEqual([0, 1]);

    // Removing something already gone is a no-op, not an error.
    expect(
      store.removeSequenceEntries(sequence.id, [ids[1]]).map((entry) => entry.id)
    ).toEqual([ids[0], ids[2]]);
  });

  it('refuses to append past the entry limit without a partial write', async () => {
    const [only] = await indexClips(['a.mp4']);
    const sequence = store.createSequence('story');
    for (let batch = 0; batch < 5; batch += 1) {
      store.appendToSequence(sequence.id, Array(100).fill(only));
    }
    expect(store.getSequence(sequence.id).entryCount).toBe(500);

    expect(() => store.appendToSequence(sequence.id, [only])).toThrow(
      /entry limit/i
    );
    expect(store.getSequence(sequence.id).entryCount).toBe(500);
  });

  it('refuses a batch containing unindexed content without a partial write', async () => {
    const [known] = await indexClips(['a.mp4']);
    const sequence = store.createSequence('story');

    expect(() =>
      store.appendToSequence(sequence.id, [known, 'not-a-real-fingerprint'])
    ).toThrow(/unknown content/i);
    expect(store.getSequenceEntries(sequence.id)).toEqual([]);
  });

  it('survives a rename on disk and reports a missing clip as a gap', async () => {
    const fingerprints = await indexClips(['a.mp4', 'b.mp4']);
    const sequence = store.createSequence('story');
    store.appendToSequence(sequence.id, fingerprints);

    const renamed = path.join(rootPath, 'renamed.mp4');
    fs.renameSync(path.join(rootPath, 'a.mp4'), renamed);
    store.markFileMissing(path.join(rootPath, 'a.mp4'), { rootPath });
    await store.indexFile({ rootPath, filePath: renamed, stats: fs.statSync(renamed) });

    const afterRename = store.getSequenceSnapshot(sequence.id);
    expect(afterRename.entries).toHaveLength(2);
    expect(afterRename.missingCount).toBe(0);
    expect(afterRename.entries[0].instance.absolutePath).toBe(renamed);

    fs.rmSync(renamed);
    store.markFileMissing(renamed, { rootPath });
    const afterDelete = store.getSequenceSnapshot(sequence.id);
    // The entry keeps its position rather than shortening the sequence.
    expect(afterDelete.entries).toHaveLength(2);
    expect(afterDelete.entries[0].position).toBe(0);
    expect(afterDelete.entries[0].instance).toBeNull();
    expect(afterDelete.missingCount).toBe(1);
  });

  it('resolves entries to the record fields the renderer contract needs', async () => {
    const [only] = await indexClips(['a.mp4']);
    store.assignTags([only], ['keeper']);
    store.setRating([only], 4);
    const sequence = store.createSequence('story');
    store.appendToSequence(sequence.id, [only]);

    const [resolved] = store.getSequenceSnapshot(sequence.id).entries;
    // Without these the renderer receives a clip it cannot key, play or label.
    expect(resolved.instance).toMatchObject({
      rootPath,
      relativePath: 'a.mp4',
      absolutePath: path.join(rootPath, 'a.mp4'),
      fingerprint: only,
      tags: ['keeper'],
      rating: 4,
      reviewState: 'reviewed',
    });
    expect(resolved.instance.instanceId).toBeGreaterThan(0);
    expect(resolved.instance.size).toBeGreaterThan(0);
    expect(resolved.instance.mtimeMs).toBeGreaterThan(0);
  });

  it('prefers an instance under the root the caller is looking at', async () => {
    const shared = 'identical-bytes-across-roots';
    const first = createFile('shared.mp4', shared);
    await store.indexFiles({ rootPath, entries: [first] });

    const otherRoot = path.join(tempDir, 'other-library');
    fs.mkdirSync(otherRoot, { recursive: true });
    const otherPath = path.join(otherRoot, 'shared.mp4');
    fs.writeFileSync(otherPath, shared);
    const [otherIndexed] = await store.indexFiles({
      rootPath: otherRoot,
      entries: [{ filePath: otherPath, stats: fs.statSync(otherPath) }],
    });

    // One content row, two instances: the sequence entry has to choose.
    const sequence = store.createSequence('story');
    store.appendToSequence(sequence.id, [otherIndexed.fingerprint]);

    expect(
      store.getSequenceSnapshot(sequence.id, { preferredRootPath: otherRoot })
        .entries[0].instance.rootPath
    ).toBe(otherRoot);
    expect(
      store.getSequenceSnapshot(sequence.id, { preferredRootPath: rootPath })
        .entries[0].instance.rootPath
    ).toBe(rootPath);
    // No preference still resolves to a present instance rather than a gap.
    expect(
      store.getSequenceSnapshot(sequence.id).entries[0].instance
    ).toBeTruthy();
  });

  it('persists across a store reload', async () => {
    const fingerprints = await indexClips(['a.mp4', 'b.mp4']);
    const sequence = store.createSequence('story');
    const ids = store
      .appendToSequence(sequence.id, fingerprints)
      .map((entry) => entry.id);
    store.reorderSequenceEntries(sequence.id, [ids[1], ids[0]]);

    database.resetDatabase();
    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();

    expect(
      store.getSequenceEntries(sequence.id).map((entry) => entry.id)
    ).toEqual([ids[1], ids[0]]);
  });

  it('refuses a duplicate sequence name regardless of case', async () => {
    const first = store.createSequence('Act one');
    store.createSequence('Act two');
    expect(() => store.createSequence('act ONE')).toThrow(/already exists/i);
    try {
      store.createSequence('act ONE');
    } catch (error) {
      expect(error.code).toBe('SEQUENCE_NAME_TAKEN');
    }
    expect(() => store.renameSequence(first.id, 'ACT TWO')).toThrow(
      /already exists/i
    );
    expect(store.listSequences()).toHaveLength(2);
    expect(store.getSequence(first.id).name).toBe('Act one');
  });

  it('carries entries across a v1 -> v2 content identity migration', async () => {
    const { computeFingerprint } = require('../fingerprint');
    const entry = createFile('legacy.mp4', 'legacy-sequence-payload');
    const [indexed] = await store.indexFiles({ rootPath, entries: [entry] });

    const sequence = store.createSequence('story');
    store.appendToSequence(sequence.id, [indexed.fingerprint]);

    const { fingerprint, legacyFingerprint } = await computeFingerprint(
      entry.filePath
    );
    expect(legacyFingerprint.startsWith('v1-')).toBe(true);

    // Rewrite the indexed rows back onto their v1 identity so re-indexing
    // exercises the real upgrade path rather than a synthetic fixture.
    const raw = new BetterSqlite(path.join(tempDir, 'videoswarm-meta.db'));
    try {
      raw.pragma('foreign_keys = OFF');
      raw.transaction(() => {
        for (const table of [
          'media_content',
          'files',
          'file_instances',
          'sequence_entries',
        ]) {
          raw
            .prepare(`UPDATE ${table} SET fingerprint = ? WHERE fingerprint = ?;`)
            .run(legacyFingerprint, fingerprint);
        }
      })();
    } finally {
      raw.close();
    }

    await store.indexFiles({
      rootPath,
      entries: [{ filePath: entry.filePath, stats: entry.stats }],
    });

    // The migration drops the old media_content row, which cascades. Without
    // the rekey the entry would vanish and the sequence would silently shorten.
    const entries = store.getSequenceEntries(sequence.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].fingerprint).toBe(fingerprint);
    expect(store.getSequenceSnapshot(sequence.id).missingCount).toBe(0);
  });

  it('rejects unusable ids and names', async () => {
    expect(() => store.createSequence('   ')).toThrow(/name is required/i);
    expect(() => store.createSequence('x'.repeat(81))).toThrow(/exceeds 80/i);
    expect(() => store.getSequenceEntries(0)).toThrow(/positive sequence id/i);
    expect(() => store.renameSequence(9999, 'gone')).toThrow(/does not exist/i);
    expect(store.getSequenceSnapshot(9999)).toBeNull();
  });
});
