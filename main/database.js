const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { computeFingerprint } = require('./fingerprint');
const profileManager = require('./profile-manager');

let dbInstance = null;
let metadataStoreInstance = null;
let currentProfilePath = null;

const DB_FILE_NAME = 'videoswarm-meta.db';
const DB_SIDE_FILES = ['-wal', '-shm', '-journal'];

function isSqliteCorruptionError(error) {
  if (!error) return false;
  if (error.code === 'SQLITE_CORRUPT') {
    return true;
  }
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('malformed') ||
    message.includes('database disk image is malformed') ||
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

function canonicalizePath(filePath) {
  if (!filePath) return '';
  const raw = path.resolve(String(filePath));
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(raw) : fs.realpathSync(raw);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    const normalized = path.normalize(raw);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
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
      canonical_path TEXT,
      last_known_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_ms INTEGER,
      updated_at INTEGER NOT NULL,
      width INTEGER,
      height INTEGER
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
  if (!columns.has('canonical_path')) {
    try {
      db.exec('ALTER TABLE files ADD COLUMN canonical_path TEXT;');
    } catch (error) {
      if (!/duplicate column/i.test(error?.message || '')) throw error;
    }
  }

  const rowsToCanonicalize = db
    .prepare("SELECT fingerprint, last_known_path, updated_at FROM files WHERE canonical_path IS NULL OR canonical_path = '';")
    .all();
  const updateCanonicalStmt = db.prepare('UPDATE files SET canonical_path = ? WHERE fingerprint = ?;');
  const lookupCanonicalOwnerStmt = db.prepare(`
    SELECT fingerprint, updated_at
    FROM files
    WHERE canonical_path = ?
    LIMIT 1;
  `);
  const moveTagsStmt = db.prepare(`
    INSERT OR IGNORE INTO file_tags (fingerprint, tag_id, added_at)
    SELECT ?, tag_id, added_at FROM file_tags WHERE fingerprint = ?;
  `);
  const moveRatingStmt = db.prepare(`
    INSERT OR REPLACE INTO ratings (fingerprint, value, updated_at)
    SELECT ?, value, updated_at FROM ratings WHERE fingerprint = ?;
  `);
  const deleteFileStmt = db.prepare('DELETE FROM files WHERE fingerprint = ?;');

  const canonicalTxn = db.transaction((rows) => {
    rows.forEach((row) => {
      const canonical = canonicalizePath(row.last_known_path);
      if (!canonical) return;

      const existingOwner = lookupCanonicalOwnerStmt.get(canonical);
      if (!existingOwner || existingOwner.fingerprint === row.fingerprint) {
        updateCanonicalStmt.run(canonical, row.fingerprint);
        return;
      }

      const keepFingerprint =
        Number(existingOwner.updated_at || 0) >= Number(row.updated_at || 0)
          ? existingOwner.fingerprint
          : row.fingerprint;
      const dropFingerprint =
        keepFingerprint === row.fingerprint
          ? existingOwner.fingerprint
          : row.fingerprint;

      moveTagsStmt.run(keepFingerprint, dropFingerprint);
      moveRatingStmt.run(keepFingerprint, dropFingerprint);
      deleteFileStmt.run(dropFingerprint);

      if (keepFingerprint === row.fingerprint) {
        updateCanonicalStmt.run(canonical, row.fingerprint);
      }
    });
  });
  canonicalTxn(rowsToCanonicalize);

  const duplicateCanonicalRows = db
    .prepare(`
      SELECT canonical_path
      FROM files
      WHERE canonical_path IS NOT NULL AND canonical_path != ''
      GROUP BY canonical_path
      HAVING COUNT(*) > 1;
    `)
    .all();

  if (duplicateCanonicalRows.length > 0) {
    const pickStmt = db.prepare(`
      SELECT fingerprint
      FROM files
      WHERE canonical_path = ?
      ORDER BY updated_at DESC
      LIMIT 1;
    `);
    const listStmt = db.prepare('SELECT fingerprint FROM files WHERE canonical_path = ?;');
    const dedupeTxn = db.transaction((rows) => {
      rows.forEach((row) => {
        const keep = pickStmt.get(row.canonical_path)?.fingerprint;
        if (!keep) return;
        const all = listStmt.all(row.canonical_path).map((entry) => entry.fingerprint);
        all.forEach((fp) => {
          if (fp === keep) return;
          moveTagsStmt.run(keep, fp);
          moveRatingStmt.run(keep, fp);
          deleteFileStmt.run(fp);
        });
      });
    });
    dedupeTxn(duplicateCanonicalRows);
  }

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_files_canonical_path ON files(canonical_path);');

  const fileUpsert = db.prepare(`
    INSERT INTO files (fingerprint, canonical_path, last_known_path, size, created_ms, updated_at, width, height)
    VALUES (@fingerprint, @canonical_path, @last_known_path, @size, @created_ms, @updated_at, @width, @height)
    ON CONFLICT(canonical_path) DO UPDATE SET
      last_known_path=excluded.last_known_path,
      size=excluded.size,
      created_ms=excluded.created_ms,
      updated_at=excluded.updated_at,
      width=COALESCE(excluded.width, files.width),
      height=COALESCE(excluded.height, files.height);
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
    'SELECT width, height FROM files WHERE fingerprint = ?;'
  );
  const fingerprintByCanonicalStmt = db.prepare(
    'SELECT fingerprint FROM files WHERE canonical_path = ? LIMIT 1;'
  );

  const setDimensionsStmt = db.prepare(
    'UPDATE files SET width = ?, height = ? WHERE fingerprint = ?;'
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
  const indexedFilesStmt = db.prepare(`
    SELECT
      f.fingerprint AS fingerprint,
      f.canonical_path AS canonicalPath,
      f.last_known_path AS fullPath,
      f.created_ms AS createdMs,
      f.width AS width,
      f.height AS height,
      r.value AS rating,
      GROUP_CONCAT(t.name, '\u0001') AS tags
    FROM files f
    LEFT JOIN ratings r ON r.fingerprint = f.fingerprint
    LEFT JOIN file_tags ft ON ft.fingerprint = f.fingerprint
    LEFT JOIN tags t ON t.id = ft.tag_id
    GROUP BY f.fingerprint
    ORDER BY f.updated_at DESC;
  `);

  const metadataCache = new Map();

  function cacheKey(filePath, stats) {
    return `${filePath}::${stats.mtimeMs || 0}::${stats.size || 0}`;
  }

  async function ensureFingerprint(filePath, stats) {
    if (!stats) {
      stats = await fs.promises.stat(filePath);
    }
    const key = cacheKey(filePath, stats);
    const cached = metadataCache.get(key);
    if (cached?.fingerprint) {
      return { fingerprint: cached.fingerprint, createdMs: cached.createdMs };
    }

    const result = await computeFingerprint(filePath, stats);
    metadataCache.set(key, { fingerprint: result.fingerprint, createdMs: result.createdMs });
    return result;
  }

  function normalizeDimension(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num);
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
    const canonicalPath = canonicalizePath(filePath);
    fileUpsert.run({
      fingerprint,
      canonical_path: canonicalPath,
      last_known_path: filePath,
      size: Number(stats.size || 0),
      created_ms: createdMs,
      updated_at: now,
      width: normalizeDimension(dimensions?.width),
      height: normalizeDimension(dimensions?.height),
    });
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
    const dimRow = fileSelect.get(fingerprint);
    let dimensions = null;
    if (dimRow) {
      const width = Number(dimRow.width) || 0;
      const height = Number(dimRow.height) || 0;
      if (width > 0 && height > 0) {
        dimensions = { width, height, aspectRatio: width / height };
      }
    }
    return {
      tags,
      rating: ratingRow ? ratingRow.value : null,
      dimensions,
    };
  }

  async function indexFile({ filePath, stats, dimensions }) {
    if (!filePath) return null;
    const safeStats = stats || (await fs.promises.stat(filePath));
    const { fingerprint, createdMs } = await ensureFingerprint(filePath, safeStats);
    writeFileRecord(fingerprint, filePath, safeStats, createdMs, dimensions);
    const canonicalPath = canonicalizePath(filePath);
    const persistedFingerprint =
      fingerprintByCanonicalStmt.get(canonicalPath)?.fingerprint || fingerprint;
    return {
      fingerprint: persistedFingerprint,
      canonicalPath,
      ...mapMetadataRow(persistedFingerprint),
    };
  }

  function getMetadataForFingerprints(fingerprints) {
    const result = {};
    (fingerprints || []).forEach((fp) => {
      if (!fp) return;
      result[fp] = mapMetadataRow(fp);
    });
    return result;
  }

  function getDimensions(fingerprint) {
    if (!fingerprint) return null;
    const row = fileSelect.get(fingerprint);
    if (!row) return null;
    const width = Number(row.width) || 0;
    const height = Number(row.height) || 0;
    if (width > 0 && height > 0) {
      return { width, height, aspectRatio: width / height };
    }
    return null;
  }

  function setDimensions(fingerprint, dimensions) {
    if (!fingerprint) return;
    const width = normalizeDimension(dimensions?.width);
    const height = normalizeDimension(dimensions?.height);
    if (!width || !height) return;
    setDimensionsStmt.run(width, height, fingerprint);
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

  function setRating(fingerprints, rating) {
    const updates = {};
    const now = Date.now();
    const txn = db.transaction(() => {
      fingerprints.forEach((fingerprint) => {
        if (!fingerprint) return;
        if (rating === null || rating === undefined) {
          deleteRatingStmt.run(fingerprint);
        } else {
          const safeRating = Math.max(0, Math.min(5, Math.round(Number(rating))));
          setRatingStmt.run(fingerprint, safeRating, now);
        }
        updates[fingerprint] = mapMetadataRow(fingerprint);
      });
    });
    txn();
    return updates;
  }

  function listIndexedFiles() {
    return indexedFilesStmt.all().map((row) => {
      const width = Number(row.width) || 0;
      const height = Number(row.height) || 0;
      return {
        fingerprint: row.fingerprint,
        canonicalPath: row.canonicalPath,
        fullPath: row.fullPath,
        createdMs: Number(row.createdMs) || 0,
        rating:
          typeof row.rating === 'number' && Number.isFinite(row.rating)
            ? row.rating
            : null,
        tags:
          typeof row.tags === 'string' && row.tags.length > 0
            ? row.tags.split('\u0001').filter(Boolean)
            : [],
        dimensions:
          width > 0 && height > 0
            ? {
                width,
                height,
                aspectRatio: width / height,
              }
            : null,
      };
    });
  }

  return {
    indexFile,
    getMetadataForFingerprints,
    listTags,
    assignTags,
    removeTag,
    setRating,
    listIndexedFiles,
    getDimensions,
    setDimensions,
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
  initMetadataStore,
  getMetadataStore,
  resetDatabase,
};
