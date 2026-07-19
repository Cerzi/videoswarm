"use strict";

const ACCEPTED_COPY_MAX_MEDIA = 20_000;
const ACCEPTED_COPY_MAX_PATH_BYTES = 16 * 1024 * 1024;
const REVIEW_EXPORT_SCOPES = Object.freeze([
  "all-descendants",
  "current-folder",
  "current-subtree",
]);

class ReviewExportError extends Error {
  constructor(message, code = "REVIEW_EXPORT_ERROR") {
    super(message);
    this.name = "ReviewExportError";
    this.code = code;
  }
}

function normalizeReviewExportScope(value) {
  if (!REVIEW_EXPORT_SCOPES.includes(value)) {
    throw new ReviewExportError(
      "Review-result scope is invalid",
      "INVALID_REVIEW_EXPORT_SCOPE"
    );
  }
  return value;
}

function normalizeReviewExportDirectory(value = "") {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > 32_768
  ) {
    throw new ReviewExportError(
      "Review-result directory is invalid",
      "INVALID_REVIEW_EXPORT_DIRECTORY"
    );
  }

  const portableInput = value.replace(/\\/gu, "/");
  if (
    portableInput.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(portableInput) ||
    portableInput.split("/").some((part) => part === "..")
  ) {
    throw new ReviewExportError(
      "Review-result directory must stay inside its library root",
      "INVALID_REVIEW_EXPORT_DIRECTORY"
    );
  }

  return portableInput
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function normalizeReviewExportRelativePath(value) {
  const normalized = normalizeReviewExportDirectory(value);
  if (!normalized) {
    throw new ReviewExportError(
      "Accepted media has no relative path",
      "INVALID_REVIEW_EXPORT_RECORD"
    );
  }
  return normalized;
}

function assertReviewExportCoverage(root, directory, scope) {
  const normalizedScope = normalizeReviewExportScope(scope);
  const normalizedDirectory = normalizedScope === "all-descendants"
    ? ""
    : normalizeReviewExportDirectory(directory ?? "");

  if (!root || typeof root !== "object") {
    throw new ReviewExportError(
      "The selected library root has not been indexed",
      "REVIEW_EXPORT_ROOT_MISSING"
    );
  }
  if (root.refreshState !== "idle") {
    throw new ReviewExportError(
      "The library index is not ready. Finish refreshing this folder before copying accepted clips.",
      "REVIEW_EXPORT_INDEX_NOT_READY"
    );
  }

  const completedAt = Number(root.lastScanCompletedAt);
  const startedAt = Number(root.lastScanStartedAt);
  if (
    !Number.isFinite(completedAt) ||
    completedAt <= 0 ||
    (Number.isFinite(startedAt) && startedAt > completedAt)
  ) {
    throw new ReviewExportError(
      "The library index has no completed scan for this folder. Refresh it before copying accepted clips.",
      "REVIEW_EXPORT_INCOMPLETE_INDEX"
    );
  }

  if (root.recursive) return true;
  if (normalizedScope === "current-folder" && normalizedDirectory === "") {
    return true;
  }
  throw new ReviewExportError(
    "The selected scope has not been indexed recursively. Reopen it recursively before copying accepted clips.",
    "REVIEW_EXPORT_INCOMPLETE_INDEX"
  );
}

module.exports = {
  ACCEPTED_COPY_MAX_MEDIA,
  ACCEPTED_COPY_MAX_PATH_BYTES,
  REVIEW_EXPORT_SCOPES,
  ReviewExportError,
  assertReviewExportCoverage,
  normalizeReviewExportDirectory,
  normalizeReviewExportRelativePath,
  normalizeReviewExportScope,
};
