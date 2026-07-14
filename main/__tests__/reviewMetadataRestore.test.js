import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  REVIEW_RESTORE_MAX_SNAPSHOTS,
  normalizeReviewRestoreSnapshots,
} = require("../review-metadata-restore");

describe("review metadata restore boundary", () => {
  it("reconstructs only the atomic review fields", () => {
    expect(normalizeReviewRestoreSnapshots([
      {
        fingerprint: " fp-a ",
        reviewState: "pick",
        rating: 5,
        tags: ["must-not-cross-native-boundary"],
        absolutePath: "/private/clip.mp4",
      },
      { fingerprint: "fp-b", reviewState: "unreviewed", rating: null },
    ])).toEqual([
      { fingerprint: "fp-a", reviewState: "pick", rating: 5 },
      { fingerprint: "fp-b", reviewState: "unreviewed", rating: null },
    ]);
  });

  it("rejects duplicates, invalid states, ratings, and contradictions", () => {
    expect(() => normalizeReviewRestoreSnapshots([
      { fingerprint: "same", reviewState: "reviewed", rating: null },
      { fingerprint: "same", reviewState: "reject", rating: null },
    ])).toThrow(/duplicate fingerprint/i);
    expect(() => normalizeReviewRestoreSnapshots([
      { fingerprint: "fp", reviewState: "maybe", rating: null },
    ])).toThrow(/valid review state/i);
    expect(() => normalizeReviewRestoreSnapshots([
      { fingerprint: "fp", reviewState: "reviewed", rating: 4.5 },
    ])).toThrow(/integer from 0 to 5/i);
    expect(() => normalizeReviewRestoreSnapshots([
      { fingerprint: "fp", reviewState: "unreviewed", rating: 4 },
    ])).toThrow(/cannot retain a rating/i);
  });

  it("enforces the native batch bound before mapping entries", () => {
    expect(() => normalizeReviewRestoreSnapshots(
      new Array(REVIEW_RESTORE_MAX_SNAPSHOTS + 1)
    )).toThrow(/at most 20,000/i);
  });
});
