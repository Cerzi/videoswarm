const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { BoundedAsyncCache } = require('./bounded-async-cache');
const { computeFingerprint, isLegacyFingerprint } = require('./fingerprint');
const { createPeriodicEventLoopYielder } = require('./directory-scan-progress');
const {
  ACCEPTED_COPY_MAX_MEDIA,
  ACCEPTED_COPY_MAX_PATH_BYTES,
  ReviewExportError,
  assertReviewExportCoverage,
  normalizeReviewExportDirectory,
  normalizeReviewExportScope,
} = require('./review-export-scope');
const {
  REVIEW_VIEW_DEFINITION_BYTE_LIMIT,
  normalizeReviewViewDefinition,
} = require('./review-view-definition');
const {
  REVIEW_CHECKPOINT_LIMIT,
  ReviewCheckpointError,
  normalizeCheckpointAnchorId,
  normalizeCheckpointDirectory,
  normalizeCheckpointFingerprint,
  normalizeCheckpointScope,
  normalizeCheckpointView,
} = require('./review-checkpoint');
const profileManager = require('./profile-manager');

let dbInstance = null;
let metadataStoreInstance = null;
let currentProfilePath = null;

const DB_FILE_NAME = 'videoswarm-meta.db';
const DB_SIDE_FILES = ['-wal', '-shm', '-journal'];
const REVIEW_STATES = new Set(['unreviewed', 'reviewed', 'pick', 'reject']);
// Absences the user caused on purpose. Anything else stays unexplained and is
// reported as missing, which is the state worth drawing attention to.
const MISSING_REASONS = new Set(['trashed', 'moved']);
// A library view can span every root, so its bounds are its own rather than
// borrowed from the per-root cached grid.
const LIBRARY_TAG_VIEW_LIMITS = Object.freeze({
  maxTags: 16,
  maxRecords: 20_000,
  maxPathBytes: 16 * 1024 * 1024,
});
const SAVED_VIEW_LIMIT = 100;
const SAVED_VIEW_NAME_LIMIT = 80;
const FINGERPRINT_CACHE_MAX_ENTRIES = 4096;
const FINGERPRINT_CACHE_MAX_IN_FLIGHT = 64;
const DEFAULT_INDEX_CONCURRENCY = 1;
const GENERATION_METADATA_LIMITS = Object.freeze({
  sourceFormatBytes: 128,
  sourceLabelBytes: 512,
  promptBytes: 32 * 1024,
  promptFragmentBytes: 8 * 1024,
  scalarBytes: 2048,
  compactKeyBytes: 96,
  listEntries: 32,
  compactRecordKeys: 24,
  jsonBytes: 32 * 1024,
});
const GENERATION_SOURCE_KINDS = new Set([
  'embedded',
  'sidecar',
  'unknown',
]);
const GENERATION_EXTRACTION_STATUSES = new Set([
  'found',
  'partial',
  'unrecognized',
  'none',
  'unsupported',
]);
const GENERATION_QUALITIES = new Set(['exact', 'partial', 'unknown']);
let didWarnMalformedReviewCheckpoint = false;

function clampGenerationText(value, maxBytes) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const byteLimit = Math.max(0, Math.floor(Number(maxBytes) || 0));
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return text;
  let clipped = Buffer.from(text, 'utf8')
    .subarray(0, byteLimit)
    .toString('utf8');
  // A byte slice may end in the middle of a UTF-8 sequence. Node represents
  // that incomplete sequence with U+FFFD, which can itself exceed the byte
  // budget. Remove only replacement characters introduced at the cut edge.
  while (
    clipped.endsWith('\uFFFD') ||
    Buffer.byteLength(clipped, 'utf8') > byteLimit
  ) {
    clipped = clipped.slice(0, -1);
  }
  return clipped.trim() || null;
}

function normalizeGenerationEnum(value, allowed, fallback, label, strict = true) {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';
  if (!normalized) return fallback;
  if (allowed.has(normalized)) return normalized;
  if (strict) throw new TypeError(`Unsupported generation ${label}: ${value}`);
  return fallback;
}

function normalizeGenerationList(values) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  const result = [];
  for (const value of source) {
    const normalized = clampGenerationText(
      value,
      GENERATION_METADATA_LIMITS.scalarBytes
    );
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= GENERATION_METADATA_LIMITS.listEntries) break;
  }
  return result;
}

function normalizeCompactScalar(value) {
  if (typeof value === 'string') {
    return clampGenerationText(value, GENERATION_METADATA_LIMITS.scalarBytes);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

function normalizeGenerationNumber(value, fallback = 0, { integer = false } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  if (!integer) return number;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(number));
}

function fitCompactJson(value, fallback) {
  const maxBytes = GENERATION_METADATA_LIMITS.jsonBytes;
  let candidate = value;
  let serialized = JSON.stringify(candidate);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return candidate;

  if (Array.isArray(candidate)) {
    candidate = [...candidate];
    while (candidate.length) {
      candidate.pop();
      serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return candidate;
    }
    return [];
  }

  if (candidate && typeof candidate === 'object') {
    const entries = Object.entries(candidate);
    while (entries.length) {
      entries.pop();
      candidate = Object.fromEntries(entries);
      serialized = JSON.stringify(candidate);
      if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return candidate;
    }
  }
  return fallback;
}

function normalizeCompactRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = Object.create(null);
  const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);
  const entries = Object.entries(value).slice(
    0,
    GENERATION_METADATA_LIMITS.compactRecordKeys
  );
  for (const [rawKey, rawValue] of entries) {
    const key = clampGenerationText(
      rawKey,
      GENERATION_METADATA_LIMITS.compactKeyBytes
    );
    if (
      !key ||
      forbiddenKeys.has(key) ||
      Object.prototype.hasOwnProperty.call(result, key)
    ) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      const list = rawValue
        .slice(0, GENERATION_METADATA_LIMITS.listEntries)
        .map(normalizeCompactScalar)
        .filter((entry) => entry !== null);
      if (list.length) result[key] = list;
      continue;
    }
    const scalar = normalizeCompactScalar(rawValue);
    if (scalar !== null) result[key] = scalar;
  }
  return fitCompactJson(Object.fromEntries(Object.entries(result)), {});
}

function normalizePromptFragments(values) {
  if (!Array.isArray(values)) return [];
  const fragments = [];
  for (const value of values) {
    if (fragments.length >= GENERATION_METADATA_LIMITS.listEntries) break;
    if (typeof value === 'string' || typeof value === 'number') {
      const text = clampGenerationText(
        value,
        GENERATION_METADATA_LIMITS.promptFragmentBytes
      );
      if (text) fragments.push({ text });
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const text = clampGenerationText(
      value.text ?? value.value,
      GENERATION_METADATA_LIMITS.promptFragmentBytes
    );
    if (!text) continue;
    const fragment = { text };
    const role = clampGenerationText(value.role, 32);
    const nodeId = clampGenerationText(value.nodeId, 256);
    const operation = clampGenerationText(value.operation, 128);
    const composition = clampGenerationText(value.composition, 128);
    const classType = clampGenerationText(value.classType, 256);
    const field = clampGenerationText(value.field, 128);
    if (role) fragment.role = role;
    if (nodeId) fragment.nodeId = nodeId;
    if (operation) fragment.operation = operation;
    if (composition) fragment.composition = composition;
    if (classType) fragment.classType = classType;
    if (field) fragment.field = field;
    const confidence = normalizeCompactScalar(value.confidence);
    if (confidence !== null) fragment.confidence = confidence;
    if (typeof value.resolved === 'boolean') fragment.resolved = value.resolved;
    fragments.push(fragment);
  }
  return fitCompactJson(fragments, []);
}

function normalizeLoras(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (result.length >= GENERATION_METADATA_LIMITS.listEntries) break;
    const source = typeof value === 'string' ? { name: value } : value;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const name = clampGenerationText(
      source.name ?? source.loraName,
      GENERATION_METADATA_LIMITS.scalarBytes
    );
    if (!name) continue;
    const nodeId = clampGenerationText(source.nodeId, 256);
    const identity = `${name}\u0000${nodeId || ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const entry = { name };
    const normalizeStrength = (input) => {
      if (input === null || input === undefined || input === '') return null;
      const number = Number(input);
      return Number.isFinite(number) ? number : null;
    };
    const strengthModel = normalizeStrength(
      source.strengthModel ?? source.modelStrength
    );
    const strengthClip = normalizeStrength(
      source.strengthClip ?? source.clipStrength
    );
    if (strengthModel !== null) entry.strengthModel = strengthModel;
    if (strengthClip !== null) entry.strengthClip = strengthClip;
    if (nodeId) entry.nodeId = nodeId;
    const sourceLabel = clampGenerationText(source.source, 128);
    if (sourceLabel) entry.source = sourceLabel;
    if (Array.isArray(source.appliedTo)) {
      const appliedTo = normalizeGenerationList(source.appliedTo);
      if (appliedTo.length) entry.appliedTo = appliedTo;
    } else {
      const appliedTo = clampGenerationText(source.appliedTo, 256);
      if (appliedTo) entry.appliedTo = appliedTo;
    }
    result.push(entry);
  }
  return fitCompactJson(result, []);
}

function normalizeAssets(values) {
  const sourceValues = [];
  if (Array.isArray(values)) {
    sourceValues.push(...values);
  } else if (values && typeof values === 'object') {
    const groups = [
      ['models', 'model', 'model'],
      ['checkpoints', 'model', 'checkpoint'],
      ['unets', 'model', 'unet'],
      ['vaes', 'vae', 'vae'],
      ['textEncoders', 'text-encoder', 'text-encoder'],
    ];
    for (const [key, category, fallbackType] of groups) {
      const entries = Array.isArray(values[key]) ? values[key] : [];
      entries.forEach((entry) => {
        sourceValues.push(
          entry && typeof entry === 'object'
            ? {
                ...entry,
                category,
                type: entry.type ?? entry.kind ?? fallbackType,
              }
            : { type: fallbackType, category, name: entry }
        );
      });
    }
  }

  const result = [];
  const seen = new Set();
  for (const value of sourceValues) {
    if (result.length >= GENERATION_METADATA_LIMITS.listEntries) break;
    const source = typeof value === 'string' ? { name: value } : value;
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const name = clampGenerationText(
      source.name ?? source.filename,
      GENERATION_METADATA_LIMITS.scalarBytes
    );
    if (!name) continue;
    const type = clampGenerationText(source.type ?? source.kind ?? 'other', 64);
    const nodeId = clampGenerationText(source.nodeId, 256);
    const identity = `${type || 'other'}\u0000${name}\u0000${nodeId || ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const entry = { type: type || 'other', name };
    const category = clampGenerationText(source.category, 64);
    if (category) entry.category = category;
    if (nodeId) entry.nodeId = nodeId;
    const role = clampGenerationText(source.role, 128);
    if (role) entry.role = role;
    result.push(entry);
  }
  return fitCompactJson(result, []);
}

function normalizeSourceInputs(values, fallbackNames = []) {
  const source = Array.isArray(values) && values.length
    ? values
    : fallbackNames;
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(source) ? source : []) {
    if (result.length >= GENERATION_METADATA_LIMITS.listEntries) break;
    const input = typeof value === 'string' ? { name: value } : value;
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const name = clampGenerationText(
      input.name ?? input.filename,
      GENERATION_METADATA_LIMITS.scalarBytes
    );
    if (!name) continue;
    const kind = clampGenerationText(input.kind ?? input.type ?? 'source', 64) ||
      'source';
    const identity = `${kind}\u0000${name}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({ name, kind });
  }
  return fitCompactJson(result, []);
}

function normalizeCompactRecordList(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    if (result.length >= GENERATION_METADATA_LIMITS.listEntries) break;
    const record = normalizeCompactRecord(value);
    if (Object.keys(record).length) result.push(record);
  }
  return fitCompactJson(result, []);
}

function normalizeDiagnostics(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    if (result.length >= GENERATION_METADATA_LIMITS.listEntries) break;
    if (typeof value === 'string') {
      const message = clampGenerationText(
        value,
        GENERATION_METADATA_LIMITS.scalarBytes
      );
      if (message) result.push({ message });
      continue;
    }
    const record = normalizeCompactRecord(value);
    if (Object.keys(record).length) result.push(record);
  }
  return fitCompactJson(result, []);
}

function parseGenerationJson(value, fallback) {
  try {
    const parsed = JSON.parse(value ?? JSON.stringify(fallback));
    return parsed;
  } catch {
    return fallback;
  }
}

function normalizeReviewState(value) {
  const state = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!REVIEW_STATES.has(state)) {
    throw new TypeError(`Unsupported review state: ${value}`);
  }
  return state;
}

function normalizeSavedViewDefinition(input) {
  return normalizeReviewViewDefinition(input, {
    includeScope: true,
    preserveInactiveRandomSeed: true,
  });
}

function isSqliteCorruptionError(error) {
  if (!error) return false;
  if (error.code === 'SQLITE_CORRUPT') {
    return true;
  }
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('malformed') ||
    message.includes('database disk image is malformed') ||
    message.includes('file is not a database') ||
    message.includes('file is encrypted or is not a database')
  );
}

function resolveBaseUserDataPath(app) {
  try {
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch (error) {
    console.warn('[database] Failed to resolve userData from app', error);
  }

  try {
    if (profileManager && typeof profileManager.getUserDataPath === 'function') {
      return profileManager.getUserDataPath();
    }
  } catch (error) {
    console.warn('[database] Failed to resolve userData from profile manager', error);
  }

  return null;
}

function archiveIfExists(filePath, suffix) {
  if (!filePath) {
    return false;
  }
  try {
    if (fs.existsSync(filePath)) {
      const target = `${filePath}${suffix}`;
      fs.renameSync(filePath, target);
      return true;
    }
  } catch (error) {
    console.warn(`[database] Failed to archive corrupt file ${filePath}`, error);
  }
  return false;
}

function copyIfExists(sourcePath, destinationPath) {
  if (!sourcePath || !destinationPath) {
    return false;
  }
  try {
    if (fs.existsSync(sourcePath)) {
      ensureDirectory(path.dirname(destinationPath));
      fs.copyFileSync(sourcePath, destinationPath);
      return true;
    }
  } catch (error) {
    console.warn(
      `[database] Failed to copy ${sourcePath} to ${destinationPath}`,
      error
    );
  }
  return false;
}

function tryRestoreFromBaseDatabase(app, profilePath) {
  const baseUserDataPath = resolveBaseUserDataPath(app);
  if (!baseUserDataPath) {
    return false;
  }

  const resolvedProfilePath = path.resolve(profilePath);
  const resolvedBasePath = path.resolve(baseUserDataPath);
  if (resolvedProfilePath === resolvedBasePath) {
    return false;
  }

  const baseDbPath = path.join(resolvedBasePath, DB_FILE_NAME);
  if (!fs.existsSync(baseDbPath)) {
    return false;
  }

  const targetDbPath = path.join(resolvedProfilePath, DB_FILE_NAME);
  const suffix = `.corrupt-${Date.now()}`;
  let restored = false;

  archiveIfExists(targetDbPath, suffix);
  DB_SIDE_FILES.forEach((sidecar) => {
    archiveIfExists(`${targetDbPath}${sidecar}`, suffix);
  });

  const copiedMain = copyIfExists(baseDbPath, targetDbPath);
  restored = restored || copiedMain;

  DB_SIDE_FILES.forEach((sidecar) => {
    const copied = copyIfExists(
      `${baseDbPath}${sidecar}`,
      `${targetDbPath}${sidecar}`
    );
    restored = restored || copied;
  });

  if (restored) {
    console.warn(
      '[database] Detected corrupt profile database – restored from base userData copy'
    );
  }

  return restored;
}

function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

function normalizeProfilePath(profilePath) {
  if (typeof profilePath === 'string') {
    const trimmed = profilePath.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function initDatabase(app, profilePath) {
  const normalized = normalizeProfilePath(profilePath);
  const resolvedProfilePath = normalized || app.getPath('userData');

  if (dbInstance && currentProfilePath === resolvedProfilePath) {
    return dbInstance;
  }

  if (dbInstance) {
    metadataStoreInstance?.dispose?.();
    metadataStoreInstance = null;
    try {
      dbInstance.close();
    } catch (error) {
      console.warn('[database] Failed to close existing instance', error);
    }
    dbInstance = null;
    currentProfilePath = null;
  }

  ensureDirectory(resolvedProfilePath);
  const dbPath = path.join(resolvedProfilePath, DB_FILE_NAME);

  function openDatabase() {
    const openedDatabase = new Database(dbPath);
    try {
      openedDatabase.pragma('journal_mode = WAL');
      openedDatabase.pragma('foreign_keys = ON');
      return openedDatabase;
    } catch (error) {
      try {
        openedDatabase.close();
      } catch (closeError) {
        console.warn(
          '[database] Failed to close database after initialization error',
          closeError
        );
      }
      throw error;
    }
  }

  let db;
  try {
    db = openDatabase();
  } catch (error) {
    if (db) {
      try {
        db.close();
      } catch (_) {
        // Ignore secondary errors when closing a corrupt handle
      }
      db = null;
    }

    if (isSqliteCorruptionError(error)) {
      const restored = tryRestoreFromBaseDatabase(app, resolvedProfilePath);
      if (restored) {
        db = openDatabase();
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      fingerprint TEXT PRIMARY KEY,
      last_known_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_ms INTEGER,
      updated_at INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      has_audio INTEGER,
      duration_ms REAL,
      frame_rate REAL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );

    CREATE TABLE IF NOT EXISTS file_tags (
      fingerprint TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (fingerprint, tag_id),
      FOREIGN KEY (fingerprint) REFERENCES files(fingerprint) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ratings (
      fingerprint TEXT PRIMARY KEY,
      value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 5),
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (fingerprint) REFERENCES files(fingerprint) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_files_path ON files(last_known_path);
    CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
  `);

  // Keep the original `files` table as a compatibility surface for the
  // metadata/tag APIs while introducing a durable content/instance catalog.
  // The migration is additive and transactional so existing profile databases
  // can be opened without rewriting or discarding their metadata.
  const migrateContentInstanceCatalog = db.transaction(() => {
    const legacyFileColumns = new Set(
      db
        .prepare('PRAGMA table_info(files);')
        .all()
        .map((row) => row.name)
    );
    if (!legacyFileColumns.has('width')) {
      db.exec('ALTER TABLE files ADD COLUMN width INTEGER;');
    }
    if (!legacyFileColumns.has('height')) {
      db.exec('ALTER TABLE files ADD COLUMN height INTEGER;');
    }
    if (!legacyFileColumns.has('has_audio')) {
      db.exec('ALTER TABLE files ADD COLUMN has_audio INTEGER;');
    }
    if (!legacyFileColumns.has('duration_ms')) {
      db.exec('ALTER TABLE files ADD COLUMN duration_ms REAL;');
    }
    if (!legacyFileColumns.has('frame_rate')) {
      db.exec('ALTER TABLE files ADD COLUMN frame_rate REAL;');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS library_roots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path TEXT NOT NULL UNIQUE,
        label TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        recursive INTEGER NOT NULL DEFAULT 1,
        refresh_state TEXT NOT NULL DEFAULT 'idle',
        last_scan_started_at INTEGER,
        last_scan_completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media_content (
        fingerprint TEXT PRIMARY KEY,
        size INTEGER NOT NULL DEFAULT 0,
        created_ms INTEGER,
        width INTEGER,
        height INTEGER,
        has_audio INTEGER,
        duration_ms REAL,
        frame_rate REAL,
        thumbnail_identity TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        parent_relative_path TEXT,
        name TEXT NOT NULL,
        is_present INTEGER NOT NULL DEFAULT 1,
        last_seen_at INTEGER,
        missing_since INTEGER,
        direct_instance_count INTEGER NOT NULL DEFAULT 0,
        direct_present_count INTEGER NOT NULL DEFAULT 0,
        direct_missing_count INTEGER NOT NULL DEFAULT 0,
        direct_removed_count INTEGER NOT NULL DEFAULT 0,
        direct_reviewed_count INTEGER NOT NULL DEFAULT 0,
        instance_count INTEGER NOT NULL DEFAULT 0,
        present_count INTEGER NOT NULL DEFAULT 0,
        missing_count INTEGER NOT NULL DEFAULT 0,
        removed_count INTEGER NOT NULL DEFAULT 0,
        reviewed_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        UNIQUE(root_id, relative_path),
        FOREIGN KEY (root_id) REFERENCES library_roots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS file_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id INTEGER NOT NULL,
        directory_id INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        absolute_path TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms REAL NOT NULL DEFAULT 0,
        fingerprint TEXT,
        is_present INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        missing_since INTEGER,
        missing_reason TEXT,
        UNIQUE(root_id, relative_path),
        FOREIGN KEY (root_id) REFERENCES library_roots(id) ON DELETE CASCADE,
        FOREIGN KEY (directory_id) REFERENCES directories(id) ON DELETE CASCADE,
        FOREIGN KEY (fingerprint) REFERENCES media_content(fingerprint) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS content_review (
        fingerprint TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (
          state IN ('unreviewed', 'reviewed', 'pick', 'reject')
        ),
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (fingerprint) REFERENCES media_content(fingerprint) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS saved_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        definition_json TEXT NOT NULL CHECK (
          length(CAST(definition_json AS BLOB)) <= 8192
        ),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_checkpoints (
        root_id INTEGER PRIMARY KEY,
        directory_relative_path TEXT NOT NULL DEFAULT '',
        scope_mode TEXT NOT NULL CHECK (
          scope_mode IN ('all-descendants', 'current-folder', 'current-subtree')
        ),
        view_json TEXT NOT NULL CHECK (
          length(CAST(view_json AS BLOB)) <= 8192
        ),
        anchor_instance_id INTEGER,
        anchor_fingerprint TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (root_id) REFERENCES library_roots(id) ON DELETE CASCADE,
        FOREIGN KEY (anchor_instance_id) REFERENCES file_instances(id)
          ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS instance_generation_metadata (
        instance_id INTEGER PRIMARY KEY,
        sidecar_path TEXT NOT NULL,
        sidecar_size INTEGER NOT NULL,
        sidecar_mtime_ms REAL NOT NULL,
        parser_version INTEGER NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'sidecar' CHECK (
          source_kind IN ('embedded', 'sidecar', 'unknown')
        ),
        source_format TEXT,
        source_label TEXT,
        media_size INTEGER NOT NULL DEFAULT 0,
        media_mtime_ms REAL NOT NULL DEFAULT 0,
        provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (
          length(CAST(provenance_json AS BLOB)) <= 32768
        ),
        prompt TEXT,
        negative_prompt TEXT,
        prompt_fragments_json TEXT NOT NULL DEFAULT '[]' CHECK (
          length(CAST(prompt_fragments_json AS BLOB)) <= 32768
        ),
        seed TEXT,
        models_json TEXT NOT NULL DEFAULT '[]',
        assets_json TEXT NOT NULL DEFAULT '[]' CHECK (
          length(CAST(assets_json AS BLOB)) <= 32768
        ),
        samplers_json TEXT NOT NULL DEFAULT '[]',
        loras_json TEXT NOT NULL DEFAULT '[]' CHECK (
          length(CAST(loras_json AS BLOB)) <= 32768
        ),
        sampling_json TEXT NOT NULL DEFAULT '{}' CHECK (
          length(CAST(sampling_json AS BLOB)) <= 32768
        ),
        sampler_stages_json TEXT NOT NULL DEFAULT '[]' CHECK (
          length(CAST(sampler_stages_json AS BLOB)) <= 32768
        ),
        source_images_json TEXT NOT NULL DEFAULT '[]',
        source_inputs_json TEXT NOT NULL DEFAULT '[]' CHECK (
          length(CAST(source_inputs_json AS BLOB)) <= 32768
        ),
        generation_run TEXT,
        diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK (
          length(CAST(diagnostics_json AS BLOB)) <= 32768
        ),
        extraction_status TEXT NOT NULL DEFAULT 'found' CHECK (
          extraction_status IN (
            'found', 'partial', 'unrecognized', 'none', 'unsupported'
          )
        ),
        quality TEXT NOT NULL DEFAULT 'partial' CHECK (
          quality IN ('exact', 'partial', 'unknown')
        ),
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES file_instances(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_library_roots_path
        ON library_roots(root_path);
      CREATE INDEX IF NOT EXISTS idx_directories_root_parent
        ON directories(root_id, parent_relative_path);
      CREATE INDEX IF NOT EXISTS idx_file_instances_absolute_path
        ON file_instances(absolute_path);
      CREATE INDEX IF NOT EXISTS idx_file_instances_root_presence
        ON file_instances(root_id, is_present);
      CREATE INDEX IF NOT EXISTS idx_file_instances_fingerprint
        ON file_instances(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_file_instances_reuse
        ON file_instances(root_id, relative_path, size, mtime_ms);
      CREATE INDEX IF NOT EXISTS idx_content_review_state
        ON content_review(state);
      CREATE INDEX IF NOT EXISTS idx_saved_views_updated
        ON saved_views(updated_at DESC, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_review_checkpoints_updated
        ON review_checkpoints(updated_at DESC, root_id DESC);
    `);

    const mediaContentColumns = new Set(
      db
        .prepare('PRAGMA table_info(media_content);')
        .all()
        .map((row) => row.name)
    );
    if (!mediaContentColumns.has('has_audio')) {
      db.exec('ALTER TABLE media_content ADD COLUMN has_audio INTEGER;');
    }
    if (!mediaContentColumns.has('duration_ms')) {
      db.exec('ALTER TABLE media_content ADD COLUMN duration_ms REAL;');
    }
    if (!mediaContentColumns.has('frame_rate')) {
      db.exec('ALTER TABLE media_content ADD COLUMN frame_rate REAL;');
    }

    const libraryRootColumns = new Set(
      db
        .prepare('PRAGMA table_info(library_roots);')
        .all()
        .map((row) => row.name)
    );
    if (!libraryRootColumns.has('is_pinned')) {
      db.exec(
        'ALTER TABLE library_roots ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;'
      );
    }

    const directoryColumns = new Set(
      db
        .prepare('PRAGMA table_info(directories);')
        .all()
        .map((row) => row.name)
    );
    if (!directoryColumns.has('is_present')) {
      db.exec(
        'ALTER TABLE directories ADD COLUMN is_present INTEGER NOT NULL DEFAULT 1;'
      );
    }
    if (!directoryColumns.has('last_seen_at')) {
      db.exec('ALTER TABLE directories ADD COLUMN last_seen_at INTEGER;');
    }
    if (!directoryColumns.has('missing_since')) {
      db.exec('ALTER TABLE directories ADD COLUMN missing_since INTEGER;');
    }
    // A file the user deliberately trashed or moved is absent for a known
    // reason. Counting it as "missing" alongside genuinely lost files reads as
    // accidental reference loss, so removals are aggregated separately. The
    // instance row itself is always retained: it is what keeps the content's
    // review state, rating, and tags reachable.
    if (!directoryColumns.has('direct_removed_count')) {
      db.exec(
        'ALTER TABLE directories ADD COLUMN direct_removed_count INTEGER NOT NULL DEFAULT 0;'
      );
    }
    if (!directoryColumns.has('removed_count')) {
      db.exec(
        'ALTER TABLE directories ADD COLUMN removed_count INTEGER NOT NULL DEFAULT 0;'
      );
    }

    const fileInstanceColumns = new Set(
      db
        .prepare('PRAGMA table_info(file_instances);')
        .all()
        .map((row) => row.name)
    );
    if (!fileInstanceColumns.has('missing_reason')) {
      db.exec('ALTER TABLE file_instances ADD COLUMN missing_reason TEXT;');
    }

    // Generation metadata began as a sidecar-only cache. Keep those columns
    // intact for existing profiles and callers, while extending each row with
    // compact source/provenance fields that can also describe metadata read
    // from the media container itself. Defaults intentionally describe legacy
    // rows as partial sidecar results; a zero media signature forces one
    // signature-aware refresh before newer extractors reuse them.
    const generationMetadataColumns = new Set(
      db
        .prepare('PRAGMA table_info(instance_generation_metadata);')
        .all()
        .map((row) => row.name)
    );
    const generationColumnMigrations = [
      [
        'source_kind',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'sidecar' CHECK (
           source_kind IN ('embedded', 'sidecar', 'unknown')
         );`,
      ],
      [
        'source_format',
        'ALTER TABLE instance_generation_metadata ADD COLUMN source_format TEXT;',
      ],
      [
        'source_label',
        'ALTER TABLE instance_generation_metadata ADD COLUMN source_label TEXT;',
      ],
      [
        'media_size',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN media_size INTEGER NOT NULL DEFAULT 0;`,
      ],
      [
        'media_mtime_ms',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN media_mtime_ms REAL NOT NULL DEFAULT 0;`,
      ],
      [
        'provenance_json',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}' CHECK (
           length(CAST(provenance_json AS BLOB)) <= 32768
         );`,
      ],
      [
        'negative_prompt',
        'ALTER TABLE instance_generation_metadata ADD COLUMN negative_prompt TEXT;',
      ],
      [
        'prompt_fragments_json',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN prompt_fragments_json TEXT NOT NULL DEFAULT '[]' CHECK (
           length(CAST(prompt_fragments_json AS BLOB)) <= 32768
         );`,
      ],
      [
        'loras_json',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN loras_json TEXT NOT NULL DEFAULT '[]' CHECK (
           length(CAST(loras_json AS BLOB)) <= 32768
         );`,
      ],
      [
        'assets_json',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN assets_json TEXT NOT NULL DEFAULT '[]' CHECK (
           length(CAST(assets_json AS BLOB)) <= 32768
         );`,
      ],
      [
        'sampling_json',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN sampling_json TEXT NOT NULL DEFAULT '{}' CHECK (
           length(CAST(sampling_json AS BLOB)) <= 32768
         );`,
      ],
      [
        'sampler_stages_json',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN sampler_stages_json TEXT NOT NULL DEFAULT '[]' CHECK (
           length(CAST(sampler_stages_json AS BLOB)) <= 32768
         );`,
      ],
      [
        'source_inputs_json',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN source_inputs_json TEXT NOT NULL DEFAULT '[]' CHECK (
           length(CAST(source_inputs_json AS BLOB)) <= 32768
         );`,
      ],
      [
        'diagnostics_json',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '[]' CHECK (
           length(CAST(diagnostics_json AS BLOB)) <= 32768
         );`,
      ],
      [
        'extraction_status',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'found' CHECK (
           extraction_status IN (
             'found', 'partial', 'unrecognized', 'none', 'unsupported'
           )
         );`,
      ],
      [
        'quality',
        `ALTER TABLE instance_generation_metadata
         ADD COLUMN quality TEXT NOT NULL DEFAULT 'partial' CHECK (
           quality IN ('exact', 'partial', 'unknown')
         );`,
      ],
    ];
    generationColumnMigrations.forEach(([column, statement]) => {
      if (!generationMetadataColumns.has(column)) db.exec(statement);
    });

    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO media_content (
        fingerprint, size, created_ms, width, height, duration_ms, frame_rate,
        created_at, updated_at
      )
      SELECT fingerprint, size, created_ms, width, height, duration_ms,
        frame_rate, ?, ?
      FROM files;
    `).run(now, now);

    // A rating is durable evidence that review occurred. Older builds allowed
    // an explicit `unreviewed` row to mask a rating, which made folder totals
    // and the broad Reviewed filter contradict the rating UI. Reconcile those
    // rows once and repair the persisted aggregates in the same transaction.
    db.prepare(`
      INSERT OR IGNORE INTO content_review (fingerprint, state, updated_at)
      SELECT fingerprint, 'reviewed', updated_at FROM ratings;
    `).run();
    const promotedRatedRows = db.prepare(`
      UPDATE content_review
      SET state = 'reviewed',
          updated_at = MAX(
            updated_at,
            COALESCE(
              (SELECT ratings.updated_at
               FROM ratings
               WHERE ratings.fingerprint = content_review.fingerprint),
              updated_at
            )
          )
      WHERE state = 'unreviewed'
        AND EXISTS (
          SELECT 1 FROM ratings
          WHERE ratings.fingerprint = content_review.fingerprint
        );
    `).run();
    if (promotedRatedRows.changes > 0) {
      db.prepare(`
        UPDATE directories
        SET direct_reviewed_count = (
              SELECT COUNT(*)
              FROM file_instances fi
              LEFT JOIN ratings r ON r.fingerprint = fi.fingerprint
              LEFT JOIN content_review cr ON cr.fingerprint = fi.fingerprint
              WHERE fi.directory_id = directories.id
                AND fi.is_present != 0
                AND COALESCE(
                  cr.state,
                  CASE WHEN r.fingerprint IS NULL
                    THEN 'unreviewed' ELSE 'reviewed' END
                ) != 'unreviewed'
            ),
            reviewed_count = (
              SELECT COUNT(*)
              FROM file_instances fi
              LEFT JOIN ratings r ON r.fingerprint = fi.fingerprint
              LEFT JOIN content_review cr ON cr.fingerprint = fi.fingerprint
              WHERE fi.root_id = directories.root_id
                AND fi.is_present != 0
                AND (
                  directories.relative_path = ''
                  OR substr(
                    fi.relative_path,
                    1,
                    length(directories.relative_path) + 1
                  ) = directories.relative_path || '/'
                )
                AND COALESCE(
                  cr.state,
                  CASE WHEN r.fingerprint IS NULL
                    THEN 'unreviewed' ELSE 'reviewed' END
                ) != 'unreviewed'
            ),
            updated_at = ?;
      `).run(now);
    }

    // A process can exit while a root is being scanned. On the next launch,
    // expose that state as interrupted rather than leaving the catalog looking
    // permanently busy.
    db.prepare(`
      UPDATE library_roots
      SET refresh_state = 'interrupted', updated_at = ?
      WHERE refresh_state = 'scanning';
    `).run(now);
  });

  migrateContentInstanceCatalog();

  dbInstance = db;
  currentProfilePath = resolvedProfilePath;
  return db;
}

function createMetadataStore(db) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(files);')
      .all()
      .map((row) => row.name)
  );

  if (!columns.has('width')) {
    try {
      db.exec('ALTER TABLE files ADD COLUMN width INTEGER;');
    } catch (error) {
      if (!/duplicate column/i.test(error?.message || '')) throw error;
    }
  }
  if (!columns.has('height')) {
    try {
      db.exec('ALTER TABLE files ADD COLUMN height INTEGER;');
    } catch (error) {
      if (!/duplicate column/i.test(error?.message || '')) throw error;
    }
  }
  if (!columns.has('has_audio')) {
    try {
      db.exec('ALTER TABLE files ADD COLUMN has_audio INTEGER;');
    } catch (error) {
      if (!/duplicate column/i.test(error?.message || '')) throw error;
    }
  }
  if (!columns.has('duration_ms')) {
    try {
      db.exec('ALTER TABLE files ADD COLUMN duration_ms REAL;');
    } catch (error) {
      if (!/duplicate column/i.test(error?.message || '')) throw error;
    }
  }
  if (!columns.has('frame_rate')) {
    try {
      db.exec('ALTER TABLE files ADD COLUMN frame_rate REAL;');
    } catch (error) {
      if (!/duplicate column/i.test(error?.message || '')) throw error;
    }
  }

  const fileUpsert = db.prepare(`
    INSERT INTO files (
      fingerprint, last_known_path, size, created_ms, updated_at, width, height,
      has_audio, duration_ms, frame_rate
    )
    VALUES (
      @fingerprint, @last_known_path, @size, @created_ms, @updated_at, @width,
      @height, @has_audio, @duration_ms, @frame_rate
    )
    ON CONFLICT(fingerprint) DO UPDATE SET
      last_known_path=excluded.last_known_path,
      size=excluded.size,
      created_ms=excluded.created_ms,
      updated_at=excluded.updated_at,
      width=COALESCE(excluded.width, files.width),
      height=COALESCE(excluded.height, files.height),
      has_audio=COALESCE(excluded.has_audio, files.has_audio),
      duration_ms=COALESCE(excluded.duration_ms, files.duration_ms),
      frame_rate=COALESCE(excluded.frame_rate, files.frame_rate);
  `);

  const mediaContentUpsert = db.prepare(`
    INSERT INTO media_content (
      fingerprint, size, created_ms, width, height, has_audio, duration_ms,
      frame_rate, created_at, updated_at
    )
    VALUES (
      @fingerprint, @size, @created_ms, @width, @height, @has_audio,
      @duration_ms, @frame_rate, @created_at, @updated_at
    )
    ON CONFLICT(fingerprint) DO UPDATE SET
      size=excluded.size,
      created_ms=COALESCE(media_content.created_ms, excluded.created_ms),
      width=COALESCE(excluded.width, media_content.width),
      height=COALESCE(excluded.height, media_content.height),
      has_audio=COALESCE(excluded.has_audio, media_content.has_audio),
      duration_ms=COALESCE(excluded.duration_ms, media_content.duration_ms),
      frame_rate=COALESCE(excluded.frame_rate, media_content.frame_rate),
      updated_at=excluded.updated_at;
  `);
  const mediaContentByFingerprint = db.prepare(`
    SELECT * FROM media_content WHERE fingerprint = ?;
  `);

  const rootInsert = db.prepare(`
    INSERT OR IGNORE INTO library_roots (
      root_path, label, is_pinned, recursive, refresh_state, last_scan_started_at,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `);
  const rootUpdate = db.prepare(`
    UPDATE library_roots
    SET label = ?, is_pinned = ?, recursive = ?, refresh_state = ?,
        last_scan_started_at = ?, updated_at = ?
    WHERE id = ?;
  `);
  const rootComplete = db.prepare(`
    UPDATE library_roots
    SET recursive = ?, refresh_state = 'idle',
        last_scan_completed_at = ?, updated_at = ?
    WHERE id = ?;
  `);
  const rootByPath = db.prepare(`
    SELECT * FROM library_roots WHERE root_path = ?;
  `);
  const rootById = db.prepare(`
    SELECT * FROM library_roots WHERE id = ?;
  `);
  const rootsList = db.prepare(`
    SELECT * FROM library_roots ORDER BY root_path COLLATE NOCASE;
  `);
  const rootPinUpdate = db.prepare(`
    UPDATE library_roots
    SET is_pinned = ?, updated_at = ?
    WHERE id = ?;
  `);

  const directoryUpsert = db.prepare(`
    INSERT INTO directories (
      root_id, relative_path, parent_relative_path, name, is_present,
      last_seen_at, missing_since, updated_at
    )
    VALUES (?, ?, ?, ?, 1, ?, NULL, ?)
    ON CONFLICT(root_id, relative_path) DO UPDATE SET
      parent_relative_path=excluded.parent_relative_path,
      name=excluded.name,
      is_present=1,
      last_seen_at=excluded.last_seen_at,
      missing_since=NULL,
      updated_at=excluded.updated_at;
  `);
  const directoryByPath = db.prepare(`
    SELECT * FROM directories WHERE root_id = ? AND relative_path = ?;
  `);
  const directoriesForRoot = db.prepare(`
    SELECT * FROM directories
    WHERE root_id = ?
    ORDER BY relative_path COLLATE NOCASE;
  `);
  const directoryCountsUpdate = db.prepare(`
    UPDATE directories
    SET direct_instance_count = @direct_instance_count,
        direct_present_count = @direct_present_count,
        direct_missing_count = @direct_missing_count,
        direct_removed_count = @direct_removed_count,
        direct_reviewed_count = @direct_reviewed_count,
        instance_count = @instance_count,
        present_count = @present_count,
        missing_count = @missing_count,
        removed_count = @removed_count,
        reviewed_count = @reviewed_count,
        updated_at = @updated_at
    WHERE id = @id;
  `);
  const markDirectoryMissingById = db.prepare(`
    UPDATE directories
    SET is_present = 0,
        missing_since = COALESCE(missing_since, ?),
        updated_at = ?
    WHERE id = ? AND relative_path != '' AND is_present != 0;
  `);

  const fileInstanceByRelativePath = db.prepare(`
    SELECT * FROM file_instances
    WHERE root_id = ? AND relative_path = ?;
  `);
  const fileInstanceById = db.prepare(`
    SELECT * FROM file_instances WHERE id = ?;
  `);
  const fileInstanceUpsert = db.prepare(`
    INSERT INTO file_instances (
      root_id, directory_id, relative_path, absolute_path, size, mtime_ms,
      fingerprint, is_present, first_seen_at, last_seen_at, missing_since
    )
    VALUES (
      @root_id, @directory_id, @relative_path, @absolute_path, @size,
      @mtime_ms, @fingerprint, 1, @first_seen_at, @last_seen_at, NULL
    )
    ON CONFLICT(root_id, relative_path) DO UPDATE SET
      directory_id=excluded.directory_id,
      absolute_path=excluded.absolute_path,
      size=excluded.size,
      mtime_ms=excluded.mtime_ms,
      fingerprint=excluded.fingerprint,
      is_present=1,
      last_seen_at=excluded.last_seen_at,
      missing_since=NULL;
  `);
  const fileInstancesForRoot = db.prepare(`
    SELECT fi.*,
      COALESCE(cr.state,
        CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
      ) AS review_state,
      CASE WHEN COALESCE(cr.state,
        CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
      ) = 'unreviewed' THEN 0 ELSE 1 END AS reviewed
    FROM file_instances fi
    LEFT JOIN ratings r ON r.fingerprint = fi.fingerprint
    LEFT JOIN content_review cr ON cr.fingerprint = fi.fingerprint
    WHERE fi.root_id = ?
    ORDER BY fi.relative_path COLLATE NOCASE;
  `);
  // Folder revisits must not rebuild renderer records with one metadata query
  // per file. These statements hydrate either the complete serializable
  // snapshot or a bounded first-grid preview with a fixed number of reads.
  const cachedFileInstancesForRoot = db.prepare(`
    SELECT fi.*,
      mc.created_ms AS content_created_ms,
      mc.width AS content_width,
      mc.height AS content_height,
      mc.has_audio AS content_has_audio,
      mc.duration_ms AS content_duration_ms,
      mc.frame_rate AS content_frame_rate,
      r.value AS rating_value,
      COALESCE(cr.state,
        CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
      ) AS review_state
    FROM file_instances fi
    LEFT JOIN media_content mc ON mc.fingerprint = fi.fingerprint
    LEFT JOIN ratings r ON r.fingerprint = fi.fingerprint
    LEFT JOIN content_review cr ON cr.fingerprint = fi.fingerprint
    WHERE fi.root_id = ?
      AND fi.is_present != 0
      AND (? != 0 OR instr(fi.relative_path, '/') = 0)
    ORDER BY fi.relative_path COLLATE NOCASE
    LIMIT ?;
  `);
  // The library-wide projection is deliberately the cached-grid projection with
  // the root predicate swapped for a tag join, so a clip looks identical however
  // it was reached. Directory presence is checked too: a retired directory's
  // instances must not reappear just because they carry a tag.
  const taggedInstancesAcrossRoots = db.prepare(`
    SELECT fi.*,
      lr.root_path AS owner_root_path,
      mc.created_ms AS content_created_ms,
      mc.width AS content_width,
      mc.height AS content_height,
      mc.has_audio AS content_has_audio,
      mc.duration_ms AS content_duration_ms,
      mc.frame_rate AS content_frame_rate,
      r.value AS rating_value,
      COALESCE(cr.state,
        CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
      ) AS review_state
    FROM file_instances fi
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    INNER JOIN directories d ON d.id = fi.directory_id
    LEFT JOIN media_content mc ON mc.fingerprint = fi.fingerprint
    LEFT JOIN ratings r ON r.fingerprint = fi.fingerprint
    LEFT JOIN content_review cr ON cr.fingerprint = fi.fingerprint
    WHERE fi.is_present != 0
      AND d.is_present != 0
      AND fi.fingerprint IS NOT NULL
      -- tags.name is declared COLLATE NOCASE, so matching and DISTINCT are
      -- already case-insensitive without restating it here. Counting the
      -- distinct matches and requiring the full tag count is what makes a
      -- multi-tag view an intersection rather than a union.
      AND (
        SELECT COUNT(DISTINCT t.name)
        FROM file_tags ft
        INNER JOIN tags t ON t.id = ft.tag_id
        WHERE ft.fingerprint = fi.fingerprint
          AND t.name IN (SELECT value FROM json_each(@tag_names))
      ) = @tag_count
    ORDER BY lr.root_path COLLATE NOCASE, fi.relative_path COLLATE NOCASE
    LIMIT @limit;
  `);
  const cachedFileTagsForRoot = db.prepare(`
    SELECT DISTINCT fi.fingerprint, t.name
    FROM file_instances fi
    INNER JOIN file_tags ft ON ft.fingerprint = fi.fingerprint
    INNER JOIN tags t ON t.id = ft.tag_id
    WHERE fi.root_id = ?
      AND fi.is_present != 0
      AND (? != 0 OR instr(fi.relative_path, '/') = 0)
    ORDER BY fi.fingerprint, t.name COLLATE NOCASE;
  `);
  const cachedFileTagsForRootLimited = db.prepare(`
    SELECT DISTINCT limited.fingerprint, t.name
    FROM (
      SELECT fingerprint, relative_path
      FROM file_instances
      WHERE root_id = ?
        AND is_present != 0
        AND (? != 0 OR instr(relative_path, '/') = 0)
      ORDER BY relative_path COLLATE NOCASE
      LIMIT ?
    ) limited
    INNER JOIN file_tags ft ON ft.fingerprint = limited.fingerprint
    INNER JOIN tags t ON t.id = ft.tag_id
    ORDER BY limited.fingerprint, t.name COLLATE NOCASE;
  `);
  const cachedFileCountForRoot = db.prepare(`
    SELECT COUNT(*) AS record_count
    FROM file_instances
    WHERE root_id = ?
      AND is_present != 0
      AND (? != 0 OR instr(relative_path, '/') = 0);
  `);
  const acceptedExportScopePredicates = Object.freeze({
    'all-descendants': '1 = 1',
    'current-folder': 'd.relative_path = @directory',
    'current-subtree': `(
      @directory = ''
      OR d.relative_path = @directory
      OR substr(d.relative_path, 1, length(@directory) + 1) = @directory || '/'
    )`,
  });
  const acceptedExportRecordQueries = Object.fromEntries(
    Object.entries(acceptedExportScopePredicates).map(([scope, predicate]) => [
      scope,
      db.prepare(`
        SELECT fi.id, fi.absolute_path, fi.relative_path, fi.size,
          fi.mtime_ms, fi.fingerprint
        FROM file_instances fi
        INNER JOIN directories d ON d.id = fi.directory_id
        INNER JOIN content_review cr
          ON cr.fingerprint = fi.fingerprint AND cr.state = 'pick'
        WHERE fi.root_id = @root_id
          AND fi.is_present != 0
          AND d.is_present != 0
          AND ${predicate}
        ORDER BY fi.relative_path COLLATE BINARY, fi.id
        LIMIT @limit;
      `),
    ])
  );
  // Transfers driven by an explicit selection name rows, not paths. Resolving
  // those ids here keeps the renderer from asserting what a row contains: an id
  // that is unknown, absent, or outside the named root simply yields no row.
  const selectionExportRecordQuery = db.prepare(`
    SELECT fi.id, fi.absolute_path, fi.relative_path, fi.size,
      fi.mtime_ms, fi.fingerprint, lr.root_path AS owner_root_path
    FROM json_each(@instance_ids) requested
    INNER JOIN file_instances fi ON fi.id = requested.value
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    INNER JOIN directories d ON d.id = fi.directory_id
    WHERE fi.is_present != 0
      AND d.is_present != 0
    ORDER BY lr.root_path COLLATE NOCASE, fi.relative_path COLLATE BINARY, fi.id
    LIMIT @limit;
  `);
  const fileInstancesByAbsolutePath = db.prepare(`
    SELECT * FROM file_instances WHERE absolute_path = ?;
  `);
  const markInstanceMissingById = db.prepare(`
    UPDATE file_instances
    SET is_present = 0,
        missing_since = COALESCE(missing_since, @now),
        missing_reason = COALESCE(@reason, missing_reason)
    WHERE id = @id AND is_present != 0;
  `);
  // A watcher can observe the unlink before the action that caused it finishes
  // reporting. Recording the reason afterwards must still work, but it may only
  // explain an absence that has none - never relabel one.
  const explainInstanceRemovalById = db.prepare(`
    UPDATE file_instances
    SET missing_reason = @reason
    WHERE id = @id AND is_present = 0 AND missing_reason IS NULL;
  `);
  const presentInstancesForFingerprint = db.prepare(`
    SELECT root_id, relative_path FROM file_instances
    WHERE fingerprint = ? AND is_present != 0;
  `);
  const directoryReviewedCountsDelta = db.prepare(`
    UPDATE directories
    SET direct_reviewed_count = MAX(
          0,
          direct_reviewed_count + @direct_reviewed_delta
        ),
        reviewed_count = MAX(0, reviewed_count + @reviewed_delta),
        updated_at = @updated_at
    WHERE root_id = @root_id AND relative_path = @relative_path;
  `);

  const tagInsert = db.prepare(`
    INSERT INTO tags (name) VALUES (?)
    ON CONFLICT(name) DO NOTHING;
  `);

  const tagSelect = db.prepare(`SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE`);
  const tagUsage = db.prepare(`
    SELECT t.name AS name, COUNT(ft.fingerprint) AS usageCount
    FROM tags t
    LEFT JOIN file_tags ft ON ft.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.name COLLATE NOCASE;
  `);

  const fileSelect = db.prepare(
    'SELECT width, height, has_audio, duration_ms, frame_rate FROM files WHERE fingerprint = ?;'
  );

  const setDimensionsStmt = db.prepare(
    `UPDATE files
     SET width = ?, height = ?, has_audio = COALESCE(?, has_audio),
         duration_ms = COALESCE(?, duration_ms),
         frame_rate = COALESCE(?, frame_rate)
     WHERE fingerprint = ?;`
  );
  const setContentDimensionsStmt = db.prepare(
    `UPDATE media_content
     SET width = ?, height = ?, has_audio = COALESCE(?, has_audio),
         duration_ms = COALESCE(?, duration_ms),
         frame_rate = COALESCE(?, frame_rate), updated_at = ?
     WHERE fingerprint = ?;`
  );

  const tagsForFingerprint = db.prepare(`
    SELECT t.name AS name
    FROM tags t
    INNER JOIN file_tags ft ON ft.tag_id = t.id
    WHERE ft.fingerprint = ?
    ORDER BY t.name COLLATE NOCASE;
  `);

  const addTagLink = db.prepare(`
    INSERT INTO file_tags (fingerprint, tag_id, added_at)
    VALUES (?, ?, ?)
    ON CONFLICT(fingerprint, tag_id) DO NOTHING;
  `);

  const removeTagLink = db.prepare(`
    DELETE FROM file_tags WHERE fingerprint = ? AND tag_id = ?;
  `);

  const countTagUsage = db.prepare(
    "SELECT COUNT(*) AS count FROM file_tags WHERE tag_id = ?;"
  );

  const deleteTagById = db.prepare("DELETE FROM tags WHERE id = ?;");

  const getRating = db.prepare(`
    SELECT value FROM ratings WHERE fingerprint = ?;
  `);

  const setRatingStmt = db.prepare(`
    INSERT INTO ratings (fingerprint, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
  `);

  const deleteRatingStmt = db.prepare(`DELETE FROM ratings WHERE fingerprint = ?;`);

  // Fingerprint re-key statements. Foreign keys are enforced, and neither
  // `files` nor `media_content` declares ON UPDATE, so a parent key cannot be
  // rewritten in place while children reference it. Every move therefore
  // creates the destination parent, repoints children, and only then drops the
  // source parent. Metadata is merged rather than overwritten because two v1
  // rows (the same bytes copied at different times) legitimately collapse into
  // one v2 row.
  const rekeyMediaContent = db.prepare(`
    INSERT INTO media_content (
      fingerprint, size, created_ms, width, height, has_audio, duration_ms,
      frame_rate, created_at, updated_at
    )
    SELECT @to, size, created_ms, width, height, has_audio, duration_ms,
      frame_rate, created_at, updated_at
    FROM media_content WHERE fingerprint = @from
    ON CONFLICT(fingerprint) DO UPDATE SET
      created_ms=MIN(
        COALESCE(media_content.created_ms, excluded.created_ms),
        COALESCE(excluded.created_ms, media_content.created_ms)
      ),
      width=COALESCE(media_content.width, excluded.width),
      height=COALESCE(media_content.height, excluded.height),
      has_audio=COALESCE(media_content.has_audio, excluded.has_audio),
      duration_ms=COALESCE(media_content.duration_ms, excluded.duration_ms),
      frame_rate=COALESCE(media_content.frame_rate, excluded.frame_rate),
      updated_at=MAX(media_content.updated_at, excluded.updated_at);
  `);
  const rekeyFileRecord = db.prepare(`
    INSERT INTO files (
      fingerprint, last_known_path, size, created_ms, updated_at, width, height,
      has_audio, duration_ms, frame_rate
    )
    SELECT @to, last_known_path, size, created_ms, updated_at, width, height,
      has_audio, duration_ms, frame_rate
    FROM files WHERE fingerprint = @from
    ON CONFLICT(fingerprint) DO UPDATE SET
      last_known_path=CASE
        WHEN excluded.updated_at >= files.updated_at THEN excluded.last_known_path
        ELSE files.last_known_path
      END,
      width=COALESCE(files.width, excluded.width),
      height=COALESCE(files.height, excluded.height),
      has_audio=COALESCE(files.has_audio, excluded.has_audio),
      duration_ms=COALESCE(files.duration_ms, excluded.duration_ms),
      frame_rate=COALESCE(files.frame_rate, excluded.frame_rate),
      updated_at=MAX(files.updated_at, excluded.updated_at);
  `);
  const rekeyContentReview = db.prepare(`
    INSERT INTO content_review (fingerprint, state, updated_at)
    SELECT @to, state, updated_at FROM content_review WHERE fingerprint = @from
    ON CONFLICT(fingerprint) DO UPDATE SET
      -- Ties are resolved in favour of the row being merged in. Two decisions
      -- can share a millisecond, and "the later one processed wins" is both
      -- deterministic and the closest match to the user's last action.
      state=CASE
        WHEN excluded.updated_at >= content_review.updated_at THEN excluded.state
        ELSE content_review.state
      END,
      updated_at=MAX(content_review.updated_at, excluded.updated_at);
  `);
  const rekeyRating = db.prepare(`
    INSERT INTO ratings (fingerprint, value, updated_at)
    SELECT @to, value, updated_at FROM ratings WHERE fingerprint = @from
    ON CONFLICT(fingerprint) DO UPDATE SET
      value=CASE
        WHEN excluded.updated_at >= ratings.updated_at THEN excluded.value
        ELSE ratings.value
      END,
      updated_at=MAX(ratings.updated_at, excluded.updated_at);
  `);
  const rekeyTagLinks = db.prepare(`
    INSERT OR IGNORE INTO file_tags (fingerprint, tag_id, added_at)
    SELECT @to, tag_id, added_at FROM file_tags WHERE fingerprint = @from;
  `);
  const rekeyInstanceFingerprints = db.prepare(`
    UPDATE file_instances SET fingerprint = @to WHERE fingerprint = @from;
  `);
  const rekeyCheckpointAnchors = db.prepare(`
    UPDATE review_checkpoints
    SET anchor_fingerprint = @to
    WHERE anchor_fingerprint = @from;
  `);
  const deleteContentReviewStmt = db.prepare(
    'DELETE FROM content_review WHERE fingerprint = ?;'
  );
  const deleteTagLinksStmt = db.prepare(
    'DELETE FROM file_tags WHERE fingerprint = ?;'
  );
  const deleteMediaContentStmt = db.prepare(
    'DELETE FROM media_content WHERE fingerprint = ?;'
  );
  const deleteFileRecordStmt = db.prepare(
    'DELETE FROM files WHERE fingerprint = ?;'
  );
  const fileRecordByFingerprint = db.prepare(
    'SELECT fingerprint FROM files WHERE fingerprint = ?;'
  );

  const getReviewState = db.prepare(`
    SELECT state FROM content_review WHERE fingerprint = ?;
  `);
  const setReviewStateStmt = db.prepare(`
    INSERT INTO content_review (fingerprint, state, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      state=excluded.state,
      updated_at=excluded.updated_at;
  `);

  const savedViewCount = db.prepare(`SELECT COUNT(*) AS count FROM saved_views;`);
  const savedViewById = db.prepare(`SELECT * FROM saved_views WHERE id = ?;`);
  const savedViewsList = db.prepare(`
    SELECT * FROM saved_views ORDER BY name COLLATE NOCASE, id;
  `);
  const savedViewInsert = db.prepare(`
    INSERT INTO saved_views (name, definition_json, created_at, updated_at)
    VALUES (?, ?, ?, ?);
  `);
  const savedViewUpdate = db.prepare(`
    UPDATE saved_views
    SET name = ?, definition_json = ?, updated_at = ?
    WHERE id = ?;
  `);
  const savedViewDelete = db.prepare(`DELETE FROM saved_views WHERE id = ?;`);

  const reviewCheckpointCount = db.prepare(`
    SELECT COUNT(*) AS count FROM review_checkpoints;
  `);
  const reviewCheckpointByRootId = db.prepare(`
    SELECT
      cp.*,
      lr.root_path
    FROM review_checkpoints cp
    INNER JOIN library_roots lr ON lr.id = cp.root_id
    WHERE cp.root_id = ?;
  `);
  const reviewCheckpointSummaries = db.prepare(`
    SELECT
      cp.root_id,
      lr.root_path,
      cp.directory_relative_path,
      cp.scope_mode,
      cp.anchor_instance_id,
      cp.anchor_fingerprint,
      cp.updated_at
    FROM (
      SELECT
        root_id,
        directory_relative_path,
        scope_mode,
        view_json,
        anchor_instance_id,
        anchor_fingerprint,
        updated_at
      FROM review_checkpoints
      ORDER BY updated_at DESC, root_id DESC
      LIMIT ${REVIEW_CHECKPOINT_LIMIT}
    ) cp
    INNER JOIN library_roots lr ON lr.id = cp.root_id
    WHERE CASE
      WHEN json_valid(cp.view_json)
      THEN
        json_type(cp.view_json) = 'object' AND
        json_type(cp.view_json, '$.version') = 'integer' AND
        json_extract(cp.view_json, '$.version') = 1 AND
        (
          COALESCE(json_extract(cp.view_json, '$.sort.key'), 'name') != 'random' OR
          json_type(cp.view_json, '$.sort.randomSeed') IN ('integer', 'real')
        )
      ELSE 0
    END
    ORDER BY cp.updated_at DESC, cp.root_id DESC
    LIMIT ${REVIEW_CHECKPOINT_LIMIT};
  `);
  const malformedReviewCheckpointSummary = db.prepare(`
    SELECT cp.root_id
    FROM (
      SELECT root_id, view_json
      FROM review_checkpoints
      ORDER BY updated_at DESC, root_id DESC
      LIMIT ${REVIEW_CHECKPOINT_LIMIT}
    ) cp
    WHERE NOT CASE
      WHEN json_valid(cp.view_json)
      THEN
        json_type(cp.view_json) = 'object' AND
        json_type(cp.view_json, '$.version') = 'integer' AND
        json_extract(cp.view_json, '$.version') = 1 AND
        (
          COALESCE(json_extract(cp.view_json, '$.sort.key'), 'name') != 'random' OR
          json_type(cp.view_json, '$.sort.randomSeed') IN ('integer', 'real')
        )
      ELSE 0
    END
    LIMIT 1;
  `);
  const reviewCheckpointUpsert = db.prepare(`
    INSERT INTO review_checkpoints (
      root_id,
      directory_relative_path,
      scope_mode,
      view_json,
      anchor_instance_id,
      anchor_fingerprint,
      updated_at
    ) VALUES (
      @root_id,
      @directory_relative_path,
      @scope_mode,
      @view_json,
      @anchor_instance_id,
      @anchor_fingerprint,
      @updated_at
    )
    ON CONFLICT(root_id) DO UPDATE SET
      directory_relative_path=excluded.directory_relative_path,
      scope_mode=excluded.scope_mode,
      view_json=excluded.view_json,
      anchor_instance_id=excluded.anchor_instance_id,
      anchor_fingerprint=excluded.anchor_fingerprint,
      updated_at=excluded.updated_at;
  `);
  const reviewCheckpointEvictOldest = db.prepare(`
    DELETE FROM review_checkpoints
    WHERE root_id IN (
      SELECT root_id
      FROM review_checkpoints
      WHERE root_id != ?
      ORDER BY updated_at ASC, root_id ASC
      LIMIT ?
    );
  `);
  const reviewCheckpointDelete = db.prepare(`
    DELETE FROM review_checkpoints WHERE root_id = ?;
  `);
  const reviewCheckpointSaveTransaction = db.transaction((record) => {
    reviewCheckpointUpsert.run(record);
    const count = Number(reviewCheckpointCount.get()?.count || 0);
    const overflow = Math.max(0, count - REVIEW_CHECKPOINT_LIMIT);
    if (overflow > 0) {
      reviewCheckpointEvictOldest.run(record.root_id, overflow);
    }
  });

  const generationMetadataByInstance = db.prepare(`
    SELECT * FROM instance_generation_metadata WHERE instance_id = ?;
  `);
  const generationMetadataUpsert = db.prepare(`
    INSERT INTO instance_generation_metadata (
      instance_id, sidecar_path, sidecar_size, sidecar_mtime_ms,
      parser_version, source_kind, source_format, source_label,
      media_size, media_mtime_ms, provenance_json,
      prompt, negative_prompt, prompt_fragments_json, seed,
      models_json, assets_json, samplers_json, loras_json, sampling_json,
      sampler_stages_json,
      source_images_json, source_inputs_json, generation_run, diagnostics_json,
      extraction_status, quality, updated_at
    ) VALUES (
      @instance_id, @sidecar_path, @sidecar_size, @sidecar_mtime_ms,
      @parser_version, @source_kind, @source_format, @source_label,
      @media_size, @media_mtime_ms, @provenance_json,
      @prompt, @negative_prompt, @prompt_fragments_json, @seed,
      @models_json, @assets_json, @samplers_json, @loras_json, @sampling_json,
      @sampler_stages_json,
      @source_images_json, @source_inputs_json, @generation_run, @diagnostics_json,
      @extraction_status, @quality, @updated_at
    )
    ON CONFLICT(instance_id) DO UPDATE SET
      sidecar_path=excluded.sidecar_path,
      sidecar_size=excluded.sidecar_size,
      sidecar_mtime_ms=excluded.sidecar_mtime_ms,
      parser_version=excluded.parser_version,
      source_kind=excluded.source_kind,
      source_format=excluded.source_format,
      source_label=excluded.source_label,
      media_size=excluded.media_size,
      media_mtime_ms=excluded.media_mtime_ms,
      provenance_json=excluded.provenance_json,
      prompt=excluded.prompt,
      negative_prompt=excluded.negative_prompt,
      prompt_fragments_json=excluded.prompt_fragments_json,
      seed=excluded.seed,
      models_json=excluded.models_json,
      assets_json=excluded.assets_json,
      samplers_json=excluded.samplers_json,
      loras_json=excluded.loras_json,
      sampling_json=excluded.sampling_json,
      sampler_stages_json=excluded.sampler_stages_json,
      source_images_json=excluded.source_images_json,
      source_inputs_json=excluded.source_inputs_json,
      generation_run=excluded.generation_run,
      diagnostics_json=excluded.diagnostics_json,
      extraction_status=excluded.extraction_status,
      quality=excluded.quality,
      updated_at=excluded.updated_at;
  `);
  const generationMetadataDelete = db.prepare(`
    DELETE FROM instance_generation_metadata WHERE instance_id = ?;
  `);

  const fingerprintCache = new BoundedAsyncCache({
    maxEntries: FINGERPRINT_CACHE_MAX_ENTRIES,
    maxInFlight: FINGERPRINT_CACHE_MAX_IN_FLIGHT,
  });
  let disposed = false;

  function assertOperationActive(assertActive) {
    if (disposed) {
      const error = new Error('Metadata store is disposed');
      error.code = 'METADATA_STORE_DISPOSED';
      throw error;
    }
    if (typeof assertActive === 'function') {
      assertActive();
    }
  }

  function normalizeRootPath(rootPath) {
    if (typeof rootPath !== 'string' || !rootPath.trim()) {
      throw new TypeError('A non-empty library root path is required');
    }
    return path.resolve(rootPath.trim());
  }

  function normalizeCatalogRelativePath(relativePath) {
    const normalized = String(relativePath || '')
      .split(path.sep)
      .join('/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    return normalized === '.' ? '' : normalized;
  }

  function getCatalogLocation(rootPath, targetPath, { allowRoot = false } = {}) {
    const normalizedRoot = normalizeRootPath(rootPath);
    if (typeof targetPath !== 'string' || !targetPath.trim()) {
      throw new TypeError('A non-empty path is required');
    }

    const absolutePath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(normalizedRoot, targetPath);
    const nativeRelativePath = path.relative(normalizedRoot, absolutePath);
    const outsideRoot =
      path.isAbsolute(nativeRelativePath) ||
      nativeRelativePath === '..' ||
      nativeRelativePath.startsWith(`..${path.sep}`);
    if (outsideRoot || (!allowRoot && nativeRelativePath === '')) {
      throw new Error(`Path is outside the library root: ${targetPath}`);
    }

    return {
      rootPath: normalizedRoot,
      absolutePath,
      relativePath: normalizeCatalogRelativePath(nativeRelativePath),
    };
  }

  function getDirectoryRelativePath(fileRelativePath) {
    const directoryPath = path.posix.dirname(fileRelativePath);
    return directoryPath === '.' ? '' : directoryPath;
  }

  function getDirectoryAncestorPaths(directoryRelativePath) {
    const ancestors = [''];
    if (!directoryRelativePath) return ancestors;
    const parts = directoryRelativePath.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      ancestors.push(parts.slice(0, index).join('/'));
    }
    return ancestors;
  }

  function normalizeStatSize(stats) {
    const value = Number(stats?.size || 0);
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  }

  function normalizeStatMtime(stats) {
    const value = Number(stats?.mtimeMs || 0);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function mapRootRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      rootPath: row.root_path,
      label: row.label || null,
      pinned: Boolean(row.is_pinned),
      recursive: Boolean(row.recursive),
      refreshState: row.refresh_state,
      lastScanStartedAt: row.last_scan_started_at ?? null,
      lastScanCompletedAt: row.last_scan_completed_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function mapDirectoryRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      rootId: Number(row.root_id),
      relativePath: row.relative_path,
      parentRelativePath: row.parent_relative_path ?? null,
      name: row.name,
      present: Boolean(row.is_present),
      lastSeenAt: row.last_seen_at ?? null,
      missingSince: row.missing_since ?? null,
      directInstanceCount: Number(row.direct_instance_count || 0),
      directPresentCount: Number(row.direct_present_count || 0),
      directMissingCount: Number(row.direct_missing_count || 0),
      directRemovedCount: Number(row.direct_removed_count || 0),
      directReviewedCount: Number(row.direct_reviewed_count || 0),
      instanceCount: Number(row.instance_count || 0),
      presentCount: Number(row.present_count || 0),
      missingCount: Number(row.missing_count || 0),
      removedCount: Number(row.removed_count || 0),
      reviewedCount: Number(row.reviewed_count || 0),
      updatedAt: row.updated_at,
    };
  }

  function mapFileInstanceRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      rootId: Number(row.root_id),
      directoryId: Number(row.directory_id),
      relativePath: row.relative_path,
      absolutePath: row.absolute_path,
      size: Number(row.size || 0),
      mtimeMs: Number(row.mtime_ms || 0),
      fingerprint: row.fingerprint || null,
      present: Boolean(row.is_present),
      reviewState: REVIEW_STATES.has(row.review_state)
        ? row.review_state
        : 'unreviewed',
      reviewed: Boolean(row.reviewed),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      missingSince: row.missing_since ?? null,
      missingReason: MISSING_REASONS.has(row.missing_reason)
        ? row.missing_reason
        : null,
    };
  }

  function mapGenerationMetadataRow(row) {
    if (!row) return null;
    const sourceKind = normalizeGenerationEnum(
      row.source_kind,
      GENERATION_SOURCE_KINDS,
      'sidecar',
      'source kind',
      false
    );
    const extractionStatus = normalizeGenerationEnum(
      row.extraction_status,
      GENERATION_EXTRACTION_STATUSES,
      'found',
      'extraction status',
      false
    );
    const quality = normalizeGenerationEnum(
      row.quality,
      GENERATION_QUALITIES,
      'partial',
      'quality',
      false
    );
    const models = normalizeGenerationList(
      parseGenerationJson(row.models_json, [])
    );
    const samplers = normalizeGenerationList(
      parseGenerationJson(row.samplers_json, [])
    );
    const sourceImages = normalizeGenerationList(
      parseGenerationJson(row.source_images_json, [])
    );
    const sourceInputs = normalizeSourceInputs(
      parseGenerationJson(row.source_inputs_json, []),
      sourceImages
    );
    const provenance = normalizeCompactRecord(
      parseGenerationJson(row.provenance_json, {})
    );
    const promptFragments = normalizePromptFragments(
      parseGenerationJson(row.prompt_fragments_json, [])
    );
    const loras = normalizeLoras(parseGenerationJson(row.loras_json, []));
    const assets = normalizeAssets(parseGenerationJson(row.assets_json, []));
    const sampling = normalizeCompactRecord(
      parseGenerationJson(row.sampling_json, {})
    );
    const samplerStages = normalizeCompactRecordList(
      parseGenerationJson(row.sampler_stages_json, [])
    );
    const diagnostics = normalizeDiagnostics(
      parseGenerationJson(row.diagnostics_json, [])
    );
    const prompt = clampGenerationText(
      row.prompt,
      GENERATION_METADATA_LIMITS.promptBytes
    );
    const negativePrompt = clampGenerationText(
      row.negative_prompt,
      GENERATION_METADATA_LIMITS.promptBytes
    );
    const sidecarPath = typeof row.sidecar_path === 'string'
      ? row.sidecar_path
      : '';
    const sidecarSize = normalizeGenerationNumber(row.sidecar_size, 0, {
      integer: true,
    });
    const sidecarMtimeMs = normalizeGenerationNumber(row.sidecar_mtime_ms);
    const mediaSize = normalizeGenerationNumber(row.media_size, 0, {
      integer: true,
    });
    const mediaMtimeMs = normalizeGenerationNumber(row.media_mtime_ms);
    const sourceUsesSidecar = sourceKind === 'sidecar';
    return {
      instanceId: Number(row.instance_id),
      // These legacy fields remain internal cache-validation compatibility
      // surfaces. Main-process wire DTOs may omit the absolute path.
      sidecarPath,
      sidecarSize,
      sidecarMtimeMs,
      parserVersion: Number(row.parser_version || 0),
      sourceKind,
      sourceFormat: clampGenerationText(
        row.source_format,
        GENERATION_METADATA_LIMITS.sourceFormatBytes
      ),
      sourceLabel: clampGenerationText(
        row.source_label,
        GENERATION_METADATA_LIMITS.sourceLabelBytes
      ),
      sourcePath: sourceUsesSidecar && sidecarPath ? sidecarPath : null,
      sourceSize: sourceUsesSidecar ? sidecarSize : mediaSize,
      sourceMtimeMs: sourceUsesSidecar ? sidecarMtimeMs : mediaMtimeMs,
      mediaSize,
      mediaMtimeMs,
      provenance,
      prompt,
      positivePrompt: prompt,
      negativePrompt,
      promptFragments,
      seed: clampGenerationText(
        row.seed,
        GENERATION_METADATA_LIMITS.scalarBytes
      ),
      model: models[0] ?? null,
      models,
      assets,
      vaes: assets
        .filter((asset) =>
          asset.category?.toLowerCase() === 'vae' ||
          asset.type.toLowerCase() === 'vae'
        )
        .map((asset) => asset.name),
      textEncoders: assets
        .filter((asset) =>
          asset.category?.toLowerCase() === 'text-encoder' ||
          ['text-encoder', 'textencoder', 'clip'].includes(
            asset.type.toLowerCase()
          )
        )
        .map((asset) => asset.name),
      sampler: samplers[0] ?? null,
      samplers,
      loras,
      sampling,
      samplingParameters: sampling,
      samplerStages,
      scheduler: sampling.scheduler ?? null,
      steps: sampling.steps ?? null,
      cfg: sampling.cfg ?? null,
      denoise: sampling.denoise ?? null,
      sourceImage: sourceImages[0] ?? null,
      sourceImages,
      sourceInputs,
      generationRun: clampGenerationText(
        row.generation_run,
        GENERATION_METADATA_LIMITS.scalarBytes
      ),
      diagnostics,
      extractionStatus,
      status: extractionStatus,
      quality,
      confidence: quality,
      updatedAt: Number(row.updated_at || 0),
    };
  }

  function normalizeSavedViewId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new TypeError('A positive saved view id is required');
    }
    return id;
  }

  function normalizeSavedViewName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) throw new TypeError('Saved view name is required');
    if (name.length > SAVED_VIEW_NAME_LIMIT) {
      throw new RangeError(
        `Saved view name exceeds ${SAVED_VIEW_NAME_LIMIT} characters`
      );
    }
    return name;
  }

  function mapSavedViewRow(row) {
    if (!row) return null;
    try {
      return {
        id: Number(row.id),
        name: row.name,
        definition: normalizeSavedViewDefinition(JSON.parse(row.definition_json)),
        createdAt: Number(row.created_at || 0),
        updatedAt: Number(row.updated_at || 0),
      };
    } catch {
      return null;
    }
  }

  function warnMalformedReviewCheckpoint(error, row = null) {
    if (didWarnMalformedReviewCheckpoint) return;
    didWarnMalformedReviewCheckpoint = true;
    console.warn('[database] Skipping malformed review checkpoint', {
      rootId: Number(row?.root_id) || null,
      message: error?.message || String(error),
    });
  }

  function normalizeCheckpointUpdatedAt(value) {
    const updatedAt = Number(value);
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      throw new ReviewCheckpointError(
        'Review checkpoint timestamp is invalid',
        'INVALID_REVIEW_CHECKPOINT_ROW'
      );
    }
    return updatedAt;
  }

  function mapReviewCheckpointSummary(row) {
    if (!row) return null;
    try {
      const rootPath = normalizeRootPath(row.root_path);
      // Anchors are deliberately omitted from the summary wire shape, but
      // still validate them here so an externally modified malformed row
      // cannot advertise a Continue action that get() will later reject.
      normalizeCheckpointAnchorId(row.anchor_instance_id);
      normalizeCheckpointFingerprint(row.anchor_fingerprint);
      return {
        rootPath,
        directory: normalizeCheckpointDirectory(row.directory_relative_path),
        scope: normalizeCheckpointScope(row.scope_mode),
        updatedAt: normalizeCheckpointUpdatedAt(row.updated_at),
      };
    } catch (error) {
      warnMalformedReviewCheckpoint(error, row);
      return null;
    }
  }

  function mapReviewCheckpointRow(row) {
    if (!row) return null;
    try {
      const summary = mapReviewCheckpointSummary(row);
      if (!summary) return null;
      const { normalized: view } = normalizeCheckpointView(
        JSON.parse(row.view_json)
      );
      return {
        ...summary,
        view,
        anchorInstanceId: normalizeCheckpointAnchorId(row.anchor_instance_id),
        anchorFingerprint: normalizeCheckpointFingerprint(
          row.anchor_fingerprint
        ),
      };
    } catch (error) {
      warnMalformedReviewCheckpoint(error, row);
      return null;
    }
  }

  function cacheKey(filePath, stats) {
    return `${filePath}::${stats.mtimeMs || 0}::${stats.size || 0}`;
  }

  async function ensureFingerprint(filePath, stats, assertActive) {
    assertOperationActive(assertActive);
    if (!stats) {
      stats = await fs.promises.stat(filePath);
      assertOperationActive(assertActive);
    }
    const key = cacheKey(filePath, stats);
    let result;
    try {
      result = await fingerprintCache.getOrCreate(key, () =>
        computeFingerprint(filePath, stats)
      );
    } catch (error) {
      // Profile/store invalidation is authoritative over the cache's internal
      // generation error and retains the public lifecycle error code.
      assertOperationActive(assertActive);
      throw error;
    }
    assertOperationActive(assertActive);
    return {
      fingerprint: result.fingerprint,
      legacyFingerprint: result.legacyFingerprint,
      createdMs: result.createdMs,
    };
  }

  function clearFingerprintCache() {
    fingerprintCache.clear();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    fingerprintCache.dispose();
  }

  function getResourceSnapshot() {
    return {
      disposed,
      fingerprintCache: fingerprintCache.getSnapshot(),
    };
  }

  function normalizeDimension(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num);
  }

  function normalizeHasAudio(value) {
    if (value === true || value === 1) return 1;
    if (value === false || value === 0) return 0;
    return null;
  }

  function mapHasAudio(value) {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }

  function normalizeDurationMs(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 604_800_000
      ? number
      : null;
  }

  function normalizeFrameRate(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 1000
      ? number
      : null;
  }

  /**
   * Move every fingerprint-keyed row from one content identity to another.
   *
   * This exists for the v1 -> v2 content-digest migration, where the caller has
   * already proved the bytes are unchanged by recomputing the legacy digest.
   * It is deliberately merge-shaped: distinct v1 rows for the same bytes
   * collapse into one v2 row, so review state and ratings resolve by recency
   * and tags become a union rather than one side silently winning.
   *
   * Must be called inside a transaction; it performs several dependent writes.
   */
  function rekeyContentFingerprint(fromFingerprint, toFingerprint) {
    if (
      typeof fromFingerprint !== 'string' ||
      typeof toFingerprint !== 'string' ||
      !fromFingerprint ||
      !toFingerprint ||
      fromFingerprint === toFingerprint
    ) {
      return false;
    }
    // Nothing to carry across: let the ordinary index path create the row.
    if (!fileRecordByFingerprint.get(fromFingerprint)) return false;

    const parameters = { from: fromFingerprint, to: toFingerprint };
    rekeyMediaContent.run(parameters);
    rekeyFileRecord.run(parameters);
    rekeyContentReview.run(parameters);
    rekeyRating.run(parameters);
    rekeyTagLinks.run(parameters);
    rekeyInstanceFingerprints.run(parameters);
    rekeyCheckpointAnchors.run(parameters);
    // Children no longer reference the source, so dropping it cannot cascade
    // into the metadata that was just carried over.
    deleteContentReviewStmt.run(fromFingerprint);
    deleteRatingStmt.run(fromFingerprint);
    deleteTagLinksStmt.run(fromFingerprint);
    deleteMediaContentStmt.run(fromFingerprint);
    deleteFileRecordStmt.run(fromFingerprint);
    return true;
  }

  function writeFileRecord(
    fingerprint,
    filePath,
    stats,
    createdMsOverride,
    dimensions
  ) {
    const now = Date.now();
    const createdMs = createdMsOverride ?? Math.round(
      stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || 0
    );
    fileUpsert.run({
      fingerprint,
      last_known_path: filePath,
      size: Number(stats.size || 0),
      created_ms: createdMs,
      updated_at: now,
      width: normalizeDimension(dimensions?.width),
      height: normalizeDimension(dimensions?.height),
      has_audio: normalizeHasAudio(dimensions?.hasAudio),
      duration_ms: normalizeDurationMs(dimensions?.durationMs),
      frame_rate: normalizeFrameRate(dimensions?.frameRate),
    });
    mediaContentUpsert.run({
      fingerprint,
      size: Number(stats.size || 0),
      created_ms: createdMs,
      width: normalizeDimension(dimensions?.width),
      height: normalizeDimension(dimensions?.height),
      has_audio: normalizeHasAudio(dimensions?.hasAudio),
      duration_ms: normalizeDurationMs(dimensions?.durationMs),
      frame_rate: normalizeFrameRate(dimensions?.frameRate),
      created_at: now,
      updated_at: now,
    });
    return { createdMs, updatedAt: now };
  }

  function ensureDirectoryHierarchy(rootRow, relativeDirectoryPath, now = Date.now()) {
    const normalizedRelativePath = normalizeCatalogRelativePath(relativeDirectoryPath);
    const parts = normalizedRelativePath ? normalizedRelativePath.split('/') : [];
    const paths = [''];
    for (let index = 1; index <= parts.length; index += 1) {
      paths.push(parts.slice(0, index).join('/'));
    }

    let finalRow = null;
    paths.forEach((directoryPath) => {
      const parentRelativePath = directoryPath
        ? getDirectoryRelativePath(directoryPath)
        : null;
      const name = directoryPath
        ? path.posix.basename(directoryPath)
        : rootRow.label || path.basename(rootRow.root_path) || rootRow.root_path;
      directoryUpsert.run(
        rootRow.id,
        directoryPath,
        parentRelativePath,
        name,
        now,
        now
      );
      finalRow = directoryByPath.get(rootRow.id, directoryPath);
    });
    return finalRow;
  }

  function registerLibraryRoot(rootPath, options = {}) {
    const normalizedRoot = normalizeRootPath(rootPath);
    const now = Date.now();
    let row = rootByPath.get(normalizedRoot);
    const recursive = options.recursive === undefined
      ? row ? Boolean(row.recursive) : true
      : Boolean(options.recursive);
    const label = options.label === undefined
      ? row?.label || path.basename(normalizedRoot) || normalizedRoot
      : String(options.label || '').trim() || null;
    const pinned = options.pinned === undefined
      ? row ? Boolean(row.is_pinned) : false
      : Boolean(options.pinned);
    const refreshState = options.refreshState === undefined
      ? row?.refresh_state || 'idle'
      : String(options.refreshState || 'idle');
    const lastScanStartedAt = options.scanStartedAt === undefined
      ? refreshState === 'scanning'
        ? now
        : row?.last_scan_started_at ?? null
      : options.scanStartedAt;

    rootInsert.run(
      normalizedRoot,
      label,
      pinned ? 1 : 0,
      recursive ? 1 : 0,
      refreshState,
      lastScanStartedAt,
      now,
      now
    );
    row = rootByPath.get(normalizedRoot);
    rootUpdate.run(
      label,
      pinned ? 1 : 0,
      recursive ? 1 : 0,
      refreshState,
      lastScanStartedAt,
      now,
      row.id
    );
    row = rootByPath.get(normalizedRoot);
    ensureDirectoryHierarchy(row, '', now);
    return mapRootRow(row);
  }

  function mapLibraryRootSummary(row) {
    if (!row) return null;
    const directoryRows = directoriesForRoot.all(row.id);
    const rootDirectory = directoryRows.find(
      (directory) => directory.relative_path === ''
    );
    const presentDirectoryCount = directoryRows.reduce(
      (count, directory) => count + (Boolean(directory.is_present) ? 1 : 0),
      0
    );

    return {
      ...mapRootRow(row),
      directoryCount: presentDirectoryCount,
      subdirectoryCount: Math.max(0, presentDirectoryCount - 1),
      directInstanceCount: Number(rootDirectory?.direct_instance_count || 0),
      directPresentCount: Number(rootDirectory?.direct_present_count || 0),
      directMissingCount: Number(rootDirectory?.direct_missing_count || 0),
      directRemovedCount: Number(rootDirectory?.direct_removed_count || 0),
      directReviewedCount: Number(rootDirectory?.direct_reviewed_count || 0),
      instanceCount: Number(rootDirectory?.instance_count || 0),
      presentCount: Number(rootDirectory?.present_count || 0),
      missingCount: Number(rootDirectory?.missing_count || 0),
      removedCount: Number(rootDirectory?.removed_count || 0),
      reviewedCount: Number(rootDirectory?.reviewed_count || 0),
    };
  }

  function getLibraryRoot(rootPath) {
    const row = rootByPath.get(normalizeRootPath(rootPath));
    return mapLibraryRootSummary(row);
  }

  function getLibraryRoots() {
    return rootsList.all().map(mapRootRow);
  }

  function listLibraryRoots(options = {}) {
    const pinnedOnly = Boolean(options?.pinnedOnly);
    return rootsList
      .all()
      .filter((row) => !pinnedOnly || Boolean(row.is_pinned))
      .map(mapLibraryRootSummary);
  }

  function setLibraryRootPinned(rootPath, pinned) {
    const normalizedRoot = normalizeRootPath(rootPath);
    const row = rootByPath.get(normalizedRoot);
    if (!row) {
      throw new Error(`Library root has not been indexed: ${normalizedRoot}`);
    }
    rootPinUpdate.run(Boolean(pinned) ? 1 : 0, Date.now(), row.id);
    return mapLibraryRootSummary(rootById.get(row.id));
  }

  function registerDirectories(rootPath, directoryPaths = [], options = {}) {
    const root = registerLibraryRoot(rootPath, options);
    const rootRow = rootById.get(root.id);
    const inputs = Array.isArray(directoryPaths) ? directoryPaths : [];
    const registered = [];
    const txn = db.transaction(() => {
      const pathsToRegister = inputs.length > 0 ? inputs : [''];
      pathsToRegister.forEach((directoryPath) => {
        let relativePath = '';
        if (directoryPath) {
          relativePath = getCatalogLocation(root.rootPath, directoryPath, {
            allowRoot: true,
          }).relativePath;
        }
        const row = ensureDirectoryHierarchy(rootRow, relativePath);
        registered.push(mapDirectoryRow(row));
      });
    });
    txn();
    return registered;
  }

  function registerDirectory(rootPath, directoryPath = '', options = {}) {
    return registerDirectories(rootPath, [directoryPath], options).at(-1) || null;
  }

  function getReusableFingerprint({ rootPath, filePath, stats }) {
    if (!rootPath || !filePath || !stats) return null;
    const root = rootByPath.get(normalizeRootPath(rootPath));
    if (!root) return null;
    const location = getCatalogLocation(root.root_path, filePath);
    const instance = fileInstanceByRelativePath.get(root.id, location.relativePath);
    if (!instance?.fingerprint) return null;
    if (
      Number(instance.size) !== normalizeStatSize(stats) ||
      Number(instance.mtime_ms) !== normalizeStatMtime(stats)
    ) {
      return null;
    }
    return instance.fingerprint;
  }

  function writeFileInstance(rootRow, entry, now = Date.now()) {
    const directoryRelativePath = getDirectoryRelativePath(entry.relativePath);
    const directoryRow = ensureDirectoryHierarchy(
      rootRow,
      directoryRelativePath,
      now
    );
    const existingInstance = fileInstanceByRelativePath.get(
      rootRow.id,
      entry.relativePath
    );
    const nextSize = normalizeStatSize(entry.stats);
    const nextMtimeMs = normalizeStatMtime(entry.stats);
    const nextFingerprint = entry.fingerprint || null;
    const mediaIdentityChanged = Boolean(
      existingInstance &&
      (
        Number(existingInstance.size) !== nextSize ||
        Number(existingInstance.mtime_ms) !== nextMtimeMs ||
        (existingInstance.fingerprint || null) !== nextFingerprint
      )
    );
    fileInstanceUpsert.run({
      root_id: rootRow.id,
      directory_id: directoryRow.id,
      relative_path: entry.relativePath,
      absolute_path: entry.filePath,
      size: nextSize,
      mtime_ms: nextMtimeMs,
      fingerprint: nextFingerprint,
      first_seen_at: now,
      last_seen_at: now,
    });
    if (mediaIdentityChanged) {
      generationMetadataDelete.run(existingInstance.id);
    }
    return fileInstanceByRelativePath.get(rootRow.id, entry.relativePath);
  }

  function refreshDirectoryCountsByRootId(rootId) {
    const directoryRows = directoriesForRoot.all(rootId);
    const instanceRows = fileInstancesForRoot.all(rootId);
    const counts = new Map();

    directoryRows.forEach((row) => {
      counts.set(row.relative_path, {
        id: row.id,
        direct_instance_count: 0,
        direct_present_count: 0,
        direct_missing_count: 0,
        direct_removed_count: 0,
        direct_reviewed_count: 0,
        instance_count: 0,
        present_count: 0,
        missing_count: 0,
        removed_count: 0,
        reviewed_count: 0,
      });
    });

    instanceRows.forEach((instance) => {
      const directPath = getDirectoryRelativePath(instance.relative_path);
      const ancestors = getDirectoryAncestorPaths(directPath);
      const present = Boolean(instance.is_present);
      const reviewed = present && Boolean(instance.reviewed);
      // Deliberate removals are absent for a reason the user already knows
      // about, so they are counted apart from files that simply disappeared.
      const removed = !present && Boolean(instance.missing_reason);
      const missing = !present && !removed;

      ancestors.forEach((directoryPath) => {
        const value = counts.get(directoryPath);
        if (!value) return;
        value.instance_count += 1;
        value.present_count += present ? 1 : 0;
        value.missing_count += missing ? 1 : 0;
        value.removed_count += removed ? 1 : 0;
        value.reviewed_count += reviewed ? 1 : 0;
      });

      const direct = counts.get(directPath);
      if (direct) {
        direct.direct_instance_count += 1;
        direct.direct_present_count += present ? 1 : 0;
        direct.direct_missing_count += missing ? 1 : 0;
        direct.direct_removed_count += removed ? 1 : 0;
        direct.direct_reviewed_count += reviewed ? 1 : 0;
      }
    });

    const now = Date.now();
    const txn = db.transaction(() => {
      counts.forEach((value) => {
        directoryCountsUpdate.run({ ...value, updated_at: now });
      });
    });
    txn();
    return directoriesForRoot.all(rootId).map(mapDirectoryRow);
  }

  function getDirectorySummaries(rootPath) {
    const row = rootByPath.get(normalizeRootPath(rootPath));
    if (!row) return [];
    return directoriesForRoot.all(row.id).map(mapDirectoryRow);
  }

  function getLibraryTree(rootPath, options = {}) {
    const row = rootByPath.get(normalizeRootPath(rootPath));
    if (!row) {
      return { root: null, directories: [] };
    }
    const includeMissing = Boolean(options?.includeMissing);
    const directories = directoriesForRoot
      .all(row.id)
      .filter((directory) => includeMissing || Boolean(directory.is_present))
      .map(mapDirectoryRow);
    return {
      root: mapLibraryRootSummary(row),
      directories,
    };
  }

  function getFileInstances(rootPath, options = {}) {
    const row = rootByPath.get(normalizeRootPath(rootPath));
    if (!row) return [];
    const includeMissing = options.includeMissing !== false;
    return fileInstancesForRoot
      .all(row.id)
      .filter((instance) => includeMissing || Boolean(instance.is_present))
      .map(mapFileInstanceRow);
  }

  function getCachedLibrarySnapshot(rootPath, options = {}) {
    assertOperationActive(options.assertActive);
    const row = rootByPath.get(normalizeRootPath(rootPath));
    if (!row) return null;

    const recursive = options.recursive !== false;
    const recursiveFlag = recursive ? 1 : 0;
    const requestedLimit = options.limit;
    const recordLimit = requestedLimit === undefined || requestedLimit === null
      ? null
      : Number(requestedLimit);
    if (
      recordLimit !== null &&
      (!Number.isSafeInteger(recordLimit) || recordLimit < 1 || recordLimit > 256)
    ) {
      throw new RangeError('Cached snapshot limit must be between 1 and 256');
    }
    const tagsByFingerprint = new Map();
    const tagRows = recordLimit === null
      ? cachedFileTagsForRoot.all(row.id, recursiveFlag)
      : cachedFileTagsForRootLimited.all(
          row.id,
          recursiveFlag,
          recordLimit
        );
    tagRows.forEach((tagRow) => {
      const tags = tagsByFingerprint.get(tagRow.fingerprint) || [];
      tags.push(tagRow.name);
      tagsByFingerprint.set(tagRow.fingerprint, tags);
    });
    assertOperationActive(options.assertActive);

    const records = cachedFileInstancesForRoot
      .all(row.id, recursiveFlag, recordLimit ?? -1)
      .map((instance) => {
        const width = Number(instance.content_width || 0);
        const height = Number(instance.content_height || 0);
        const durationMs = normalizeDurationMs(instance.content_duration_ms);
        const frameRate = normalizeFrameRate(instance.content_frame_rate);
        const dimensions = width > 0 && height > 0
          ? {
              width,
              height,
              aspectRatio: width / height,
              ...(durationMs ? { durationMs } : {}),
              ...(frameRate ? { frameRate } : {}),
            }
          : null;
        return {
          instanceId: Number(instance.id),
          relativePath: instance.relative_path,
          absolutePath: instance.absolute_path,
          size: Number(instance.size || 0),
          mtimeMs: Number(instance.mtime_ms || 0),
          createdMs: Number(
            instance.content_created_ms || instance.mtime_ms || 0
          ),
          fingerprint: instance.fingerprint || null,
          tags: tagsByFingerprint.get(instance.fingerprint) || [],
          rating: instance.rating_value !== null &&
            instance.rating_value !== undefined &&
            Number.isFinite(Number(instance.rating_value))
            ? Number(instance.rating_value)
            : null,
          reviewState: REVIEW_STATES.has(instance.review_state)
            ? instance.review_state
            : 'unreviewed',
          dimensions,
          hasAudio: mapHasAudio(instance.content_has_audio),
        };
      });
    assertOperationActive(options.assertActive);

    return {
      root: mapLibraryRootSummary(row),
      directories: directoriesForRoot
        .all(row.id)
        .filter((directory) => Boolean(directory.is_present))
        .map(mapDirectoryRow),
      records,
      totalRecordCount: recordLimit === null
        ? records.length
        : Number(
            cachedFileCountForRoot.get(row.id, recursiveFlag)?.record_count || 0
          ),
    };
  }

  /**
   * Every present instance carrying all of the named tags, across every indexed
   * root in the profile.
   *
   * This is a point-in-time read, not a watched collection: watching every
   * contributing root at once is exactly the cost the bounded watcher design
   * avoids, and the cached-grid path already establishes that a SQLite-derived
   * collection is a snapshot. Records carry their owning root so the renderer
   * can group and authorize without a second lookup.
   */
  function getTaggedLibrarySnapshot(options = {}) {
    assertOperationActive(options.assertActive);
    const tagNames = [
      ...new Set(
        (Array.isArray(options.tagNames) ? options.tagNames : [])
          .map((tag) => (tag ?? '').toString().trim())
          .filter(Boolean)
          .map((tag) => tag.toLowerCase())
      ),
    ];
    // An empty tag set is not an error: it means "no tag constraint", and the
    // COUNT(...) = @tag_count predicate already matches every row at zero.
    if (tagNames.length > LIBRARY_TAG_VIEW_LIMITS.maxTags) {
      throw new RangeError(
        `A tag view is limited to ${LIBRARY_TAG_VIEW_LIMITS.maxTags} tags`
      );
    }

    const maxRecords = normalizeAcceptedExportReadLimit(
      options.maxRecords,
      LIBRARY_TAG_VIEW_LIMITS.maxRecords,
      'Tag view record limit'
    );
    const maxPathBytes = normalizeAcceptedExportReadLimit(
      options.maxPathBytes,
      LIBRARY_TAG_VIEW_LIMITS.maxPathBytes,
      'Tag view path-byte limit'
    );

    const rows = taggedInstancesAcrossRoots.all({
      tag_names: JSON.stringify(tagNames),
      tag_count: tagNames.length,
      limit: maxRecords + 1,
    });
    assertOperationActive(options.assertActive);
    // One row beyond the cap proves truncation without materializing the rest.
    const truncated = rows.length > maxRecords;
    const kept = truncated ? rows.slice(0, maxRecords) : rows;

    const tagsByFingerprint = new Map();
    let pathBytes = 0;
    const records = kept.map((instance, index) => {
      if ((index & 255) === 255) assertOperationActive(options.assertActive);
      pathBytes += Buffer.byteLength(String(instance.absolute_path || ''), 'utf8');
      if (pathBytes > maxPathBytes) {
        throw new RangeError('Tag view paths exceed the bounded query budget');
      }
      const width = Number(instance.content_width || 0);
      const height = Number(instance.content_height || 0);
      const durationMs = normalizeDurationMs(instance.content_duration_ms);
      const frameRate = normalizeFrameRate(instance.content_frame_rate);
      if (!tagsByFingerprint.has(instance.fingerprint)) {
        tagsByFingerprint.set(
          instance.fingerprint,
          tagsForFingerprint.all(instance.fingerprint).map((row) => row.name)
        );
      }
      return {
        instanceId: Number(instance.id),
        rootPath: instance.owner_root_path,
        relativePath: instance.relative_path,
        absolutePath: instance.absolute_path,
        size: Number(instance.size || 0),
        mtimeMs: Number(instance.mtime_ms || 0),
        createdMs: Number(instance.content_created_ms || instance.mtime_ms || 0),
        fingerprint: instance.fingerprint || null,
        tags: tagsByFingerprint.get(instance.fingerprint) || [],
        rating:
          instance.rating_value !== null &&
          instance.rating_value !== undefined &&
          Number.isFinite(Number(instance.rating_value))
            ? Number(instance.rating_value)
            : null,
        reviewState: REVIEW_STATES.has(instance.review_state)
          ? instance.review_state
          : 'unreviewed',
        dimensions:
          width > 0 && height > 0
            ? {
                width,
                height,
                aspectRatio: width / height,
                ...(durationMs ? { durationMs } : {}),
                ...(frameRate ? { frameRate } : {}),
              }
            : null,
        hasAudio: mapHasAudio(instance.content_has_audio),
      };
    });
    assertOperationActive(options.assertActive);

    return {
      tags: tagNames,
      records,
      // Reported rather than hidden: a silently clipped library reads as a
      // wrong answer instead of a bounded one.
      truncated,
      recordLimit: maxRecords,
      rootPaths: [...new Set(records.map((record) => record.rootPath))],
    };
  }

  function normalizeAcceptedExportReadLimit(value, hardLimit, label) {
    const candidate = value === undefined ? hardLimit : Number(value);
    if (
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > hardLimit
    ) {
      throw new RangeError(`${label} must be between 1 and ${hardLimit}`);
    }
    return candidate;
  }

  /**
   * Read only present Accepted file instances for one authoritative review
   * scope. Absolute paths remain inside the main process; the copy coordinator
   * reauthorizes and identity-checks each source before native work begins.
   * SQL LIMIT plus a byte budget prevent unexpectedly large catalogs or path
   * data from becoming an unbounded in-memory export plan.
   */
  function getAcceptedExportSnapshot(rootPath, options = {}) {
    assertOperationActive(options.assertActive);
    const normalizedRoot = normalizeRootPath(rootPath);
    const row = rootByPath.get(normalizedRoot);
    if (!row) {
      throw new ReviewExportError(
        `Library root has not been indexed: ${normalizedRoot}`,
        'REVIEW_EXPORT_ROOT_MISSING'
      );
    }

    const scope = normalizeReviewExportScope(options.scope);
    const directory = scope === 'all-descendants'
      ? ''
      : normalizeReviewExportDirectory(options.directory ?? '');
    const root = mapRootRow(row);
    assertReviewExportCoverage(root, directory, scope);

    if (scope !== 'all-descendants') {
      const directoryRow = directoryByPath.get(row.id, directory);
      if (!directoryRow || !Boolean(directoryRow.is_present)) {
        throw new ReviewExportError(
          'The selected review directory is not present in the completed index.',
          'REVIEW_EXPORT_DIRECTORY_NOT_INDEXED'
        );
      }
    }

    const maxRecords = normalizeAcceptedExportReadLimit(
      options.maxRecords,
      ACCEPTED_COPY_MAX_MEDIA,
      'Accepted copy media limit'
    );
    const maxPathBytes = normalizeAcceptedExportReadLimit(
      options.maxPathBytes,
      ACCEPTED_COPY_MAX_PATH_BYTES,
      'Accepted copy path-byte limit'
    );
    const records = collectExportRecords(
      acceptedExportRecordQueries[scope].iterate({
        root_id: row.id,
        directory,
        limit: maxRecords + 1,
      }),
      { maxRecords, maxPathBytes, assertActive: options.assertActive }
    );
    return { root, directory, scope, records };
  }

  /**
   * Snapshot an explicit set of file instances for transfer. Unlike the review
   * export this imposes no scope or coverage requirement, because the caller
   * has named exact rows rather than a region of the tree. Ids that no longer
   * resolve inside this root are reported as unavailable rather than failing
   * the whole request; the transfer already knows how to skip those.
   */
  function getSelectionExportSnapshot(options = {}) {
    assertOperationActive(options.assertActive);
    const requestedIds = [
      ...new Set(
        (Array.isArray(options.instanceIds) ? options.instanceIds : []).map(
          (value) => {
            const id = Number(value);
            if (!Number.isSafeInteger(id) || id <= 0) {
              throw new ReviewExportError(
                'Every selected instance id must be a positive integer',
                'SELECTION_EXPORT_INVALID_ID'
              );
            }
            return id;
          }
        )
      ),
    ];
    if (requestedIds.length === 0) {
      throw new ReviewExportError(
        'Select at least one clip to transfer',
        'SELECTION_EXPORT_EMPTY'
      );
    }

    const maxRecords = normalizeAcceptedExportReadLimit(
      options.maxRecords,
      ACCEPTED_COPY_MAX_MEDIA,
      'Selection transfer media limit'
    );
    const maxPathBytes = normalizeAcceptedExportReadLimit(
      options.maxPathBytes,
      ACCEPTED_COPY_MAX_PATH_BYTES,
      'Selection transfer path-byte limit'
    );
    if (requestedIds.length > maxRecords) {
      throw new ReviewExportError(
        `A transfer is limited to ${maxRecords.toLocaleString()} media files per operation`,
        'ACCEPTED_COPY_TOO_MANY_MEDIA'
      );
    }

    const records = collectExportRecords(
      selectionExportRecordQuery.iterate({
        instance_ids: JSON.stringify(requestedIds),
        limit: maxRecords + 1,
      }),
      { maxRecords, maxPathBytes, assertActive: options.assertActive }
    );
    return {
      directory: '',
      scope: 'all-descendants',
      records,
      requestedCount: requestedIds.length,
      unavailableCount: Math.max(0, requestedIds.length - records.length),
      // Every root the selection actually touches. The transfer authorizes and
      // containment-checks each of these rather than assuming one source root.
      rootPaths: [...new Set(records.map((record) => record.rootPath))],
    };
  }

  function collectExportRecords(
    iterator,
    { maxRecords, maxPathBytes, assertActive } = {}
  ) {
    const records = [];
    let pathBytes = 0;
    let recordCount = 0;

    for (const instance of iterator) {
      recordCount += 1;
      if (recordCount > maxRecords) {
        throw new ReviewExportError(
          `Copy Accepted is limited to ${maxRecords.toLocaleString()} media files per operation`,
          'ACCEPTED_COPY_TOO_MANY_MEDIA'
        );
      }
      if ((recordCount & 255) === 0) {
        assertOperationActive(assertActive);
      }

      const absolutePath = String(instance.absolute_path || '');
      const relativePath = String(instance.relative_path || '');
      pathBytes += Buffer.byteLength(absolutePath, 'utf8');
      pathBytes += Buffer.byteLength(relativePath, 'utf8');
      if (pathBytes > maxPathBytes) {
        throw new ReviewExportError(
          'Accepted copy paths exceed the bounded query budget.',
          'ACCEPTED_COPY_PATHS_TOO_LARGE'
        );
      }
      records.push({
        instanceId: Number(instance.id),
        rootPath: instance.owner_root_path || null,
        absolutePath,
        relativePath,
        fingerprint: instance.fingerprint || null,
        size: Number(instance.size || 0),
        mtimeMs: Number(instance.mtime_ms || 0),
      });
    }
    assertOperationActive(assertActive);
    return records;
  }

  function getFileInstanceById(instanceId) {
    const id = Number(instanceId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const row = fileInstanceById.get(id);
    if (!row) return null;
    const reviewState = row.fingerprint
      ? getReviewState.get(row.fingerprint)?.state ||
        (getRating.get(row.fingerprint) ? 'reviewed' : 'unreviewed')
      : 'unreviewed';
    return mapFileInstanceRow({
      ...row,
      review_state: reviewState,
      reviewed: reviewState === 'unreviewed' ? 0 : 1,
    });
  }

  function getGenerationMetadata(instanceId) {
    const instance = getFileInstanceById(instanceId);
    if (!instance) return null;
    return mapGenerationMetadataRow(
      generationMetadataByInstance.get(instance.id)
    );
  }

  function setGenerationMetadata(instanceId, metadata = {}) {
    const instance = getFileInstanceById(instanceId);
    if (!instance) throw new Error(`File instance does not exist: ${instanceId}`);
    const sourceKind = normalizeGenerationEnum(
      metadata.sourceKind,
      GENERATION_SOURCE_KINDS,
      'sidecar',
      'source kind'
    );
    const rawSidecarPath = typeof metadata.sidecarPath === 'string'
      ? metadata.sidecarPath.trim()
      : '';
    const sidecarPath = rawSidecarPath ? path.resolve(rawSidecarPath) : '';
    if (
      sourceKind === 'sidecar' &&
      !sidecarPath
    ) {
      throw new TypeError('Sidecar path is required');
    }
    const sidecarSize = normalizeGenerationNumber(metadata.sidecarSize, 0, {
      integer: true,
    });
    const sidecarMtimeMs = normalizeGenerationNumber(metadata.sidecarMtimeMs);
    const parserVersionInput = Number(metadata.parserVersion);
    const parserVersion = Number.isFinite(parserVersionInput)
      ? Math.max(1, Math.round(parserVersionInput))
      : 1;
    const mediaSize = normalizeGenerationNumber(
      metadata.mediaSize,
      normalizeGenerationNumber(instance.size, 0, { integer: true }),
      { integer: true }
    );
    const mediaMtimeMs = normalizeGenerationNumber(
      metadata.mediaMtimeMs,
      normalizeGenerationNumber(instance.mtimeMs)
    );
    const models = normalizeGenerationList(metadata.models || [metadata.model]);
    const samplers = normalizeGenerationList(
      metadata.samplers || [metadata.sampler]
    );
    const sourceInputs = normalizeSourceInputs(metadata.sourceInputs);
    const sourceImages = normalizeGenerationList([
      ...(Array.isArray(metadata.sourceImages)
        ? metadata.sourceImages
        : [metadata.sourceImage]),
      ...sourceInputs.map((entry) => entry.name),
    ]);
    const persistedSourceInputs = sourceInputs.length
      ? sourceInputs
      : normalizeSourceInputs([], sourceImages);
    const provenance = normalizeCompactRecord(metadata.provenance);
    const promptFragments = normalizePromptFragments(metadata.promptFragments);
    const loras = normalizeLoras(metadata.loras || [metadata.lora]);
    const explicitAssets = normalizeAssets(metadata.assets);
    const assetInputs = [
      ...explicitAssets,
      ...normalizeGenerationList(metadata.vaes || [metadata.vae])
        .map((name) => ({ type: 'vae', name })),
      ...normalizeGenerationList(
        metadata.textEncoders || [metadata.textEncoder]
      ).map((name) => ({ type: 'text-encoder', name })),
    ];
    if (!explicitAssets.some((asset) =>
      asset.category?.toLowerCase() === 'model' ||
      ['model', 'checkpoint', 'unet', 'diffusion-model'].includes(
        asset.type.toLowerCase()
      )
    )) {
      assetInputs.push(...models.map((name) => ({ type: 'model', name })));
    }
    const assets = normalizeAssets(assetInputs);
    const legacySampling = {
      steps: metadata.steps,
      cfg: metadata.cfg,
      denoise: metadata.denoise,
      scheduler: metadata.scheduler,
      sampler: metadata.sampler,
    };
    const sampling = normalizeCompactRecord(
      metadata.samplingParameters ||
      metadata.sampling ||
      metadata.parameters ||
      legacySampling
    );
    const samplerStages = normalizeCompactRecordList(metadata.samplerStages);
    const diagnostics = normalizeDiagnostics(
      metadata.diagnostics || metadata.warnings
    );
    const extractionStatus = normalizeGenerationEnum(
      metadata.extractionStatus ?? metadata.status,
      GENERATION_EXTRACTION_STATUSES,
      'found',
      'extraction status'
    );
    const quality = normalizeGenerationEnum(
      metadata.quality ?? metadata.confidence,
      GENERATION_QUALITIES,
      'partial',
      'quality'
    );
    const sourceFormat = clampGenerationText(
      metadata.sourceFormat ?? (sourceKind === 'sidecar' ? 'json' : null),
      GENERATION_METADATA_LIMITS.sourceFormatBytes
    );
    const defaultSourceLabel = sourceKind === 'sidecar'
      ? path.basename(sidecarPath)
      : path.basename(instance.absolutePath || instance.relativePath || '');
    const sourceLabel = clampGenerationText(
      metadata.sourceLabel ?? defaultSourceLabel,
      GENERATION_METADATA_LIMITS.sourceLabelBytes
    );
    generationMetadataUpsert.run({
      instance_id: instance.id,
      sidecar_path: sidecarPath,
      sidecar_size: sidecarSize,
      sidecar_mtime_ms: sidecarMtimeMs,
      parser_version: parserVersion,
      source_kind: sourceKind,
      source_format: sourceFormat,
      source_label: sourceLabel,
      media_size: mediaSize,
      media_mtime_ms: mediaMtimeMs,
      provenance_json: JSON.stringify(provenance),
      prompt: clampGenerationText(
        metadata.positivePrompt ?? metadata.prompt,
        GENERATION_METADATA_LIMITS.promptBytes
      ),
      negative_prompt: clampGenerationText(
        metadata.negativePrompt,
        GENERATION_METADATA_LIMITS.promptBytes
      ),
      prompt_fragments_json: JSON.stringify(promptFragments),
      seed: clampGenerationText(
        metadata.seed,
        GENERATION_METADATA_LIMITS.scalarBytes
      ),
      models_json: JSON.stringify(models),
      assets_json: JSON.stringify(assets),
      samplers_json: JSON.stringify(samplers),
      loras_json: JSON.stringify(loras),
      sampling_json: JSON.stringify(sampling),
      sampler_stages_json: JSON.stringify(samplerStages),
      source_images_json: JSON.stringify(sourceImages),
      source_inputs_json: JSON.stringify(persistedSourceInputs),
      generation_run: clampGenerationText(
        metadata.generationRun,
        GENERATION_METADATA_LIMITS.scalarBytes
      ),
      diagnostics_json: JSON.stringify(diagnostics),
      extraction_status: extractionStatus,
      quality,
      updated_at: Date.now(),
    });
    return getGenerationMetadata(instance.id);
  }

  function clearGenerationMetadata(instanceId) {
    const id = Number(instanceId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    return generationMetadataDelete.run(id).changes > 0;
  }

  function listSavedViews() {
    return savedViewsList.all().map(mapSavedViewRow).filter(Boolean);
  }

  function createSavedView(name, definition) {
    const safeName = normalizeSavedViewName(name);
    const safeDefinition = normalizeSavedViewDefinition(definition);
    const count = Number(savedViewCount.get()?.count || 0);
    if (count >= SAVED_VIEW_LIMIT) {
      throw new RangeError(`Saved view limit of ${SAVED_VIEW_LIMIT} reached`);
    }
    const serialized = JSON.stringify(safeDefinition);
    if (Buffer.byteLength(serialized, 'utf8') > REVIEW_VIEW_DEFINITION_BYTE_LIMIT) {
      throw new RangeError('Saved view definition is too large');
    }
    const now = Date.now();
    const result = savedViewInsert.run(safeName, serialized, now, now);
    return mapSavedViewRow(savedViewById.get(result.lastInsertRowid));
  }

  function updateSavedView(savedViewId, changes = {}) {
    const id = normalizeSavedViewId(savedViewId);
    const current = savedViewById.get(id);
    if (!current) throw new Error(`Saved view does not exist: ${id}`);
    const currentDefinition = JSON.parse(current.definition_json);
    const safeName = normalizeSavedViewName(
      changes.name === undefined ? current.name : changes.name
    );
    const safeDefinition = normalizeSavedViewDefinition(
      changes.definition === undefined ? currentDefinition : changes.definition
    );
    const serialized = JSON.stringify(safeDefinition);
    savedViewUpdate.run(safeName, serialized, Date.now(), id);
    return mapSavedViewRow(savedViewById.get(id));
  }

  function deleteSavedView(savedViewId) {
    const id = normalizeSavedViewId(savedViewId);
    return savedViewDelete.run(id).changes > 0;
  }

  function requireReviewCheckpointRoot(rootPath) {
    const normalizedRoot = normalizeRootPath(rootPath);
    const root = rootByPath.get(normalizedRoot);
    if (!root) {
      throw new ReviewCheckpointError(
        `Library root has not been indexed: ${normalizedRoot}`,
        'REVIEW_CHECKPOINT_ROOT_NOT_FOUND'
      );
    }
    return root;
  }

  function listReviewCheckpoints(options = {}) {
    assertOperationActive(options.assertActive);
    const malformed = malformedReviewCheckpointSummary.get();
    if (malformed) {
      warnMalformedReviewCheckpoint(
        new ReviewCheckpointError(
          'Checkpoint JSON is malformed or uses an unsupported version',
          'INVALID_REVIEW_CHECKPOINT_ROW'
        ),
        malformed
      );
    }
    const checkpoints = reviewCheckpointSummaries
      .all()
      .map(mapReviewCheckpointSummary)
      .filter(Boolean);
    assertOperationActive(options.assertActive);
    return checkpoints;
  }

  function getReviewCheckpoint(rootPath, options = {}) {
    assertOperationActive(options.assertActive);
    const root = requireReviewCheckpointRoot(rootPath);
    const checkpoint = mapReviewCheckpointRow(
      reviewCheckpointByRootId.get(root.id)
    );
    assertOperationActive(options.assertActive);
    return checkpoint;
  }

  function saveReviewCheckpoint(draft, options = {}) {
    assertOperationActive(options.assertActive);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new ReviewCheckpointError(
        'Review checkpoint draft must be an object',
        'INVALID_REVIEW_CHECKPOINT'
      );
    }
    const root = requireReviewCheckpointRoot(draft.rootPath);
    const scope = normalizeCheckpointScope(draft.scope);
    const directory = scope === 'all-descendants'
      ? ''
      : normalizeCheckpointDirectory(draft.directory ?? '');
    const directoryRow = directoryByPath.get(root.id, directory);
    if (!directoryRow || !Boolean(directoryRow.is_present)) {
      throw new ReviewCheckpointError(
        'Review checkpoint directory is not present in the library index',
        'REVIEW_CHECKPOINT_DIRECTORY_NOT_FOUND'
      );
    }
    const { serialized: viewJson } = normalizeCheckpointView(draft.view);
    const anchorInstanceId = normalizeCheckpointAnchorId(
      draft.anchorInstanceId
    );
    let anchorFingerprint = normalizeCheckpointFingerprint(
      draft.anchorFingerprint
    );
    if (anchorInstanceId !== null) {
      const instance = fileInstanceById.get(anchorInstanceId);
      if (!instance || Number(instance.root_id) !== Number(root.id)) {
        throw new ReviewCheckpointError(
          'Review checkpoint anchor does not belong to the requested root',
          'REVIEW_CHECKPOINT_ANCHOR_NOT_FOUND'
        );
      }
      const instanceFingerprint = normalizeCheckpointFingerprint(
        instance.fingerprint
      );
      if (!instanceFingerprint) {
        throw new ReviewCheckpointError(
          'Review checkpoint anchor has no indexed fingerprint',
          'REVIEW_CHECKPOINT_ANCHOR_NOT_FOUND'
        );
      }
      if (
        anchorFingerprint !== null &&
        anchorFingerprint !== instanceFingerprint
      ) {
        throw new ReviewCheckpointError(
          'Review checkpoint anchor fingerprint does not match its instance',
          'REVIEW_CHECKPOINT_ANCHOR_MISMATCH'
        );
      }
      anchorFingerprint = instanceFingerprint;
    }

    const updatedAt = Date.now();
    reviewCheckpointSaveTransaction({
      root_id: root.id,
      directory_relative_path: directory,
      scope_mode: scope,
      view_json: viewJson,
      anchor_instance_id: anchorInstanceId,
      anchor_fingerprint: anchorFingerprint,
      updated_at: updatedAt,
    });
    assertOperationActive(options.assertActive);
    const checkpoint = mapReviewCheckpointRow(
      reviewCheckpointByRootId.get(root.id)
    );
    if (!checkpoint) {
      throw new ReviewCheckpointError(
        'Saved review checkpoint could not be read back',
        'REVIEW_CHECKPOINT_WRITE_FAILED'
      );
    }
    return checkpoint;
  }

  function clearReviewCheckpoint(rootPath, options = {}) {
    assertOperationActive(options.assertActive);
    const root = requireReviewCheckpointRoot(rootPath);
    const deleted = reviewCheckpointDelete.run(root.id).changes > 0;
    assertOperationActive(options.assertActive);
    return deleted;
  }

  function normalizeCatalogPathSet(rootPath, values, { directories = false } = {}) {
    const normalized = new Set();
    (Array.isArray(values) ? values : []).forEach((value) => {
      if (directories && (value === '' || value === '.')) {
        normalized.add('');
        return;
      }
      const location = getCatalogLocation(rootPath, value, {
        allowRoot: directories,
      });
      normalized.add(location.relativePath);
    });
    return normalized;
  }

  function reconcileLibraryRoot(
    rootPath,
    seenPaths = [],
    {
      recursive = true,
      scannedDirectories,
      completeCoverage,
      assertActive,
    } = {}
  ) {
    assertOperationActive(assertActive);
    const normalizedRoot = normalizeRootPath(rootPath);
    const root = registerLibraryRoot(normalizedRoot, { recursive });
    const rootRow = rootById.get(root.id);
    const seen = normalizeCatalogPathSet(normalizedRoot, seenPaths);
    const hasExplicitDirectoryScope = Array.isArray(scannedDirectories);
    const scanned = hasExplicitDirectoryScope
      ? normalizeCatalogPathSet(normalizedRoot, scannedDirectories, {
          directories: true,
        })
      : null;
    const coversWholeRoot = Boolean(recursive) && (
      completeCoverage === true ||
      (!hasExplicitDirectoryScope && completeCoverage !== false)
    );

    if (hasExplicitDirectoryScope) {
      registerDirectories(normalizedRoot, scannedDirectories, { recursive });
    }

    const instanceRows = fileInstancesForRoot.all(rootRow.id);
    const missingCandidates = instanceRows.filter((instance) => {
      const directDirectory = getDirectoryRelativePath(instance.relative_path);
      const directoryWasScanned = coversWholeRoot
        ? true
        : scanned
          ? scanned.has(directDirectory)
          : directDirectory === '';
      return directoryWasScanned && !seen.has(instance.relative_path);
    });
    const missingDirectoryCandidates = coversWholeRoot && scanned
      ? directoriesForRoot
          .all(rootRow.id)
          .filter(
            (directory) =>
              directory.relative_path !== '' &&
              Boolean(directory.is_present) &&
              !scanned.has(directory.relative_path)
          )
      : [];

    assertOperationActive(assertActive);
    const now = Date.now();
    let markedMissing = 0;
    let markedDirectoriesMissing = 0;
    const txn = db.transaction(() => {
      missingCandidates.forEach((instance) => {
        // Scan reconciliation cannot explain why a file vanished.
        markedMissing += markInstanceMissingById.run({
          now,
          id: instance.id,
          reason: null,
        }).changes;
      });
      missingDirectoryCandidates.forEach((directory) => {
        markedDirectoriesMissing += markDirectoryMissingById.run(
          now,
          now,
          directory.id
        ).changes;
      });
      rootComplete.run(recursive ? 1 : 0, now, now, rootRow.id);
    });
    txn();

    const directories = refreshDirectoryCountsByRootId(rootRow.id);
    return {
      root: mapRootRow(rootById.get(rootRow.id)),
      markedMissing,
      markedDirectoriesMissing,
      directories,
    };
  }

  function markFileMissing(
    filePath,
    {
      rootPath,
      assertActive,
      refreshDirectoryCounts: shouldRefreshDirectoryCounts = true,
    } = {}
  ) {
    if (!filePath) return { markedMissing: 0, instances: [] };
    assertOperationActive(assertActive);
    const absolutePath = path.resolve(filePath);
    let rows;
    if (rootPath) {
      const root = rootByPath.get(normalizeRootPath(rootPath));
      if (!root) return { markedMissing: 0, instances: [] };
      const location = getCatalogLocation(root.root_path, absolutePath);
      const row = fileInstanceByRelativePath.get(root.id, location.relativePath);
      rows = row ? [row] : [];
    } else {
      rows = fileInstancesByAbsolutePath.all(absolutePath);
    }

    assertOperationActive(assertActive);
    const now = Date.now();
    let markedMissing = 0;
    const affectedRootIds = new Set();
    db.transaction(() => {
      rows.forEach((row) => {
        // Watcher-observed removals arrive without a cause of their own.
        markedMissing += markInstanceMissingById.run({
          now,
          id: row.id,
          reason: null,
        }).changes;
        affectedRootIds.add(row.root_id);
      });
    })();
    if (shouldRefreshDirectoryCounts !== false) {
      affectedRootIds.forEach((rootId) => refreshDirectoryCountsByRootId(rootId));
    }

    const instances = rows.map((row) => {
      const updated = fileInstanceByRelativePath.get(row.root_id, row.relative_path);
      return mapFileInstanceRow(updated);
    });
    return { markedMissing, instances };
  }

  function normalizeMissingReason(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !MISSING_REASONS.has(value)) {
      throw new TypeError(
        `Missing reason must be one of: ${[...MISSING_REASONS].join(', ')}`
      );
    }
    return value;
  }

  function markFilesMissing(filePaths, { assertActive, reason = null } = {}) {
    assertOperationActive(assertActive);
    if (!Array.isArray(filePaths)) {
      throw new TypeError('File paths must be an array');
    }
    const normalizedReason = normalizeMissingReason(reason);
    const normalizedPaths = [...new Set(filePaths.map((filePath) => {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new TypeError('Every missing file path must be a non-empty string');
      }
      return path.resolve(filePath);
    }))];
    const rowsById = new Map();
    normalizedPaths.forEach((absolutePath, index) => {
      fileInstancesByAbsolutePath.all(absolutePath).forEach((row) => {
        // With a known cause, an instance the watcher already retired still
        // needs explaining, so absent rows are collected too.
        if (Boolean(row.is_present) || normalizedReason) {
          rowsById.set(Number(row.id), row);
        }
      });
      if ((index & 255) === 255) assertOperationActive(assertActive);
    });
    assertOperationActive(assertActive);

    const rows = [...rowsById.values()];
    const affectedRootIds = new Set();
    const now = Date.now();
    let markedMissing = 0;
    let explainedRemovals = 0;
    db.transaction(() => {
      rows.forEach((row) => {
        const changed = markInstanceMissingById.run({
          now,
          id: row.id,
          reason: normalizedReason,
        }).changes;
        markedMissing += changed;
        let explained = 0;
        if (changed === 0 && normalizedReason) {
          explained = explainInstanceRemovalById.run({
            id: row.id,
            reason: normalizedReason,
          }).changes;
          explainedRemovals += explained;
        }
        if (changed > 0 || explained > 0) {
          affectedRootIds.add(Number(row.root_id));
        }
      });
    })();

    // Aggregate each root once even when a native action affected many files
    // or overlapping indexed roots.
    affectedRootIds.forEach((rootId) => refreshDirectoryCountsByRootId(rootId));
    const instances = rows.map((row) => mapFileInstanceRow(
      fileInstanceByRelativePath.get(row.root_id, row.relative_path)
    ));
    return {
      markedMissing,
      explainedRemovals,
      affectedRootCount: affectedRootIds.size,
      instances,
    };
  }

  function refreshDirectoryCounts(rootPath) {
    const root = rootByPath.get(normalizeRootPath(rootPath));
    if (!root) return [];
    return refreshDirectoryCountsByRootId(root.id);
  }

  function getTagId(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return null;
    tagInsert.run(trimmed);
    const row = tagSelect.get(trimmed);
    return row ? row.id : null;
  }

  function mapMetadataRow(fingerprint) {
    const tags = tagsForFingerprint.all(fingerprint).map((row) => row.name);
    const ratingRow = getRating.get(fingerprint);
    const reviewRow = getReviewState.get(fingerprint);
    const dimRow = fileSelect.get(fingerprint);
    let dimensions = null;
    if (dimRow) {
      const width = Number(dimRow.width) || 0;
      const height = Number(dimRow.height) || 0;
      if (width > 0 && height > 0) {
        const durationMs = normalizeDurationMs(dimRow.duration_ms);
        const frameRate = normalizeFrameRate(dimRow.frame_rate);
        dimensions = {
          width,
          height,
          aspectRatio: width / height,
          ...(durationMs ? { durationMs } : {}),
          ...(frameRate ? { frameRate } : {}),
        };
      }
    }
    return {
      tags,
      rating: ratingRow ? ratingRow.value : null,
      reviewState: reviewRow?.state || (ratingRow ? 'reviewed' : 'unreviewed'),
      dimensions,
      hasAudio: mapHasAudio(dimRow?.has_audio),
    };
  }

  async function indexFiles({
    rootPath,
    entries = [],
    recursive = true,
    assertActive,
    onProgress,
    concurrency = DEFAULT_INDEX_CONCURRENCY,
  } = {}) {
    assertOperationActive(assertActive);
    const normalizedRoot = normalizeRootPath(rootPath);
    const root = registerLibraryRoot(normalizedRoot, { recursive });
    const rootRow = rootById.get(root.id);
    const preparedEntries = new Array(
      Array.isArray(entries) ? entries.length : 0
    );
    const sourceEntries = Array.isArray(entries) ? entries : [];
    let completedEntryCount = 0;
    let fingerprintsReused = 0;

    const notifyProgress = (filePath = null) => {
      if (typeof onProgress !== 'function') return;
      try {
        const notification = onProgress({
          indexedFiles: completedEntryCount,
          totalFiles: sourceEntries.length,
          fingerprintsReused,
          filePath,
        });
        notification?.catch?.(() => {});
      } catch {
        // Telemetry must never make catalog indexing fail.
      }
    };

    notifyProgress();

    const prepareEntry = async (input, index) => {
      assertOperationActive(assertActive);
      if (!input?.filePath) {
        throw new TypeError('Every indexed entry requires a filePath');
      }
      const location = getCatalogLocation(normalizedRoot, input.filePath);
      const safeStats = input.stats || (await fs.promises.stat(location.absolutePath));
      assertOperationActive(assertActive);
      const existingInstance = fileInstanceByRelativePath.get(
        rootRow.id,
        location.relativePath
      );
      const canReuse =
        existingInstance?.fingerprint &&
        Number(existingInstance.size) === normalizeStatSize(safeStats) &&
        Number(existingInstance.mtime_ms) === normalizeStatMtime(safeStats);

      let fingerprintResult;
      let reusedPersistedFingerprint = false;
      // A legacy row must be re-read once so its content digest can be
      // recomputed; reusing it would pin the file on v1 forever and keep its
      // metadata unreachable from copies. Everything else still short-circuits.
      if (canReuse && !isLegacyFingerprint(existingInstance.fingerprint)) {
        const content = mediaContentByFingerprint.get(existingInstance.fingerprint);
        if (content) {
          fingerprintResult = {
            fingerprint: existingInstance.fingerprint,
            createdMs: content.created_ms,
          };
          reusedPersistedFingerprint = true;
        }
      }
      if (!fingerprintResult) {
        fingerprintResult = await ensureFingerprint(
          location.absolutePath,
          safeStats,
          assertActive
        );
      }
      assertOperationActive(assertActive);

      const prepared = {
        filePath: location.absolutePath,
        relativePath: location.relativePath,
        stats: safeStats,
        dimensions: input.dimensions,
        fingerprint: fingerprintResult.fingerprint,
        createdMs: fingerprintResult.createdMs,
        fingerprintReused: reusedPersistedFingerprint,
        previousFingerprint: existingInstance?.fingerprint || null,
        legacyFingerprint: fingerprintResult.legacyFingerprint || null,
      };
      preparedEntries[index] = prepared;

      if (reusedPersistedFingerprint) {
        fingerprintsReused += 1;
      }
      completedEntryCount += 1;
      notifyProgress(location.relativePath);
    };

    const workerCount = Math.max(
      1,
      Math.min(
        sourceEntries.length || 1,
        Number.isFinite(Number(concurrency))
          ? Math.floor(Number(concurrency))
          : DEFAULT_INDEX_CONCURRENCY
      )
    );
    let nextEntryIndex = 0;
    const workers = Array.from({ length: workerCount }, async () => {
      const maybeYield = createPeriodicEventLoopYielder();
      while (true) {
        assertOperationActive(assertActive);
        const entryIndex = nextEntryIndex;
        nextEntryIndex += 1;
        if (entryIndex >= sourceEntries.length) return;
        await prepareEntry(sourceEntries[entryIndex], entryIndex);
        const pendingYield = maybeYield();
        if (pendingYield) {
          await pendingYield;
          assertOperationActive(assertActive);
        }
      }
    });
    await Promise.all(workers);

    // Fingerprinting and stat calls above are asynchronous. Re-check ownership
    // immediately before entering this synchronous transaction so stale scan
    // generations can never resume and write into a newly active profile.
    assertOperationActive(assertActive);
    const instanceRows = [];
    const txn = db.transaction(() => {
      preparedEntries.forEach((entry) => {
        // Carry v1 metadata forward only when the recomputed legacy digest
        // still matches what was stored. That equality is exact proof the
        // bytes are unchanged, so a genuinely edited file is never allowed to
        // inherit the previous content's review state, rating, or tags.
        if (
          entry.previousFingerprint &&
          entry.legacyFingerprint &&
          entry.previousFingerprint !== entry.fingerprint &&
          isLegacyFingerprint(entry.previousFingerprint) &&
          entry.previousFingerprint === entry.legacyFingerprint
        ) {
          rekeyContentFingerprint(entry.previousFingerprint, entry.fingerprint);
        }
        writeFileRecord(
          entry.fingerprint,
          entry.filePath,
          entry.stats,
          entry.createdMs,
          entry.dimensions
        );
        instanceRows.push(writeFileInstance(rootRow, entry));
      });
    });
    txn();

    const metadata = getMetadataForFingerprints(
      preparedEntries.map((entry) => entry.fingerprint)
    );
    return preparedEntries.map((entry, index) => ({
      filePath: entry.filePath,
      fingerprint: entry.fingerprint,
      ...(metadata[entry.fingerprint] || {
        tags: [],
        rating: null,
        reviewState: 'unreviewed',
        dimensions: null,
        hasAudio: null,
      }),
      fingerprintReused: entry.fingerprintReused,
      instance: mapFileInstanceRow(instanceRows[index]),
    }));
  }

  async function indexFile({
    filePath,
    stats,
    dimensions,
    rootPath,
    recursive = true,
    assertActive,
    refreshDirectoryCounts: shouldRefreshDirectoryCounts = true,
  } = {}) {
    if (!filePath) return null;
    if (rootPath) {
      const [result] = await indexFiles({
        rootPath,
        entries: [{ filePath, stats, dimensions }],
        recursive,
        assertActive,
      });
      if (shouldRefreshDirectoryCounts !== false) {
        refreshDirectoryCounts(rootPath);
      }
      return result || null;
    }

    assertOperationActive(assertActive);
    const absolutePath = path.resolve(filePath);
    const safeStats = stats || (await fs.promises.stat(absolutePath));
    assertOperationActive(assertActive);
    const { fingerprint, createdMs } = await ensureFingerprint(
      absolutePath,
      safeStats,
      assertActive
    );
    assertOperationActive(assertActive);
    db.transaction(() => {
      writeFileRecord(fingerprint, absolutePath, safeStats, createdMs, dimensions);
    })();
    return {
      fingerprint,
      ...mapMetadataRow(fingerprint),
    };
  }

  function getMetadataForFingerprints(fingerprints) {
    const uniqueFingerprints = [...new Set((fingerprints || []).filter(Boolean))];
    const result = {};
    const chunkSize = 400;

    for (let offset = 0; offset < uniqueFingerprints.length; offset += chunkSize) {
      const chunk = uniqueFingerprints.slice(offset, offset + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const metadataRows = db.prepare(`
        SELECT f.fingerprint, f.width, f.height, f.has_audio, f.duration_ms,
          f.frame_rate, r.value AS rating,
          COALESCE(cr.state,
            CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
          ) AS review_state
        FROM files f
        LEFT JOIN ratings r ON r.fingerprint = f.fingerprint
        LEFT JOIN content_review cr ON cr.fingerprint = f.fingerprint
        WHERE f.fingerprint IN (${placeholders});
      `).all(...chunk);

      metadataRows.forEach((row) => {
        const width = Number(row.width) || 0;
        const height = Number(row.height) || 0;
        const durationMs = normalizeDurationMs(row.duration_ms);
        const frameRate = normalizeFrameRate(row.frame_rate);
        result[row.fingerprint] = {
          tags: [],
          rating: row.rating ?? null,
          reviewState: REVIEW_STATES.has(row.review_state)
            ? row.review_state
            : 'unreviewed',
          dimensions: width > 0 && height > 0
            ? {
                width,
                height,
                aspectRatio: width / height,
                ...(durationMs ? { durationMs } : {}),
                ...(frameRate ? { frameRate } : {}),
              }
            : null,
          hasAudio: mapHasAudio(row.has_audio),
        };
      });

      const tagRows = db.prepare(`
        SELECT ft.fingerprint, t.name
        FROM file_tags ft
        INNER JOIN tags t ON t.id = ft.tag_id
        WHERE ft.fingerprint IN (${placeholders})
        ORDER BY t.name COLLATE NOCASE;
      `).all(...chunk);
      tagRows.forEach((row) => {
        if (result[row.fingerprint]) {
          result[row.fingerprint].tags.push(row.name);
        }
      });
    }

    return result;
  }

  function getDimensions(fingerprint) {
    if (!fingerprint) return null;
    const row = fileSelect.get(fingerprint);
    if (!row) return null;
    const width = Number(row.width) || 0;
    const height = Number(row.height) || 0;
    if (width > 0 && height > 0) {
      const durationMs = normalizeDurationMs(row.duration_ms);
      const frameRate = normalizeFrameRate(row.frame_rate);
      return {
        width,
        height,
        aspectRatio: width / height,
        ...(durationMs ? { durationMs } : {}),
        ...(frameRate ? { frameRate } : {}),
      };
    }
    return null;
  }

  function getHasAudio(fingerprint) {
    if (!fingerprint) return null;
    const row = fileSelect.get(fingerprint);
    return mapHasAudio(row?.has_audio);
  }

  function setDimensions(fingerprint, dimensions) {
    if (!fingerprint) return;
    const width = normalizeDimension(dimensions?.width);
    const height = normalizeDimension(dimensions?.height);
    if (!width || !height) return;
    const hasAudio = normalizeHasAudio(dimensions?.hasAudio);
    const durationMs = normalizeDurationMs(dimensions?.durationMs);
    const frameRate = normalizeFrameRate(dimensions?.frameRate);
    db.transaction(() => {
      setDimensionsStmt.run(
        width,
        height,
        hasAudio,
        durationMs,
        frameRate,
        fingerprint
      );
      setContentDimensionsStmt.run(
        width,
        height,
        hasAudio,
        durationMs,
        frameRate,
        Date.now(),
        fingerprint
      );
    })();
  }

  function listTags() {
    return tagUsage.all();
  }

  function assignTags(fingerprints, tagNames) {
    const now = Date.now();
    const applied = {};
    const txn = db.transaction(() => {
      fingerprints.forEach((fingerprint) => {
        if (!fingerprint) return;
        (tagNames || []).forEach((nameRaw) => {
          const id = getTagId(nameRaw);
          if (!id) return;
          addTagLink.run(fingerprint, id, now);
        });
        applied[fingerprint] = mapMetadataRow(fingerprint);
      });
    });
    txn();
    return applied;
  }

  function removeTag(fingerprints, tagName) {
    const name = (tagName || "").trim();
    if (!name) return {};
    const existing = tagSelect.get(name);
    if (!existing?.id) return {};
    const id = existing.id;
    const removed = {};
    const txn = db.transaction(() => {
      fingerprints.forEach((fingerprint) => {
        if (!fingerprint) return;
        removeTagLink.run(fingerprint, id);
        removed[fingerprint] = mapMetadataRow(fingerprint);
      });

      const usageRow = countTagUsage.get(id);
      const usageCount = Number(usageRow?.count || 0);
      if (usageCount === 0) {
        deleteTagById.run(id);
      }
    });
    txn();
    return removed;
  }

  function isFingerprintReviewed(fingerprint) {
    const explicitState = getReviewState.get(fingerprint)?.state;
    if (REVIEW_STATES.has(explicitState)) {
      return explicitState !== 'unreviewed';
    }
    return Boolean(getRating.get(fingerprint));
  }

  function addReviewedCountDeltasForFingerprint(
    fingerprint,
    reviewedDelta,
    deltasByRoot
  ) {
    if (!reviewedDelta) return;
    presentInstancesForFingerprint.all(fingerprint).forEach((instance) => {
      const rootId = Number(instance.root_id);
      let deltasByPath = deltasByRoot.get(rootId);
      if (!deltasByPath) {
        deltasByPath = new Map();
        deltasByRoot.set(rootId, deltasByPath);
      }
      const directPath = getDirectoryRelativePath(instance.relative_path);
      getDirectoryAncestorPaths(directPath).forEach((relativePath) => {
        const delta = deltasByPath.get(relativePath) || {
          directReviewedDelta: 0,
          reviewedDelta: 0,
        };
        delta.reviewedDelta += reviewedDelta;
        deltasByPath.set(relativePath, delta);
      });
      const directDelta = deltasByPath.get(directPath) || {
        directReviewedDelta: 0,
        reviewedDelta: 0,
      };
      directDelta.directReviewedDelta += reviewedDelta;
      deltasByPath.set(directPath, directDelta);
    });
  }

  function applyReviewedCountDeltas(deltasByRoot, updatedAt) {
    deltasByRoot.forEach((deltasByPath, rootId) => {
      deltasByPath.forEach((delta, relativePath) => {
        directoryReviewedCountsDelta.run({
          root_id: rootId,
          relative_path: relativePath,
          direct_reviewed_delta: delta.directReviewedDelta,
          reviewed_delta: delta.reviewedDelta,
          updated_at: updatedAt,
        });
      });
    });
  }

  function setRating(fingerprints, rating) {
    const updates = {};
    const now = Date.now();
    const uniqueFingerprints = [...new Set(
      (Array.isArray(fingerprints) ? fingerprints : []).filter(Boolean)
    )];
    const reviewedCountDeltas = new Map();
    const txn = db.transaction(() => {
      uniqueFingerprints.forEach((fingerprint) => {
        const wasReviewed = isFingerprintReviewed(fingerprint);
        if (rating === null || rating === undefined) {
          deleteRatingStmt.run(fingerprint);
        } else {
          const safeRating = Math.max(0, Math.min(5, Math.round(Number(rating))));
          setRatingStmt.run(fingerprint, safeRating, now);
          const currentReviewState = getReviewState.get(fingerprint)?.state;
          // Rating and review are separate fields, but a rating proves that
          // review occurred. Preserve explicit Accept/Reject decisions and
          // promote only missing or Unreviewed state.
          if (!currentReviewState || currentReviewState === 'unreviewed') {
            setReviewStateStmt.run(fingerprint, 'reviewed', now);
          }
        }
        const isReviewed = isFingerprintReviewed(fingerprint);
        addReviewedCountDeltasForFingerprint(
          fingerprint,
          Number(isReviewed) - Number(wasReviewed),
          reviewedCountDeltas
        );
        updates[fingerprint] = mapMetadataRow(fingerprint);
      });
      applyReviewedCountDeltas(reviewedCountDeltas, now);
    });
    txn();
    return updates;
  }

  function setReviewState(fingerprints, value) {
    const reviewState = normalizeReviewState(value);
    const uniqueFingerprints = [...new Set(
      (Array.isArray(fingerprints) ? fingerprints : []).filter(Boolean)
    )];
    const updates = {};
    const reviewedCountDeltas = new Map();
    const now = Date.now();
    db.transaction(() => {
      uniqueFingerprints.forEach((fingerprint) => {
        const wasReviewed = isFingerprintReviewed(fingerprint);
        if (reviewState === 'unreviewed') {
          // Tags are intentionally untouched. A retained rating would make
          // the requested Unreviewed state contradictory, so reset both parts
          // of review progress together.
          deleteRatingStmt.run(fingerprint);
        }
        setReviewStateStmt.run(fingerprint, reviewState, now);
        const isReviewed = isFingerprintReviewed(fingerprint);
        addReviewedCountDeltasForFingerprint(
          fingerprint,
          Number(isReviewed) - Number(wasReviewed),
          reviewedCountDeltas
        );
        updates[fingerprint] = mapMetadataRow(fingerprint);
      });
      applyReviewedCountDeltas(reviewedCountDeltas, now);
    })();
    return updates;
  }

  function restoreReviewMetadata(snapshots, { assertActive } = {}) {
    assertOperationActive(assertActive);
    if (!Array.isArray(snapshots)) {
      throw new TypeError('Review metadata snapshots must be an array');
    }
    const normalizedByFingerprint = new Map();
    snapshots.forEach((snapshot) => {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new TypeError('Every review metadata snapshot must be an object');
      }
      const fingerprint = typeof snapshot.fingerprint === 'string'
        ? snapshot.fingerprint.trim()
        : '';
      if (!fingerprint) {
        throw new TypeError('Every review metadata snapshot requires a fingerprint');
      }
      const reviewState = normalizeReviewState(snapshot.reviewState);
      let rating = null;
      if (snapshot.rating !== null && snapshot.rating !== undefined) {
        rating = Number(snapshot.rating);
        if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
          throw new TypeError(`Unsupported rating: ${snapshot.rating}`);
        }
      }
      if (reviewState === 'unreviewed' && rating !== null) {
        throw new TypeError('Unreviewed metadata cannot retain a rating');
      }
      normalizedByFingerprint.set(fingerprint, {
        fingerprint,
        reviewState,
        rating,
      });
    });
    const normalized = [...normalizedByFingerprint.values()];
    assertOperationActive(assertActive);

    const updates = {};
    const reviewedCountDeltas = new Map();
    const now = Date.now();
    db.transaction(() => {
      normalized.forEach(({ fingerprint, reviewState, rating }) => {
        const wasReviewed = isFingerprintReviewed(fingerprint);
        if (rating === null) deleteRatingStmt.run(fingerprint);
        else setRatingStmt.run(fingerprint, rating, now);
        setReviewStateStmt.run(fingerprint, reviewState, now);
        const isReviewed = isFingerprintReviewed(fingerprint);
        addReviewedCountDeltasForFingerprint(
          fingerprint,
          Number(isReviewed) - Number(wasReviewed),
          reviewedCountDeltas
        );
        updates[fingerprint] = mapMetadataRow(fingerprint);
      });
      applyReviewedCountDeltas(reviewedCountDeltas, now);
    })();
    return updates;
  }

  return {
    indexFile,
    indexFiles,
    registerLibraryRoot,
    registerDirectory,
    registerDirectories,
    getReusableFingerprint,
    reconcileLibraryRoot,
    markFileMissing,
    markFilesMissing,
    getLibraryRoot,
    getLibraryRoots,
    listLibraryRoots,
    setLibraryRootPinned,
    getDirectorySummaries,
    getLibraryTree,
    getCachedLibrarySnapshot,
    getAcceptedExportSnapshot,
    getSelectionExportSnapshot,
    getTaggedLibrarySnapshot,
    getFileInstances,
    getFileInstanceById,
    getGenerationMetadata,
    setGenerationMetadata,
    clearGenerationMetadata,
    listSavedViews,
    createSavedView,
    updateSavedView,
    deleteSavedView,
    listReviewCheckpoints,
    getReviewCheckpoint,
    saveReviewCheckpoint,
    clearReviewCheckpoint,
    refreshDirectoryCounts,
    getMetadataForFingerprints,
    listTags,
    assignTags,
    removeTag,
    setRating,
    setReviewState,
    restoreReviewMetadata,
    getDimensions,
    getHasAudio,
    setDimensions,
    clearFingerprintCache,
    dispose,
    getResourceSnapshot,
  };
}

function initMetadataStore(app, profilePath) {
  const normalized = normalizeProfilePath(profilePath) || currentProfilePath;
  if (metadataStoreInstance && currentProfilePath && normalized === currentProfilePath) {
    return metadataStoreInstance;
  }
  const db = initDatabase(app, profilePath);
  metadataStoreInstance = createMetadataStore(db);
  return metadataStoreInstance;
}

function getMetadataStore() {
  if (!metadataStoreInstance) {
    throw new Error('Metadata store not initialised');
  }
  return metadataStoreInstance;
}

function resetDatabase() {
  if (metadataStoreInstance) {
    metadataStoreInstance.dispose?.();
    metadataStoreInstance = null;
  }
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (error) {
      console.warn('[database] Failed to close database during reset', error);
    }
    dbInstance = null;
  }
  currentProfilePath = null;
}

module.exports = {
  FINGERPRINT_CACHE_MAX_ENTRIES,
  FINGERPRINT_CACHE_MAX_IN_FLIGHT,
  GENERATION_METADATA_LIMITS,
  initMetadataStore,
  getMetadataStore,
  resetDatabase,
};
