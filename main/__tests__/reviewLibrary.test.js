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
    store.assignTags([fingerprint], ['wan', 'favorite']);

    expect(store.setRating([fingerprint], 4)[fingerprint].reviewState).toBe('reviewed');
    expect(store.getLibraryRoot(rootPath).reviewedCount).toBe(2);

    store.setReviewState([fingerprint], 'reject');
    store.setRating([fingerprint], 5);
    expect(store.getMetadataForFingerprints([fingerprint])[fingerprint]).toMatchObject({
      rating: 5,
      reviewState: 'reject',
    });

    store.setReviewState([fingerprint], 'unreviewed');
    expect(store.getMetadataForFingerprints([fingerprint])[fingerprint]).toMatchObject({
      rating: null,
      reviewState: 'unreviewed',
      tags: ['favorite', 'wan'],
    });
    store.setRating([fingerprint], 3);
    expect(store.getLibraryRoot(rootPath).reviewedCount).toBe(2);

    database.resetDatabase();
    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();
    expect(store.getMetadataForFingerprints([fingerprint])[fingerprint]).toMatchObject({
      rating: 3,
      reviewState: 'reviewed',
    });
    expect(store.getFileInstances(rootPath).every(
      (instance) => instance.reviewState === 'reviewed' && instance.reviewed
    )).toBe(true);

    store.setReviewState([fingerprint], 'unreviewed');
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

  it('keeps rating-derived review completion after rating is cleared', async () => {
    const indexed = await store.indexFile({
      rootPath,
      ...createFile('rated.mp4', 'rated'),
    });

    expect(store.setRating([indexed.fingerprint], 4)[indexed.fingerprint])
      .toMatchObject({ rating: 4, reviewState: 'reviewed' });
    expect(store.setRating([indexed.fingerprint], null)[indexed.fingerprint])
      .toMatchObject({ rating: null, reviewState: 'reviewed' });
    expect(store.getLibraryRoot(rootPath).reviewedCount).toBe(1);
  });

  it('restores review status and rating atomically without changing tags', async () => {
    const first = await store.indexFile({
      rootPath,
      ...createFile('first.mp4', 'first'),
    });
    const second = await store.indexFile({
      rootPath,
      ...createFile('second.mp4', 'second'),
    });
    store.assignTags([first.fingerprint], ['keep-me']);
    store.setReviewState([first.fingerprint], 'reject');
    store.setRating([first.fingerprint], 5);
    store.setReviewState([second.fingerprint], 'pick');

    const updates = store.restoreReviewMetadata([
      {
        fingerprint: first.fingerprint,
        reviewState: 'reviewed',
        rating: 3,
      },
      {
        fingerprint: second.fingerprint,
        reviewState: 'unreviewed',
        rating: null,
      },
    ]);
    expect(updates[first.fingerprint]).toMatchObject({
      reviewState: 'reviewed',
      rating: 3,
      tags: ['keep-me'],
    });
    expect(updates[second.fingerprint]).toMatchObject({
      reviewState: 'unreviewed',
      rating: null,
    });
    expect(store.getLibraryRoot(rootPath).reviewedCount).toBe(1);

    expect(() => store.restoreReviewMetadata([
      {
        fingerprint: first.fingerprint,
        reviewState: 'pick',
        rating: 4,
      },
      {
        fingerprint: second.fingerprint,
        reviewState: 'unreviewed',
        rating: 4,
      },
    ])).toThrow(/cannot retain a rating/i);
    expect(store.getMetadataForFingerprints([
      first.fingerprint,
      second.fingerprint,
    ])).toMatchObject({
      [first.fingerprint]: { reviewState: 'reviewed', rating: 3 },
      [second.fingerprint]: { reviewState: 'unreviewed', rating: null },
    });
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

  it('stores bounded embedded provenance without retaining arbitrary workflow objects', async () => {
    const clip = createFile('embedded/clip.mp4', 'embedded metadata clip');
    const indexed = await store.indexFile({ rootPath, ...clip });
    const pollutedRecord = JSON.parse(`{
      "__proto__": {"polluted": true},
      "constructor": "blocked",
      "prototype": "blocked",
      "container": "mp4",
      "nestedWorkflow": {"nodes": {"1": {"inputs": {"text": "raw"}}}}
    }`);
    const longFragments = Array.from({ length: 40 }, (_, index) => ({
      text: `${index}-${'😀'.repeat(3000)}`,
      role: index % 2 ? 'negative' : 'positive',
      nodeId: String(index),
      composition: 'concat',
      confidence: index === 0 ? 1 : 0.5,
      classType: 'CLIPTextEncode',
      field: 'text',
      resolved: true,
    }));

    const metadata = store.setGenerationMetadata(indexed.instance.id, {
      sourceKind: 'embedded',
      sourceFormat: 'mp4-comment',
      sourceLabel: 'clip.mp4 · comment',
      parserVersion: 2,
      provenance: pollutedRecord,
      positivePrompt: 'a city at dusk',
      negativePrompt: 'blur, artifacts',
      promptFragments: longFragments,
      seed: '90071992547409931234',
      models: ['wan2.2.safetensors'],
      assets: {
        checkpoints: ['wan2.2.safetensors'],
        vaes: ['wan_vae.safetensors'],
        textEncoders: ['umt5_xxl.safetensors'],
      },
      samplers: ['euler'],
      loras: [
        {
          name: 'detail.safetensors',
          strengthModel: null,
          strengthClip: '',
          appliedTo: ['model', 'clip'],
        },
        {
          name: 'motion.safetensors',
          strengthModel: 0.8,
          strengthClip: 0.4,
          appliedTo: 'model',
        },
      ],
      samplingParameters: {
        steps: 30,
        cfg: 4.5,
        denoise: 0.85,
        scheduler: 'normal',
        nestedGraph: { shouldNotPersist: true },
      },
      samplerStages: Array.from({ length: 40 }, (_, index) => ({
        nodeId: String(index),
        sampler: 'euler',
        steps: index + 1,
      })),
      sourceInputs: [
        { name: 'start.png', kind: 'image', nodeId: '90' },
        { name: 'motion.mp4', kind: 'video', nodeId: '91' },
      ],
      diagnostics: [
        pollutedRecord,
        { code: 'UNKNOWN_NODE', message: 'Custom prompt node was unresolved' },
      ],
      extractionStatus: 'partial',
      quality: 'partial',
    });

    expect({}.polluted).toBeUndefined();
    expect(metadata).toMatchObject({
      sourceKind: 'embedded',
      sourceFormat: 'mp4-comment',
      sourceLabel: 'clip.mp4 · comment',
      sidecarPath: '',
      prompt: 'a city at dusk',
      positivePrompt: 'a city at dusk',
      negativePrompt: 'blur, artifacts',
      seed: '90071992547409931234',
      status: 'partial',
      extractionStatus: 'partial',
      quality: 'partial',
      confidence: 'partial',
      sampling: {
        steps: 30,
        cfg: 4.5,
        denoise: 0.85,
        scheduler: 'normal',
      },
      vaes: ['wan_vae.safetensors'],
      textEncoders: ['umt5_xxl.safetensors'],
      sourceInputs: [
        { name: 'start.png', kind: 'image' },
        { name: 'motion.mp4', kind: 'video' },
      ],
    });
    expect(metadata.mediaSize).toBe(clip.stats.size);
    expect(metadata.mediaMtimeMs).toBe(clip.stats.mtimeMs);
    expect(metadata.provenance).toEqual({ container: 'mp4' });
    expect(metadata.promptFragments.length).toBeGreaterThan(0);
    expect(metadata.promptFragments.length).toBeLessThanOrEqual(32);
    expect(metadata.promptFragments[0]).toMatchObject({
      composition: 'concat',
      confidence: 1,
      classType: 'CLIPTextEncode',
      field: 'text',
    });
    expect(Buffer.byteLength(JSON.stringify(metadata.promptFragments), 'utf8'))
      .toBeLessThanOrEqual(32 * 1024);
    expect(metadata.loras[0]).toEqual({
      name: 'detail.safetensors',
      appliedTo: ['model', 'clip'],
    });
    expect(metadata.loras[1]).toMatchObject({
      strengthModel: 0.8,
      strengthClip: 0.4,
      appliedTo: 'model',
    });
    expect(metadata.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'checkpoint', name: 'wan2.2.safetensors' }),
      expect.objectContaining({ type: 'vae', name: 'wan_vae.safetensors' }),
      expect.objectContaining({
        type: 'text-encoder',
        name: 'umt5_xxl.safetensors',
      }),
    ]));
    expect(metadata.samplerStages).toHaveLength(32);
    expect(metadata.diagnostics[0]).toEqual({ container: 'mp4' });
    expect(() => store.setGenerationMetadata(indexed.instance.id, {
      sourceKind: 'combined',
      sidecarPath: `${clip.filePath}.json`,
    })).toThrow(/unsupported generation source kind/i);
    expect({}.polluted).toBeUndefined();
  });

  it('retains cached generation fields on ordinary refresh and clears them on media change', async () => {
    const clip = createFile('cache/clip.mp4', 'first media identity');
    const [indexed] = await store.indexFiles({ rootPath, entries: [clip] });
    store.setGenerationMetadata(indexed.instance.id, {
      sourceKind: 'embedded',
      parserVersion: 2,
      prompt: 'first prompt',
    });

    await store.indexFiles({ rootPath, entries: [clip] });
    expect(store.getGenerationMetadata(indexed.instance.id)?.prompt).toBe(
      'first prompt'
    );

    fs.writeFileSync(clip.filePath, 'a changed and longer media identity');
    await store.indexFiles({
      rootPath,
      entries: [{ filePath: clip.filePath, stats: fs.statSync(clip.filePath) }],
    });
    expect(store.getGenerationMetadata(indexed.instance.id)).toBeNull();
  });

  it('additively migrates and preserves legacy sidecar generation rows', async () => {
    const clip = createFile('legacy/clip.mp4', 'legacy generation row');
    const indexed = await store.indexFile({ rootPath, ...clip });
    store.setGenerationMetadata(indexed.instance.id, {
      sidecarPath: `${clip.filePath}.json`,
      sidecarSize: 42,
      sidecarMtimeMs: 123,
      parserVersion: 1,
      prompt: 'legacy prompt',
      models: ['legacy-model'],
    });

    database.resetDatabase();
    const dbPath = path.join(tempDir, 'videoswarm-meta.db');
    const legacy = new BetterSqlite(dbPath);
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      ALTER TABLE instance_generation_metadata
        RENAME TO instance_generation_metadata_extended;
      CREATE TABLE instance_generation_metadata (
        instance_id INTEGER PRIMARY KEY,
        sidecar_path TEXT NOT NULL,
        sidecar_size INTEGER NOT NULL,
        sidecar_mtime_ms REAL NOT NULL,
        parser_version INTEGER NOT NULL,
        prompt TEXT,
        seed TEXT,
        models_json TEXT NOT NULL DEFAULT '[]',
        samplers_json TEXT NOT NULL DEFAULT '[]',
        source_images_json TEXT NOT NULL DEFAULT '[]',
        generation_run TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES file_instances(id) ON DELETE CASCADE
      );
      INSERT INTO instance_generation_metadata (
        instance_id, sidecar_path, sidecar_size, sidecar_mtime_ms,
        parser_version, prompt, seed, models_json, samplers_json,
        source_images_json, generation_run, updated_at
      )
      SELECT
        instance_id, sidecar_path, sidecar_size, sidecar_mtime_ms,
        parser_version, prompt, seed, models_json, samplers_json,
        source_images_json, generation_run, updated_at
      FROM instance_generation_metadata_extended;
      DROP TABLE instance_generation_metadata_extended;
    `);
    legacy.close();

    database.initMetadataStore({ getPath: () => tempDir }, tempDir);
    store = database.getMetadataStore();
    expect(store.getGenerationMetadata(indexed.instance.id)).toMatchObject({
      sourceKind: 'sidecar',
      sourceFormat: null,
      mediaSize: 0,
      mediaMtimeMs: 0,
      prompt: 'legacy prompt',
      models: ['legacy-model'],
      status: 'found',
      quality: 'partial',
      provenance: {},
      promptFragments: [],
      loras: [],
      assets: [],
      samplerStages: [],
      diagnostics: [],
    });

    database.resetDatabase();
    const migrated = new BetterSqlite(dbPath, { readonly: true });
    const columns = migrated
      .prepare('PRAGMA table_info(instance_generation_metadata)')
      .all()
      .map((column) => column.name);
    migrated.close();
    expect(columns).toEqual(expect.arrayContaining([
      'source_kind',
      'media_size',
      'provenance_json',
      'negative_prompt',
      'prompt_fragments_json',
      'loras_json',
      'assets_json',
      'sampling_json',
      'sampler_stages_json',
      'source_inputs_json',
      'diagnostics_json',
      'extraction_status',
      'quality',
    ]));
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
  it('reconciles rated content to reviewed and lets reset clear its rating', () => {
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
      database.resetDatabase();

      // Reproduce the contradictory state allowed by the previous release:
      // an explicit Unreviewed row masking a durable rating.
      const previous = new BetterSqlite(dbPath);
      previous.prepare(`
        UPDATE content_review SET state = 'unreviewed'
        WHERE fingerprint = 'legacy';
      `).run();
      previous.close();

      database.initMetadataStore({ getPath: () => tempDir }, tempDir);
      store = database.getMetadataStore();
      expect(store.getMetadataForFingerprints(['legacy']).legacy).toMatchObject({
        rating: 4,
        reviewState: 'reviewed',
      });
      store.setReviewState(['legacy'], 'unreviewed');
      expect(store.getMetadataForFingerprints(['legacy']).legacy).toMatchObject({
        rating: null,
        reviewState: 'unreviewed',
      });
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
