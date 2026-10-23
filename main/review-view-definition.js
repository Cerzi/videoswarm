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
  'not-reject',
]);
const REVIEW_SORT_KEYS = new Set(['name', 'created', 'resolution', 'rating', 'random']);
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

// Generation-version filter; see docs/architecture/generation-versions.md.
const VERSION_FILTERS = new Set(['any', 'superseded', 'best', 'supersedes']);

// Frame rate and workflow filters (docs/architecture/workflow-filters.md).
function normalizePositiveBound(value, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.min(max, Math.round(number * 100) / 100);
}
function normalizeWorkflowWords(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

// Companion app filters (docs/architecture/companion-app.md): a phase per
// action id, as src/app/companion/companionFilters.js reads them.
const COMPANION_PHASE_FILTERS = new Set([
  'not-sent', 'sent', 'under-way', 'done', 'stopped', 'n/a', 'not-done',
]);
const COMPANION_ACTION_ID = /^[a-z][a-z0-9_-]{0,31}$/u;

// Keys name a companion and one of its actions (`c1/polish`); a plain action
// id, saved when a profile had one companion, belongs to the first.
const COMPANION_FILTER_KEY = /^c[1-9]\/[a-z][a-z0-9_-]{0,31}$/;

// The apps whose "Hide clips already sent" switch is on, as sorted ids. A
// view saved with the old single switch (`true`) meant the first app.
const COMPANION_ID = /^c[1-9]$/u;
function normalizeCompanionHideSent(value) {
  if (value === true) return ['c1'];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && COMPANION_ID.test(id)))]
    .sort()
    .slice(0, 8);
}

// Tags chosen to filter by, per app: `{ c1: { tags, mode } }`, as
// src/app/companion/companionFilters.js reads them. These are the user's
// own filter choices; a companion's answers are never stored.
function normalizeCompanionTagFilters(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [id, entry] of Object.entries(value)) {
    if (!COMPANION_ID.test(id) || !entry || typeof entry !== 'object') continue;
    const tags = [];
    const seen = new Set();
    for (const raw of Array.isArray(entry.tags) ? entry.tags : []) {
      if (tags.length >= 20) break;
      const tag = typeof raw === 'string' ? raw.trim().slice(0, 64) : '';
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
    if (tags.length) result[id] = { tags, mode: entry.mode === 'all' ? 'all' : 'any' };
  }
  return result;
}

function normalizeCompanionFilters(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [rawKey, phase] of Object.entries(value)) {
    if (Object.keys(result).length >= 8) break;
    const key = COMPANION_ACTION_ID.test(rawKey) ? `c1/${rawKey}` : rawKey;
    if (COMPANION_FILTER_KEY.test(key) && COMPANION_PHASE_FILTERS.has(phase)) result[key] = phase;
  }
  return result;
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

  // Present only when set, so views saved without them keep their shape.
  const companionFilters = normalizeCompanionFilters(filtersInput.companionFilters);
  const companionHideSent = normalizeCompanionHideSent(filtersInput.companionHideSent);
  const companionTags = normalizeCompanionTagFilters(filtersInput.companionTags);
  const companion = {
    ...(Object.keys(companionFilters).length ? { companionFilters } : {}),
    ...(companionHideSent.length ? { companionHideSent } : {}),
    ...(Object.keys(companionTags).length ? { companionTags } : {}),
  };
  const promptQuery =
    typeof filtersInput.promptQuery === 'string' ? filtersInput.promptQuery.trim().slice(0, 200) : '';
  const mightBe =
    typeof filtersInput.mightBe === 'string' ? filtersInput.mightBe.trim().slice(0, 256) : '';
  // Present only when set, as above.
  const workflow = {};
  for (const [name, max] of [['minFrameRate', 1000], ['maxFrameRate', 1000]]) {
    const bound = normalizePositiveBound(filtersInput[name], max);
    if (bound !== null) workflow[name] = bound;
  }
  for (const name of ['minSteps', 'maxSteps']) {
    const bound = normalizePositiveBound(filtersInput[name], 100_000);
    if (bound !== null) workflow[name] = Math.round(bound);
  }
  for (const name of ['workflowInclude', 'workflowExclude']) {
    const words = normalizeWorkflowWords(filtersInput[name]);
    if (words) workflow[name] = words;
  }

  const normalized = {
    version: REVIEW_VIEW_VERSION,
    filters: {
      includeTags: normalizeTags(filtersInput.includeTags),
      excludeTags: normalizeTags(filtersInput.excludeTags),
      minRating: normalizeRating(filtersInput.minRating, { minimum: 1 }),
      exactRating: normalizeRating(filtersInput.exactRating),
      reviewFilter,
      includeTagsMode: filtersInput.includeTagsMode === 'any' ? 'any' : 'all',
      minMegapixels: normalizeMegapixels(filtersInput.minMegapixels),
      maxMegapixels: normalizeMegapixels(filtersInput.maxMegapixels),
      versionFilter: VERSION_FILTERS.has(filtersInput.versionFilter)
        ? filtersInput.versionFilter
        : 'any',
      ...companion,
      ...(promptQuery ? { promptQuery } : {}),
      ...(mightBe ? { mightBe } : {}),
      ...workflow,
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
    // Where a saved view searches: the open folder (the default, so every
    // view saved before this axis existed means what it meant), or every
    // indexed root, narrowed by whatever filters it has or not at all.
    normalized.searchScope = input.searchScope === 'library' ? 'library' : 'folder';
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
  REVIEW_SORT_KEYS,
  REVIEW_VIEW_DEFINITION_BYTE_LIMIT,
  REVIEW_VIEW_TAG_LENGTH_LIMIT,
  REVIEW_VIEW_TAG_LIMIT,
  REVIEW_VIEW_VERSION,
  compareCaseInsensitive,
  normalizeReviewViewDefinition,
};
