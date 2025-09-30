const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { computeFingerprint } = require('./fingerprint');

let dbInstance = null;
let metadataStoreInstance = null;

function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

function initDatabase(app) {
  if (dbInstance) return dbInstance;
  const userData = app.getPath('userData');
  ensureDirectory(userData);
  const dbPath = path.join(userData, 'videoswarm-meta.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      fingerprint TEXT PRIMARY KEY,
      last_known_path TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_ms INTEGER,
      updated_at INTEGER NOT NULL
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
  return db;
}

function createMetadataStore(db) {
  const fileUpsert = db.prepare(`
    INSERT INTO files (fingerprint, last_known_path, size, created_ms, updated_at)
    VALUES (@fingerprint, @last_known_path, @size, @created_ms, @updated_at)
    ON CONFLICT(fingerprint) DO UPDATE SET
      last_known_path=excluded.last_known_path,
      size=excluded.size,
      created_ms=excluded.created_ms,
      updated_at=excluded.updated_at;
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

  const getRating = db.prepare(`
    SELECT value FROM ratings WHERE fingerprint = ?;
  `);

  const setRatingStmt = db.prepare(`
    INSERT INTO ratings (fingerprint, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
  `);

  const deleteRatingStmt = db.prepare(`DELETE FROM ratings WHERE fingerprint = ?;`);

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

  function writeFileRecord(fingerprint, filePath, stats, createdMsOverride) {
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
    return {
      tags,
      rating: ratingRow ? ratingRow.value : null,
    };
  }

  async function indexFile({ filePath, stats }) {
    if (!filePath) return null;
    const safeStats = stats || (await fs.promises.stat(filePath));
    const { fingerprint, createdMs } = await ensureFingerprint(filePath, safeStats);
    writeFileRecord(fingerprint, filePath, safeStats, createdMs);
    return {
      fingerprint,
      ...mapMetadataRow(fingerprint),
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

  return {
    indexFile,
    getMetadataForFingerprints,
    listTags,
    assignTags,
    removeTag,
    setRating,
  };
}

function initMetadataStore(app) {
  if (metadataStoreInstance) return metadataStoreInstance;
  const db = initDatabase(app);
  metadataStoreInstance = createMetadataStore(db);
  return metadataStoreInstance;
}

function getMetadataStore() {
  if (!metadataStoreInstance) {
    throw new Error('Metadata store not initialised');
  }
  return metadataStoreInstance;
}

module.exports = {
  initMetadataStore,
  getMetadataStore,
};
