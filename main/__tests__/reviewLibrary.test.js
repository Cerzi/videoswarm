import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let database;
let BetterSqlite;
try {
  BetterSqlite = require('better-sqlite3');
  const probe = new BetterSqlite(':memory:');
  probe.close();
  database = require('../database');
} catch {
  database = null;
}

const maybeDescribe = database ? describe : describe.skip;

maybeDescribe('review state and saved library views', () => {
  let tempDir;
  let rootPath;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-review-'));
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

  it('persists explicit content review state and counts duplicate instances', async () => {
    const first = createFile('a/clip.mp4', 'same-content');
    const secondPath = path.join(rootPath, 'b/clip.mp4');
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    fs.linkSync(first.filePath, secondPath);
    const indexed = await store.indexFiles({
      rootPath,
      entries: [first, { filePath: secondPath, stats: fs.statSync(secondPath) }],
    });
    const fingerprint = indexed[0].fingerprint;
    expect(indexed[1].fingerprint).toBe(fingerprint);

    expect(store.setRating([fingerprint], 4)[fingerprint].reviewState).toBe('reviewed');
    expect(store.getLibraryRoot(rootPath).reviewedCount).toBe(2);

    store.setReviewState([fingerprint], 'reject');
    store.setRating([fingerprint], 5);
    expect(store.getMetadataForFingerprints([fingerprint])[fingerprint]).toMatchObject({
      rating: 5,
      reviewState: 'reject',
    });

    store.setReviewState([fingerprint], 'unreviewed');
    store.setRating([fingerprint], 3);
    expect(store.getLibraryRoot(rootPath).reviewedCount).toBe(0);

    database.resetDatabase();
    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();
    expect(store.getMetadataForFingerprints([fingerprint])[fingerprint]).toMatchObject({
      rating: 3,
      reviewState: 'unreviewed',
    });
    expect(store.getFileInstances(rootPath).every(
      (instance) => instance.reviewState === 'unreviewed' && !instance.reviewed
    )).toBe(true);

    store.setRating([fingerprint], null);
    expect(store.getMetadataForFingerprints([fingerprint])[fingerprint]).toMatchObject({
      rating: null,
      reviewState: 'unreviewed',
    });
  });

  it('rejects invalid review states without mutating metadata', async () => {
    const indexed = await store.indexFile({ rootPath, ...createFile('clip.mp4') });
    expect(() => store.setReviewState([indexed.fingerprint], 'maybe')).toThrow(
      /unsupported review state/i
    );
    expect(store.getMetadataForFingerprints([indexed.fingerprint])[indexed.fingerprint]
      .reviewState).toBe('unreviewed');
  });

  it('updates reviewed aggregates only along affected instance ancestors', async () => {
    const target = await store.indexFile({
      rootPath,
      ...createFile('target/nested/clip.mp4', 'target'),
    });
    const unrelated = await store.indexFile({
      rootPath,
      ...createFile('unrelated/clip.mp4', 'unrelated'),
    });
    const summaries = () => Object.fromEntries(
      store.getDirectorySummaries(rootPath).map((row) => [row.relativePath, row])
    );

    const initial = summaries();
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.setReviewState([target.fingerprint], 'pick');
    const afterPick = summaries();

    expect(afterPick['']).toMatchObject({ reviewedCount: 1 });
    expect(afterPick.target).toMatchObject({ reviewedCount: 1 });
    expect(afterPick['target/nested']).toMatchObject({
      directReviewedCount: 1,
      reviewedCount: 1,
    });
    expect(afterPick.unrelated).toMatchObject({ reviewedCount: 0 });
    expect(afterPick.unrelated.updatedAt).toBe(initial.unrelated.updatedAt);
    expect(afterPick.target.updatedAt).toBeGreaterThan(initial.target.updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 5));
    store.setRating([unrelated.fingerprint], 4);
    const afterRating = summaries();
    expect(afterRating['']).toMatchObject({ reviewedCount: 2 });
    expect(afterRating.unrelated).toMatchObject({
      directReviewedCount: 1,
      reviewedCount: 1,
    });
    expect(afterRating.target.updatedAt).toBe(afterPick.target.updatedAt);
    expect(afterRating.unrelated.updatedAt).toBeGreaterThan(
      afterPick.unrelated.updatedAt
    );
  });

  it('stores generation provenance per instance rather than per fingerprint', async () => {
    const first = createFile('run-a/clip.mp4', 'same');
    const secondPath = path.join(rootPath, 'run-b/clip.mp4');
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    fs.linkSync(first.filePath, secondPath);
    const indexed = await store.indexFiles({
      rootPath,
      entries: [first, { filePath: secondPath, stats: fs.statSync(secondPath) }],
    });
    expect(indexed[0].fingerprint).toBe(indexed[1].fingerprint);

    const a = store.setGenerationMetadata(indexed[0].instance.id, {
      sidecarPath: `${first.filePath}.json`,
      sidecarSize: 20,
      sidecarMtimeMs: 10,
      parserVersion: 1,
      prompt: 'first prompt',
      seed: '90071992547409931234',
      models: ['wan-a'],
    });
    const b = store.setGenerationMetadata(indexed[1].instance.id, {
      sidecarPath: `${secondPath}.json`,
      sidecarSize: 21,
      sidecarMtimeMs: 11,
      parserVersion: 1,
      prompt: 'second prompt',
      models: ['wan-b'],
    });

    expect(a).toMatchObject({ prompt: 'first prompt', seed: '90071992547409931234' });
    expect(b).toMatchObject({ prompt: 'second prompt', model: 'wan-b' });
    expect(store.clearGenerationMetadata(indexed[0].instance.id)).toBe(true);
    expect(store.getGenerationMetadata(indexed[0].instance.id)).toBeNull();
    expect(store.getGenerationMetadata(indexed[1].instance.id)?.prompt).toBe(
      'second prompt'
    );
  });

  const definition = (overrides = {}) => ({
    version: 1,
    filters: {
      includeTags: ['picked'],
      excludeTags: [],
      minRating: null,
      exactRating: null,
      reviewFilter: 'pick',
    },
    sort: { key: 'created', dir: 'desc', groupByFolders: false },
    scope: { mode: 'current-subtree' },
    ...overrides,
  });

  it('validates, normalizes, updates, and deletes profile-local saved views', () => {
    const created = store.createSavedView(' Picks ', {
      ...definition(),
      ignored: { arbitrary: true },
    });
    expect(created).toMatchObject({
      id: expect.any(Number),
      name: 'Picks',
      definition: {
        version: 1,
        filters: { reviewFilter: 'pick' },
        sort: { key: 'created', dir: 'desc', groupByFolders: false },
        scope: { mode: 'current-subtree' },
      },
    });
    expect(created.definition).not.toHaveProperty('ignored');
    expect(() => store.createSavedView('picks', definition())).toThrow();
    expect(() => store.createSavedView('x'.repeat(81), definition())).toThrow(
      /80 characters/i
    );
    expect(() => store.createSavedView('Future', definition({ version: 2 }))).toThrow(
      /version/i
    );
    const hugeTags = Array.from({ length: 100 }, (_, index) =>
      `${String(index).padStart(3, '0')}${'x'.repeat(77)}`
    );
    expect(() => store.createSavedView('Too large', definition({
      filters: {
        includeTags: hugeTags,
        excludeTags: hugeTags.map((tag) => `z${tag.slice(1)}`),
      },
    }))).toThrow(/8192 bytes|too large/i);

    const updated = store.updateSavedView(created.id, {
      name: 'Rejects',
      definition: definition({
        filters: { reviewFilter: 'reject', exactRating: 0 },
        scopeMode: 'current-folder',
        scope: undefined,
      }),
    });
    expect(updated).toMatchObject({
      name: 'Rejects',
      definition: {
        filters: { reviewFilter: 'reject', exactRating: 0, minRating: null },
        scope: { mode: 'current-folder' },
      },
    });
    expect(store.listSavedViews()).toHaveLength(1);
    expect(store.deleteSavedView(created.id)).toBe(true);
    expect(store.deleteSavedView(created.id)).toBe(false);
  });

  it('enforces the saved-view count limit', () => {
    for (let index = 0; index < 100; index += 1) {
      store.createSavedView(`View ${index}`, definition());
    }
    expect(() => store.createSavedView('One too many', definition())).toThrow(
      /limit of 100/i
    );
  });

  it('keeps saved views isolated between profiles', () => {
    store.createSavedView('Profile A', definition());
    const profileB = path.join(tempDir, 'profile-b');
    fs.mkdirSync(profileB, { recursive: true });
    database.resetDatabase();
    database.initMetadataStore({ getPath: () => tempDir }, profileB);
    store = database.getMetadataStore();
    expect(store.listSavedViews()).toEqual([]);
  });
});

maybeDescribe('review-state legacy migration', () => {
  it('backfills ratings once while preserving a later explicit unreviewed state', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videoswarm-review-migrate-'));
    const dbPath = path.join(tempDir, 'videoswarm-meta.db');
    const legacy = new BetterSqlite(dbPath);
    legacy.exec(`
      CREATE TABLE files (
        fingerprint TEXT PRIMARY KEY,
        last_known_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_ms INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ratings (
        fingerprint TEXT PRIMARY KEY,
        value INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO files VALUES ('legacy', '/old/clip.mp4', 10, 1, 2);
      INSERT INTO ratings VALUES ('legacy', 4, 3);
    `);
    legacy.close();

    try {
      database.initMetadataStore({ getPath: () => tempDir }, tempDir);
      let store = database.getMetadataStore();
      expect(store.getMetadataForFingerprints(['legacy']).legacy.reviewState).toBe(
        'reviewed'
      );
      store.setReviewState(['legacy'], 'unreviewed');
      database.resetDatabase();
      database.initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = database.getMetadataStore();
      expect(store.getMetadataForFingerprints(['legacy']).legacy.reviewState).toBe(
        'unreviewed'
      );
    } finally {
      database.resetDatabase();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
