import {
  REVIEW_CHECKPOINT_VIEW_VERSION,
  REVIEW_SESSION_TAG_LIMIT,
  buildReviewCheckpointDraft,
  checkpointLocationMatches,
  createReviewCheckpointSignature,
  findNearestPresentDirectory,
  findRenderLimitStepForIndex,
  findSmallestRenderLimitStep,
  normalizeReviewAnchor,
  normalizeReviewCheckpoint,
  normalizeReviewSessionView,
  requiresRecursiveReviewCoverage,
  resolveContinueReviewCandidate,
  resolveReviewCheckpointLocation,
} from "./continueReview";

const view = (overrides = {}) => ({
  version: 1,
  filters: {
    includeTags: [],
    excludeTags: [],
    minRating: null,
    exactRating: null,
    reviewFilter: "any",
    ...overrides.filters,
  },
  sort: {
    key: "name",
    dir: "asc",
    groupByFolders: true,
    randomSeed: null,
    ...overrides.sort,
  },
});

const checkpoint = (overrides = {}) => ({
  rootPath: "/library",
  directory: "run/one",
  scope: "current-folder",
  view: view(),
  anchorInstanceId: 2,
  anchorFingerprint: "fp-2",
  updatedAt: 123,
  ...overrides,
});

const video = (
  id,
  instanceId,
  fingerprint,
  reviewState = "unreviewed",
  overrides = {}
) => ({
  id,
  instanceId,
  fingerprint,
  reviewState,
  basename: `${id}.mp4`,
  present: true,
  ...overrides,
});

describe("Continue Review checkpoint normalization", () => {
  it("normalizes and bounds the persisted view definition deterministically", () => {
    const includeTags = Array.from(
      { length: REVIEW_SESSION_TAG_LIMIT + 5 },
      (_, index) => `tag-${String(index).padStart(3, "0")}`
    );
    includeTags.push(" ALPHA ", "alpha", "x".repeat(100));

    expect(normalizeReviewSessionView({
      version: 999,
      filters: {
        includeTags,
        excludeTags: [" Zebra ", "zebra", "Apple"],
        minRating: 3,
        exactRating: 4.4,
        reviewFilter: "PICK",
      },
      sort: {
        key: "random",
        dir: "desc",
        groupByFolders: false,
        randomSeed: 42.9,
      },
    })).toEqual({
      version: REVIEW_CHECKPOINT_VIEW_VERSION,
      filters: {
        includeTags: expect.arrayContaining(["ALPHA"]),
        excludeTags: ["Apple", "Zebra"],
        minRating: null,
        exactRating: 4,
        reviewFilter: "pick",
      },
      sort: {
        key: "random",
        dir: "desc",
        groupByFolders: false,
        randomSeed: 42,
      },
    });
    expect(normalizeReviewSessionView({ filters: { includeTags } }).filters.includeTags)
      .toHaveLength(REVIEW_SESSION_TAG_LIMIT);
  });

  it("uses bounded defaults and keeps random order reproducible", () => {
    expect(normalizeReviewSessionView({
      filters: { minRating: -10, exactRating: "", reviewFilter: "unknown" },
      sort: { key: "random", randomSeed: "invalid" },
    })).toEqual({
      version: 1,
      filters: {
        includeTags: [],
        excludeTags: [],
        minRating: 1,
        exactRating: null,
        reviewFilter: "any",
      },
      sort: {
        key: "random",
        dir: "asc",
        groupByFolders: true,
        randomSeed: 0,
      },
    });
  });

  it("normalizes anchors and strips timestamps from save drafts/signatures", () => {
    expect(normalizeReviewAnchor({
      anchor: { instanceId: "4", fingerprint: " fp-4 " },
    })).toEqual({ anchorInstanceId: 4, anchorFingerprint: "fp-4" });
    expect(normalizeReviewAnchor({
      anchorInstanceId: -1,
      anchorFingerprint: " ",
    })).toEqual({ anchorInstanceId: null, anchorFingerprint: null });

    const normalized = normalizeReviewCheckpoint(checkpoint({ updatedAt: 987 }));
    expect(normalized.updatedAt).toBe(987);
    expect(buildReviewCheckpointDraft(normalized)).not.toHaveProperty("updatedAt");
    expect(createReviewCheckpointSignature(normalized)).toBe(
      createReviewCheckpointSignature({ ...normalized, updatedAt: 654 })
    );
  });

  it("forces All descendants to the root and compares normalized locations", () => {
    const normalized = normalizeReviewCheckpoint(checkpoint({
      directory: "ignored/path",
      scope: "all-descendants",
    }));
    expect(normalized.directory).toBe("");
    expect(checkpointLocationMatches(normalized, {
      rootPath: "/library",
      directory: "also/ignored",
      scope: "all-descendants",
    })).toBe(true);
    expect(checkpointLocationMatches(normalized, {
      rootPath: "/other",
      directory: "",
      scope: "all-descendants",
    })).toBe(false);
  });
});

describe("Continue Review location recovery", () => {
  it("finds an exact directory or its nearest present ancestor", () => {
    const directories = [
      { relativePath: "run", present: true },
      { path: "run/one", present: false },
      "other",
    ];
    expect(findNearestPresentDirectory("run/one/deep", directories)).toBe("run");
    expect(findNearestPresentDirectory("other", directories)).toBe("other");
    expect(findNearestPresentDirectory("gone/deep", directories)).toBe("");
  });

  it("reports missing-directory fallback without changing scope", () => {
    expect(resolveReviewCheckpointLocation(
      checkpoint({ directory: "run/one/deep", scope: "current-subtree" }),
      [{ relativePath: "run" }]
    )).toEqual({
      rootPath: "/library",
      directory: "run",
      scope: "current-subtree",
      didFallback: true,
      requestedDirectory: "run/one/deep",
    });
  });
});

describe("Continue Review candidate resolution", () => {
  const videos = [
    video("a", 1, "fp-1", "unreviewed"),
    video("b", 2, "fp-2", "reviewed"),
    video("c", 3, "fp-3", "unreviewed"),
  ];

  it("selects an exact still-Unreviewed instance anchor first", () => {
    const result = resolveContinueReviewCandidate(videos, checkpoint({
      anchorInstanceId: 1,
      anchorFingerprint: "fp-1",
    }));
    expect(result).toMatchObject({
      candidateId: "a",
      candidateInstanceId: 1,
      candidateIndex: 0,
      anchorIndex: 0,
      anchorResolution: "instance",
      wrapped: false,
      reason: "anchor",
    });
  });

  it("searches after a reviewed anchor", () => {
    expect(resolveContinueReviewCandidate(videos, checkpoint())).toMatchObject({
      candidateId: "c",
      candidateIndex: 2,
      anchorIndex: 1,
      reason: "after-anchor",
    });
  });

  it("requires the fingerprint to match an instance and falls back by content", () => {
    const moved = [
      video("changed-instance", 2, "new-content", "reviewed"),
      video("moved-copy", 9, "fp-2", "reviewed"),
      video("candidate", 10, "fp-10", "unreviewed"),
    ];
    expect(resolveContinueReviewCandidate(moved, checkpoint())).toMatchObject({
      candidateId: "candidate",
      anchorIndex: 1,
      anchorResolution: "fingerprint",
      reason: "after-anchor",
    });
  });

  it("uses the first content duplicate as the fingerprint fallback", () => {
    const duplicates = [
      video("first-copy", 8, "fp-2", "reviewed"),
      video("second-copy", 9, "fp-2", "reviewed"),
      video("next", 10, "fp-next", "unreviewed"),
    ];
    expect(resolveContinueReviewCandidate(duplicates, checkpoint({
      anchorInstanceId: 999,
    }))).toMatchObject({
      candidateId: "next",
      anchorIndex: 0,
      anchorResolution: "fingerprint",
    });
  });

  it("wraps once when only an earlier candidate remains", () => {
    expect(resolveContinueReviewCandidate([
      video("earlier", 1, "fp-1", "unreviewed"),
      video("anchor", 2, "fp-2", "reviewed"),
      video("later", 3, "fp-3", "reject"),
    ], checkpoint())).toMatchObject({
      candidateId: "earlier",
      candidateIndex: 0,
      anchorIndex: 1,
      wrapped: true,
      reason: "wrapped",
    });
  });

  it("starts at the beginning when the anchor is stale", () => {
    expect(resolveContinueReviewCandidate(videos, checkpoint({
      anchorInstanceId: 99,
      anchorFingerprint: "missing",
    }))).toMatchObject({
      candidateId: "a",
      anchorIndex: -1,
      anchorResolution: "missing",
      wrapped: false,
      reason: "start",
    });
  });

  it("ignores missing and non-Unreviewed instances and reports completion", () => {
    expect(resolveContinueReviewCandidate([
      video("missing", 1, "fp-1", "unreviewed", { present: false }),
      video("rated", 2, "fp-2", "reviewed", { rating: 5 }),
    ], checkpoint({ anchorInstanceId: null, anchorFingerprint: null }))).toEqual({
      candidateId: null,
      candidateInstanceId: null,
      candidateFingerprint: null,
      candidateName: "",
      candidateIndex: -1,
      anchorIndex: -1,
      anchorResolution: "none",
      wrapped: false,
      reason: "complete",
    });
  });
});

describe("Continue Review render and scan guards", () => {
  it("returns the smallest render step that includes the logical target", () => {
    expect(findSmallestRenderLimitStep(1, 6_000)).toBe(0);
    expect(findSmallestRenderLimitStep(101, 6_000)).toBe(1);
    expect(findRenderLimitStepForIndex(5_999, 6_000)).toBe(10);
    expect(findRenderLimitStepForIndex(0, 0)).toBe(0);
  });

  it("requires recursive coverage except for the root Current folder scope", () => {
    expect(requiresRecursiveReviewCoverage(
      { directory: "", scope: "current-folder" },
      false
    )).toBe(false);
    expect(requiresRecursiveReviewCoverage(
      { directory: "run", scope: "current-folder" },
      false
    )).toBe(true);
    expect(requiresRecursiveReviewCoverage(
      { directory: "", scope: "all-descendants" },
      false
    )).toBe(true);
    expect(requiresRecursiveReviewCoverage(
      { directory: "run", scope: "current-subtree" },
      true
    )).toBe(false);
  });
});
