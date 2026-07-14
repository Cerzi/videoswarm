const path = require("path");

function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    sizes.length - 1,
    Math.floor(Math.log(Math.max(1, bytes)) / Math.log(k))
  );
  return `${parseFloat((bytes / Math.pow(k, index)).toFixed(2))} ${sizes[index]}`;
}

function createCachedVideoFileObject(record, rootPath) {
  if (!record?.absolutePath) return null;
  const filePath = path.resolve(record.absolutePath);
  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();
  const size = Math.max(0, Number(record.size || 0));
  const modifiedMs = Math.max(0, Number(record.mtimeMs || 0));
  const createdMs = Math.max(0, Number(record.createdMs || modifiedMs));
  const dateModified = new Date(modifiedMs);
  const dateCreated = new Date(createdMs);
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

  return {
    id: filePath,
    instanceId: Number(record.instanceId) || null,
    name: fileName,
    fullPath: filePath,
    relativePath: path.relative(rootPath, filePath),
    extension,
    size,
    dateModified,
    dateCreated,
    isElectronFile: true,
    basename: fileName,
    dirname,
    createdMs,
    fingerprint: record.fingerprint || null,
    tags: Array.isArray(record.tags) ? record.tags : [],
    rating: Number.isFinite(record.rating) ? record.rating : null,
    reviewState: record.reviewState || "unreviewed",
    dimensions,
    aspectRatio: dimensions?.aspectRatio ?? null,
    metadata: {
      folder: path.dirname(filePath),
      baseName: path.basename(fileName, extension),
      sizeFormatted: formatFileSize(size),
      dateModifiedFormatted: dateModified.toLocaleDateString(),
      dateCreatedFormatted: dateCreated.toLocaleDateString(),
    },
  };
}

function createCachedLibraryResponse(snapshot, rootPath, scanId = null) {
  if (!snapshot?.root || !Array.isArray(snapshot.records)) return null;
  return {
    files: snapshot.records
      .map((record) => createCachedVideoFileObject(record, rootPath))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name)),
    root: { ...snapshot.root, refreshState: "refreshing" },
    directories: Array.isArray(snapshot.directories)
      ? snapshot.directories
      : [],
    scanId,
    cached: true,
    refreshing: true,
  };
}

module.exports = {
  createCachedLibraryResponse,
  createCachedVideoFileObject,
};
