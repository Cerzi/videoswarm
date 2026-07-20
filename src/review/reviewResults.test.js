import {
  REVIEW_RESULTS_TRASH_LIMIT,
  summarizeReviewScope,
} from "./reviewResults";

describe("summarizeReviewScope", () => {
  it("reports exact state, review-progress, instance, and unique counts", () => {
    const videos = [
      { instanceId: 1, fingerprint: "same", reviewState: "pick" },
      {
        instanceId: 2,
        fingerprint: "same",
        reviewState: "reject",
        isElectronFile: true,
        fullPath: "/library/reject.mp4",
      },
      { instanceId: 3, fingerprint: "neutral", reviewState: "reviewed" },
      { instanceId: 4, fingerprint: "rated", reviewState: "unreviewed", rating: 0 },
      { instanceId: 5, fingerprint: "new", reviewState: "unreviewed" },
    ];

    expect(summarizeReviewScope(videos)).toMatchObject({
      instanceCount: 5,
      uniqueCount: 4,
      pick: 1,
      acceptedCount: 1,
      reviewed: 1,
      reject: 1,
      unreviewed: 2,
      reviewedTotal: 4,
      rejectVideos: [videos[1]],
      trashableRejectCount: 1,
      nonLocalRejectCount: 0,
      canTrashRejects: true,
      canCopyAccepted: true,
    });
  });

  it("uses stable fallbacks for records without fingerprints", () => {
    const result = summarizeReviewScope([
      { instanceId: 7, reviewState: "unreviewed" },
      { instanceId: 7, reviewState: "reviewed" },
      { relativePath: "a.mp4", reviewState: "unreviewed" },
      { relativePath: "a.mp4", reviewState: "unreviewed" },
      { reviewState: "invalid" },
    ]);

    expect(result.instanceCount).toBe(5);
    expect(result.uniqueCount).toBe(3);
    expect(result.unreviewed).toBe(4);
    expect(result.reviewed).toBe(1);
  });

  it("refuses to admit a partial trash batch above the hard limit", () => {
    const rejects = Array.from(
      { length: REVIEW_RESULTS_TRASH_LIMIT + 1 },
      (_, index) => ({
        instanceId: index + 1,
        reviewState: "reject",
        isElectronFile: true,
        fullPath: `/library/reject-${index}.mp4`,
      })
    );

    const result = summarizeReviewScope(rejects);
    expect(result.reject).toBe(REVIEW_RESULTS_TRASH_LIMIT + 1);
    expect(result.canTrashRejects).toBe(false);
    expect(result.rejectVideos).toHaveLength(REVIEW_RESULTS_TRASH_LIMIT + 1);
  });

  it("counts non-local rejects without admitting them to native trash", () => {
    const result = summarizeReviewScope([
      { instanceId: 1, reviewState: "reject" },
      {
        instanceId: 2,
        reviewState: "reject",
        isElectronFile: true,
        fullPath: "/library/local.mp4",
      },
    ]);

    expect(result).toMatchObject({
      reject: 2,
      trashableRejectCount: 1,
      nonLocalRejectCount: 1,
      canTrashRejects: true,
    });
    expect(result.rejectVideos).toEqual([expect.objectContaining({ instanceId: 2 })]);
  });

  it("returns an empty, safe summary for invalid input", () => {
    expect(summarizeReviewScope(null)).toMatchObject({
      instanceCount: 0,
      uniqueCount: 0,
      reviewedTotal: 0,
      reject: 0,
      canTrashRejects: false,
      acceptedCount: 0,
      canCopyAccepted: false,
    });
  });
});
