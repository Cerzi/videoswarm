import { describe, expect, it } from "vitest";
import budget from "./folder-revisit-budget.cjs";

const {
  evaluateFolderRevisitReport,
  median,
  percentile,
  summarizeDataset,
} = budget;

function trial({
  firstGridMs,
  refreshCompleteMs = firstGridMs * 4,
  count = 1000,
  cached = false,
  heapUsedMB = 100,
  workingSetMB = 500,
  activeResources = {},
  cleanupResources = {},
  reviewCheckpoint = {},
} = {}) {
  return {
    timings: {
      firstGridMs,
      refreshCompleteMs,
      cachedPreviewMs: cached ? Math.max(0, firstGridMs - 40) : null,
    },
    wallDurationMs: refreshCompleteMs + 20,
    milestoneRecordCount: count,
    firstGridRecordCount: cached ? Math.min(count, 128) : count,
    finalCollectionCount: count,
    authoritativeCollection: {
      recordCount: count,
      relativePathDigest: "a".repeat(64),
    },
    cache: {
      previewObserved: cached,
      usablePreviewObserved: cached,
      completionReportedCache: cached,
      previewRecordCount: cached ? count : null,
    },
    activeResources: {
      mountedCards: 40,
      masonrySlots: 40,
      mediaElements: 24,
      loadedMediaElements: 16,
      ...activeResources,
    },
    cleanupResources: {
      collectionCount: 1,
      inactiveRootCards: 0,
      inactiveRootSelectedCards: 0,
      inactiveRootMasonrySlots: 0,
      inactiveRootMediaElements: 0,
      inactiveRootLoadedMediaElements: 0,
      inactiveRootPlayingMediaElements: 0,
      mountedCards: 1,
      masonrySlots: 1,
      mediaElements: 1,
      heapUsedMB,
      workingSetMB,
      ...cleanupResources,
    },
    reviewCheckpoint: cached
      ? {
          verified: true,
          summaryCount: 1,
          summaryObserved: true,
          checkpointObserved: true,
          readTimings: {
            listMs: 2,
            getMs: 2,
            totalMs: 4,
          },
          inactiveResources: {
            inactiveRootCards: 0,
            inactiveRootSelectedCards: 0,
            inactiveRootMasonrySlots: 0,
            inactiveRootMediaElements: 0,
            inactiveRootLoadedMediaElements: 0,
            inactiveRootPlayingMediaElements: 0,
          },
          ...reviewCheckpoint,
        }
      : null,
  };
}

function scenario(values, options = {}) {
  return values.map((firstGridMs, index) =>
    trial({
      firstGridMs,
      cached: options.cached,
      count: options.count || 1000,
      heapUsedMB: 100 + index,
      workingSetMB: 500 + index * 2,
    })
  );
}

function passingDataset(count = 1000) {
  const dataset = {
    label: `${count} clips`,
    declaredCount: count,
    diskFileCount: count,
    scenarios: {
      cold: scenario([220, 200, 240, 210, 230], { count }),
      warm: scenario([80, 90, 85, 75, 82], { cached: true, count }),
      restart: scenario([95, 100, 90, 92, 94], { cached: true, count }),
    },
  };
  dataset.scenarios.cold.forEach((entry, index) => {
    entry.processRunId = `cold-${index + 1}`;
  });
  dataset.scenarios.warm.forEach((entry) => {
    entry.processRunId = "warm-process";
  });
  dataset.scenarios.restart.forEach((entry, index) => {
    entry.processRunId = `restart-${index + 1}`;
  });
  return dataset;
}

describe("folder revisit benchmark evaluation", () => {
  it("calculates a conventional median for odd and even samples", () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([8, 2, 4, 6])).toBe(5);
    expect(median([null, undefined, 6])).toBe(6);
    expect(median([])).toBeNull();
    expect(percentile([9, 1, 5, 3, 7], 0.95)).toBe(9);
    expect(percentile([9, 1, 5, 3, 7], 0.5)).toBe(5);
  });

  it("summarizes cached speedup and refresh completion independently", () => {
    const summary = summarizeDataset(passingDataset());
    expect(summary.scenarios.cold.firstGridMedianMs).toBe(220);
    expect(summary.scenarios.warm.refreshCompleteMedianMs).toBe(328);
    expect(summary.scenarios.warm.cachedPreviewMedianMs).toBe(42);
    expect(summary.scenarios.warm.cachedPreviewToGridMedianMs).toBe(40);
    expect(summary.scenarios.warm.reviewCheckpointRead).toMatchObject({
      verifiedTrials: 5,
      listP95Ms: 2,
      getP95Ms: 2,
      totalP95Ms: 4,
    });
    expect(summary.firstGridSpeedup.warm).toBeCloseTo(220 / 82);
    expect(summary.firstGridSpeedup.restart).toBeCloseTo(220 / 94);
  });

  it("accepts five count-identical bounded trials with a 2x cached first grid", () => {
    const evaluation = evaluateFolderRevisitReport({
      datasets: [passingDataset()],
    });
    expect(evaluation).toMatchObject({ passed: true, failures: [] });
  });

  it("accepts a partial large cached first grid but rejects empty or oversized previews", () => {
    const partialDataset = passingDataset();
    partialDataset.scenarios.warm[0].firstGridRecordCount = 37;
    expect(
      evaluateFolderRevisitReport({ datasets: [partialDataset] }).passed
    ).toBe(true);

    const emptyDataset = passingDataset();
    emptyDataset.scenarios.warm[0].firstGridRecordCount = 0;
    expect(
      evaluateFolderRevisitReport({ datasets: [emptyDataset] }).failures
    ).toContainEqual(
      expect.objectContaining({
        metric: "trials[0].firstGridRecordCount",
      })
    );

    const oversizedDataset = passingDataset();
    oversizedDataset.scenarios.restart[0].firstGridRecordCount = 129;
    expect(
      evaluateFolderRevisitReport({ datasets: [oversizedDataset] }).failures
    ).toContainEqual(
      expect.objectContaining({
        metric: "trials[0].firstGridRecordCount",
      })
    );
  });

  it("requires a small cached collection to appear in full on its first grid", () => {
    const dataset = passingDataset();
    dataset.declaredCount = 64;
    dataset.diskFileCount = 64;
    for (const trials of Object.values(dataset.scenarios)) {
      for (const entry of trials) {
        entry.milestoneRecordCount = 64;
        entry.finalCollectionCount = 64;
        entry.authoritativeCollection.recordCount = 64;
        entry.firstGridRecordCount = 64;
        if (entry.cache.previewObserved) entry.cache.previewRecordCount = 64;
      }
    }
    expect(evaluateFolderRevisitReport({ datasets: [dataset] }).passed).toBe(true);

    dataset.scenarios.warm[0].firstGridRecordCount = 63;
    expect(
      evaluateFolderRevisitReport({ datasets: [dataset] }).failures
    ).toContainEqual(
      expect.objectContaining({
        metric: "trials[0].firstGridRecordCount",
      })
    );
  });

  it("treats dataset labels as minimum sizes while matching the real disk count", () => {
    const dataset = passingDataset();
    dataset.diskFileCount = 1008;
    for (const trials of Object.values(dataset.scenarios)) {
      for (const entry of trials) {
        entry.milestoneRecordCount = 1008;
        entry.finalCollectionCount = 1008;
        entry.authoritativeCollection.recordCount = 1008;
        entry.firstGridRecordCount = entry.cache.previewObserved ? 128 : 1008;
        if (entry.cache.previewObserved) entry.cache.previewRecordCount = 1008;
      }
    }
    expect(evaluateFolderRevisitReport({ datasets: [dataset] }).passed).toBe(true);
  });

  it("rejects a collection identity mismatch even when all counts match", () => {
    const dataset = passingDataset();
    dataset.scenarios.restart[4].authoritativeCollection.relativePathDigest =
      "b".repeat(64);
    const evaluation = evaluateFolderRevisitReport({ datasets: [dataset] });
    expect(evaluation.failures).toContainEqual(
      expect.objectContaining({
        metric: "authoritativeCollection.relativePathDigest",
      })
    );
  });

  it("does not mistake a newly registered zero-record root for a usable cache", () => {
    const dataset = passingDataset();
    dataset.scenarios.cold[0].cache = {
      previewObserved: true,
      usablePreviewObserved: false,
      previewRecordCount: 0,
      completionReportedCache: true,
    };
    expect(evaluateFolderRevisitReport({ datasets: [dataset] }).passed).toBe(true);
  });

  it("rejects missing trials, count drift, absent cache evidence, and slow hydration", () => {
    const dataset = passingDataset();
    dataset.diskFileCount = 999;
    dataset.scenarios.warm = [
      trial({ firstGridMs: 180, cached: false, count: 998 }),
    ];
    const evaluation = evaluateFolderRevisitReport({ datasets: [dataset] });
    const metrics = evaluation.failures.map((failure) => failure.metric);
    expect(evaluation.passed).toBe(false);
    expect(metrics).toEqual(
      expect.arrayContaining([
        "diskFileCount",
        "trialCount",
        "trials[0].milestoneRecordCount",
        "trials[0].finalCollectionCount",
        "trials[0].cachedPreview",
        "firstGridSpeedup",
      ])
    );
  });

  it("rejects retained inactive resources and same-process memory growth", () => {
    const dataset = passingDataset();
    dataset.scenarios.warm[2].cleanupResources.inactiveRootCards = 1;
    dataset.scenarios.warm[1].cleanupResources.inactiveRootLoadedMediaElements = 1;
    dataset.scenarios.warm[3].activeResources.mediaElements = 300;
    dataset.scenarios.warm[4].cleanupResources.heapUsedMB = 200;
    dataset.scenarios.warm[4].cleanupResources.workingSetMB = 900;
    const evaluation = evaluateFolderRevisitReport({ datasets: [dataset] });
    const metrics = evaluation.failures.map((failure) => failure.metric);
    expect(metrics).toEqual(
      expect.arrayContaining([
        "trials[2].cleanupResources.inactiveRootCards",
        "trials[1].cleanupResources.inactiveRootLoadedMediaElements",
        "trials[3].activeResources.mediaElements",
        "cleanupHeapGrowthMB",
        "cleanupWorkingSetGrowthMB",
      ])
    );
  });

  it("requires cached preview, first grid, and authoritative refresh ordering", () => {
    const dataset = passingDataset();
    dataset.scenarios.warm[0].timings.refreshCompleteMs =
      dataset.scenarios.warm[0].timings.firstGridMs;
    dataset.scenarios.restart[0].timings.cachedPreviewMs =
      dataset.scenarios.restart[0].timings.firstGridMs + 1;

    const metrics = evaluateFolderRevisitReport({ datasets: [dataset] })
      .failures.map((failure) => failure.metric);
    expect(metrics).toEqual(
      expect.arrayContaining([
        "trials[0].timings.cachedFirstGridBeforeRefresh",
        "trials[0].timings.cachedPreviewBeforeFirstGrid",
      ])
    );
  });

  it("requires checkpoint evidence without retaining inactive UI or decoders", () => {
    const dataset = passingDataset();
    dataset.scenarios.warm[0].reviewCheckpoint = null;
    dataset.scenarios.warm[2].reviewCheckpoint.summaryCount = 129;
    dataset.scenarios.restart[1].reviewCheckpoint.inactiveResources
      .inactiveRootLoadedMediaElements = 1;

    const metrics = evaluateFolderRevisitReport({ datasets: [dataset] })
      .failures.map((failure) => failure.metric);
    expect(metrics).toEqual(
      expect.arrayContaining([
        "trials[0].reviewCheckpoint.evidence",
        "trials[0].reviewCheckpoint.readTimings.totalMs",
        "trials[2].reviewCheckpoint.summaryCount",
        "trials[1].reviewCheckpoint.inactiveResources.inactiveRootLoadedMediaElements",
      ])
    );
  });

  it("enforces a 25 ms checkpoint list/get p95 for the 6,000-clip class", () => {
    const dataset = passingDataset(6000);
    [8, 11, 14, 19, 25].forEach((totalMs, index) => {
      dataset.scenarios.warm[index].reviewCheckpoint.readTimings.totalMs =
        totalMs;
      dataset.scenarios.restart[index].reviewCheckpoint.readTimings.totalMs =
        totalMs;
    });
    let evaluation = evaluateFolderRevisitReport({ datasets: [dataset] });
    expect(evaluation.passed).toBe(true);
    expect(
      evaluation.summary.datasets[0].scenarios.warm.reviewCheckpointRead
        .totalP95Ms
    ).toBe(25);

    dataset.scenarios.warm[4].reviewCheckpoint.readTimings.totalMs = 25.01;
    evaluation = evaluateFolderRevisitReport({ datasets: [dataset] });
    expect(evaluation.failures).toContainEqual(
      expect.objectContaining({
        scenario: "warm",
        metric: "reviewCheckpointRead.totalP95Ms",
        actual: 25.01,
        limit: 25,
      })
    );
  });
});
