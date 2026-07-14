"use strict";

const REVIEW_RESTORE_MAX_SNAPSHOTS = 20_000;
const REVIEW_STATES = new Set(["unreviewed", "reviewed", "pick", "reject"]);

function normalizeReviewRestoreSnapshots(value) {
  if (
    !Array.isArray(value) ||
    value.length > REVIEW_RESTORE_MAX_SNAPSHOTS
  ) {
    throw new TypeError(
      `Review restore snapshots must contain at most ${REVIEW_RESTORE_MAX_SNAPSHOTS.toLocaleString()} entries`
    );
  }

  const fingerprints = new Set();
  return value.map((snapshot) => {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new TypeError("Every review restore snapshot must be an object");
    }
    const prototype = Object.getPrototypeOf(snapshot);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Every review restore snapshot must be a plain object");
    }

    const fingerprint =
      typeof snapshot.fingerprint === "string"
        ? snapshot.fingerprint.trim()
        : "";
    if (
      !fingerprint ||
      fingerprint.length > 512 ||
      fingerprint.includes("\0")
    ) {
      throw new TypeError("Every review restore snapshot requires a valid fingerprint");
    }
    if (fingerprints.has(fingerprint)) {
      throw new TypeError("Review restore snapshots contain a duplicate fingerprint");
    }
    fingerprints.add(fingerprint);

    const reviewState =
      typeof snapshot.reviewState === "string"
        ? snapshot.reviewState.trim()
        : "";
    if (!REVIEW_STATES.has(reviewState)) {
      throw new TypeError("Every review restore snapshot requires a valid review state");
    }

    const rating =
      snapshot.rating === null || snapshot.rating === undefined
        ? null
        : snapshot.rating;
    if (
      rating !== null &&
      (!Number.isSafeInteger(rating) || rating < 0 || rating > 5)
    ) {
      throw new TypeError("Every review restore rating must be null or an integer from 0 to 5");
    }
    if (reviewState === "unreviewed" && rating !== null) {
      throw new TypeError("Unreviewed metadata cannot retain a rating");
    }

    // Reconstruct the native payload so renderer-controlled fields such as
    // tags can never be restored as an unintended side effect of Undo.
    return { fingerprint, reviewState, rating };
  });
}

module.exports = {
  REVIEW_RESTORE_MAX_SNAPSHOTS,
  normalizeReviewRestoreSnapshots,
};
