import {
  REVIEW_FILTERS,
  REVIEW_STATES,
  isReviewedState,
  matchesReviewFilter,
  normalizeReviewFilter,
  normalizeReviewState,
  reviewStateLabel,
} from "./reviewState";

describe("reviewState", () => {
  it("normalizes invalid state and filter values safely", () => {
    expect(normalizeReviewState(" PICK ")).toBe(REVIEW_STATES.PICK);
    expect(normalizeReviewState("unknown")).toBe(REVIEW_STATES.UNREVIEWED);
    expect(normalizeReviewFilter(" Reject ")).toBe(REVIEW_FILTERS.REJECT);
    expect(normalizeReviewFilter(null)).toBe(REVIEW_FILTERS.ANY);
  });

  it("treats picks and rejects as reviewed", () => {
    expect(isReviewedState(REVIEW_STATES.UNREVIEWED)).toBe(false);
    expect(isReviewedState(REVIEW_STATES.REVIEWED)).toBe(true);
    expect(isReviewedState(REVIEW_STATES.PICK)).toBe(true);
    expect(isReviewedState(REVIEW_STATES.REJECT)).toBe(true);
  });

  it("supports broad reviewed and exact review filters", () => {
    expect(matchesReviewFilter(REVIEW_STATES.PICK, REVIEW_FILTERS.REVIEWED)).toBe(true);
    expect(matchesReviewFilter(REVIEW_STATES.REJECT, REVIEW_FILTERS.PICK)).toBe(false);
    expect(matchesReviewFilter(REVIEW_STATES.UNREVIEWED, REVIEW_FILTERS.UNREVIEWED)).toBe(true);
    expect(matchesReviewFilter(REVIEW_STATES.UNREVIEWED, REVIEW_FILTERS.ANY)).toBe(true);
  });

  it("provides compact user-facing labels", () => {
    expect(reviewStateLabel(REVIEW_STATES.PICK)).toBe("Accept");
    expect(reviewStateLabel(REVIEW_STATES.REVIEWED)).toBe("Reviewed");
    expect(reviewStateLabel(REVIEW_STATES.REJECT)).toBe("Reject");
    expect(reviewStateLabel("invalid")).toBe("Unreviewed");
  });
});
