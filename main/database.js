const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { BoundedAsyncCache } = require('./bounded-async-cache');
const {
  computeFingerprint,
  isLegacyFingerprint,
  matchLegacyFingerprints,
} = require('./fingerprint');
const { createPeriodicEventLoopYielder } = require('./directory-scan-progress');
const { orderVersions } = require('./shared/generationVersions.mjs');
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
const {
  GENERATION_KEY_VERSION,
  WORKFLOW_FACTS_VERSION,
  PROMPT_KEY_VERSION,
  isGenerationKey,
  isPromptKey,
} = require('./generation-key');

let dbInstance = null;
let metadataStoreInstance = null;
let currentProfilePath = null;

const DB_FILE_NAME = 'videoswarm-meta.db';
const DB_SIDE_FILES = ['-wal', '-shm', '-journal'];
const REVIEW_STATES = new Set(['unreviewed', 'reviewed', 'pick', 'reject']);

// Record fields for a content's generation and prompt keys. A key from an
// older algorithm version is not used: the content is due for re-evaluation,
// and the renderer treats it as pending rather than grouping with it. Both
// keys come from one evaluation, so the content counts as checked only when
// both are current; a current generation key is still delivered while its
// prompt key is pending, so version badges stay put during that catch-up.
function mapGenerationKeyFields(
  generationKey,
  generationKeyVersion,
  promptKey,
  promptKeyVersion
) {
  const generationCurrent = Number(generationKeyVersion) === GENERATION_KEY_VERSION;
  const promptCurrent = Number(promptKeyVersion) === PROMPT_KEY_VERSION;
  const fields = {};
  if (generationCurrent && isGenerationKey(generationKey)) {
    fields.generationKey = generationKey;
  }
  if (promptCurrent && isPromptKey(promptKey)) fields.promptKey = promptKey;
  if (generationCurrent && promptCurrent) fields.generationKeyChecked = true;
  return fields;
}
// Absences the user caused on purpose. Anything else stays unexplained and is
// reported as missing, which is the state worth drawing attention to.
const MISSING_REASONS = new Set(['trashed', 'moved']);
// A library view can span every root, so its bounds are its own rather than
// borrowed from the per-root cached grid.
// Tag hierarchy depth, root to leaf. Deep enough for any real taxonomy and a
// hard bound on every walk up or down the tree.
const MAX_TAG_DEPTH = 8;

class TagHierarchyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TagHierarchyError';
    this.code = 'TAG_HIERARCHY';
  }
}

// A library search with no filter is the whole library, so the cap sits well
// above a large profile (folder views have none); past it the newest are kept.
const LIBRARY_TAG_VIEW_LIMITS = Object.freeze({
  maxTags: 16,
  maxRecords: 50_000,
  maxPathBytes: 32 * 1024 * 1024,
});
// Generation versions read and summarize content keys in bounded pages; the
// renderer asks for at most this many keys or instances at a time.
const GENERATION_VERSION_LIMITS = Object.freeze({
  maxCandidatePage: 256,
  maxRequestedInstances: 20_000,
  maxSummaryKeys: 4096,
  maxWriteBatch: 256,
  maxSiblingVersions: 32,
  maxSiblingRows: 512,
});
const SAVED_VIEW_LIMIT = 100;
// A pass holds as many clips as a library view (50,000); ten are kept.
const REVIEW_PASS_LIMITS = Object.freeze({ maxClips: 50_000, keep: 10, maxNameChars: 120 });
const WORKFLOW_FACT_LIMITS = Object.freeze({
  maxTerms: 512,
  maxTermChars: 128,
  maxWords: 8,
  maxMatchFingerprints: 100_000,
});
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
const GENERATION_QUALITIES = new Set(['exact', 'derived', 'partial', 'unknown']);
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
    // A generation-metadata table whose quality check predates 'derived'
    // (graph-derived evidence) refuses to save such a result, and SQLite
    // cannot relax a CHECK in place. Set it aside here, let the table be
    // created with the current check below, and copy its rows back once the
    // column migrations have run. A table with no quality column yet needs
    // nothing: the column is added later with the current check.
    const generationTableSql = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'instance_generation_metadata';"
      )
      .get()?.sql;
    const rebuildGenerationTable = Boolean(
      generationTableSql &&
        /quality\s+IN\s*\(/i.test(generationTableSql) &&
        !generationTableSql.includes("'derived'")
    );
    if (rebuildGenerationTable) {
      db.exec(
        'ALTER TABLE instance_generation_metadata RENAME TO instance_generation_metadata_before_derived;'
      );
    }
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

      -- First-frame fingerprints of stacked clips (prompt-stacks.md,
      -- Section 8): 64-bit difference hashes, per content.
      CREATE TABLE IF NOT EXISTS frame_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        frame_hash TEXT NOT NULL CHECK (length(frame_hash) = 16),
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (fingerprint) REFERENCES media_content(fingerprint) ON DELETE CASCADE
      );

      -- Tag suggestions the user turned down, per content and tag
      -- (prompt-search-and-tag-suggestions.md, Section 2). Nothing learned
      -- from prompts is stored.
      CREATE TABLE IF NOT EXISTS tag_suggestion_dismissals (
        fingerprint TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        dismissed_at INTEGER NOT NULL,
        PRIMARY KEY (fingerprint, tag_id),
        FOREIGN KEY (fingerprint) REFERENCES media_content(fingerprint) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tag_suggestion_dismissals_tag
        ON tag_suggestion_dismissals(tag_id);

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
          quality IN ('exact', 'derived', 'partial', 'unknown')
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

      -- What changed, in order, for the local read API's changes cursor
      -- (local-read-api.md): a clip's tags, rating or review state (kind
      -- 'clip', naming the content) or the tag tree (kind 'tags'). Kept to
      -- the latest 100,000 rows and 90 days.
      CREATE TABLE IF NOT EXISTS metadata_changes (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('clip', 'tags')),
        changed_at INTEGER NOT NULL
      );
      -- The local read API looks clips up by path.
      CREATE INDEX IF NOT EXISTS idx_file_instances_absolute_path
        ON file_instances(absolute_path);

      -- Review passes (docs/architecture/review-passes.md): a frozen list of
      -- clips to review, by content, in the order they were shown, and how
      -- far the review has got. A few are kept to resume.
      CREATE TABLE IF NOT EXISTS review_passes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('results', 'selection')),
        definition_json TEXT,
        location_json TEXT,
        clip_count INTEGER NOT NULL,
        cursor_position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS review_pass_clips (
        pass_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        instance_id INTEGER,
        PRIMARY KEY (pass_id, position),
        FOREIGN KEY (pass_id) REFERENCES review_passes(id) ON DELETE CASCADE
      );

      -- The rating arena (docs/architecture/rating-arena.md, Section 6): one
      -- row per clip per round finished. Holds and last-checked times are
      -- derived from it; it only steers which clips the arena picks.
      CREATE TABLE IF NOT EXISTS arena_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('place', 'first', 'tier', 'border')),
        outcome TEXT NOT NULL CHECK (
          outcome IN ('placed', 'held', 'raised', 'lowered', 'skipped', 'rejected')
        ),
        rating_before INTEGER,
        rating_after INTEGER,
        FOREIGN KEY (fingerprint) REFERENCES media_content(fingerprint) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_arena_checks_fingerprint
        ON arena_checks(fingerprint, checked_at);
    `);

    // View feeds (view-feeds.md): a saved view other apps may follow, on
    // unless the owner turns it off for that view.
    const savedViewColumns = new Set(
      db
        .prepare('PRAGMA table_info(saved_views);')
        .all()
        .map((row) => row.name)
    );
    if (!savedViewColumns.has('feed_shared')) {
      db.exec('ALTER TABLE saved_views ADD COLUMN feed_shared INTEGER NOT NULL DEFAULT 1;');
    }

    // Tag hierarchy: each tag may have one parent ("bellydance" under
    // "dance"). Ancestors are derived when matching and counting, never
    // written onto clips. See docs/architecture/tag-hierarchy.md.
    const tagColumns = new Set(
      db
        .prepare('PRAGMA table_info(tags);')
        .all()
        .map((row) => row.name)
    );
    if (!tagColumns.has('parent_id')) {
      db.exec(
        'ALTER TABLE tags ADD COLUMN parent_id INTEGER REFERENCES tags(id) ON DELETE SET NULL;'
      );
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tags_parent
        ON tags(parent_id)
        WHERE parent_id IS NOT NULL;
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
    // Generation versions: the derived key only, never the graph it came
    // from. A NULL version means not yet evaluated; a version with a NULL key
    // means evaluated and not keyable.
    if (!mediaContentColumns.has('generation_key')) {
      db.exec('ALTER TABLE media_content ADD COLUMN generation_key TEXT;');
    }
    if (!mediaContentColumns.has('generation_key_version')) {
      db.exec(
        'ALTER TABLE media_content ADD COLUMN generation_key_version INTEGER;'
      );
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_media_content_generation_key
        ON media_content(generation_key)
        WHERE generation_key IS NOT NULL;
    `);
    // Key versions 2 (short texts) and 3 (where a video-to-video cut starts)
    // change what is hashed, not what is keyable: a key still needs a seed
    // and a four-word text. Content an older version found unkeyable is
    // therefore unkeyable now, and is carried over rather than every file
    // without embedded metadata being read again. Keyed content is
    // re-evaluated. Revisit this if a version ever changes keyability.
    db.prepare(`
      UPDATE media_content
      SET generation_key_version = @version
      WHERE generation_key_version < @version
        AND generation_key IS NULL;
    `).run({ version: GENERATION_KEY_VERSION });
    // Prompt stacks: the prompt key is the generation key without its seeds
    // (docs/architecture/prompt-stacks.md). Same rule: derived key only.
    if (!mediaContentColumns.has('prompt_key')) {
      db.exec('ALTER TABLE media_content ADD COLUMN prompt_key TEXT;');
    }
    if (!mediaContentColumns.has('prompt_key_version')) {
      db.exec('ALTER TABLE media_content ADD COLUMN prompt_key_version INTEGER;');
      // Both keys come from the same parts and are absent under the same
      // conditions, so content already found to have no generation key has
      // no prompt key either. Recording that here spares re-reading every
      // file without embedded metadata just to learn nothing.
      db.prepare(`
        UPDATE media_content
        SET prompt_key = NULL, prompt_key_version = @prompt_version
        WHERE generation_key_version = @generation_version
          AND generation_key IS NULL;
      `).run({
        prompt_version: PROMPT_KEY_VERSION,
        generation_version: GENERATION_KEY_VERSION,
      });
    }
    // The same carry-over for the prompt key, which exists exactly when the
    // generation key does.
    db.prepare(`
      UPDATE media_content
      SET prompt_key = NULL, prompt_key_version = @prompt_version
      WHERE prompt_key_version < @prompt_version
        AND generation_key_version = @generation_version
        AND generation_key IS NULL;
    `).run({
      prompt_version: PROMPT_KEY_VERSION,
      generation_version: GENERATION_KEY_VERSION,
    });
    // Workflow facts for filters (docs/architecture/workflow-filters.md): the
    // largest steps setting, and the node types and weight-file names the
    // embedded workflow uses, one per line. Never a text input or a prompt.
    // A NULL version means not yet read; content without a workflow has a
    // version and no facts.
    if (!mediaContentColumns.has('workflow_steps')) {
      db.exec('ALTER TABLE media_content ADD COLUMN workflow_steps INTEGER;');
    }
    if (!mediaContentColumns.has('workflow_terms')) {
      db.exec('ALTER TABLE media_content ADD COLUMN workflow_terms TEXT;');
    }
    if (!mediaContentColumns.has('workflow_facts_version')) {
      db.exec('ALTER TABLE media_content ADD COLUMN workflow_facts_version INTEGER;');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_media_content_prompt_key
        ON media_content(prompt_key)
        WHERE prompt_key IS NOT NULL;
    `);

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
           quality IN ('exact', 'derived', 'partial', 'unknown')
         );`,
      ],
    ];
    generationColumnMigrations.forEach(([column, statement]) => {
      if (!generationMetadataColumns.has(column)) db.exec(statement);
    });
    if (rebuildGenerationTable) {
      const columnsOf = (table) =>
        db.prepare(`PRAGMA table_info(${table});`).all().map((row) => row.name);
      const previous = new Set(columnsOf('instance_generation_metadata_before_derived'));
      const shared = columnsOf('instance_generation_metadata')
        .filter((column) => previous.has(column))
        .join(', ');
      db.exec(`
        INSERT INTO instance_generation_metadata (${shared})
        SELECT ${shared} FROM instance_generation_metadata_before_derived;
        DROP TABLE instance_generation_metadata_before_derived;
      `);
    }

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
  // The change log (local-read-api.md): written in the same transaction as
  // every tag, rating and review write, so a reader never misses one.
  const METADATA_CHANGE_LIMITS = Object.freeze({
    keepRows: 100_000,
    keepMs: 90 * 24 * 60 * 60 * 1000,
    pruneEvery: 1_000,
    readLimit: 10_000,
  });
  const insertMetadataChange = db.prepare(
    'INSERT INTO metadata_changes (fingerprint, kind, changed_at) VALUES (?, ?, ?);'
  );
  const pruneMetadataChanges = db.prepare(`
    DELETE FROM metadata_changes
    WHERE revision <= (SELECT MAX(revision) FROM metadata_changes) - @keep_rows
       OR changed_at < @oldest;
  `);
  let changesSincePrune = 0;
  const pruneChangeLog = () => {
    changesSincePrune = 0;
    pruneMetadataChanges.run({
      keep_rows: METADATA_CHANGE_LIMITS.keepRows,
      oldest: Date.now() - METADATA_CHANGE_LIMITS.keepMs,
    });
  };
  function noteMetadataChange(fingerprint, kind = 'clip') {
    if (kind === 'clip' && !fingerprint) return;
    insertMetadataChange.run(kind === 'clip' ? fingerprint : null, kind, Date.now());
    changesSincePrune += 1;
    if (changesSincePrune >= METADATA_CHANGE_LIMITS.pruneEvery) pruneChangeLog();
  }
  const noteTagTreeChange = () => noteMetadataChange(null, 'tags');
  pruneChangeLog();

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
  // The same file as indexed under another root: a folder indexed inside
  // another lists its files under both.
  const fileInstanceInRootByPath = db.prepare(`
    SELECT * FROM file_instances
    WHERE root_id = ? AND absolute_path = ? AND is_present != 0
    ORDER BY id
    LIMIT 1;
  `);
  const fileInstanceLocationById = db.prepare(`
    SELECT id, absolute_path, is_present, fingerprint FROM file_instances WHERE id = ?;
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
  // Folder opens re-index every file. One whose stored rows already match
  // only records that it was seen again (see indexFiles).
  const fileInstanceSeen = db.prepare(`
    UPDATE file_instances SET last_seen_at = ? WHERE id = ?;
  `);
  const fileRecordForIndex = db.prepare(`
    SELECT last_known_path, size, created_ms, width, height, has_audio,
      duration_ms, frame_rate
    FROM files WHERE fingerprint = ?;
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
      mc.generation_key AS content_generation_key,
      mc.generation_key_version AS content_generation_key_version,
      mc.prompt_key AS content_prompt_key,
      mc.prompt_key_version AS content_prompt_key_version,
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
  // instances must not reappear just because they carry a tag. A root whose
  // folder is gone from disk is never rescanned, so its rows still read as
  // present; the caller names those roots and they are left out.
  // A folder indexed inside another indexed folder puts its files in the
  // catalog once per root, with one path. A library search shows each path
  // once: the copy seen most recently, then the one in the most specific root.
  const taggedInstancesAcrossRoots = db.prepare(`
    SELECT * FROM (
    SELECT fi.*,
      ROW_NUMBER() OVER (
        PARTITION BY fi.absolute_path
        ORDER BY fi.last_seen_at DESC, LENGTH(lr.root_path) DESC, fi.id
      ) AS path_rank,
      lr.root_path AS owner_root_path,
      mc.created_ms AS content_created_ms,
      mc.width AS content_width,
      mc.height AS content_height,
      mc.has_audio AS content_has_audio,
      mc.duration_ms AS content_duration_ms,
      mc.frame_rate AS content_frame_rate,
      mc.generation_key AS content_generation_key,
      mc.generation_key_version AS content_generation_key_version,
      mc.prompt_key AS content_prompt_key,
      mc.prompt_key_version AS content_prompt_key_version,
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
      AND lr.root_path NOT IN (SELECT value FROM json_each(@unavailable_root_paths))
      -- tags.name is declared COLLATE NOCASE, so matching and DISTINCT are
      -- already case-insensitive without restating it here. Counting the
      -- distinct matches and requiring the full tag count is what makes a
      -- multi-tag view an intersection rather than a union.
      -- @required_matches is the tag count for "all" and 1 for "any", so one
      -- statement serves both without a second prepared query. At zero tags it
      -- is zero, which matches every row - the no-constraint case.
      -- With the tag hierarchy, each requested tag is a group of itself and
      -- every tag under it (@tag_groups pairs), and distinct groups count.
      AND (
        SELECT COUNT(DISTINCT json_extract(g.value, '$[1]'))
        FROM file_tags ft
        INNER JOIN tags t ON t.id = ft.tag_id
        INNER JOIN json_each(@tag_groups) g
          ON t.name = json_extract(g.value, '$[0]')
        WHERE ft.fingerprint = fi.fingerprint
      ) >= @required_matches
      -- A rating narrows the search too, so "4 stars or more" alone is a
      -- library search. Unrated clips never match a rating.
      AND (@min_rating IS NULL OR r.value >= @min_rating)
      AND (@exact_rating IS NULL OR r.value = @exact_rating)
      -- Prompt search narrows to the prompt keys that matched it.
      AND (
        @prompt_keys IS NULL
        OR mc.prompt_key IN (SELECT value FROM json_each(@prompt_keys))
      )
      -- "Might be" a tag: not under it already (@might_be_groups is the tag
      -- and every tag under it) and not having turned its suggestion down.
      AND (
        @might_be_groups IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM file_tags mft
          INNER JOIN tags mt ON mt.id = mft.tag_id
          WHERE mft.fingerprint = fi.fingerprint
            AND mt.name IN (SELECT value FROM json_each(@might_be_groups))
        )
      )
      AND (
        @might_be_tag IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM tag_suggestion_dismissals mds
          INNER JOIN tags mdt ON mdt.id = mds.tag_id
          WHERE mds.fingerprint = fi.fingerprint AND mdt.name = @might_be_tag
        )
      )
    )
    WHERE path_rank = 1
    -- The grid sorts for itself; this order only decides which clips a
    -- search past the record cap keeps: the newest.
    ORDER BY mtime_ms DESC, owner_root_path COLLATE NOCASE, relative_path COLLATE NOCASE
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
  // A tag counts the clips it is on that the library has present: content
  // whose every known file is missing, or that no scan has located, is left
  // out, so deleted clips do not inflate counts. Opening a folder locates its
  // clips and their tags count again. Each link is one indexed probe.
  const presentTagLinks = db.prepare(`
    SELECT ft.tag_id AS tagId, ft.fingerprint AS fingerprint
    FROM file_tags ft
    WHERE EXISTS (
      SELECT 1 FROM file_instances fi
      WHERE fi.fingerprint = ft.fingerprint AND fi.is_present = 1
    );
  `);
  const tagRows = db.prepare(`
    SELECT id, name, parent_id AS parentId
    FROM tags
    ORDER BY name COLLATE NOCASE;
  `);
  const tagById = db.prepare('SELECT id, name, parent_id AS parentId FROM tags WHERE id = ?;');
  const setTagParentStmt = db.prepare('UPDATE tags SET parent_id = ? WHERE id = ?;');
  const tagChildCount = db.prepare(
    'SELECT COUNT(*) AS count FROM tags WHERE parent_id = ?;'
  );
  const reparentTagChildren = db.prepare(
    'UPDATE tags SET parent_id = ? WHERE parent_id = ?;'
  );

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
      frame_rate, generation_key, generation_key_version, prompt_key,
      prompt_key_version, created_at, updated_at
    )
    SELECT @to, size, created_ms, width, height, has_audio, duration_ms,
      frame_rate, generation_key, generation_key_version, prompt_key,
      prompt_key_version, created_at, updated_at
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
      generation_key=CASE
        WHEN media_content.generation_key_version IS NULL
          THEN excluded.generation_key
        ELSE media_content.generation_key
      END,
      generation_key_version=COALESCE(
        media_content.generation_key_version,
        excluded.generation_key_version
      ),
      prompt_key=CASE
        WHEN media_content.prompt_key_version IS NULL
          THEN excluded.prompt_key
        ELSE media_content.prompt_key
      END,
      prompt_key_version=COALESCE(
        media_content.prompt_key_version,
        excluded.prompt_key_version
      ),
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
  // Turned-down suggestions are the user's word too; they cascade away with
  // the source content once it is dropped.
  const rekeyTagSuggestionDismissals = db.prepare(`
    INSERT OR IGNORE INTO tag_suggestion_dismissals (fingerprint, tag_id, dismissed_at)
    SELECT @to, tag_id, dismissed_at FROM tag_suggestion_dismissals
    WHERE fingerprint = @from;
  `);
  const rekeyInstanceFingerprints = db.prepare(`
    UPDATE file_instances SET fingerprint = @to WHERE fingerprint = @from;
  `);
  // The arena's history follows the content too.
  const rekeyArenaChecks = db.prepare(`
    UPDATE arena_checks SET fingerprint = @to WHERE fingerprint = @from;
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
  // v1 identities begin `v1-<size hex>-`, so a primary-key range finds every
  // legacy row of one byte size without needing a size index. '.' sorts
  // directly after '-', which makes the upper bound exact.
  const anyLegacyFileRecord = db.prepare(`
    SELECT 1 FROM files WHERE fingerprint >= 'v1-' AND fingerprint < 'v1.' LIMIT 1;
  `);
  const legacyFileRecordsBySize = db.prepare(`
    SELECT fingerprint FROM files
    WHERE fingerprint >= @lower AND fingerprint < @upper;
  `);

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
  const savedViewSetShared = db.prepare(`
    UPDATE saved_views SET feed_shared = ?, updated_at = ? WHERE id = ?;
  `);
  // A view feed's catalog (view-feeds.md): every present clip of every root,
  // in id order and chunks, with the facts a view's filters read. Roots that
  // cannot be opened are kept; the feed marks their clips unavailable.
  const feedPoolChunk = db.prepare(`
    SELECT fi.id, fi.absolute_path, fi.relative_path, fi.fingerprint, fi.last_seen_at,
      lr.root_path AS owner_root_path,
      mc.width AS content_width,
      mc.height AS content_height,
      mc.duration_ms AS content_duration_ms,
      mc.frame_rate AS content_frame_rate,
      mc.generation_key AS content_generation_key,
      mc.generation_key_version AS content_generation_key_version,
      mc.prompt_key AS content_prompt_key,
      mc.prompt_key_version AS content_prompt_key_version,
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
    WHERE fi.id > @after_id
      AND fi.is_present != 0
      AND d.is_present != 0
      AND fi.fingerprint IS NOT NULL
    ORDER BY fi.id
    LIMIT @limit;
  `);
  // One clip in the pool's shape, for the smart views it is part of.
  const feedClipById = db.prepare(
    feedPoolChunk.source
      .replace('WHERE fi.id > @after_id', 'WHERE fi.id = @id')
      .replace(/ORDER BY fi\.id\s+LIMIT @limit;/u, ';')
  );
  const feedTagNamesForContent = db.prepare(`
    SELECT t.name AS name
    FROM file_tags ft
    INNER JOIN tags t ON t.id = ft.tag_id
    WHERE ft.fingerprint = ?
    ORDER BY t.name COLLATE NOCASE;
  `);
  // Every present clip's tag names, by content, in one pass.
  const feedTagNames = db.prepare(`
    SELECT ft.fingerprint AS fingerprint, t.name AS name
    FROM file_tags ft
    INNER JOIN tags t ON t.id = ft.tag_id
    WHERE EXISTS (
      SELECT 1 FROM file_instances fi
      WHERE fi.fingerprint = ft.fingerprint AND fi.is_present = 1
    )
    ORDER BY ft.fingerprint, t.name COLLATE NOCASE;
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
    if (!name) throw new TypeError('Smart view name is required');
    if (name.length > SAVED_VIEW_NAME_LIMIT) {
      throw new RangeError(
        `Smart view name exceeds ${SAVED_VIEW_NAME_LIMIT} characters`
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
        // Followed by other apps unless turned off (view-feeds.md).
        shared: row.feed_shared === undefined ? true : Number(row.feed_shared) !== 0,
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
   * Every stored v1 row whose digest this file's bytes reproduce.
   *
   * The upgrade used to consult only the instance previously indexed at the
   * same path, so content moved or copied before its old folder was rescanned
   * left its review state, rating and tags on a v1 row nothing could reach.
   * Any v1 row of the same byte size is now a candidate. Proof recomputes the
   * row's digest from these bytes and the creation time recorded in the row,
   * so a different file that merely shares the size never matches.
   */
  async function findProvenLegacyFingerprints(
    filePath,
    stats,
    fingerprintResult,
    assertActive
  ) {
    const prefix = `v1-${normalizeStatSize(stats).toString(16)}`;
    const candidates = legacyFileRecordsBySize
      .all({ lower: `${prefix}-`, upper: `${prefix}.` })
      .map((row) => row.fingerprint);
    if (!candidates.length) return [];

    // A fresh read already reproduced one digest under the file's own creation
    // time; that is the common in-place upgrade and needs no second read.
    const freshLegacy = fingerprintResult.legacyFingerprint || null;
    const proven = candidates.filter((candidate) => candidate === freshLegacy);
    const unproven = candidates.filter((candidate) => candidate !== freshLegacy);
    if (unproven.length) {
      proven.push(...(await matchLegacyFingerprints(filePath, stats, unproven)));
      assertOperationActive(assertActive);
    }
    return proven;
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
    rekeyTagSuggestionDismissals.run(parameters);
    rekeyArenaChecks.run(parameters);
    // The metadata moved: one content lost it, another gained it.
    noteMetadataChange(fromFingerprint);
    noteMetadataChange(toFingerprint);
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

  // `memo` (path -> row) lets one batch upsert each directory once rather
  // than once per file beneath it.
  function ensureDirectoryHierarchy(
    rootRow,
    relativeDirectoryPath,
    now = Date.now(),
    memo = null
  ) {
    const normalizedRelativePath = normalizeCatalogRelativePath(relativeDirectoryPath);
    const parts = normalizedRelativePath ? normalizedRelativePath.split('/') : [];
    const paths = [''];
    for (let index = 1; index <= parts.length; index += 1) {
      paths.push(parts.slice(0, index).join('/'));
    }

    let finalRow = null;
    paths.forEach((directoryPath) => {
      if (memo?.has(directoryPath)) {
        finalRow = memo.get(directoryPath);
        return;
      }
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
      memo?.set(directoryPath, finalRow);
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

  function writeFileInstance(rootRow, entry, now = Date.now(), ensuredDirectory = null) {
    const directoryRelativePath = getDirectoryRelativePath(entry.relativePath);
    const directoryRow = ensuredDirectory || ensureDirectoryHierarchy(
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

  // True when upserting these dimensions would leave the row as it is: the
  // upserts keep a stored value wherever the new one is unknown.
  function keepsStoredDimensions(row, dimensions) {
    return [
      ['width', normalizeDimension(dimensions?.width)],
      ['height', normalizeDimension(dimensions?.height)],
      ['has_audio', normalizeHasAudio(dimensions?.hasAudio)],
      ['duration_ms', normalizeDurationMs(dimensions?.durationMs)],
      ['frame_rate', normalizeFrameRate(dimensions?.frameRate)],
    ].every(([column, value]) => value === null || row[column] === value);
  }

  /**
   * The instance row when re-indexing this entry would change nothing but its
   * last_seen_at: same instance, path, directory, size, mtime and content,
   * present, and no new file or media-content facts. Read inside the write
   * transaction, so a change made after the entry was prepared is never
   * skipped.
   */
  function findUnchangedIndexedInstance(rootRow, entry, directoryRow) {
    const expected = entry.reusableInstance;
    if (!expected || !directoryRow) return null;
    const current = fileInstanceByRelativePath.get(rootRow.id, entry.relativePath);
    if (
      !current ||
      current.id !== expected.id ||
      !current.is_present ||
      current.missing_since != null ||
      current.absolute_path !== entry.filePath ||
      current.directory_id !== directoryRow.id ||
      current.fingerprint !== entry.fingerprint ||
      Number(current.size) !== normalizeStatSize(entry.stats) ||
      Number(current.mtime_ms) !== normalizeStatMtime(entry.stats)
    ) {
      return null;
    }

    const size = Number(entry.stats.size || 0);
    const record = fileRecordForIndex.get(entry.fingerprint);
    const content = mediaContentByFingerprint.get(entry.fingerprint);
    if (
      !record ||
      !content ||
      record.last_known_path !== entry.filePath ||
      Number(record.size) !== size ||
      record.created_ms == null ||
      record.created_ms !== entry.createdMs ||
      Number(content.size) !== size ||
      !keepsStoredDimensions(record, entry.dimensions) ||
      !keepsStoredDimensions(content, entry.dimensions)
    ) {
      return null;
    }
    return current;
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

    // Most recounts after a scan change nothing; only changed rows are
    // written, and the rows already read are returned when none were.
    const rowsByPath = new Map(directoryRows.map((row) => [row.relative_path, row]));
    const changed = [];
    counts.forEach((value, relativePath) => {
      const row = rowsByPath.get(relativePath);
      const same = row && Object.keys(value).every(
        (column) => column === 'id' || Number(row[column]) === value[column]
      );
      if (!same) changed.push(value);
    });
    if (!changed.length) return directoryRows.map(mapDirectoryRow);

    const now = Date.now();
    const txn = db.transaction(() => {
      changed.forEach((value) => {
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
          ...mapGenerationKeyFields(
            instance.content_generation_key,
            instance.content_generation_key_version,
            instance.content_prompt_key,
            instance.content_prompt_key_version
          ),
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
  // One present instance from a library-wide query (the tag view's and the
  // versions view's columns) as a catalog record; tags are read once per
  // content through `tagsByFingerprint`.
  function mapLibraryInstanceRow(instance, tagsByFingerprint) {
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
      ...mapGenerationKeyFields(
        instance.content_generation_key,
        instance.content_generation_key_version,
        instance.content_prompt_key,
        instance.content_prompt_key_version
      ),
    };
  }

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

    const matchMode = options.matchMode === 'any' ? 'any' : 'all';
    const unavailableRootPaths = (
      Array.isArray(options.unavailableRootPaths) ? options.unavailableRootPaths : []
    ).filter((rootPath) => typeof rootPath === 'string' && rootPath);
    const ratingOf = (value) =>
      Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
    const mightBeTag =
      typeof options.mightBeTag === 'string' ? options.mightBeTag.trim().toLowerCase() : '';
    const rows = taggedInstancesAcrossRoots.all({
      tag_groups: JSON.stringify(expandTagGroups(tagNames)),
      unavailable_root_paths: JSON.stringify(unavailableRootPaths),
      required_matches:
        tagNames.length === 0 ? 0 : matchMode === 'any' ? 1 : tagNames.length,
      min_rating: ratingOf(options.minRating),
      exact_rating: ratingOf(options.exactRating),
      prompt_keys: Array.isArray(options.promptKeys)
        ? JSON.stringify(options.promptKeys.filter(isPromptKey))
        : null,
      might_be_groups: mightBeTag
        ? JSON.stringify(expandTagGroups([mightBeTag]).map(([name]) => name))
        : null,
      might_be_tag: mightBeTag || null,
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
      return mapLibraryInstanceRow(instance, tagsByFingerprint);
    });
    assertOperationActive(options.assertActive);

    return {
      tags: tagNames,
      matchMode,
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
          `A transfer is limited to ${maxRecords.toLocaleString()} media files per operation`,
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

  /**
   * Where an instance's file is, for the media protocol: one indexed read
   * per video range request, without the review state getFileInstanceById
   * also looks up.
   */
  function getFileInstanceLocation(instanceId) {
    const id = Number(instanceId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const row = fileInstanceLocationById.get(id);
    if (!row) return null;
    return {
      id: Number(row.id),
      absolutePath: row.absolute_path,
      present: Boolean(row.is_present),
      fingerprint: row.fingerprint || null,
    };
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

  function getSavedView(savedViewId) {
    return mapSavedViewRow(savedViewById.get(normalizeSavedViewId(savedViewId)));
  }

  function setSavedViewShared(savedViewId, shared) {
    const id = normalizeSavedViewId(savedViewId);
    if (!savedViewById.get(id)) throw new RangeError('Saved view not found');
    savedViewSetShared.run(shared ? 1 : 0, Date.now(), id);
    return mapSavedViewRow(savedViewById.get(id));
  }

  /**
   * One chunk of a view feed's catalog (view-feeds.md): present clips after
   * `afterId` in id order, as `{ lastId, rows }`; rows have the facts a view
   * filters on, without tags (see `listFeedTagNames`).
   */
  function listFeedPoolChunk({ afterId = 0, limit = 5_000, assertActive } = {}) {
    assertOperationActive(assertActive);
    const rows = feedPoolChunk.all({
      after_id: Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0,
      limit: Math.max(1, Math.min(20_000, Number(limit) || 5_000)),
    });
    const clips = rows.map(mapFeedPoolRow);
    return { lastId: rows.length ? Number(rows[rows.length - 1].id) : afterId, clips };
  }

  /**
   * One present clip in the pool's shape, with its tag names, or null.
   */
  function getFeedClip(instanceId) {
    if (!Number.isSafeInteger(instanceId) || instanceId < 1) return null;
    const row = feedClipById.get({ id: instanceId });
    if (!row) return null;
    const clip = mapFeedPoolRow(row);
    clip.tags = feedTagNamesForContent.all(clip.fingerprint).map((tag) => tag.name);
    return clip;
  }

  function mapFeedPoolRow(row) {
    const width = Number(row.content_width || 0);
    const height = Number(row.content_height || 0);
    const durationMs = normalizeDurationMs(row.content_duration_ms);
    const frameRate = normalizeFrameRate(row.content_frame_rate);
    return {
      instanceId: Number(row.id),
      fingerprint: row.fingerprint,
      absolutePath: row.absolute_path,
      relativePath: row.relative_path,
      rootPath: row.owner_root_path,
      lastSeenAt: Number(row.last_seen_at || 0),
      rating:
        row.rating_value !== null && Number.isFinite(Number(row.rating_value))
          ? Number(row.rating_value)
          : null,
      reviewState: REVIEW_STATES.has(row.review_state) ? row.review_state : 'unreviewed',
      dimensions:
        width > 0 && height > 0
          ? {
              width,
              height,
              ...(durationMs ? { durationMs } : {}),
              ...(frameRate ? { frameRate } : {}),
            }
          : null,
      ...mapGenerationKeyFields(
        row.content_generation_key,
        row.content_generation_key_version,
        row.content_prompt_key,
        row.content_prompt_key_version
      ),
    };
  }

  /** Every present content's tag names: `Map<fingerprint, string[]>`. */
  function listFeedTagNames() {
    const byFingerprint = new Map();
    for (const row of feedTagNames.iterate()) {
      let list = byFingerprint.get(row.fingerprint);
      if (!list) byFingerprint.set(row.fingerprint, (list = []));
      list.push(row.name);
    }
    return byFingerprint;
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
    let anchorInstanceId = normalizeCheckpointAnchorId(
      draft.anchorInstanceId
    );
    let anchorFingerprint = normalizeCheckpointFingerprint(
      draft.anchorFingerprint
    );
    if (anchorInstanceId !== null) {
      let instance = fileInstanceById.get(anchorInstanceId);
      // A clip of a folder indexed inside another may arrive as the other
      // root's copy of the same file; the requested root's own copy stands
      // in for it.
      if (instance && Number(instance.root_id) !== Number(root.id)) {
        instance = fileInstanceInRootByPath.get(root.id, instance.absolute_path) || null;
        if (instance) anchorInstanceId = Number(instance.id);
      }
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
    if (tagInsert.run(trimmed).changes > 0) noteTagTreeChange();
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
    // Once a profile holds no v1 rows the per-file legacy lookup is skipped.
    const legacyRowsRemain = Boolean(anyLegacyFileRecord.get());

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
      const provenLegacyFingerprints = legacyRowsRemain
        ? await findProvenLegacyFingerprints(
          location.absolutePath,
          safeStats,
          fingerprintResult,
          assertActive
        )
        : [];

      const prepared = {
        filePath: location.absolutePath,
        relativePath: location.relativePath,
        stats: safeStats,
        dimensions: input.dimensions,
        fingerprint: fingerprintResult.fingerprint,
        createdMs: fingerprintResult.createdMs,
        fingerprintReused: reusedPersistedFingerprint,
        provenLegacyFingerprints,
        // A candidate for the seen-again fast path; the transaction confirms
        // that nothing else about it would change.
        reusableInstance:
          reusedPersistedFingerprint && provenLegacyFingerprints.length === 0
            ? existingInstance
            : null,
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
    const now = Date.now();
    const directoryMemo = new Map();
    const txn = db.transaction(() => {
      preparedEntries.forEach((entry) => {
        // Carry v1 metadata forward only when these bytes reproduce the
        // stored legacy digest, wherever that row was last seen. That equality
        // is exact proof the content is unchanged, so a genuinely edited file
        // is never allowed to inherit the previous content's review state,
        // rating, or tags. Two copies proving one row in the same batch share
        // a v2 identity, so the second re-key finds nothing left to move.
        entry.provenLegacyFingerprints.forEach((legacyFingerprint) => {
          rekeyContentFingerprint(legacyFingerprint, entry.fingerprint);
        });
        const directoryRow = ensureDirectoryHierarchy(
          rootRow,
          getDirectoryRelativePath(entry.relativePath),
          now,
          directoryMemo
        );
        // Re-opening a folder mostly finds files exactly as indexed. Those
        // need one write instead of rewriting their file, content and
        // instance rows, which kept the main process busy and churned the WAL.
        const unchanged = findUnchangedIndexedInstance(rootRow, entry, directoryRow);
        if (unchanged) {
          fileInstanceSeen.run(now, unchanged.id);
          instanceRows.push({ ...unchanged, last_seen_at: now });
          return;
        }
        writeFileRecord(
          entry.fingerprint,
          entry.filePath,
          entry.stats,
          entry.createdMs,
          entry.dimensions
        );
        instanceRows.push(writeFileInstance(rootRow, entry, now, directoryRow));
      });
    });
    txn();

    const metadata = getMetadataForFingerprints(
      preparedEntries.map((entry) => entry.fingerprint)
    );
    const generationKeys = getGenerationKeyFields(
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
      ...(generationKeys.get(entry.fingerprint) || {}),
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
      ...(getGenerationKeyFields([fingerprint]).get(fingerprint) || {}),
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

  // --- Generation versions ------------------------------------------------
  // See docs/architecture/generation-versions.md. Only derived keys are
  // stored, and for filters the node types, weight-file names and steps
  // setting (docs/architecture/workflow-filters.md); text inputs, and so
  // prompts, never reach SQLite.

  const generationKeysForFingerprints = db.prepare(`
    SELECT fingerprint, generation_key, generation_key_version, prompt_key,
      prompt_key_version
    FROM media_content
    WHERE fingerprint IN (SELECT value FROM json_each(@fingerprints));
  `);
  // Candidates are present instances in present directories whose content
  // has not been evaluated under the current versions of both keys. Pages advance by
  // instance id, so a transient failure is retried by a later request rather
  // than looped on within this one.
  const generationKeyCandidates = db.prepare(`
    SELECT fi.id AS instance_id, fi.fingerprint, fi.absolute_path, fi.size,
      fi.mtime_ms, lr.root_path
    FROM file_instances fi
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    INNER JOIN directories d ON d.id = fi.directory_id
    INNER JOIN media_content mc ON mc.fingerprint = fi.fingerprint
    WHERE fi.is_present != 0
      AND d.is_present != 0
      AND fi.id > @after_id
      AND (
        mc.generation_key_version IS NULL
        OR mc.generation_key_version != @version
        OR mc.prompt_key_version IS NULL
        OR mc.prompt_key_version != @prompt_version
        OR mc.workflow_facts_version IS NULL
        OR mc.workflow_facts_version != @facts_version
      )
      AND (
        @instance_ids IS NULL
        OR fi.id IN (SELECT value FROM json_each(@instance_ids))
      )
    ORDER BY fi.id
    LIMIT @limit;
  `);
  const generationKeyCandidateCount = db.prepare(`
    SELECT COUNT(DISTINCT fi.fingerprint) AS pending
    FROM file_instances fi
    INNER JOIN directories d ON d.id = fi.directory_id
    INNER JOIN media_content mc ON mc.fingerprint = fi.fingerprint
    WHERE fi.is_present != 0
      AND d.is_present != 0
      AND (
        mc.generation_key_version IS NULL
        OR mc.generation_key_version != @version
        OR mc.prompt_key_version IS NULL
        OR mc.prompt_key_version != @prompt_version
        OR mc.workflow_facts_version IS NULL
        OR mc.workflow_facts_version != @facts_version
      )
      AND (
        @instance_ids IS NULL
        OR fi.id IN (SELECT value FROM json_each(@instance_ids))
      );
  `);
  const evaluatedGenerationKeysForInstances = db.prepare(`
    SELECT DISTINCT mc.fingerprint, mc.generation_key, mc.prompt_key
    FROM file_instances fi
    INNER JOIN media_content mc ON mc.fingerprint = fi.fingerprint
    WHERE fi.id IN (SELECT value FROM json_each(@instance_ids))
      AND mc.generation_key_version = @version
      AND mc.prompt_key_version = @prompt_version;
  `);
  const setGenerationKeyStmt = db.prepare(`
    UPDATE media_content
    SET generation_key = @generation_key,
      generation_key_version = @version,
      prompt_key = @prompt_key,
      prompt_key_version = @prompt_version,
      workflow_steps = @workflow_steps,
      workflow_terms = @workflow_terms,
      workflow_facts_version = @facts_version,
      updated_at = @updated_at
    WHERE fingerprint = @fingerprint;
  `);
  // A version is a content, not an instance, and it counts only while some
  // instance of it is present in a present directory.
  // Per key: how many versions, the largest and smallest, and what the
  // best-version rule needs (generationVersions.mjs): the top rating, the
  // largest version that is unrated or rated that high, and the largest
  // unrated one.
  const generationVersionSummaries = db.prepare(`
    WITH present AS (
      SELECT mc.generation_key AS generation_key,
        COALESCE(mc.width, 0) * COALESCE(mc.height, 0) AS pixels,
        CASE WHEN mc.width > 0 AND mc.height > 0 THEN mc.width * mc.height END AS measured,
        CASE WHEN r.value BETWEEN 1 AND 5 THEN r.value END AS rating
      FROM media_content mc
      LEFT JOIN ratings r ON r.fingerprint = mc.fingerprint
      WHERE mc.generation_key IN (SELECT value FROM json_each(@keys))
        AND mc.generation_key_version = @version
        AND EXISTS (
          SELECT 1
          FROM file_instances fi
          INNER JOIN directories d ON d.id = fi.directory_id
          WHERE fi.fingerprint = mc.fingerprint
            AND fi.is_present != 0
            AND d.is_present != 0
        )
    ),
    tops AS (
      SELECT generation_key, MAX(rating) AS max_rating FROM present GROUP BY generation_key
    )
    SELECT p.generation_key,
      COUNT(*) AS version_count,
      MAX(p.pixels) AS max_pixels,
      MIN(p.measured) AS min_pixels,
      t.max_rating,
      MAX(CASE WHEN p.rating IS NULL OR p.rating = t.max_rating THEN p.pixels END) AS best_pixels,
      MAX(CASE WHEN p.rating IS NULL THEN p.pixels END) AS unrated_max_pixels
    FROM present p
    INNER JOIN tops t ON t.generation_key = p.generation_key
    GROUP BY p.generation_key;
  `);
  const generationKeyForInstance = db.prepare(`
    SELECT fi.fingerprint, mc.generation_key, mc.generation_key_version,
      mc.prompt_key, mc.prompt_key_version
    FROM file_instances fi
    INNER JOIN media_content mc ON mc.fingerprint = fi.fingerprint
    WHERE fi.id = ?;
  `);
  const generationVersionSiblingRows = db.prepare(`
    SELECT mc.fingerprint, mc.width, mc.height, mc.duration_ms,
      fi.id AS instance_id, fi.relative_path, fi.mtime_ms,
      lr.root_path,
      CASE WHEN r.value BETWEEN 1 AND 5 THEN r.value END AS rating
    FROM media_content mc
    INNER JOIN file_instances fi ON fi.fingerprint = mc.fingerprint
    INNER JOIN directories d ON d.id = fi.directory_id
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    LEFT JOIN ratings r ON r.fingerprint = mc.fingerprint
    WHERE mc.generation_key = @generation_key
      AND mc.generation_key_version = @version
      AND fi.is_present != 0
      AND d.is_present != 0
    ORDER BY mc.fingerprint, fi.id
    LIMIT @limit;
  `);

  // Every present instance of one generation's versions, with the tag
  // view's columns, for the versions view.
  // Review passes. A clip is decided once it has a review state other than
  // unreviewed, a rating counting as reviewed, as everywhere else.
  const reviewPassInsert = db.prepare(`
    INSERT INTO review_passes (
      name, source, definition_json, location_json, clip_count, cursor_position,
      created_at, updated_at
    ) VALUES (@name, @source, @definition_json, @location_json, @clip_count, 0, @now, @now);
  `);
  const reviewPassClipInsert = db.prepare(`
    INSERT INTO review_pass_clips (pass_id, position, fingerprint, instance_id)
    VALUES (?, ?, ?, ?);
  `);
  const reviewPassSummaries = db.prepare(`
    SELECT p.*,
      (
        SELECT COUNT(*) FROM review_pass_clips c
        LEFT JOIN ratings r ON r.fingerprint = c.fingerprint
        LEFT JOIN content_review cr ON cr.fingerprint = c.fingerprint
        WHERE c.pass_id = p.id
          AND COALESCE(cr.state,
            CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
          ) != 'unreviewed'
      ) AS decided
    FROM review_passes p
    ORDER BY p.updated_at DESC, p.id DESC;
  `);
  const reviewPassById = db.prepare('SELECT * FROM review_passes WHERE id = ?;');
  const reviewPassPrune = db.prepare(`
    DELETE FROM review_passes WHERE id IN (
      SELECT id FROM review_passes
      ORDER BY (finished_at IS NULL) DESC, updated_at DESC, id DESC
      LIMIT -1 OFFSET @keep
    );
  `);
  const reviewPassCursor = db.prepare(`
    UPDATE review_passes SET cursor_position = @position, updated_at = @now WHERE id = @id;
  `);
  const reviewPassFinish = db.prepare(`
    UPDATE review_passes SET finished_at = COALESCE(finished_at, @now), updated_at = @now
    WHERE id = @id;
  `);
  const reviewPassDelete = db.prepare('DELETE FROM review_passes WHERE id = ?;');
  // Each position's clip as one present instance: the one the pass was made
  // from while it is present, otherwise the copy seen most recently.
  const reviewPassInstances = db.prepare(`
    SELECT * FROM (
    SELECT c.position AS pass_position, fi.*,
      ROW_NUMBER() OVER (
        PARTITION BY c.position
        ORDER BY (fi.id = c.instance_id) DESC, fi.last_seen_at DESC, fi.id
      ) AS position_rank,
      lr.root_path AS owner_root_path,
      mc.created_ms AS content_created_ms,
      mc.width AS content_width,
      mc.height AS content_height,
      mc.has_audio AS content_has_audio,
      mc.duration_ms AS content_duration_ms,
      mc.frame_rate AS content_frame_rate,
      mc.generation_key AS content_generation_key,
      mc.generation_key_version AS content_generation_key_version,
      mc.prompt_key AS content_prompt_key,
      mc.prompt_key_version AS content_prompt_key_version,
      r.value AS rating_value,
      COALESCE(cr.state,
        CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
      ) AS review_state
    FROM review_pass_clips c
    INNER JOIN file_instances fi ON fi.fingerprint = c.fingerprint
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    INNER JOIN directories d ON d.id = fi.directory_id
    LEFT JOIN media_content mc ON mc.fingerprint = fi.fingerprint
    LEFT JOIN ratings r ON r.fingerprint = fi.fingerprint
    LEFT JOIN content_review cr ON cr.fingerprint = fi.fingerprint
    WHERE c.pass_id = @pass_id
      AND fi.is_present != 0
      AND d.is_present != 0
      AND lr.root_path NOT IN (SELECT value FROM json_each(@unavailable_root_paths))
    )
    WHERE position_rank = 1
    ORDER BY pass_position;
  `);

  const generationVersionInstances = db.prepare(`
    SELECT * FROM (
    SELECT fi.*,
      ROW_NUMBER() OVER (
        PARTITION BY fi.absolute_path
        ORDER BY fi.last_seen_at DESC, LENGTH(lr.root_path) DESC, fi.id
      ) AS path_rank,
      lr.root_path AS owner_root_path,
      mc.created_ms AS content_created_ms,
      mc.width AS content_width,
      mc.height AS content_height,
      mc.has_audio AS content_has_audio,
      mc.duration_ms AS content_duration_ms,
      mc.frame_rate AS content_frame_rate,
      mc.generation_key AS content_generation_key,
      mc.generation_key_version AS content_generation_key_version,
      mc.prompt_key AS content_prompt_key,
      mc.prompt_key_version AS content_prompt_key_version,
      r.value AS rating_value,
      COALESCE(cr.state,
        CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
      ) AS review_state
    FROM media_content mc
    INNER JOIN file_instances fi ON fi.fingerprint = mc.fingerprint
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    INNER JOIN directories d ON d.id = fi.directory_id
    LEFT JOIN ratings r ON r.fingerprint = fi.fingerprint
    LEFT JOIN content_review cr ON cr.fingerprint = fi.fingerprint
    WHERE mc.generation_key = @generation_key
      AND mc.generation_key_version = @version
      AND fi.is_present != 0
      AND d.is_present != 0
      AND lr.root_path NOT IN (SELECT value FROM json_each(@unavailable_root_paths))
    )
    WHERE path_rank = 1
    ORDER BY fingerprint, id
    LIMIT @limit;
  `);

  // The rating arena's pool (rating-arena.md, Section 2): each present
  // content once, as the copy seen most recently, in roots that can be
  // opened; the whole library or the rows the renderer showed.
  const arenaPoolRows = db.prepare(`
    SELECT fingerprint, id, prompt_key, prompt_key_version, generation_key,
      generation_key_version, width, height, duration_ms, mtime_ms, rating FROM (
      SELECT fi.fingerprint, fi.id, mc.prompt_key, mc.prompt_key_version,
        mc.generation_key, mc.generation_key_version, mc.width, mc.height,
        mc.duration_ms, fi.mtime_ms,
        (SELECT CASE WHEN r.value BETWEEN 1 AND 5 THEN r.value END
          FROM ratings r WHERE r.fingerprint = fi.fingerprint) AS rating,
        ROW_NUMBER() OVER (
          PARTITION BY fi.fingerprint
          ORDER BY fi.last_seen_at DESC, fi.id
        ) AS content_rank
      FROM file_instances fi
      INNER JOIN library_roots lr ON lr.id = fi.root_id
      INNER JOIN directories d ON d.id = fi.directory_id
      INNER JOIN media_content mc ON mc.fingerprint = fi.fingerprint
      WHERE fi.is_present != 0
        AND d.is_present != 0
        AND lr.root_path NOT IN (SELECT value FROM json_each(@unavailable_root_paths))
        AND (@instance_ids IS NULL OR fi.id IN (SELECT value FROM json_each(@instance_ids)))
    )
    WHERE content_rank = 1
    LIMIT @limit;
  `);
  const arenaRatingRows = db.prepare(
    'SELECT fingerprint, value FROM ratings WHERE value BETWEEN 1 AND 5;'
  );
  const arenaRejectRows = db.prepare(
    "SELECT fingerprint FROM content_review WHERE state = 'reject';"
  );
  const arenaCheckRows = db.prepare(`
    SELECT id, fingerprint, checked_at, kind, outcome FROM arena_checks
    ORDER BY checked_at, id;
  `);
  const arenaCheckInsert = db.prepare(`
    INSERT INTO arena_checks (fingerprint, checked_at, kind, outcome, rating_before, rating_after)
    SELECT @fingerprint, @checked_at, @kind, @outcome, @rating_before, @rating_after
    WHERE EXISTS (SELECT 1 FROM media_content WHERE fingerprint = @fingerprint);
  `);
  const arenaCheckDelete = db.prepare('DELETE FROM arena_checks WHERE id = ?;');
  const arenaCheckPrune = db.prepare(`
    DELETE FROM arena_checks WHERE id IN (
      SELECT id FROM arena_checks ORDER BY checked_at DESC, id DESC
      LIMIT -1 OFFSET @keep
    );
  `);
  // A round's clips as playable records, by the rows the pool chose.
  const arenaRecordInstances = db.prepare(`
    SELECT fi.*,
      lr.root_path AS owner_root_path,
      mc.created_ms AS content_created_ms,
      mc.width AS content_width,
      mc.height AS content_height,
      mc.has_audio AS content_has_audio,
      mc.duration_ms AS content_duration_ms,
      mc.frame_rate AS content_frame_rate,
      mc.generation_key AS content_generation_key,
      mc.generation_key_version AS content_generation_key_version,
      mc.prompt_key AS content_prompt_key,
      mc.prompt_key_version AS content_prompt_key_version,
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
    WHERE fi.id IN (SELECT value FROM json_each(@instance_ids))
      AND fi.is_present != 0
      AND d.is_present != 0
      AND lr.root_path NOT IN (SELECT value FROM json_each(@unavailable_root_paths));
  `);

  // Contents asked about whose workflow has not been read yet.
  const workflowFactsUnread = db.prepare(`
    SELECT COUNT(*) AS unread FROM media_content
    WHERE fingerprint IN (SELECT value FROM json_each(@fingerprints))
      AND (workflow_facts_version IS NULL OR workflow_facts_version != @facts_version);
  `);

  // Similar-prompt stacks read a prompt back from one present clip carrying
  // the key; main/prompt-similarity.js verifies it still matches.
  const promptKeyInstanceRows = db.prepare(`
    SELECT fi.absolute_path, fi.size, fi.mtime_ms, lr.root_path
    FROM media_content mc
    INNER JOIN file_instances fi ON fi.fingerprint = mc.fingerprint
    INNER JOIN directories d ON d.id = fi.directory_id
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    WHERE mc.prompt_key = @prompt_key
      AND mc.prompt_key_version = @prompt_version
      AND fi.is_present != 0
      AND d.is_present != 0
    ORDER BY fi.id
    LIMIT @limit;
  `);

  // Every prompt key with a present clip, for prompt search across the
  // library (prompt-search-and-tag-suggestions.md).
  const libraryPromptKeyRows = db.prepare(`
    SELECT DISTINCT mc.prompt_key
    FROM media_content mc
    INNER JOIN file_instances fi ON fi.fingerprint = mc.fingerprint
    INNER JOIN directories d ON d.id = fi.directory_id
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    WHERE mc.prompt_key IS NOT NULL
      AND mc.prompt_key_version = @prompt_version
      AND fi.is_present != 0
      AND d.is_present != 0
      AND lr.root_path NOT IN (SELECT value FROM json_each(@unavailable_root_paths));
  `);

  const frameRowsForInstances = db.prepare(`
    SELECT fi.id AS instance_id, fi.fingerprint, fi.absolute_path,
      lr.root_path, ff.frame_hash, ff.version AS frame_version
    FROM file_instances fi
    INNER JOIN library_roots lr ON lr.id = fi.root_id
    LEFT JOIN frame_fingerprints ff ON ff.fingerprint = fi.fingerprint
    WHERE fi.id IN (SELECT value FROM json_each(@instance_ids))
      AND fi.is_present != 0
      AND fi.fingerprint IS NOT NULL;
  `);
  const upsertFrameFingerprint = db.prepare(`
    INSERT INTO frame_fingerprints (fingerprint, frame_hash, version, updated_at)
    SELECT @fingerprint, @frame_hash, @version, @updated_at
    WHERE EXISTS (SELECT 1 FROM media_content WHERE fingerprint = @fingerprint)
    ON CONFLICT(fingerprint) DO UPDATE SET
      frame_hash = excluded.frame_hash,
      version = excluded.version,
      updated_at = excluded.updated_at;
  `);

  function normalizeInstanceIdList(instanceIds) {
    if (instanceIds === null || instanceIds === undefined) return null;
    if (!Array.isArray(instanceIds)) {
      throw new TypeError('Instance ids must be an array');
    }
    const ids = [...new Set(instanceIds)].filter(
      (id) => Number.isSafeInteger(id) && id > 0
    );
    if (ids.length > GENERATION_VERSION_LIMITS.maxRequestedInstances) {
      throw new RangeError(
        `At most ${GENERATION_VERSION_LIMITS.maxRequestedInstances} instances can be requested`
      );
    }
    return JSON.stringify(ids);
  }

  function getGenerationKeyFields(fingerprints) {
    const unique = [...new Set((fingerprints || []).filter(Boolean))];
    const result = new Map();
    if (unique.length === 0) return result;
    generationKeysForFingerprints
      .all({ fingerprints: JSON.stringify(unique) })
      .forEach((row) => {
        result.set(
          row.fingerprint,
          mapGenerationKeyFields(
            row.generation_key,
            row.generation_key_version,
            row.prompt_key,
            row.prompt_key_version
          )
        );
      });
    return result;
  }

  function listGenerationKeyCandidates(options = {}) {
    const afterId = Number(options.afterInstanceId ?? 0);
    const limit = Number(options.limit ?? GENERATION_VERSION_LIMITS.maxCandidatePage);
    if (!Number.isSafeInteger(afterId) || afterId < 0) {
      throw new RangeError('Candidate cursor must be a non-negative integer');
    }
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > GENERATION_VERSION_LIMITS.maxCandidatePage
    ) {
      throw new RangeError('Candidate page size is out of range');
    }
    return generationKeyCandidates
      .all({
        after_id: afterId,
        version: GENERATION_KEY_VERSION,
        prompt_version: PROMPT_KEY_VERSION,
        facts_version: WORKFLOW_FACTS_VERSION,
        instance_ids: normalizeInstanceIdList(options.instanceIds),
        limit,
      })
      .map((row) => ({
        instanceId: Number(row.instance_id),
        fingerprint: row.fingerprint,
        absolutePath: row.absolute_path,
        rootPath: row.root_path,
        size: Number(row.size || 0),
        mtimeMs: Number(row.mtime_ms || 0),
      }));
  }

  // Already-evaluated content among the named instances, so a renderer whose
  // records predate a write can catch up without re-reading any file.
  function listEvaluatedGenerationKeys(instanceIds) {
    const ids = normalizeInstanceIdList(instanceIds);
    if (ids === null) return [];
    return evaluatedGenerationKeysForInstances
      .all({
        instance_ids: ids,
        version: GENERATION_KEY_VERSION,
        prompt_version: PROMPT_KEY_VERSION,
      })
      .map((row) => ({
        fingerprint: row.fingerprint,
        generationKey: isGenerationKey(row.generation_key) ? row.generation_key : null,
        promptKey: isPromptKey(row.prompt_key) ? row.prompt_key : null,
      }));
  }

  function countGenerationKeyCandidates(options = {}) {
    const row = generationKeyCandidateCount.get({
      version: GENERATION_KEY_VERSION,
      prompt_version: PROMPT_KEY_VERSION,
      facts_version: WORKFLOW_FACTS_VERSION,
      instance_ids: normalizeInstanceIdList(options.instanceIds),
    });
    return Number(row?.pending || 0);
  }

  // `entries` are `{ fingerprint, generationKey, promptKey }` where null keys
  // record a definitive "not keyable". Both keys come from one evaluation and
  // exist together, so an entry with only one of them is refused, as are
  // invalid keys, rather than stored.
  function setGenerationKeys(entries, options = {}) {
    if (!Array.isArray(entries)) throw new TypeError('Entries must be an array');
    if (entries.length > GENERATION_VERSION_LIMITS.maxWriteBatch) {
      throw new RangeError('Too many generation keys in one write');
    }
    const normalized = entries.map((entry) => {
      const fingerprint = entry?.fingerprint;
      const generationKey = entry?.generationKey ?? null;
      const promptKey = entry?.promptKey ?? null;
      if (typeof fingerprint !== 'string' || !fingerprint) {
        throw new TypeError('A fingerprint is required');
      }
      if (generationKey !== null && !isGenerationKey(generationKey)) {
        throw new TypeError('Invalid generation key');
      }
      if (promptKey !== null && !isPromptKey(promptKey)) {
        throw new TypeError('Invalid prompt key');
      }
      if ((generationKey === null) !== (promptKey === null)) {
        throw new TypeError('Generation and prompt keys must be stored together');
      }
      return { fingerprint, generationKey, promptKey, ...normalizeWorkflowFacts(entry) };
    });
    assertOperationActive(options.assertActive);
    const updatedAt = Date.now();
    let updated = 0;
    db.transaction(() => {
      normalized.forEach((entry) => {
        updated += setGenerationKeyStmt.run({
          fingerprint: entry.fingerprint,
          generation_key: entry.generationKey,
          version: GENERATION_KEY_VERSION,
          prompt_key: entry.promptKey,
          prompt_version: PROMPT_KEY_VERSION,
          workflow_steps: entry.workflowSteps,
          workflow_terms: entry.workflowTerms,
          facts_version: WORKFLOW_FACTS_VERSION,
          updated_at: updatedAt,
        }).changes;
      });
    })();
    return updated;
  }

  // Workflow facts ride with the keys, read from the same file. Terms are
  // node types and weight-file names: short, single-line, no prompt text.
  function normalizeWorkflowFacts(entry) {
    const steps = entry?.workflowSteps ?? null;
    if (steps !== null && !(Number.isSafeInteger(steps) && steps > 0 && steps <= 100_000)) {
      throw new TypeError('Invalid workflow steps');
    }
    const terms = entry?.workflowTerms ?? null;
    if (terms !== null) {
      if (!Array.isArray(terms) || terms.length > WORKFLOW_FACT_LIMITS.maxTerms) {
        throw new TypeError('Invalid workflow terms');
      }
      for (const term of terms) {
        if (
          typeof term !== 'string' ||
          !term ||
          term.length > WORKFLOW_FACT_LIMITS.maxTermChars ||
          /[\r\n]/u.test(term) ||
          term !== term.toLowerCase()
        ) {
          throw new TypeError('Invalid workflow term');
        }
      }
    }
    return {
      workflowSteps: steps,
      workflowTerms: terms === null ? null : [...new Set(terms)].sort().join('\n'),
    };
  }

  /**
   * Which of these contents' workflows match: every `include` word appears
   * in one of its node types or weight-file names, no `exclude` word does,
   * and its steps setting is within the bounds. Content whose workflow has
   * not been read, or has none, never matches. Words never leave main; only
   * fingerprints come back.
   */
  function matchWorkflowFacts(fingerprints, options = {}) {
    assertOperationActive(options.assertActive);
    if (!Array.isArray(fingerprints)) throw new TypeError('Fingerprints must be an array');
    if (fingerprints.length > WORKFLOW_FACT_LIMITS.maxMatchFingerprints) {
      throw new RangeError('Too many clips in one workflow match');
    }
    const words = (list) =>
      (Array.isArray(list) ? list : [])
        .map((word) => String(word).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, WORKFLOW_FACT_LIMITS.maxWords);
    const include = words(options.include);
    const exclude = words(options.exclude);
    const bound = (value) =>
      Number.isSafeInteger(value) && value > 0 && value <= 100_000 ? value : null;
    const minSteps = bound(options.minSteps);
    const maxSteps = bound(options.maxSteps);
    const conditions = [
      'workflow_facts_version = @facts_version',
      'workflow_terms IS NOT NULL',
      'fingerprint IN (SELECT value FROM json_each(@fingerprints))',
    ];
    const params = {
      facts_version: WORKFLOW_FACTS_VERSION,
      fingerprints: JSON.stringify(fingerprints.filter((value) => typeof value === 'string')),
    };
    if (minSteps !== null) {
      conditions.push('workflow_steps >= @min_steps');
      params.min_steps = minSteps;
    }
    if (maxSteps !== null) {
      conditions.push('workflow_steps <= @max_steps');
      params.max_steps = maxSteps;
    }
    include.forEach((word, index) => {
      conditions.push(`instr(workflow_terms, @include_${index}) > 0`);
      params[`include_${index}`] = word;
    });
    exclude.forEach((word, index) => {
      conditions.push(`instr(workflow_terms, @exclude_${index}) = 0`);
      params[`exclude_${index}`] = word;
    });
    const rows = db
      .prepare(`SELECT fingerprint FROM media_content WHERE ${conditions.join(' AND ')}`)
      .all(params);
    const unread = workflowFactsUnread.get({
      fingerprints: params.fingerprints,
      facts_version: WORKFLOW_FACTS_VERSION,
    });
    assertOperationActive(options.assertActive);
    return {
      matches: rows.map((row) => row.fingerprint),
      unread: Number(unread?.unread || 0),
    };
  }

  function getGenerationVersionSummaries(keys) {
    if (!Array.isArray(keys)) throw new TypeError('Keys must be an array');
    const unique = [...new Set(keys.filter(isGenerationKey))];
    if (unique.length > GENERATION_VERSION_LIMITS.maxSummaryKeys) {
      throw new RangeError('Too many generation keys in one summary request');
    }
    const summaries = {};
    if (unique.length === 0) return summaries;
    generationVersionSummaries
      .all({ keys: JSON.stringify(unique), version: GENERATION_KEY_VERSION })
      .forEach((row) => {
        summaries[row.generation_key] = {
          versionCount: Number(row.version_count || 0),
          maxPixels: Number(row.max_pixels || 0),
          // The smallest measured version, for "has a lower-resolution
          // version"; 0 when none is measured.
          minPixels: Number(row.min_pixels || 0),
          // For the best version: ratings overrule size.
          maxRating: row.max_rating === null ? null : Number(row.max_rating),
          bestPixels: Number(row.best_pixels || 0),
          unratedMaxPixels: Number(row.unrated_max_pixels || 0),
        };
      });
    return summaries;
  }

  // Tag suggestions (prompt-search-and-tag-suggestions.md, Section 2): what
  // the learning reads, per present content with a current prompt key.
  const tagSuggestionLinkRows = db.prepare(`
    SELECT mc.prompt_key AS prompt_key, ft.fingerprint AS fingerprint, ft.tag_id AS tag_id
    FROM file_tags ft
    INNER JOIN media_content mc ON mc.fingerprint = ft.fingerprint
    WHERE mc.prompt_key IS NOT NULL
      AND mc.prompt_key_version = @prompt_version
      AND EXISTS (
        SELECT 1 FROM file_instances fi
        WHERE fi.fingerprint = ft.fingerprint AND fi.is_present != 0
      )
    ORDER BY ft.fingerprint, ft.tag_id;
  `);
  const tagSuggestionDismissalRows = db.prepare(`
    SELECT mc.prompt_key AS prompt_key, ds.fingerprint AS fingerprint, ds.tag_id AS tag_id
    FROM tag_suggestion_dismissals ds
    INNER JOIN media_content mc ON mc.fingerprint = ds.fingerprint
    WHERE mc.prompt_key IS NOT NULL
      AND mc.prompt_key_version = @prompt_version
      AND EXISTS (
        SELECT 1 FROM file_instances fi
        WHERE fi.fingerprint = ds.fingerprint AND fi.is_present != 0
      )
    ORDER BY ds.fingerprint, ds.tag_id;
  `);
  const tagSuggestionTargetRows = db.prepare(`
    SELECT fi.id AS instance_id, fi.fingerprint, mc.prompt_key, mc.prompt_key_version,
      (SELECT group_concat(ft.tag_id) FROM file_tags ft
        WHERE ft.fingerprint = fi.fingerprint) AS tag_ids,
      (SELECT group_concat(ds.tag_id) FROM tag_suggestion_dismissals ds
        WHERE ds.fingerprint = fi.fingerprint) AS dismissed_tag_ids
    FROM file_instances fi
    LEFT JOIN media_content mc ON mc.fingerprint = fi.fingerprint
    WHERE fi.id IN (SELECT value FROM json_each(@instance_ids))
      AND fi.is_present != 0
      AND fi.fingerprint IS NOT NULL;
  `);
  const insertTagSuggestionDismissal = db.prepare(`
    INSERT INTO tag_suggestion_dismissals (fingerprint, tag_id, dismissed_at)
    SELECT @fingerprint, @tag_id, @dismissed_at
    WHERE EXISTS (SELECT 1 FROM media_content WHERE fingerprint = @fingerprint)
    ON CONFLICT(fingerprint, tag_id) DO NOTHING;
  `);

  const TAG_SUGGESTION_MAX_TARGETS = 50_000;
  const idList = (value) =>
    String(value || '')
      .split(',')
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0);

  /**
   * What tag suggestions learn from: the tag tree, and the tags and turned-
   * down suggestions of present contents with a prompt key, as
   * `{ promptKey, fingerprint, tagId }` rows.
   */
  function getTagSuggestionLabels() {
    const toRow = (row) => ({
      promptKey: row.prompt_key,
      fingerprint: row.fingerprint,
      tagId: Number(row.tag_id),
    });
    return {
      tags: tagRows.all().map((row) => ({
        id: Number(row.id),
        name: row.name,
        parentId: row.parentId == null ? null : Number(row.parentId),
      })),
      links: tagSuggestionLinkRows.all({ prompt_version: PROMPT_KEY_VERSION }).map(toRow),
      dismissals: tagSuggestionDismissalRows
        .all({ prompt_version: PROMPT_KEY_VERSION })
        .map(toRow),
    };
  }

  /** Present catalog rows with their prompt key, tags and turned-down tags. */
  function getTagSuggestionTargets(instanceIds) {
    const ids = [...new Set((instanceIds || []).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids.length === 0) return [];
    if (ids.length > TAG_SUGGESTION_MAX_TARGETS) {
      throw new RangeError(`At most ${TAG_SUGGESTION_MAX_TARGETS} clips can be checked at once`);
    }
    return tagSuggestionTargetRows.all({ instance_ids: JSON.stringify(ids) }).map((row) => ({
      instanceId: Number(row.instance_id),
      fingerprint: row.fingerprint,
      promptKey:
        Number(row.prompt_key_version) === PROMPT_KEY_VERSION && isPromptKey(row.prompt_key)
          ? row.prompt_key
          : null,
      tagIds: idList(row.tag_ids),
      dismissedTagIds: idList(row.dismissed_tag_ids),
    }));
  }

  /**
   * Remembers that these contents are not `tagName`, so it is not suggested
   * for them again. Returns how many were newly turned down; a tag that does
   * not exist turns nothing down.
   */
  function dismissTagSuggestion(fingerprints, tagName) {
    const tag = tagSelect.get(String(tagName || '').trim());
    if (!tag?.id) return 0;
    const now = Date.now();
    let dismissed = 0;
    db.transaction(() => {
      for (const fingerprint of new Set(fingerprints || [])) {
        if (typeof fingerprint !== 'string' || !fingerprint) continue;
        dismissed += insertTagSuggestionDismissal.run({
          fingerprint,
          tag_id: tag.id,
          dismissed_at: now,
        }).changes;
      }
    })();
    return dismissed;
  }

  // The local read API (local-read-api.md): clips by path or content, and
  // the change log.
  const metadataSequence = db.prepare(
    "SELECT seq FROM sqlite_sequence WHERE name = 'metadata_changes';"
  );
  const metadataOldestRevision = db.prepare(
    'SELECT MIN(revision) AS oldest FROM metadata_changes;'
  );
  const metadataChangesAfter = db.prepare(`
    SELECT revision, fingerprint, kind FROM metadata_changes
    WHERE revision > ? ORDER BY revision LIMIT ?;
  `);
  const localApiPathRows = db.prepare(`
    SELECT * FROM (
      SELECT fi.absolute_path AS absolute_path, fi.fingerprint,
        ROW_NUMBER() OVER (
          PARTITION BY fi.absolute_path
          ORDER BY fi.last_seen_at DESC, LENGTH(lr.root_path) DESC, fi.id
        ) AS path_rank
      FROM file_instances fi
      INNER JOIN library_roots lr ON lr.id = fi.root_id
      INNER JOIN directories d ON d.id = fi.directory_id
      WHERE fi.absolute_path IN (SELECT value FROM json_each(@paths))
        AND fi.is_present != 0
        AND d.is_present != 0
        AND fi.fingerprint IS NOT NULL
    )
    WHERE path_rank = 1;
  `);
  const localApiContentRows = db.prepare(`
    SELECT mc.fingerprint, mc.prompt_key, mc.prompt_key_version,
      mc.generation_key, mc.generation_key_version,
      r.value AS rating,
      COALESCE(cr.state,
        CASE WHEN r.fingerprint IS NULL THEN 'unreviewed' ELSE 'reviewed' END
      ) AS review_state
    FROM media_content mc
    LEFT JOIN ratings r ON r.fingerprint = mc.fingerprint
    LEFT JOIN content_review cr ON cr.fingerprint = mc.fingerprint
    WHERE mc.fingerprint IN (SELECT value FROM json_each(@fingerprints));
  `);

  /** The last revision the change log handed out; 0 before any change. */
  function getMetadataRevision() {
    return Number(metadataSequence.get()?.seq || 0);
  }

  /**
   * What changed after revision `since`: `{ revision, changed, tagTreeChanged,
   * reset, more }`. `changed` lists contents whose tags, rating or review
   * state changed; `revision` is where to ask from next. `reset` says the log
   * no longer reaches back that far (or `since` is from elsewhere): read
   * everything again.
   */
  function listMetadataChangesSince(since) {
    const current = getMetadataRevision();
    const oldest = metadataOldestRevision.get()?.oldest;
    const gone = oldest == null ? since < current : since < Number(oldest) - 1;
    if (!Number.isSafeInteger(since) || since < 0 || since > current || gone) {
      return { revision: current, changed: [], tagTreeChanged: false, reset: true, more: false };
    }
    const limit = METADATA_CHANGE_LIMITS.readLimit;
    const rows = metadataChangesAfter.all(since, limit + 1);
    const more = rows.length > limit;
    const kept = more ? rows.slice(0, limit) : rows;
    return {
      revision: kept.length ? Number(kept[kept.length - 1].revision) : since,
      changed: [
        ...new Set(kept.filter((row) => row.kind === 'clip' && row.fingerprint).map((row) => row.fingerprint)),
      ],
      tagTreeChanged: kept.some((row) => row.kind === 'tags'),
      reset: false,
      more,
    };
  }

  /**
   * Clips for the local read API, by present path or by content id: a Map of
   * each key found to `{ contentId, tags, rating, review, hasPrompt,
   * promptKey, generationKey }`. Keys not found are left out.
   */
  function getLocalApiClips({ paths = [], contentIds = [] } = {}) {
    const fingerprintByKey = new Map();
    if (paths.length) {
      for (const row of localApiPathRows.all({ paths: JSON.stringify(paths) })) {
        fingerprintByKey.set(row.absolute_path, row.fingerprint);
      }
    }
    for (const id of contentIds) fingerprintByKey.set(id, id);
    const fingerprints = [...new Set(fingerprintByKey.values())];
    const contents = new Map();
    if (fingerprints.length) {
      for (const row of localApiContentRows.all({ fingerprints: JSON.stringify(fingerprints) })) {
        contents.set(row.fingerprint, row);
      }
    }
    // Where each tag sits: its name and every name above it, top first.
    const tags = tagRows.all();
    const byId = new Map(tags.map((row) => [row.id, row]));
    const byName = new Map(tags.map((row) => [row.name.toLowerCase(), row]));
    const pathOf = (name) => {
      const names = [];
      const seen = new Set();
      let row = byName.get(String(name).toLowerCase());
      while (row && !seen.has(row.id) && names.length <= MAX_TAG_DEPTH) {
        seen.add(row.id);
        names.unshift(row.name);
        row = row.parentId == null ? null : byId.get(row.parentId);
      }
      return names;
    };
    const clips = new Map();
    const shaped = new Map();
    for (const [key, fingerprint] of fingerprintByKey) {
      const row = contents.get(fingerprint);
      if (!row) continue;
      if (!shaped.has(fingerprint)) {
        const promptCurrent = Number(row.prompt_key_version) === PROMPT_KEY_VERSION;
        const generationCurrent = Number(row.generation_key_version) === GENERATION_KEY_VERSION;
        const rating = Number(row.rating);
        shaped.set(fingerprint, {
          contentId: fingerprint,
          tags: tagsForFingerprint.all(fingerprint).map(({ name }) => ({ name, path: pathOf(name) })),
          rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
          review: REVIEW_STATES.has(row.review_state) ? row.review_state : 'unreviewed',
          // Unknown until the clip's embedded metadata has been read.
          hasPrompt: promptCurrent ? isPromptKey(row.prompt_key) : null,
          promptKey: promptCurrent && isPromptKey(row.prompt_key) ? row.prompt_key : null,
          generationKey:
            generationCurrent && isGenerationKey(row.generation_key) ? row.generation_key : null,
        });
      }
      clips.set(key, shaped.get(fingerprint));
    }
    return clips;
  }

  /**
   * Present catalog rows with their stored first-frame fingerprint, if any of
   * `version`. Rows of contents without one are returned with `frameHash`
   * null, for the caller to grab.
   */
  function getFrameRows(instanceIds, version) {
    const ids = [...new Set((instanceIds || []).filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids.length === 0) return [];
    if (ids.length > 5000) throw new RangeError('At most 5000 frame rows can be read at once');
    return frameRowsForInstances.all({ instance_ids: JSON.stringify(ids) }).map((row) => ({
      instanceId: Number(row.instance_id),
      fingerprint: row.fingerprint,
      absolutePath: row.absolute_path,
      rootPath: row.root_path,
      frameHash:
        Number(row.frame_version) === version && /^[0-9a-f]{16}$/u.test(row.frame_hash || '')
          ? row.frame_hash
          : null,
    }));
  }

  function setFrameFingerprint(fingerprint, frameHash, version) {
    if (typeof fingerprint !== 'string' || !fingerprint) return false;
    if (!/^[0-9a-f]{16}$/u.test(frameHash || '')) {
      throw new TypeError('A frame fingerprint is 16 hex digits');
    }
    return (
      upsertFrameFingerprint.run({
        fingerprint,
        frame_hash: frameHash,
        version,
        updated_at: Date.now(),
      }).changes > 0
    );
  }

  function listLibraryPromptKeys({ unavailableRootPaths = [] } = {}) {
    return libraryPromptKeyRows
      .all({
        prompt_version: PROMPT_KEY_VERSION,
        unavailable_root_paths: JSON.stringify(
          (Array.isArray(unavailableRootPaths) ? unavailableRootPaths : []).filter(
            (rootPath) => typeof rootPath === 'string' && rootPath
          )
        ),
      })
      .map((row) => row.prompt_key);
  }

  function listPresentInstancesForPromptKey(promptKey, limit = 3) {
    if (!isPromptKey(promptKey)) return [];
    const bounded = Math.max(1, Math.min(16, Number(limit) || 3));
    return promptKeyInstanceRows
      .all({ prompt_key: promptKey, prompt_version: PROMPT_KEY_VERSION, limit: bounded })
      .map((row) => ({
        absolutePath: row.absolute_path,
        rootPath: row.root_path,
        size: Number(row.size || 0),
        mtimeMs: Number(row.mtime_ms || 0),
      }));
  }

  // Siblings are grouped by content; the representative instance of the
  // requested content is the requested instance itself.
  function getGenerationVersionSiblings(instanceId) {
    if (!Number.isSafeInteger(instanceId) || instanceId < 1) {
      throw new TypeError('A valid instance id is required');
    }
    const self = generationKeyForInstance.get(instanceId);
    const selfFields = self
      ? mapGenerationKeyFields(
        self.generation_key,
        self.generation_key_version,
        self.prompt_key,
        self.prompt_key_version
      )
      : {};
    if (!selfFields.generationKey) {
      return {
        generationKey: null,
        checked: Boolean(selfFields.generationKeyChecked),
        versions: [],
        truncated: false,
      };
    }
    const rows = generationVersionSiblingRows.all({
      generation_key: selfFields.generationKey,
      version: GENERATION_KEY_VERSION,
      limit: GENERATION_VERSION_LIMITS.maxSiblingRows + 1,
    });
    const rowsTruncated = rows.length > GENERATION_VERSION_LIMITS.maxSiblingRows;
    const byFingerprint = new Map();
    rows.slice(0, GENERATION_VERSION_LIMITS.maxSiblingRows).forEach((row) => {
      const width = Number(row.width || 0);
      const height = Number(row.height || 0);
      const existing = byFingerprint.get(row.fingerprint);
      const isRequested = Number(row.instance_id) === instanceId;
      if (existing) {
        existing.instanceCount += 1;
        existing.mtimeMs = Math.max(existing.mtimeMs, Number(row.mtime_ms || 0));
        if (isRequested) {
          existing.instanceId = instanceId;
          existing.relativePath = row.relative_path;
          existing.rootPath = row.root_path;
        }
        return;
      }
      byFingerprint.set(row.fingerprint, {
        fingerprint: row.fingerprint,
        instanceId: Number(row.instance_id),
        rootPath: row.root_path,
        relativePath: row.relative_path,
        width: width > 0 && height > 0 ? width : null,
        height: width > 0 && height > 0 ? height : null,
        durationMs: normalizeDurationMs(row.duration_ms),
        mtimeMs: Number(row.mtime_ms || 0),
        rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
        instanceCount: 1,
        isSelf: row.fingerprint === self.fingerprint,
      });
    });
    // Best first: ratings overrule size (generationVersions.mjs).
    const ordered = orderVersions([...byFingerprint.values()], (version) => ({
      rating: version.rating,
      pixels: (version.width || 0) * (version.height || 0),
      durationMs: version.durationMs || 0,
      mtimeMs: version.mtimeMs,
      key: version.fingerprint,
    }));
    let versions = ordered.slice(0, GENERATION_VERSION_LIMITS.maxSiblingVersions);
    if (!versions.some((version) => version.isSelf)) {
      const selfVersion = ordered.find((version) => version.isSelf);
      if (selfVersion) versions = [...versions.slice(0, -1), selfVersion];
    }
    return {
      generationKey: selfFields.generationKey,
      checked: true,
      versions,
      truncated:
        rowsTruncated ||
        ordered.length > GENERATION_VERSION_LIMITS.maxSiblingVersions,
    };
  }

  /**
   * Every present version of one clip's generation, library-wide, as catalog
   * records in version order, one per content: the clip asked about for its
   * own content, otherwise its most recently seen copy. For the versions view
   * (docs/architecture/generation-versions.md, Section 8).
   */
  function getGenerationVersionRecords(instanceId, options = {}) {
    assertOperationActive(options.assertActive);
    if (!Number.isSafeInteger(instanceId) || instanceId < 1) {
      throw new TypeError('A valid instance id is required');
    }
    const self = generationKeyForInstance.get(instanceId);
    const selfFields = self
      ? mapGenerationKeyFields(
        self.generation_key,
        self.generation_key_version,
        self.prompt_key,
        self.prompt_key_version
      )
      : {};
    if (!selfFields.generationKey) {
      return { generationKey: null, records: [], truncated: false, rootPaths: [] };
    }
    const unavailableRootPaths = (
      Array.isArray(options.unavailableRootPaths) ? options.unavailableRootPaths : []
    ).filter((rootPath) => typeof rootPath === 'string' && rootPath);
    const rows = generationVersionInstances.all({
      generation_key: selfFields.generationKey,
      version: GENERATION_KEY_VERSION,
      unavailable_root_paths: JSON.stringify(unavailableRootPaths),
      limit: GENERATION_VERSION_LIMITS.maxSiblingRows + 1,
    });
    assertOperationActive(options.assertActive);
    const rowsTruncated = rows.length > GENERATION_VERSION_LIMITS.maxSiblingRows;
    const byFingerprint = new Map();
    for (const row of rows.slice(0, GENERATION_VERSION_LIMITS.maxSiblingRows)) {
      if (!byFingerprint.has(row.fingerprint) || Number(row.id) === instanceId) {
        byFingerprint.set(row.fingerprint, row);
      }
    }
    // Version order, as the details panel lists siblings.
    const ordered = orderVersions([...byFingerprint.values()], (row) => ({
      rating:
        Number(row.rating_value) >= 1 && Number(row.rating_value) <= 5 ? Number(row.rating_value) : null,
      pixels: Number(row.content_width || 0) * Number(row.content_height || 0),
      durationMs: normalizeDurationMs(row.content_duration_ms) || 0,
      mtimeMs: Number(row.mtime_ms || 0),
      key: row.fingerprint,
    }));
    let kept = ordered.slice(0, GENERATION_VERSION_LIMITS.maxSiblingVersions);
    if (!kept.some((row) => Number(row.id) === instanceId)) {
      const selfRow = ordered.find((row) => Number(row.id) === instanceId);
      if (selfRow) kept = [...kept.slice(0, -1), selfRow];
    }
    const tagsByFingerprint = new Map();
    const records = kept.map((row) => mapLibraryInstanceRow(row, tagsByFingerprint));
    return {
      generationKey: selfFields.generationKey,
      records,
      truncated:
        rowsTruncated || ordered.length > GENERATION_VERSION_LIMITS.maxSiblingVersions,
      rootPaths: [...new Set(records.map((record) => record.rootPath))],
    };
  }

  function mapReviewPassRow(row) {
    if (!row) return null;
    const parse = (value) => {
      if (!value) return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    };
    return {
      id: Number(row.id),
      name: row.name,
      source: row.source,
      definition: parse(row.definition_json),
      location: parse(row.location_json),
      clipCount: Number(row.clip_count || 0),
      decided: row.decided === undefined ? undefined : Number(row.decided || 0),
      cursorPosition: Number(row.cursor_position || 0),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
      finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    };
  }

  function normalizeReviewPassId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('A valid review pass id is required');
    return id;
  }

  /**
   * Freezes clips into a review pass (docs/architecture/review-passes.md):
   * `clips` are `{ fingerprint, instanceId }` in the order shown, at most
   * 50,000, each content once. A pass made from results keeps the view it
   * was made with (`definition`, as a smart view's) and where (`location`),
   * to run the search again. Only the newest ten are kept, finished first
   * to go.
   */
  function createReviewPass(input = {}) {
    const source = input.source === 'selection' ? 'selection' : input.source === 'results' ? 'results' : null;
    if (!source) throw new TypeError('A review pass comes from results or a selection');
    const name = String(input.name ?? '').trim().slice(0, REVIEW_PASS_LIMITS.maxNameChars);
    if (!name) throw new TypeError('A review pass needs a name');
    const clips = Array.isArray(input.clips) ? input.clips : null;
    if (!clips || clips.length === 0 || clips.length > REVIEW_PASS_LIMITS.maxClips) {
      throw new RangeError(
        `A review pass holds 1 to ${REVIEW_PASS_LIMITS.maxClips.toLocaleString()} clips`
      );
    }
    const seen = new Set();
    const ordered = [];
    for (const clip of clips) {
      const fingerprint = typeof clip?.fingerprint === 'string' ? clip.fingerprint : '';
      if (!fingerprint || fingerprint.length > 512 || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const instanceId = Number(clip.instanceId);
      ordered.push([fingerprint, Number.isSafeInteger(instanceId) && instanceId > 0 ? instanceId : null]);
    }
    if (!ordered.length) throw new TypeError('A review pass needs clips with content');
    const definition =
      source === 'results' && input.definition ? normalizeSavedViewDefinition(input.definition) : null;
    const location =
      input.location && typeof input.location === 'object'
        ? {
            rootPath: typeof input.location.rootPath === 'string' ? input.location.rootPath : null,
            directory: typeof input.location.directory === 'string' ? input.location.directory : '',
          }
        : null;
    const now = Date.now();
    let passId = null;
    db.transaction(() => {
      const result = reviewPassInsert.run({
        name,
        source,
        definition_json: definition ? JSON.stringify(definition) : null,
        location_json: location ? JSON.stringify(location) : null,
        clip_count: ordered.length,
        now,
      });
      passId = Number(result.lastInsertRowid);
      ordered.forEach(([fingerprint, instanceId], position) => {
        reviewPassClipInsert.run(passId, position, fingerprint, instanceId);
      });
      reviewPassPrune.run({ keep: REVIEW_PASS_LIMITS.keep });
    })();
    return mapReviewPassRow(reviewPassById.get(passId));
  }

  function listReviewPasses() {
    return reviewPassSummaries.all().map(mapReviewPassRow);
  }

  /** A pass and its clips as library records, in order; gone clips left out. */
  function getReviewPassRecords(passId, options = {}) {
    assertOperationActive(options.assertActive);
    const id = normalizeReviewPassId(passId);
    const pass = mapReviewPassRow(reviewPassById.get(id));
    if (!pass) return null;
    const unavailableRootPaths = (
      Array.isArray(options.unavailableRootPaths) ? options.unavailableRootPaths : []
    ).filter((rootPath) => typeof rootPath === 'string' && rootPath);
    const rows = reviewPassInstances.all({
      pass_id: id,
      unavailable_root_paths: JSON.stringify(unavailableRootPaths),
    });
    assertOperationActive(options.assertActive);
    const tagsByFingerprint = new Map();
    const records = rows.map((row, index) => {
      if ((index & 255) === 255) assertOperationActive(options.assertActive);
      return { ...mapLibraryInstanceRow(row, tagsByFingerprint), passPosition: Number(row.pass_position) };
    });
    return {
      pass,
      records,
      rootPaths: [...new Set(records.map((record) => record.rootPath))],
    };
  }

  function setReviewPassCursor(passId, position) {
    const id = normalizeReviewPassId(passId);
    const at = Number(position);
    if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('A valid position is required');
    return reviewPassCursor.run({ id, position: at, now: Date.now() }).changes > 0;
  }

  function finishReviewPass(passId) {
    return reviewPassFinish.run({ id: normalizeReviewPassId(passId), now: Date.now() }).changes > 0;
  }

  function deleteReviewPass(passId) {
    return reviewPassDelete.run(normalizeReviewPassId(passId)).changes > 0;
  }

  // ----- Rating arena (docs/architecture/rating-arena.md) -----------------

  const cleanRootPaths = (value) =>
    (Array.isArray(value) ? value : []).filter((rootPath) => typeof rootPath === 'string' && rootPath);

  /**
   * The arena's pool: `{ fingerprint, instanceId, promptKey }` for each
   * present content, once, in roots that can be opened. `instanceIds`
   * limits it to those rows (the clips the grid showed); without them it is
   * the whole library. At most `limit` contents.
   */
  function getArenaPool(options = {}) {
    assertOperationActive(options.assertActive);
    const instanceIds = Array.isArray(options.instanceIds)
      ? options.instanceIds.filter((id) => Number.isSafeInteger(id) && id > 0)
      : null;
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 1_000_000;
    const rows = arenaPoolRows.all({
      unavailable_root_paths: JSON.stringify(cleanRootPaths(options.unavailableRootPaths)),
      instance_ids: instanceIds ? JSON.stringify(instanceIds) : null,
      limit,
    });
    assertOperationActive(options.assertActive);
    // Only the best version of a generation, in the order the details panel
    // lists versions (ratings overrule size): the others are re-renders of
    // the same clip.
    const groups = new Map();
    const pool = [];
    for (const row of rows) {
      const keys = mapGenerationKeyFields(
        row.generation_key,
        row.generation_key_version,
        row.prompt_key,
        row.prompt_key_version
      );
      const clip = {
        fingerprint: row.fingerprint,
        instanceId: Number(row.id),
        promptKey: keys.promptKey || null,
      };
      if (!keys.generationKey) {
        pool.push(clip);
        continue;
      }
      let group = groups.get(keys.generationKey);
      if (!group) groups.set(keys.generationKey, (group = []));
      group.push({ row, clip });
    }
    for (const group of groups.values()) {
      const [best] = orderVersions(group, ({ row }) => ({
        rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
        pixels: Number(row.width || 0) * Number(row.height || 0),
        durationMs: normalizeDurationMs(row.duration_ms) || 0,
        mtimeMs: Number(row.mtime_ms || 0),
        key: row.fingerprint,
      }));
      pool.push(best.clip);
    }
    return pool;
  }

  /** Every rating (1-5) and every rejected content, as they are now. */
  function getArenaJudgements() {
    const ratings = new Map();
    for (const row of arenaRatingRows.all()) ratings.set(row.fingerprint, Number(row.value));
    const rejects = new Set(arenaRejectRows.all().map((row) => row.fingerprint));
    return { ratings, rejects };
  }

  /** The arena's history, oldest first: `{ id, fingerprint, checkedAt, kind, outcome }`. */
  function listArenaChecks() {
    return arenaCheckRows.all().map((row) => ({
      id: Number(row.id),
      fingerprint: row.fingerprint,
      checkedAt: Number(row.checked_at),
      kind: row.kind,
      outcome: row.outcome,
    }));
  }

  /**
   * Records one round's rows and lets go of `replaceIds` (the rows the same
   * round wrote before, when it comes back after Undo). Returns the new
   * rows' ids, for a content still in the library. Keeps the newest rows.
   */
  const writeArenaChecks = db.transaction((rows, replaceIds, keep) => {
    for (const id of replaceIds) arenaCheckDelete.run(id);
    const ids = [];
    for (const row of rows) {
      const result = arenaCheckInsert.run(row);
      if (result.changes > 0) ids.push(Number(result.lastInsertRowid));
    }
    arenaCheckPrune.run({ keep });
    return ids;
  });
  const ARENA_OUTCOMES = new Set(['placed', 'held', 'raised', 'lowered', 'skipped', 'rejected']);
  const ARENA_KINDS = new Set(['place', 'first', 'tier', 'border']);
  const arenaRating = (value) =>
    Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  function recordArenaChecks(rows = [], options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const clean = (Array.isArray(rows) ? rows : [])
      .filter(
        (row) =>
          typeof row?.fingerprint === 'string' &&
          row.fingerprint &&
          ARENA_KINDS.has(row.kind) &&
          ARENA_OUTCOMES.has(row.outcome)
      )
      .map((row) => ({
        fingerprint: row.fingerprint,
        checked_at: now,
        kind: row.kind,
        outcome: row.outcome,
        rating_before: arenaRating(row.ratingBefore),
        rating_after: arenaRating(row.ratingAfter),
      }));
    const replaceIds = (Array.isArray(options.replaceIds) ? options.replaceIds : []).filter(
      (id) => Number.isSafeInteger(id) && id > 0
    );
    const keep = Number.isSafeInteger(options.keep) && options.keep > 0 ? options.keep : 200_000;
    return writeArenaChecks(clean, replaceIds, keep);
  }

  /** A round's clips as playable records, for the rows given, in that order. */
  function getArenaRecords(instanceIds = [], options = {}) {
    assertOperationActive(options.assertActive);
    const ids = (Array.isArray(instanceIds) ? instanceIds : []).filter(
      (id) => Number.isSafeInteger(id) && id > 0
    );
    if (!ids.length) return { records: [], rootPaths: [] };
    const rows = arenaRecordInstances.all({
      instance_ids: JSON.stringify(ids),
      unavailable_root_paths: JSON.stringify(cleanRootPaths(options.unavailableRootPaths)),
    });
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const tagsByFingerprint = new Map();
    const records = ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((row) => mapLibraryInstanceRow(row, tagsByFingerprint));
    return { records, rootPaths: [...new Set(records.map((record) => record.rootPath))] };
  }

  // A clip tagged "bellydance" counts toward "dance" too, once however many
  // of its tags sit under "dance". directCount is the tag's own clips.
  function listTags() {
    const rows = tagRows.all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const direct = new Map();
    const inclusive = new Map();
    for (const { tagId, fingerprint } of presentTagLinks.all()) {
      direct.set(tagId, (direct.get(tagId) || 0) + 1);
      let id = tagId;
      for (let depth = 0; id != null && depth <= MAX_TAG_DEPTH; depth += 1) {
        let clips = inclusive.get(id);
        if (!clips) inclusive.set(id, (clips = new Set()));
        clips.add(fingerprint);
        id = byId.get(id)?.parentId ?? null;
      }
    }
    return rows.map((row) => ({
      name: row.name,
      parent: byId.get(row.parentId)?.name ?? null,
      usageCount: inclusive.get(row.id)?.size || 0,
      directCount: direct.get(row.id) || 0,
    }));
  }

  function tagDepthAbove(id) {
    let depth = 0;
    let current = tagById.get(id)?.parentId ?? null;
    while (current != null && depth <= MAX_TAG_DEPTH) {
      depth += 1;
      current = tagById.get(current)?.parentId ?? null;
    }
    return depth;
  }

  function tagSubtreeHeight(id) {
    const rows = tagRows.all();
    const children = new Map();
    for (const row of rows) {
      if (row.parentId == null) continue;
      if (!children.has(row.parentId)) children.set(row.parentId, []);
      children.get(row.parentId).push(row.id);
    }
    const height = (tagId, guard) =>
      guard > MAX_TAG_DEPTH
        ? guard
        : Math.max(0, ...(children.get(tagId) || []).map((child) => 1 + height(child, guard + 1)));
    return height(id, 0);
  }

  /**
   * Make `parentName` the parent of `childName`, creating either tag if it
   * does not exist; a null parent makes the tag top-level. Refuses a cycle
   * and a tree deeper than MAX_TAG_DEPTH. Runs inside the caller's
   * transaction when there is one.
   */
  function applyTagParent(childName, parentName) {
    const childId = getTagId(childName);
    if (!childId) throw new TagHierarchyError('A tag name is required');
    if (parentName == null || String(parentName).trim() === '') {
      if ((tagById.get(childId)?.parentId ?? null) !== null) {
        setTagParentStmt.run(null, childId);
        noteTagTreeChange();
      }
      return;
    }
    const parentId = getTagId(parentName);
    if (!parentId) throw new TagHierarchyError('A parent tag name is required');
    if (parentId === childId) {
      throw new TagHierarchyError('A tag cannot be its own parent');
    }
    for (
      let current = parentId, depth = 0;
      current != null && depth <= MAX_TAG_DEPTH;
      current = tagById.get(current)?.parentId ?? null, depth += 1
    ) {
      if (current === childId) {
        throw new TagHierarchyError(
          `"${tagById.get(parentId)?.name}" is already inside "${tagById.get(childId)?.name}"`
        );
      }
    }
    if (tagDepthAbove(parentId) + 1 + tagSubtreeHeight(childId) >= MAX_TAG_DEPTH) {
      throw new TagHierarchyError(`Tags nest at most ${MAX_TAG_DEPTH} levels deep`);
    }
    if ((tagById.get(childId)?.parentId ?? null) !== parentId) {
      setTagParentStmt.run(parentId, childId);
      noteTagTreeChange();
    }
  }

  function setTagParent(childName, parentName = null) {
    db.transaction(() => applyTagParent(childName, parentName))();
    return listTags();
  }

  // "dance/latin/bellydance" applies "bellydance", placing it under "latin"
  // under "dance". Single names pass through unchanged.
  function resolveTagPath(nameRaw) {
    const segments = String(nameRaw || '')
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length <= 1) return segments[0] || null;
    if (segments.length > MAX_TAG_DEPTH) {
      throw new TagHierarchyError(`Tags nest at most ${MAX_TAG_DEPTH} levels deep`);
    }
    for (let index = 1; index < segments.length; index += 1) {
      applyTagParent(segments[index], segments[index - 1]);
    }
    return segments[segments.length - 1];
  }

  /**
   * [tag name, requested group] pairs: each requested tag with every tag
   * under it, so matching "dance" also matches "bellydance".
   */
  function expandTagGroups(tagNames) {
    const rows = tagRows.all();
    const byName = new Map(rows.map((row) => [row.name.toLowerCase(), row]));
    const children = new Map();
    for (const row of rows) {
      if (row.parentId == null) continue;
      if (!children.has(row.parentId)) children.set(row.parentId, []);
      children.get(row.parentId).push(row);
    }
    const pairs = [];
    for (const group of tagNames) {
      pairs.push([group, group]);
      const root = byName.get(group);
      if (!root) continue;
      const seen = new Set([root.id]);
      const queue = [...(children.get(root.id) || [])];
      while (queue.length) {
        const row = queue.shift();
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        pairs.push([row.name.toLowerCase(), group]);
        queue.push(...(children.get(row.id) || []));
      }
    }
    return pairs;
  }

  // A tag goes once nothing is tagged with it and nothing sits under it; a
  // parent kept only for its children goes with the last of them.
  function pruneUnusedTag(id) {
    let current = id;
    for (let depth = 0; current != null && depth <= MAX_TAG_DEPTH; depth += 1) {
      const row = tagById.get(current);
      if (!row) return;
      if (Number(countTagUsage.get(current)?.count || 0) > 0) return;
      if (Number(tagChildCount.get(current)?.count || 0) > 0) return;
      reparentTagChildren.run(row.parentId ?? null, current);
      deleteTagById.run(current);
      noteTagTreeChange();
      current = row.parentId ?? null;
    }
  }

  function assignTags(fingerprints, tagNames) {
    const now = Date.now();
    const applied = {};
    const txn = db.transaction(() => {
      fingerprints.forEach((fingerprint) => {
        if (!fingerprint) return;
        (tagNames || []).forEach((nameRaw) => {
          const id = getTagId(resolveTagPath(nameRaw));
          if (!id) return;
          addTagLink.run(fingerprint, id, now);
        });
        noteMetadataChange(fingerprint);
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
        if (removeTagLink.run(fingerprint, id).changes > 0) noteMetadataChange(fingerprint);
        removed[fingerprint] = mapMetadataRow(fingerprint);
      });

      pruneUnusedTag(id);
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
        noteMetadataChange(fingerprint);
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
        noteMetadataChange(fingerprint);
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
        noteMetadataChange(fingerprint);
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
    getFileInstanceLocation,
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
    setTagParent,
    assignTags,
    removeTag,
    setRating,
    setReviewState,
    restoreReviewMetadata,
    getDimensions,
    getHasAudio,
    setDimensions,
    getGenerationKeyFields,
    listGenerationKeyCandidates,
    countGenerationKeyCandidates,
    listEvaluatedGenerationKeys,
    setGenerationKeys,
    getGenerationVersionSummaries,
    getGenerationVersionSiblings,
    getGenerationVersionRecords,
    matchWorkflowFacts,
    getSavedView,
    setSavedViewShared,
    listFeedPoolChunk,
    getFeedClip,
    listFeedTagNames,
    createReviewPass,
    listReviewPasses,
    getReviewPassRecords,
    setReviewPassCursor,
    finishReviewPass,
    deleteReviewPass,
    getArenaPool,
    getArenaJudgements,
    listArenaChecks,
    recordArenaChecks,
    getArenaRecords,
    listPresentInstancesForPromptKey,
    listLibraryPromptKeys,
    getFrameRows,
    setFrameFingerprint,
    getTagSuggestionLabels,
    getTagSuggestionTargets,
    dismissTagSuggestion,
    getMetadataRevision,
    listMetadataChangesSince,
    getLocalApiClips,
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
  GENERATION_VERSION_LIMITS,
  initMetadataStore,
  getMetadataStore,
  resetDatabase,
};
