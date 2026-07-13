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

    db.exec(`
      CREATE TABLE IF NOT EXISTS library_roots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path TEXT NOT NULL UNIQUE,
        label TEXT,
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
        direct_instance_count INTEGER NOT NULL DEFAULT 0,
        direct_present_count INTEGER NOT NULL DEFAULT 0,
        direct_missing_count INTEGER NOT NULL DEFAULT 0,
        direct_reviewed_count INTEGER NOT NULL DEFAULT 0,
        instance_count INTEGER NOT NULL DEFAULT 0,
        present_count INTEGER NOT NULL DEFAULT 0,
        missing_count INTEGER NOT NULL DEFAULT 0,
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
        UNIQUE(root_id, relative_path),
        FOREIGN KEY (root_id) REFERENCES library_roots(id) ON DELETE CASCADE,
        FOREIGN KEY (directory_id) REFERENCES directories(id) ON DELETE CASCADE,
        FOREIGN KEY (fingerprint) REFERENCES media_content(fingerprint) ON DELETE SET NULL
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
    `);

    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO media_content (
        fingerprint, size, created_ms, width, height, created_at, updated_at
      )
      SELECT fingerprint, size, created_ms, width, height, ?, ?
      FROM files;
    `).run(now, now);

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

  const fileUpsert = db.prepare(`
    INSERT INTO files (fingerprint, last_known_path, size, created_ms, updated_at, width, height)
    VALUES (@fingerprint, @last_known_path, @size, @created_ms, @updated_at, @width, @height)
    ON CONFLICT(fingerprint) DO UPDATE SET
      last_known_path=excluded.last_known_path,
      size=excluded.size,
      created_ms=excluded.created_ms,
      updated_at=excluded.updated_at,
      width=COALESCE(excluded.width, files.width),
      height=COALESCE(excluded.height, files.height);
  `);

  const mediaContentUpsert = db.prepare(`
    INSERT INTO media_content (
      fingerprint, size, created_ms, width, height, created_at, updated_at
    )
    VALUES (
      @fingerprint, @size, @created_ms, @width, @height, @created_at, @updated_at
    )
    ON CONFLICT(fingerprint) DO UPDATE SET
      size=excluded.size,
      created_ms=COALESCE(media_content.created_ms, excluded.created_ms),
      width=COALESCE(excluded.width, media_content.width),
      height=COALESCE(excluded.height, media_content.height),
      updated_at=excluded.updated_at;
  `);
  const mediaContentByFingerprint = db.prepare(`
    SELECT * FROM media_content WHERE fingerprint = ?;
  `);

  const rootInsert = db.prepare(`
    INSERT OR IGNORE INTO library_roots (
      root_path, label, recursive, refresh_state, last_scan_started_at,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?);
  `);
  const rootUpdate = db.prepare(`
    UPDATE library_roots
    SET label = ?, recursive = ?, refresh_state = ?,
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

  const directoryUpsert = db.prepare(`
    INSERT INTO directories (
      root_id, relative_path, parent_relative_path, name, updated_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(root_id, relative_path) DO UPDATE SET
      parent_relative_path=excluded.parent_relative_path,
      name=excluded.name,
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
        direct_reviewed_count = @direct_reviewed_count,
        instance_count = @instance_count,
        present_count = @present_count,
        missing_count = @missing_count,
        reviewed_count = @reviewed_count,
        updated_at = @updated_at
    WHERE id = @id;
  `);

  const fileInstanceByRelativePath = db.prepare(`
    SELECT * FROM file_instances
    WHERE root_id = ? AND relative_path = ?;
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
    SELECT fi.*, CASE WHEN r.fingerprint IS NULL THEN 0 ELSE 1 END AS reviewed
    FROM file_instances fi
    LEFT JOIN ratings r ON r.fingerprint = fi.fingerprint
    WHERE fi.root_id = ?
    ORDER BY fi.relative_path COLLATE NOCASE;
  `);
  const fileInstancesByAbsolutePath = db.prepare(`
    SELECT * FROM file_instances WHERE absolute_path = ?;
  `);
  const markInstanceMissingById = db.prepare(`
    UPDATE file_instances
    SET is_present = 0,
        missing_since = COALESCE(missing_since, ?)
    WHERE id = ? AND is_present != 0;
  `);
  const rootsForFingerprints = db.prepare(`
    SELECT DISTINCT root_id FROM file_instances
    WHERE fingerprint = ?;
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

  const setDimensionsStmt = db.prepare(
    'UPDATE files SET width = ?, height = ? WHERE fingerprint = ?;'
  );
  const setContentDimensionsStmt = db.prepare(
    'UPDATE media_content SET width = ?, height = ?, updated_at = ? WHERE fingerprint = ?;'
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

  const metadataCache = new Map();

  function assertOperationActive(assertActive) {
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
      directInstanceCount: Number(row.direct_instance_count || 0),
      directPresentCount: Number(row.direct_present_count || 0),
      directMissingCount: Number(row.direct_missing_count || 0),
      directReviewedCount: Number(row.direct_reviewed_count || 0),
      instanceCount: Number(row.instance_count || 0),
      presentCount: Number(row.present_count || 0),
      missingCount: Number(row.missing_count || 0),
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
      reviewed: Boolean(row.reviewed),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      missingSince: row.missing_since ?? null,
    };
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
    const cached = metadataCache.get(key);
    if (cached?.fingerprint) {
      return { fingerprint: cached.fingerprint, createdMs: cached.createdMs };
    }

    const result = await computeFingerprint(filePath, stats);
    assertOperationActive(assertActive);
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
    fileUpsert.run({
      fingerprint,
      last_known_path: filePath,
      size: Number(stats.size || 0),
      created_ms: createdMs,
      updated_at: now,
      width: normalizeDimension(dimensions?.width),
      height: normalizeDimension(dimensions?.height),
    });
    mediaContentUpsert.run({
      fingerprint,
      size: Number(stats.size || 0),
      created_ms: createdMs,
      width: normalizeDimension(dimensions?.width),
      height: normalizeDimension(dimensions?.height),
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
      recursive ? 1 : 0,
      refreshState,
      lastScanStartedAt,
      now,
      now
    );
    row = rootByPath.get(normalizedRoot);
    rootUpdate.run(
      label,
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

  function getLibraryRoots() {
    return rootsList.all().map(mapRootRow);
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
    fileInstanceUpsert.run({
      root_id: rootRow.id,
      directory_id: directoryRow.id,
      relative_path: entry.relativePath,
      absolute_path: entry.filePath,
      size: normalizeStatSize(entry.stats),
      mtime_ms: normalizeStatMtime(entry.stats),
      fingerprint: entry.fingerprint,
      first_seen_at: now,
      last_seen_at: now,
    });
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
        direct_reviewed_count: 0,
        instance_count: 0,
        present_count: 0,
        missing_count: 0,
        reviewed_count: 0,
      });
    });

    instanceRows.forEach((instance) => {
      const directPath = getDirectoryRelativePath(instance.relative_path);
      const ancestors = [''];
      if (directPath) {
        const parts = directPath.split('/');
        for (let index = 1; index <= parts.length; index += 1) {
          ancestors.push(parts.slice(0, index).join('/'));
        }
      }
      const present = Boolean(instance.is_present);
      const reviewed = present && Boolean(instance.reviewed);

      ancestors.forEach((directoryPath) => {
        const value = counts.get(directoryPath);
        if (!value) return;
        value.instance_count += 1;
        value.present_count += present ? 1 : 0;
        value.missing_count += present ? 0 : 1;
        value.reviewed_count += reviewed ? 1 : 0;
      });

      const direct = counts.get(directPath);
      if (direct) {
        direct.direct_instance_count += 1;
        direct.direct_present_count += present ? 1 : 0;
        direct.direct_missing_count += present ? 0 : 1;
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

  function getFileInstances(rootPath, options = {}) {
    const row = rootByPath.get(normalizeRootPath(rootPath));
    if (!row) return [];
    const includeMissing = options.includeMissing !== false;
    return fileInstancesForRoot
      .all(row.id)
      .filter((instance) => includeMissing || Boolean(instance.is_present))
      .map(mapFileInstanceRow);
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

    if (hasExplicitDirectoryScope) {
      registerDirectories(normalizedRoot, scannedDirectories, { recursive });
    }

    const instanceRows = fileInstancesForRoot.all(rootRow.id);
    const missingCandidates = instanceRows.filter((instance) => {
      const directDirectory = getDirectoryRelativePath(instance.relative_path);
      const directoryWasScanned = scanned
        ? scanned.has(directDirectory)
        : recursive || directDirectory === '';
      return directoryWasScanned && !seen.has(instance.relative_path);
    });

    assertOperationActive(assertActive);
    const now = Date.now();
    let markedMissing = 0;
    const txn = db.transaction(() => {
      missingCandidates.forEach((instance) => {
        markedMissing += markInstanceMissingById.run(now, instance.id).changes;
      });
      rootComplete.run(recursive ? 1 : 0, now, now, rootRow.id);
    });
    txn();

    const directories = refreshDirectoryCountsByRootId(rootRow.id);
    return {
      root: mapRootRow(rootById.get(rootRow.id)),
      markedMissing,
      directories,
    };
  }

  function markFileMissing(filePath, { rootPath, assertActive } = {}) {
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
        markedMissing += markInstanceMissingById.run(now, row.id).changes;
        affectedRootIds.add(row.root_id);
      });
    })();
    affectedRootIds.forEach((rootId) => refreshDirectoryCountsByRootId(rootId));

    const instances = rows.map((row) => {
      const updated = fileInstanceByRelativePath.get(row.root_id, row.relative_path);
      return mapFileInstanceRow(updated);
    });
    return { markedMissing, instances };
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

  async function indexFiles({
    rootPath,
    entries = [],
    recursive = true,
    assertActive,
  } = {}) {
    assertOperationActive(assertActive);
    const normalizedRoot = normalizeRootPath(rootPath);
    const root = registerLibraryRoot(normalizedRoot, { recursive });
    const rootRow = rootById.get(root.id);
    const preparedEntries = [];

    for (const input of Array.isArray(entries) ? entries : []) {
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
      if (canReuse) {
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

      preparedEntries.push({
        filePath: location.absolutePath,
        relativePath: location.relativePath,
        stats: safeStats,
        dimensions: input.dimensions,
        fingerprint: fingerprintResult.fingerprint,
        createdMs: fingerprintResult.createdMs,
        fingerprintReused: reusedPersistedFingerprint,
      });
    }

    // Fingerprinting and stat calls above are asynchronous. Re-check ownership
    // immediately before entering this synchronous transaction so stale scan
    // generations can never resume and write into a newly active profile.
    assertOperationActive(assertActive);
    const instanceRows = [];
    const txn = db.transaction(() => {
      preparedEntries.forEach((entry) => {
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
        dimensions: null,
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
  } = {}) {
    if (!filePath) return null;
    if (rootPath) {
      const [result] = await indexFiles({
        rootPath,
        entries: [{ filePath, stats, dimensions }],
        recursive,
        assertActive,
      });
      refreshDirectoryCounts(rootPath);
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
        SELECT f.fingerprint, f.width, f.height, r.value AS rating
        FROM files f
        LEFT JOIN ratings r ON r.fingerprint = f.fingerprint
        WHERE f.fingerprint IN (${placeholders});
      `).all(...chunk);

      metadataRows.forEach((row) => {
        const width = Number(row.width) || 0;
        const height = Number(row.height) || 0;
        result[row.fingerprint] = {
          tags: [],
          rating: row.rating ?? null,
          dimensions: width > 0 && height > 0
            ? { width, height, aspectRatio: width / height }
            : null,
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
      return { width, height, aspectRatio: width / height };
    }
    return null;
  }

  function setDimensions(fingerprint, dimensions) {
    if (!fingerprint) return;
    const width = normalizeDimension(dimensions?.width);
    const height = normalizeDimension(dimensions?.height);
    if (!width || !height) return;
    db.transaction(() => {
      setDimensionsStmt.run(width, height, fingerprint);
      setContentDimensionsStmt.run(width, height, Date.now(), fingerprint);
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

  function setRating(fingerprints, rating) {
    const updates = {};
    const now = Date.now();
    const affectedRootIds = new Set();
    (fingerprints || []).forEach((fingerprint) => {
      if (!fingerprint) return;
      rootsForFingerprints.all(fingerprint).forEach((row) => {
        affectedRootIds.add(row.root_id);
      });
    });
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
    affectedRootIds.forEach((rootId) => refreshDirectoryCountsByRootId(rootId));
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
    getLibraryRoots,
    getDirectorySummaries,
    getFileInstances,
    refreshDirectoryCounts,
    getMetadataForFingerprints,
    listTags,
    assignTags,
    removeTag,
    setRating,
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
