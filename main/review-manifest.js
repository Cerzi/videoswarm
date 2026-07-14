const path = require("path");
const { writeFileAtomically } = require("./settings-writer");

const REVIEW_MANIFEST_FORMAT = "videoswarm-review-manifest";
const REVIEW_MANIFEST_VERSION = 1;
const REVIEW_MANIFEST_MAX_RECORDS = 20_000;
const REVIEW_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const REVIEW_MANIFEST_MAX_TAG_ROWS = 100_000;
const REVIEW_MANIFEST_MAX_TAG_BYTES = 8 * 1024 * 1024;
// Leave headroom below the serialized-file cap for manifest metadata and JSON
// structure while bounding the live record/tag payload assembled from SQLite.
const REVIEW_MANIFEST_MAX_QUERY_BYTES = 24 * 1024 * 1024;
const REVIEW_MANIFEST_MAX_FILENAME_BYTES = 180;
const REVIEW_MANIFEST_FILENAME_SUFFIX = "-review-manifest.json";
const REVIEW_MANIFEST_SCOPES = Object.freeze([
  "all-descendants",
  "current-folder",
  "current-subtree",
]);
const REVIEW_STATES = new Set(["unreviewed", "reviewed", "pick", "reject"]);

class ReviewManifestError extends Error {
  constructor(message, code = "REVIEW_MANIFEST_ERROR") {
    super(message);
    this.name = "ReviewManifestError";
    this.code = code;
  }
}

function normalizeManifestScope(value) {
  if (!REVIEW_MANIFEST_SCOPES.includes(value)) {
    throw new ReviewManifestError(
      "Review manifest scope is invalid",
      "INVALID_REVIEW_MANIFEST_SCOPE"
    );
  }
  return value;
}

function normalizeManifestDirectory(value = "") {
  if (typeof value !== "string" || value.includes("\0") || value.length > 32_768) {
    throw new ReviewManifestError(
      "Review manifest directory is invalid",
      "INVALID_REVIEW_MANIFEST_DIRECTORY"
    );
  }
  const portableInput = value.replace(/\\/g, "/");
  if (
    portableInput.startsWith("/") ||
    /^[a-zA-Z]:\//.test(portableInput) ||
    portableInput.split("/").some((part) => part === "..")
  ) {
    throw new ReviewManifestError(
      "Review manifest directory must stay inside its library root",
      "INVALID_REVIEW_MANIFEST_DIRECTORY"
    );
  }
  const portable = portableInput
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  return portable === "." ? "" : portable;
}

function normalizeRelativeFilePath(value) {
  const normalized = normalizeManifestDirectory(value);
  if (!normalized) {
    throw new ReviewManifestError(
      "Review manifest record has no relative path",
      "INVALID_REVIEW_MANIFEST_RECORD"
    );
  }
  return normalized;
}

function portableDirectoryName(relativePath) {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
}

function recordIsInScope(relativePath, directory, scope) {
  if (scope === "all-descendants") return true;
  const recordDirectory = portableDirectoryName(relativePath);
  if (scope === "current-folder") return recordDirectory === directory;
  return (
    recordDirectory === directory ||
    (directory === "" ? true : recordDirectory.startsWith(`${directory}/`))
  );
}

function assertPersistedCoverage(root, directory, scope) {
  if (root?.refreshState !== "idle") {
    throw new ReviewManifestError(
      "The library index is not ready. Finish refreshing this folder before exporting.",
      "REVIEW_MANIFEST_INDEX_NOT_READY"
    );
  }
  const completedAt = Number(root?.lastScanCompletedAt);
  const startedAt = Number(root?.lastScanStartedAt);
  if (
    !Number.isFinite(completedAt) ||
    completedAt <= 0 ||
    (Number.isFinite(startedAt) && startedAt > completedAt)
  ) {
    throw new ReviewManifestError(
      "The library index has no completed scan for this folder. Refresh it before exporting.",
      "REVIEW_MANIFEST_INCOMPLETE_INDEX"
    );
  }
  if (root?.recursive) return;
  if (scope === "current-folder" && directory === "") return;
  throw new ReviewManifestError(
    "The selected scope has not been indexed recursively. Reopen it recursively before exporting.",
    "REVIEW_MANIFEST_INCOMPLETE_INDEX"
  );
}

function normalizeRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 0 && rating <= 5 ? rating : null;
}

function normalizeNonNegativeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeDimensions(value) {
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function normalizeExportedAt(value) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new ReviewManifestError(
      "Review manifest export timestamp is invalid",
      "REVIEW_MANIFEST_INVALID_TIMESTAMP"
    );
  }
  return new Date(timestamp).toISOString();
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function mapManifestRecord(record) {
  const relativePath = normalizeRelativeFilePath(record?.relativePath);
  const reviewState = REVIEW_STATES.has(record?.reviewState)
    ? record.reviewState
    : "unreviewed";
  const fingerprint =
    typeof record?.fingerprint === "string" && record.fingerprint
      ? record.fingerprint
      : null;
  const tags = [...new Set(
    (Array.isArray(record?.tags) ? record.tags : [])
      .filter((tag) => typeof tag === "string" && tag.trim())
      .map((tag) => tag.trim())
  )].sort(compareText);

  return {
    relativePath,
    fingerprint,
    reviewState,
    rating: normalizeRating(record?.rating),
    tags,
    sizeBytes: Math.round(normalizeNonNegativeNumber(record?.size, 0)),
    modifiedAtMs: normalizeNonNegativeNumber(record?.mtimeMs),
    createdAtMs: normalizeNonNegativeNumber(record?.createdMs),
    dimensions: normalizeDimensions(record?.dimensions),
  };
}

function summarizeManifestRecords(records) {
  const unique = new Set();
  const summary = {
    instanceCount: records.length,
    uniqueCount: 0,
    reviewedTotal: 0,
    accept: 0,
    reviewed: 0,
    reject: 0,
    unreviewed: 0,
  };
  records.forEach((record) => {
    if (record.reviewState === "pick") summary.accept += 1;
    else summary[record.reviewState] += 1;
    if (record.reviewState !== "unreviewed" || record.rating !== null) {
      summary.reviewedTotal += 1;
    }
    unique.add(record.fingerprint || `path:${record.relativePath}`);
  });
  summary.uniqueCount = unique.size;
  return summary;
}

function safeRootName(root) {
  if (typeof root?.label === "string" && root.label.trim()) {
    return root.label.trim();
  }
  const candidate = String(root?.rootPath || "Library");
  return path.basename(candidate) || "Library";
}

function createReviewManifest({
  profile,
  root,
  directory = "",
  scope,
  records,
  exportedAt = Date.now(),
}) {
  const normalizedScope = normalizeManifestScope(scope);
  const normalizedDirectory = normalizeManifestDirectory(directory);
  if (!root || typeof root !== "object") {
    throw new ReviewManifestError("Indexed library root is required", "REVIEW_MANIFEST_ROOT_MISSING");
  }
  assertPersistedCoverage(root, normalizedDirectory, normalizedScope);
  const sourceRecords = Array.isArray(records) ? records : [];
  const scopedRecords = sourceRecords
    .map(mapManifestRecord)
    .filter((record) =>
      recordIsInScope(record.relativePath, normalizedDirectory, normalizedScope)
    )
    .sort((left, right) =>
      compareText(left.relativePath, right.relativePath) ||
      compareText(left.fingerprint || "", right.fingerprint || "")
    );

  if (scopedRecords.length > REVIEW_MANIFEST_MAX_RECORDS) {
    throw new ReviewManifestError(
      `Review manifests are limited to ${REVIEW_MANIFEST_MAX_RECORDS.toLocaleString()} files`,
      "REVIEW_MANIFEST_TOO_MANY_RECORDS"
    );
  }

  let tagRows = 0;
  let tagBytes = 0;
  scopedRecords.forEach((record) => {
    record.tags.forEach((tag) => {
      tagRows += 1;
      tagBytes += Buffer.byteLength(tag, "utf8");
    });
  });
  if (tagRows > REVIEW_MANIFEST_MAX_TAG_ROWS) {
    throw new ReviewManifestError(
      `Review manifests are limited to ${REVIEW_MANIFEST_MAX_TAG_ROWS.toLocaleString()} tag assignments`,
      "REVIEW_MANIFEST_TOO_MANY_TAGS"
    );
  }
  if (tagBytes > REVIEW_MANIFEST_MAX_TAG_BYTES) {
    throw new ReviewManifestError(
      "Review manifest tags exceed the 8 MiB safety limit",
      "REVIEW_MANIFEST_TAGS_TOO_LARGE"
    );
  }

  const profileId = typeof profile?.id === "string" ? profile.id : "";
  if (!profileId) {
    throw new ReviewManifestError("Active profile identity is required", "REVIEW_MANIFEST_PROFILE_MISSING");
  }

  return {
    format: REVIEW_MANIFEST_FORMAT,
    version: REVIEW_MANIFEST_VERSION,
    exportedAt: normalizeExportedAt(exportedAt),
    profile: {
      id: profileId,
      name: typeof profile?.name === "string" && profile.name ? profile.name : profileId,
    },
    root: {
      name: safeRootName(root),
      recursiveCoverage: Boolean(root.recursive),
      refreshState: typeof root.refreshState === "string" ? root.refreshState : "unknown",
      lastScanCompletedAt: root.lastScanCompletedAt ?? null,
    },
    scope: {
      kind: normalizedScope,
      directory: normalizedScope === "all-descendants" ? "" : normalizedDirectory,
    },
    summary: summarizeManifestRecords(scopedRecords),
    clips: scopedRecords,
  };
}

function serializeReviewManifest(manifest, maxBytes = REVIEW_MANIFEST_MAX_BYTES) {
  let serialized;
  try {
    serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (error) {
    throw new ReviewManifestError(
      "Review manifest could not be serialized",
      "REVIEW_MANIFEST_INVALID",
      { cause: error }
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new ReviewManifestError(
      "Review manifest exceeds the 32 MiB safety limit",
      "REVIEW_MANIFEST_TOO_LARGE"
    );
  }
  return serialized;
}

async function writeReviewManifest(destination, manifest, options = {}) {
  if (typeof destination !== "string" || !destination || destination.includes("\0")) {
    throw new ReviewManifestError(
      "Review manifest destination is invalid",
      "REVIEW_MANIFEST_DESTINATION_INVALID"
    );
  }
  const serialized = serializeReviewManifest(
    manifest,
    options.maxBytes ?? REVIEW_MANIFEST_MAX_BYTES
  );
  const atomicWrite = options.writeFileAtomically || writeFileAtomically;
  let writeOptions = options.writeOptions;
  if (typeof options.assertActive === "function" && !writeOptions?.assertActive) {
    writeOptions = { ...(writeOptions || {}), assertActive: options.assertActive };
  }
  await atomicWrite(path.resolve(destination), serialized, writeOptions);
  return { bytes: Buffer.byteLength(serialized, "utf8") };
}

function reviewManifestDefaultName(root) {
  let stem = safeRootName(root)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  const maxStemBytes =
    REVIEW_MANIFEST_MAX_FILENAME_BYTES -
    Buffer.byteLength(REVIEW_MANIFEST_FILENAME_SUFFIX, "utf8");
  stem = stem.slice(0, maxStemBytes).replace(/[._-]+$/g, "") || "library";
  return `${stem}${REVIEW_MANIFEST_FILENAME_SUFFIX}`;
}

module.exports = {
  REVIEW_MANIFEST_FORMAT,
  REVIEW_MANIFEST_VERSION,
  REVIEW_MANIFEST_MAX_RECORDS,
  REVIEW_MANIFEST_MAX_BYTES,
  REVIEW_MANIFEST_MAX_TAG_ROWS,
  REVIEW_MANIFEST_MAX_TAG_BYTES,
  REVIEW_MANIFEST_MAX_QUERY_BYTES,
  REVIEW_MANIFEST_MAX_FILENAME_BYTES,
  REVIEW_MANIFEST_SCOPES,
  ReviewManifestError,
  assertPersistedCoverage,
  createReviewManifest,
  normalizeManifestDirectory,
  normalizeManifestScope,
  reviewManifestDefaultName,
  serializeReviewManifest,
  writeReviewManifest,
};
