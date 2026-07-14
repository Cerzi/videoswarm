import { REVIEW_STATES, normalizeReviewState } from "./reviewState";

export const REVIEW_RESULTS_TRASH_LIMIT = 2_000;

const hasRating = (value) => {
  if (value === null || value === undefined || value === "") return false;
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 0 && rating <= 5;
};

const uniqueIdentity = (video, index) => {
  if (typeof video?.fingerprint === "string" && video.fingerprint) {
    return `fingerprint:${video.fingerprint}`;
  }
  const instanceId = Number(video?.instanceId);
  if (Number.isSafeInteger(instanceId) && instanceId > 0) {
    return `instance:${instanceId}`;
  }
  const path = video?.fullPath || video?.absolutePath || video?.relativePath;
  return typeof path === "string" && path ? `path:${path}` : `row:${index}`;
};

const isLocalFileInstance = (video) =>
  video?.isElectronFile === true &&
  typeof video?.fullPath === "string" &&
  video.fullPath.length > 0;

/**
 * Summarize an already scoped, unfiltered collection. Review-state counts are
 * instance counts because file actions apply to concrete files. uniqueCount
 * separately reports content identities, and the rating fallback preserves
 * the historical invariant that a rated clip contributes to review progress.
 */
export function summarizeReviewScope(videos = []) {
  const rows = Array.isArray(videos) ? videos.filter(Boolean) : [];
  const unique = new Set();
  const rejectVideos = [];
  const counts = {
    pick: 0,
    reviewed: 0,
    reject: 0,
    unreviewed: 0,
  };
  let reviewedTotal = 0;

  rows.forEach((video, index) => {
    const state = normalizeReviewState(video.reviewState);
    counts[state] += 1;
    if (state !== REVIEW_STATES.UNREVIEWED || hasRating(video.rating)) {
      reviewedTotal += 1;
    }
    if (state === REVIEW_STATES.REJECT && isLocalFileInstance(video)) {
      rejectVideos.push(video);
    }
    unique.add(uniqueIdentity(video, index));
  });

  return {
    instanceCount: rows.length,
    uniqueCount: unique.size,
    pick: counts.pick,
    reviewed: counts.reviewed,
    reject: counts.reject,
    unreviewed: counts.unreviewed,
    reviewedTotal,
    rejectVideos,
    trashableRejectCount: rejectVideos.length,
    nonLocalRejectCount: Math.max(0, counts.reject - rejectVideos.length),
    trashLimit: REVIEW_RESULTS_TRASH_LIMIT,
    canTrashRejects:
      rejectVideos.length > 0 &&
      rejectVideos.length <= REVIEW_RESULTS_TRASH_LIMIT,
  };
}
