import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  databaseLoadError = error;
}

const maybeDescribe = requireSqliteSuite(
  describe,
  database ? null : databaseLoadError || new Error('better-sqlite3 probe failed')
);

maybeDescribe('profile-local review checkpoints', () => {
  let tempDir;
  let rootPath;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-checkpoint-'));
    rootPath = path.join(tempDir, 'library');
    fs.mkdirSync(rootPath, { recursive: true });
    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();
    store.registerLibraryRoot(rootPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.resetDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const view = (overrides = {}) => ({
    version: 1,
    filters: {
      includeTags: [' Wan ', 'wan', 'Alpha'],
      excludeTags: [],
      minRating: 3,
      exactRating: null,
      reviewFilter: 'unreviewed',
    },
    sort: {
      key: 'created',
      dir: 'desc',
      groupByFolders: false,
      randomSeed: 99,
    },
    ...overrides,
  });

  const draft = (overrides = {}) => ({
    rootPath,
    directory: '',
    scope: 'all-descendants',
    view: view(),
    anchorInstanceId: null,
    anchorFingerprint: null,
    updatedAt: 1,
    ...overrides,
  });

  function rawDatabase(profilePath = tempDir) {
    const raw = new BetterSqlite(path.join(profilePath, 'videoswarm-meta.db'));
    raw.pragma('foreign_keys = ON');
    return raw;
  }

  function createFile(relativePath, contents = relativePath) {
    const filePath = path.join(rootPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    return { filePath, stats: fs.statSync(filePath) };
  }

  it('creates the additive table and persists normalized checkpoints across restart', () => {
    const raw = rawDatabase();
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_checkpoints'").get())
      .toMatchObject({ name: 'review_checkpoints' });
    raw.close();

    vi.spyOn(Date, 'now').mockReturnValue(12345);
    const saved = store.saveReviewCheckpoint(draft());
    expect(saved).toEqual({
      rootPath,
      directory: '',
      scope: 'all-descendants',
      view: {
        version: 1,
        filters: {
          includeTags: ['Alpha', 'Wan'],
          excludeTags: [],
          minRating: 3,
          exactRating: null,
          reviewFilter: 'unreviewed',
        },
        sort: {
          key: 'created',
          dir: 'desc',
          groupByFolders: false,
          randomSeed: null,
        },
      },
      anchorInstanceId: null,
      anchorFingerprint: null,
      updatedAt: 12345,
    });
    expect(store.listReviewCheckpoints()).toEqual([{
      rootPath,
      directory: '',
      scope: 'all-descendants',
      updatedAt: 12345,
    }]);

    database.resetDatabase();
    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();
    expect(store.getReviewCheckpoint(rootPath)).toEqual(saved);
  });

  it('adds the checkpoint schema when opening an existing legacy profile database', () => {
    database.resetDatabase();
    const legacyProfile = path.join(tempDir, 'legacy-profile');
    fs.mkdirSync(legacyProfile);
    const legacy = new BetterSqlite(
      path.join(legacyProfile, 'videoswarm-meta.db')
    );
    legacy.exec(`
      CREATE TABLE files (
        fingerprint TEXT PRIMARY KEY,
        last_known_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_ms INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    legacy.close();

    database.initMetadataStore({ getPath: () => tempDir }, legacyProfile);
    store = database.getMetadataStore();
    const migrated = new BetterSqlite(
      path.join(legacyProfile, 'videoswarm-meta.db')
    );
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='review_checkpoints'"
    ).get()).toEqual({ name: 'review_checkpoints' });
    expect(migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_review_checkpoints_updated'"
    ).get()).toEqual({ name: 'idx_review_checkpoints_updated' });
    migrated.close();
  });

  it('upserts, clears, and distinguishes an absent checkpoint from an unknown root', () => {
    store.saveReviewCheckpoint(draft());
    store.registerDirectory(rootPath, path.join(rootPath, 'batch'));
    const updated = store.saveReviewCheckpoint(draft({
      directory: './batch/',
      scope: 'current-folder',
      view: view({
        filters: { minRating: 5, exactRating: 2, reviewFilter: 'pick' },
      }),
    }));
    expect(updated).toMatchObject({
      directory: 'batch',
      scope: 'current-folder',
      view: { filters: { minRating: null, exactRating: 2, reviewFilter: 'pick' } },
    });
    expect(store.listReviewCheckpoints()).toHaveLength(1);
    expect(store.clearReviewCheckpoint(rootPath)).toBe(true);
    expect(store.clearReviewCheckpoint(rootPath)).toBe(false);
    expect(store.getReviewCheckpoint(rootPath)).toBeNull();
    expect(() => store.getReviewCheckpoint(path.join(tempDir, 'unknown')))
      .toThrowError(expect.objectContaining({ code: 'REVIEW_CHECKPOINT_ROOT_NOT_FOUND' }));
    expect(() => store.clearReviewCheckpoint(path.join(tempDir, 'unknown')))
      .toThrowError(expect.objectContaining({ code: 'REVIEW_CHECKPOINT_ROOT_NOT_FOUND' }));
  });

  it('validates directory containment, scope, view bounds, and deterministic random seed', () => {
    store.registerDirectory(rootPath, path.join(rootPath, 'batch'));
    expect(() => store.saveReviewCheckpoint(draft({
      directory: '../outside',
      scope: 'current-folder',
    }))).toThrowError(expect.objectContaining({
      code: 'INVALID_REVIEW_CHECKPOINT_DIRECTORY',
    }));
    expect(() => store.saveReviewCheckpoint(draft({
      directory: '/absolute',
      scope: 'current-folder',
    }))).toThrowError(expect.objectContaining({
      code: 'INVALID_REVIEW_CHECKPOINT_DIRECTORY',
    }));
    expect(() => store.saveReviewCheckpoint(draft({
      directory: 'missing',
      scope: 'current-folder',
    }))).toThrowError(expect.objectContaining({
      code: 'REVIEW_CHECKPOINT_DIRECTORY_NOT_FOUND',
    }));
    expect(() => store.saveReviewCheckpoint(draft({ scope: 'nearby' })))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_SCOPE' }));
    expect(() => store.saveReviewCheckpoint(draft({ view: view({ version: 2 }) })))
      .toThrowError(expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_VIEW' }));
    expect(() => store.saveReviewCheckpoint(draft({
      view: view({ sort: { key: 'random', randomSeed: null } }),
    }))).toThrowError(expect.objectContaining({ code: 'INVALID_REVIEW_CHECKPOINT_VIEW' }));

    const random = store.saveReviewCheckpoint(draft({
      view: view({
        sort: {
          key: 'random',
          dir: 'asc',
          groupByFolders: true,
          randomSeed: Number.MAX_VALUE,
        },
      }),
    }));
    expect(random.view.sort.randomSeed).toBe(Number.MAX_SAFE_INTEGER);

    const hugeTags = Array.from({ length: 100 }, (_, index) =>
      `${String(index).padStart(3, '0')}${'x'.repeat(77)}`
    );
    expect(() => store.saveReviewCheckpoint(draft({
      view: view({
        filters: { includeTags: hugeTags, excludeTags: hugeTags },
      }),
    }))).toThrowError(expect.objectContaining({
      code: 'REVIEW_CHECKPOINT_VIEW_TOO_LARGE',
    }));
  });

  it('enriches and validates instance-first anchors while accepting fingerprint-only anchors', async () => {
    const indexed = await store.indexFile({
      rootPath,
      ...createFile('batch/clip.mp4', 'anchor'),
    });
    const anchor = store.saveReviewCheckpoint(draft({
      anchorInstanceId: indexed.instance.id,
    }));
    expect(anchor).toMatchObject({
      anchorInstanceId: indexed.instance.id,
      anchorFingerprint: indexed.fingerprint,
    });
    expect(() => store.saveReviewCheckpoint(draft({
      anchorInstanceId: indexed.instance.id,
      anchorFingerprint: 'wrong',
    }))).toThrowError(expect.objectContaining({
      code: 'REVIEW_CHECKPOINT_ANCHOR_MISMATCH',
    }));

    const otherRoot = path.join(tempDir, 'other-library');
    fs.mkdirSync(otherRoot);
    const otherFile = path.join(otherRoot, 'other.mp4');
    fs.writeFileSync(otherFile, 'other');
    const other = await store.indexFile({
      rootPath: otherRoot,
      filePath: otherFile,
      stats: fs.statSync(otherFile),
    });
    expect(() => store.saveReviewCheckpoint(draft({
      anchorInstanceId: other.instance.id,
    }))).toThrowError(expect.objectContaining({
      code: 'REVIEW_CHECKPOINT_ANCHOR_NOT_FOUND',
    }));

    const raw = rawDatabase();
    raw.prepare('DELETE FROM file_instances WHERE id = ?').run(
      indexed.instance.id
    );
    raw.close();
    expect(store.getReviewCheckpoint(rootPath)).toMatchObject({
      anchorInstanceId: null,
      anchorFingerprint: indexed.fingerprint,
    });

    expect(store.saveReviewCheckpoint(draft({
      anchorFingerprint: 'stale-content-fingerprint',
    }))).toMatchObject({
      anchorInstanceId: null,
      anchorFingerprint: 'stale-content-fingerprint',
    });
  });

  it('evicts the deterministic oldest checkpoint in the same 129th upsert transaction', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const roots = [];
    for (let index = 0; index < 129; index += 1) {
      const nextRoot = path.join(tempDir, `root-${String(index).padStart(3, '0')}`);
      store.registerLibraryRoot(nextRoot);
      store.saveReviewCheckpoint(draft({ rootPath: nextRoot }));
      roots.push(nextRoot);
    }
    const summaries = store.listReviewCheckpoints();
    expect(summaries).toHaveLength(128);
    expect(summaries.some((checkpoint) => checkpoint.rootPath === roots[0])).toBe(false);
    expect(store.getReviewCheckpoint(roots[0])).toBeNull();
    expect(store.getReviewCheckpoint(roots[128])).not.toBeNull();
  });

  it('skips malformed rows without deleting them and cascades with root deletion', () => {
    const raw = rawDatabase();
    const root = raw.prepare('SELECT id FROM library_roots WHERE root_path = ?').get(rootPath);
    raw.prepare(`
      INSERT INTO review_checkpoints (
        root_id, directory_relative_path, scope_mode, view_json, updated_at
      ) VALUES (?, '', 'all-descendants', '{broken', 1)
    `).run(root.id);
    expect(store.listReviewCheckpoints()).toEqual([]);
    expect(store.getReviewCheckpoint(rootPath)).toBeNull();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM review_checkpoints').get().count)
      .toBe(1);
    raw.prepare(`
      UPDATE review_checkpoints
      SET view_json = '{"version":1,"filters":{},"sort":{"key":"random"}}'
      WHERE root_id = ?
    `).run(root.id);
    expect(store.listReviewCheckpoints()).toEqual([]);
    expect(store.getReviewCheckpoint(rootPath)).toBeNull();
    raw.prepare(`
      UPDATE review_checkpoints
      SET view_json = '{"version":1,"filters":{},"sort":{"key":"name"}}',
          anchor_fingerprint = ?
      WHERE root_id = ?
    `).run('x'.repeat(513), root.id);
    expect(store.listReviewCheckpoints()).toEqual([]);
    expect(store.getReviewCheckpoint(rootPath)).toBeNull();
    raw.prepare('DELETE FROM library_roots WHERE id = ?').run(root.id);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM review_checkpoints').get().count)
      .toBe(0);
    raw.close();
  });

  it('keeps checkpoints isolated between profile databases', () => {
    store.saveReviewCheckpoint(draft());
    const profileB = path.join(tempDir, 'profile-b');
    const rootB = path.join(tempDir, 'library-b');
    fs.mkdirSync(profileB);
    fs.mkdirSync(rootB);
    database.resetDatabase();
    database.initMetadataStore({ getPath: () => tempDir }, profileB);
    store = database.getMetadataStore();
    store.registerLibraryRoot(rootB);
    expect(store.listReviewCheckpoints()).toEqual([]);
    expect(store.getReviewCheckpoint(rootB)).toBeNull();
  });
});
