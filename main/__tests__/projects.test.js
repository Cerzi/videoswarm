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

maybeDescribe('projects', () => {
  let tempDir;
  let rootA;
  let rootB;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-project-'));
    rootA = path.join(tempDir, 'root-a');
    rootB = path.join(tempDir, 'root-b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();
  });

  afterEach(() => {
    database.resetDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createFile(rootPath, relativePath, content = relativePath) {
    const filePath = path.join(rootPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return { filePath, stats: fs.statSync(filePath) };
  }

  async function indexClips(rootPath, names) {
    const entries = names.map((name) =>
      createFile(rootPath, name, `content-${rootPath}-${name}`)
    );
    const indexed = await store.indexFiles({ rootPath, entries });
    return indexed.map((record) => record.fingerprint);
  }

  it('creates, renames, archives and deletes projects', () => {
    const project = store.createProject('  Client pitch  ');
    expect(project).toMatchObject({
      name: 'Client pitch',
      memberCount: 0,
      archived: false,
      archivedAt: null,
    });

    expect(store.renameProject(project.id, 'Pitch v2').name).toBe('Pitch v2');

    const archived = store.setProjectArchived(project.id, true);
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBeGreaterThan(0);
    // Archiving twice keeps the original archive time.
    expect(store.setProjectArchived(project.id, true).archivedAt).toBe(
      archived.archivedAt
    );
    expect(store.setProjectArchived(project.id, false).archived).toBe(false);

    expect(store.listProjects().map((entry) => entry.name)).toEqual(['Pitch v2']);
    expect(store.deleteProject(project.id)).toBe(true);
    expect(store.deleteProject(project.id)).toBe(false);
    expect(store.listProjects()).toEqual([]);
  });

  it('treats membership as a set and counts members', async () => {
    const [a, b, c] = await indexClips(rootA, ['a.mp4', 'b.mp4', 'c.mp4']);
    const project = store.createProject('batch');

    let result = store.addToProject(project.id, [a, b, a]);
    expect(result.added).toBe(2);
    expect(result.project.memberCount).toBe(2);

    // Adding the selection again is a no-op rather than an error.
    result = store.addToProject(project.id, [a, b, c]);
    expect(result.added).toBe(1);
    expect(result.project.memberCount).toBe(3);

    result = store.removeFromProject(project.id, [b, 'not-a-member']);
    expect(result.removed).toBe(1);
    expect(result.project.memberCount).toBe(2);
  });

  it('refuses a batch holding an unknown clip without applying any of it', async () => {
    const [a] = await indexClips(rootA, ['a.mp4']);
    const project = store.createProject('batch');
    expect(() => store.addToProject(project.id, [a, 'unknown'])).toThrow(
      /unknown content fingerprint/i
    );
    expect(store.getProject(project.id).memberCount).toBe(0);
  });

  it('opens a project across roots and reports members with no file', async () => {
    const [a, b] = await indexClips(rootA, ['a.mp4', 'nested/b.mp4']);
    const [c] = await indexClips(rootB, ['c.mp4']);
    const [notMember] = await indexClips(rootB, ['other.mp4']);
    const project = store.createProject('spans roots');
    store.addToProject(project.id, [a, b, c]);

    let snapshot = store.getProjectSnapshot(project.id);
    expect(snapshot.project.name).toBe('spans roots');
    expect(snapshot.records.map((record) => record.fingerprint).sort()).toEqual(
      [a, b, c].sort()
    );
    expect(snapshot.records.map((record) => record.fingerprint)).not.toContain(
      notMember
    );
    expect(snapshot.rootPaths.sort()).toEqual(
      [path.resolve(rootA), path.resolve(rootB)].sort()
    );
    expect(snapshot.missingCount).toBe(0);
    expect(snapshot.truncated).toBe(false);

    store.markFileMissing(path.join(rootA, 'a.mp4'), { rootPath: rootA });
    snapshot = store.getProjectSnapshot(project.id);
    expect(snapshot.records.map((record) => record.fingerprint)).not.toContain(a);
    // The member stays; it just has nothing to show.
    expect(snapshot.project.memberCount).toBe(3);
    expect(snapshot.missingCount).toBe(1);
  });

  it('carries tags, ratings and review state into project records', async () => {
    const [a] = await indexClips(rootA, ['a.mp4']);
    store.assignTags([a], ['night']);
    store.setRating([a], 4);
    const project = store.createProject('metadata');
    store.addToProject(project.id, [a]);

    const [record] = store.getProjectSnapshot(project.id).records;
    expect(record.tags).toEqual(['night']);
    expect(record.rating).toBe(4);
  });

  it('keeps projects out of the tag list and tags out of project names', async () => {
    const [a] = await indexClips(rootA, ['a.mp4']);
    store.assignTags([a], ['night']);
    // The same name as a tag is allowed: projects are not tags.
    const project = store.createProject('Night');
    store.addToProject(project.id, [a]);

    expect(store.listTags().map((tag) => tag.name)).toEqual(['night']);
    store.removeTag([a], 'night');
    expect(store.listTags()).toEqual([]);
    expect(store.getProject(project.id).memberCount).toBe(1);
  });

  it('survives being emptied, and deleting it leaves the clips alone', async () => {
    const [a] = await indexClips(rootA, ['a.mp4']);
    store.setRating([a], 5);
    const project = store.createProject('keep me');
    store.addToProject(project.id, [a]);
    store.removeFromProject(project.id, [a]);
    expect(store.getProject(project.id)).toMatchObject({ memberCount: 0 });

    store.addToProject(project.id, [a]);
    store.deleteProject(project.id);
    expect(store.getMetadataForFingerprints([a])[a].rating).toBe(5);
    expect(store.getProjectSnapshot(project.id)).toBeNull();
  });

  it('reports name collisions with a stable code, case-insensitively', () => {
    const first = store.createProject('Pitch');
    store.createProject('Trailer');
    let caught = null;
    try {
      store.createProject('PITCH');
    } catch (error) {
      caught = error;
    }
    expect(caught?.code).toBe('PROJECT_NAME_TAKEN');
    expect(() => store.renameProject(first.id, 'trailer')).toThrow(
      /already exists/i
    );
  });

  it('rejects unusable ids and names', () => {
    expect(() => store.createProject('   ')).toThrow(/name is required/i);
    expect(() => store.createProject('x'.repeat(81))).toThrow(/exceeds 80/i);
    expect(() => store.getProject(0)).toThrow(/positive project id/i);
    expect(() => store.renameProject(9999, 'gone')).toThrow(/does not exist/i);
    expect(() => store.addToProject(9999, [])).toThrow(/does not exist/i);
    expect(store.getProjectSnapshot(9999)).toBeNull();
  });

  it('carries members across a v1 -> v2 content identity migration', async () => {
    const { computeFingerprint } = require('../fingerprint');
    const entry = createFile(rootA, 'legacy.mp4', 'legacy-project-payload');
    const [indexed] = await store.indexFiles({ rootPath: rootA, entries: [entry] });

    const project = store.createProject('migrated');
    store.addToProject(project.id, [indexed.fingerprint]);

    const { fingerprint, legacyFingerprint } = await computeFingerprint(
      entry.filePath
    );
    expect(legacyFingerprint.startsWith('v1-')).toBe(true);

    const raw = new BetterSqlite(path.join(tempDir, 'videoswarm-meta.db'));
    try {
      raw.pragma('foreign_keys = OFF');
      raw.transaction(() => {
        for (const table of [
          'media_content',
          'files',
          'file_instances',
          'project_members',
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
      rootPath: rootA,
      entries: [{ filePath: entry.filePath, stats: entry.stats }],
    });

    // The migration drops the old content row, which cascades. Without the
    // rekey the project would silently lose the clip.
    const snapshot = store.getProjectSnapshot(project.id);
    expect(snapshot.project.memberCount).toBe(1);
    expect(snapshot.records.map((record) => record.fingerprint)).toEqual([
      fingerprint,
    ]);
  });
});
