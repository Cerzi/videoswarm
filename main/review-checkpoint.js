const {
  FOLDER_SCOPE_MODES,
  REVIEW_VIEW_DEFINITION_BYTE_LIMIT,
  normalizeReviewViewDefinition,
} = require('./review-view-definition');

const REVIEW_CHECKPOINT_LIMIT = 128;
const REVIEW_CHECKPOINT_FINGERPRINT_LIMIT = 512;
const REVIEW_CHECKPOINT_DIRECTORY_LIMIT = 32 * 1024;

class ReviewCheckpointError extends Error {
  constructor(message, code = 'REVIEW_CHECKPOINT_ERROR') {
    super(message);
    this.name = 'ReviewCheckpointError';
    this.code = code;
  }
}

function normalizeCheckpointScope(value) {
  if (!FOLDER_SCOPE_MODES.has(value)) {
    throw new ReviewCheckpointError(
      'Review checkpoint scope is invalid',
      'INVALID_REVIEW_CHECKPOINT_SCOPE'
    );
  }
  return value;
}

function normalizeCheckpointDirectory(value = '') {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.length > REVIEW_CHECKPOINT_DIRECTORY_LIMIT
  ) {
    throw new ReviewCheckpointError(
      'Review checkpoint directory is invalid',
      'INVALID_REVIEW_CHECKPOINT_DIRECTORY'
    );
  }
  const portableInput = value.replace(/\\/g, '/');
  if (
    portableInput.startsWith('/') ||
    /^[a-zA-Z]:\//.test(portableInput) ||
    portableInput.split('/').some((part) => part === '..')
  ) {
    throw new ReviewCheckpointError(
      'Review checkpoint directory must stay inside its library root',
      'INVALID_REVIEW_CHECKPOINT_DIRECTORY'
    );
  }
  return portableInput
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}

function normalizeCheckpointAnchorId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ReviewCheckpointError(
      'Review checkpoint anchor instance id is invalid',
      'INVALID_REVIEW_CHECKPOINT_ANCHOR'
    );
  }
  return id;
}

function normalizeCheckpointFingerprint(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new ReviewCheckpointError(
      'Review checkpoint anchor fingerprint is invalid',
      'INVALID_REVIEW_CHECKPOINT_ANCHOR'
    );
  }
  const fingerprint = value.trim();
  if (!fingerprint || fingerprint.length > REVIEW_CHECKPOINT_FINGERPRINT_LIMIT) {
    throw new ReviewCheckpointError(
      'Review checkpoint anchor fingerprint is invalid',
      'INVALID_REVIEW_CHECKPOINT_ANCHOR'
    );
  }
  return fingerprint;
}

function normalizeCheckpointView(value) {
  try {
    const normalized = normalizeReviewViewDefinition(value, {
      requireRandomSeed: true,
      strictVersion: true,
    });
    const serialized = JSON.stringify(normalized);
    if (
      Buffer.byteLength(serialized, 'utf8') >
      REVIEW_VIEW_DEFINITION_BYTE_LIMIT
    ) {
      throw new RangeError('Review checkpoint view is too large');
    }
    return { normalized, serialized };
  } catch (error) {
    if (error instanceof ReviewCheckpointError) throw error;
    throw new ReviewCheckpointError(
      error?.message || 'Review checkpoint view is invalid',
      error instanceof RangeError
        ? 'REVIEW_CHECKPOINT_VIEW_TOO_LARGE'
        : 'INVALID_REVIEW_CHECKPOINT_VIEW'
    );
  }
}

module.exports = {
  REVIEW_CHECKPOINT_DIRECTORY_LIMIT,
  REVIEW_CHECKPOINT_FINGERPRINT_LIMIT,
  REVIEW_CHECKPOINT_LIMIT,
  ReviewCheckpointError,
  normalizeCheckpointAnchorId,
  normalizeCheckpointDirectory,
  normalizeCheckpointFingerprint,
  normalizeCheckpointScope,
  normalizeCheckpointView,
};
