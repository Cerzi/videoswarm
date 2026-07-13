export const REVIEW_STATES = Object.freeze({
  UNREVIEWED: "unreviewed",
  REVIEWED: "reviewed",
  PICK: "pick",
  REJECT: "reject",
});

export const REVIEW_FILTERS = Object.freeze({
  ANY: "any",
  ...REVIEW_STATES,
});

const REVIEW_STATE_SET = new Set(Object.values(REVIEW_STATES));
const REVIEW_FILTER_SET = new Set(Object.values(REVIEW_FILTERS));

export const normalizeReviewState = (
  value,
  fallback = REVIEW_STATES.UNREVIEWED
) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (REVIEW_STATE_SET.has(normalized)) return normalized;
  return REVIEW_STATE_SET.has(fallback) ? fallback : REVIEW_STATES.UNREVIEWED;
};

export const normalizeReviewFilter = (value) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return REVIEW_FILTER_SET.has(normalized) ? normalized : REVIEW_FILTERS.ANY;
};

export const isReviewedState = (value) =>
  normalizeReviewState(value) !== REVIEW_STATES.UNREVIEWED;

export const matchesReviewFilter = (state, filter) => {
  const normalizedFilter = normalizeReviewFilter(filter);
  if (normalizedFilter === REVIEW_FILTERS.ANY) return true;

  const normalizedState = normalizeReviewState(state);
  if (normalizedFilter === REVIEW_STATES.REVIEWED) {
    return isReviewedState(normalizedState);
  }

  return normalizedState === normalizedFilter;
};

export const reviewStateLabel = (value) => {
  switch (normalizeReviewState(value)) {
    case REVIEW_STATES.PICK:
      return "Pick";
    case REVIEW_STATES.REJECT:
      return "Reject";
    case REVIEW_STATES.REVIEWED:
      return "Reviewed";
    default:
      return "Unreviewed";
  }
};
