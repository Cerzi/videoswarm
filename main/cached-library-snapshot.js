const path = require("path");
const { createMediaInstanceUrl } = require("./media-protocol");

function createCachedVideoFileObject(record, rootPath, options = {}) {
  if (!record?.absolutePath) return null;
  const filePath = path.resolve(record.absolutePath);
  const fileName = path.basename(filePath);
  const size = Math.max(0, Number(record.size || 0));
  const modifiedMs = Math.max(0, Number(record.mtimeMs || 0));
  const createdMs = Math.max(0, Number(record.createdMs || modifiedMs));
  const dateModified = new Date(modifiedMs);
  const width = Number(record.dimensions?.width || 0);
  const height = Number(record.dimensions?.height || 0);
  const dimensions = width > 0 && height > 0
    ? {
        width: Math.round(width),
        height: Math.round(height),
        aspectRatio: width / height,
      }
    : null;
  let dirname = path.relative(rootPath, path.dirname(filePath));
  if (dirname === ".") dirname = "";

  const instanceId = Number(record.instanceId) || null;
  // Display-only metadata is intentionally absent on cache hydration. All
  // renderer consumers use the raw path, size, and timestamps below, and the
  // authoritative scan restores enriched metadata. Avoiding per-record locale
  // strings trims roughly 1 MiB from a 6k IPC payload.
  const file = {
    id: filePath,
    instanceId,
    sourceUrl: instanceId
      ? createMediaInstanceUrl(instanceId, {
          version: `${size}-${modifiedMs}`,
          generation: options.generation,
        })
      : null,
    name: fileName,
    relativePath: path.relative(rootPath, filePath),
    size,
    dateModified,
    isElectronFile: true,
    dirname,
    createdMs,
  };
  if (record.fingerprint) file.fingerprint = record.fingerprint;
  if (Array.isArray(record.tags) && record.tags.length > 0) {
    file.tags = record.tags;
  }
  if (Number.isFinite(record.rating)) file.rating = record.rating;
  if (record.reviewState && record.reviewState !== "unreviewed") {
    file.reviewState = record.reviewState;
  }
  if (typeof record.hasAudio === "boolean") {
    file.hasAudio = record.hasAudio;
  }
  if (dimensions) file.dimensions = dimensions;
  return file;
}

function createCachedLibraryResponse(
  snapshot,
  rootPath,
  scanId = null,
  options = {}
) {
  if (!snapshot?.root || !Array.isArray(snapshot.records)) return null;
  return {
    files: snapshot.records
      .map((record) => createCachedVideoFileObject(record, rootPath, options))
      .filter(Boolean),
    root: { ...snapshot.root, refreshState: "refreshing" },
    directories: Array.isArray(snapshot.directories)
      ? snapshot.directories
      : [],
    totalRecordCount: Math.max(
      snapshot.records.length,
      Number(snapshot.totalRecordCount || 0)
    ),
    scanId,
    cached: true,
    refreshing: true,
  };
}

/**
 * Map a cross-root tag snapshot into renderer video records.
 *
 * A tag view reaches the same rows a folder view does, so it has to hand the
 * grid the same shape. The catalog projection it is built from is not that
 * shape: it carries no `id`, no `sourceUrl` and no `name`, so adopting it
 * directly produced a collection that could neither be keyed, played, nor
 * labelled.
 *
 * Each record resolves against its own root rather than one shared root, and
 * keeps that root on the object: relative paths from different roots collide,
 * so anything grouping or labelling by path needs the pair to stay distinct.
 */
function createTaggedLibraryFiles(records, options = {}) {
  if (!Array.isArray(records)) return [];
  return records
    .map((record) => {
      const rootPath = record?.rootPath;
      if (typeof rootPath !== "string" || !rootPath) return null;
      const file = createCachedVideoFileObject(record, rootPath, options);
      return file ? { ...file, rootPath } : null;
    })
    .filter(Boolean);
}

module.exports = {
  createCachedLibraryResponse,
  createCachedVideoFileObject,
  createTaggedLibraryFiles,
};
