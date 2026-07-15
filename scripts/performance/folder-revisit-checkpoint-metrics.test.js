import { describe, expect, it } from "vitest";
import metrics from "./folder-revisit-checkpoint-metrics.cjs";

const { createReviewCheckpointReadMeasurement } = metrics;

function input(overrides = {}) {
  return {
    rootPath: "/clips",
    startedAt: 10,
    listedAt: 13.5,
    completedAt: 18,
    listSuccess: true,
    sessionRootPaths: ["/other", "/clips"],
    getSuccess: true,
    checkpointRootPath: "/clips",
    ...overrides,
  };
}

describe("folder revisit checkpoint measurements", () => {
  it("derives list, get, and total overhead from one monotonic read", () => {
    expect(createReviewCheckpointReadMeasurement(input())).toEqual({
      verified: true,
      summaryCount: 2,
      summaryObserved: true,
      checkpointObserved: true,
      readTimings: {
        listMs: 3.5,
        getMs: 4.5,
        totalMs: 8,
      },
    });
  });

  it("retains missing bounded evidence for the report evaluator", () => {
    expect(
      createReviewCheckpointReadMeasurement(
        input({ sessionRootPaths: [], checkpointRootPath: null })
      )
    ).toMatchObject({
      summaryCount: 0,
      summaryObserved: false,
      checkpointObserved: false,
    });
  });

  it("rejects failed IPC and non-monotonic timestamps", () => {
    expect(() =>
      createReviewCheckpointReadMeasurement(
        input({ listSuccess: false, listError: "profile changed" })
      )
    ).toThrow("profile changed");
    expect(() =>
      createReviewCheckpointReadMeasurement(input({ completedAt: 12 }))
    ).toThrow("must be monotonic");
  });
});
