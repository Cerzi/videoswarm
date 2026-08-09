const REVIEW_VIEW_VERSION = 1;
const REVIEW_VIEW_DEFINITION_BYTE_LIMIT = 8192;
const REVIEW_VIEW_TAG_LIMIT = 100;
const REVIEW_VIEW_TAG_LENGTH_LIMIT = 80;
const REVIEW_FILTERS = new Set([
  'any',
  'unreviewed',
  'reviewed',
  'pick',
  'reject',
]);
const REVIEW_SORT_KEYS = new Set(['name', 'created', 'resolution', 'random']);
const FOLDER_SCOPE_MODES = new Set([
  'all-descendants',
  'current-folder',
  'current-subtree',
]);

function compareCaseInsensitive(left, right) {
  const leftFolded = left.toLowerCase();
  const rightFolded = right.toLowerCase();
  if (leftFolded < rightFolded) return -1;
  if (leftFolded > rightFolded) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeTags(values) {
  const sorted = (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim().slice(0, REVIEW_VIEW_TAG_LENGTH_LIMIT))
    .filter(Boolean)
    .sort(compareCaseInsensitive);
  const seen = new Set();
  const normalized = [];
  for (const value of sorted) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
    if (normalized.length >= REVIEW_VIEW_TAG_LIMIT) break;
  }
  return normalized;
}

function normalizeRating(value, { minimum = 0 } = {}) {
  if (value === null || value === undefined || value === '') return null;
  let number;
  try {
    number = Number(value);
  } catch {
    return null;
  }
  if (!Number.isFinite(number)) return null;
  return Math.max(minimum, Math.min(5, Math.round(number)));
}

// Saved views must round-trip a resolution bound, and the value crosses the
// IPC boundary, so it is clamped to a sane range rather than trusted.
function normalizeMegapixels(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(1000, Math.round(number * 100) / 100);
}

function normalizeRandomSeed(value) {
  if (value === null || value === undefined || value === '') return null;
  let number;
  try {
    number = Number(value);
  } catch {
    return null;
  }
  if (!Number.isFinite(number)) return null;
  return Math.max(
    Number.MIN_SAFE_INTEGER,
    Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number))
  );
}

function normalizeReviewViewDefinition(
  input,
  {
    includeScope = false,
    preserveInactiveRandomSeed = false,
    requireRandomSeed = false,
    strictVersion = false,
  } = {}
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Review view definition must be an object');
  }
  const versionMatches = strictVersion
    ? input.version === REVIEW_VIEW_VERSION
    : Number(input.version) === REVIEW_VIEW_VERSION;
  if (!versionMatches) {
    throw new TypeError(`Review view version must be ${REVIEW_VIEW_VERSION}`);
  }

  const filtersInput = input.filters && typeof input.filters === 'object' &&
    !Array.isArray(input.filters)
    ? input.filters
    : {};
  const reviewFilterCandidate = typeof filtersInput.reviewFilter === 'string'
    ? filtersInput.reviewFilter.trim().toLowerCase()
    : 'any';
  const reviewFilter = REVIEW_FILTERS.has(reviewFilterCandidate)
    ? reviewFilterCandidate
    : 'any';

  const sortInput = input.sort && typeof input.sort === 'object' &&
    !Array.isArray(input.sort)
    ? input.sort
    : {};
  const sortKey = REVIEW_SORT_KEYS.has(sortInput.key) ? sortInput.key : 'name';
  const normalizedSeed = normalizeRandomSeed(sortInput.randomSeed);
  const randomSeed = sortKey === 'random' || preserveInactiveRandomSeed
    ? normalizedSeed
    : null;
  if (sortKey === 'random' && requireRandomSeed && randomSeed === null) {
    throw new TypeError('Random review sort requires an integer seed');
  }

  const normalized = {
    version: REVIEW_VIEW_VERSION,
    filters: {
      includeTags: normalizeTags(filtersInput.includeTags),
      excludeTags: normalizeTags(filtersInput.excludeTags),
      minRating: normalizeRating(filtersInput.minRating, { minimum: 1 }),
      exactRating: normalizeRating(filtersInput.exactRating),
      reviewFilter,
      minMegapixels: normalizeMegapixels(filtersInput.minMegapixels),
      maxMegapixels: normalizeMegapixels(filtersInput.maxMegapixels),
    },
    sort: {
      key: sortKey,
      dir: sortInput.dir === 'desc' ? 'desc' : 'asc',
      groupByFolders: sortInput.groupByFolders !== false,
      randomSeed,
    },
  };

  if (normalized.filters.exactRating !== null) {
    normalized.filters.minRating = null;
  }

  if (includeScope) {
    const scopeInput = input.scope && typeof input.scope === 'object'
      ? input.scope.mode
      : input.scopeMode;
    normalized.scope = {
      mode: FOLDER_SCOPE_MODES.has(scopeInput)
        ? scopeInput
        : 'all-descendants',
    };
  }

  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > REVIEW_VIEW_DEFINITION_BYTE_LIMIT) {
    throw new RangeError(
      `Review view definition exceeds ${REVIEW_VIEW_DEFINITION_BYTE_LIMIT} bytes`
    );
  }
  return normalized;
}

module.exports = {
  FOLDER_SCOPE_MODES,
  REVIEW_VIEW_DEFINITION_BYTE_LIMIT,
  REVIEW_VIEW_TAG_LENGTH_LIMIT,
  REVIEW_VIEW_TAG_LIMIT,
  REVIEW_VIEW_VERSION,
  compareCaseInsensitive,
  normalizeReviewViewDefinition,
};
