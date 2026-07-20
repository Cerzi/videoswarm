const DEFAULT_LIMITS = Object.freeze({
  minTrialsPerScenario: 5,
  minCachedFirstGridSpeedup: 2,
  maxMountedCards: 200,
  maxMasonrySlots: 200,
  maxMediaElements: 128,
  maxLoadedMediaElements: 128,
  maxCachedFirstGridRecords: 128,
  maxInactiveRootCards: 0,
  maxInactiveRootMasonrySlots: 0,
  maxInactiveRootMediaElements: 0,
  maxInactiveRootLoadedMediaElements: 0,
  maxInactiveRootPlayingMediaElements: 0,
  maxInactiveRootSelectedCards: 0,
  maxReviewCheckpointSummaries: 128,
  maxReviewCheckpointReadP95Ms: 25,
  maxCleanupHeapGrowthMB: 64,
  maxCleanupWorkingSetGrowthMB: 256,
});

const SCENARIOS = Object.freeze(["cold", "warm", "restart"]);

function finiteValues(values = []) {
  return values
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function numericMetric(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

function median(values = []) {
  const sorted = finiteValues(values).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values = [], ratio = 0.95) {
  const sorted = finiteValues(values).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );
  return sorted[index];
}

function maximum(values = []) {
  const finite = finiteValues(values);
  return finite.length ? Math.max(...finite) : null;
}

function endpointGrowth(values = []) {
  const finite = finiteValues(values);
  if (finite.length < 2) return 0;
  return finite.at(-1) - finite[0];
}

function summarizeScenario(trials = []) {
  const normalized = Array.isArray(trials) ? trials : [];
  const usableCacheTrials = normalized.filter(
    (trial) => trial?.cache?.usablePreviewObserved === true
  );
  const processRunIds = new Set(
    normalized
      .map((trial) => trial?.processRunId)
      .filter((value) => typeof value === "string" && value.length > 0)
  );
  return {
    trialCount: normalized.length,
    processRunCount: processRunIds.size,
    firstGridMedianMs: median(
      normalized.map((trial) => trial?.timings?.firstGridMs)
    ),
    refreshCompleteMedianMs: median(
      normalized.map((trial) => trial?.timings?.refreshCompleteMs)
    ),
    cachedPreviewMedianMs: median(
      usableCacheTrials.map((trial) => trial?.timings?.cachedPreviewMs)
    ),
    cachedPreviewToGridMedianMs: median(
      usableCacheTrials.map((trial) => {
        const cachedPreviewMs = numericMetric(trial?.timings?.cachedPreviewMs);
        const firstGridMs = numericMetric(trial?.timings?.firstGridMs);
        return Number.isFinite(cachedPreviewMs) && Number.isFinite(firstGridMs)
          ? firstGridMs - cachedPreviewMs
          : null;
      })
    ),
    reviewCheckpointRead: {
      verifiedTrials: normalized.filter(
        (trial) => trial?.reviewCheckpoint?.verified === true
      ).length,
      listP95Ms: percentile(
        normalized.map(
          (trial) => trial?.reviewCheckpoint?.readTimings?.listMs
        )
      ),
      getP95Ms: percentile(
        normalized.map(
          (trial) => trial?.reviewCheckpoint?.readTimings?.getMs
        )
      ),
      totalP95Ms: percentile(
        normalized.map(
          (trial) => trial?.reviewCheckpoint?.readTimings?.totalMs
        )
      ),
    },
    wallDurationMedianMs: median(
      normalized.map((trial) => trial?.wallDurationMs)
    ),
    cachedPreviewTrials: usableCacheTrials.length,
    finalCounts: normalized.map((trial) => trial?.finalCollectionCount),
    peakMountedCards: maximum(
      normalized.map((trial) => trial?.activeResources?.mountedCards)
    ),
    peakMasonrySlots: maximum(
      normalized.map((trial) => trial?.activeResources?.masonrySlots)
    ),
    peakMediaElements: maximum(
      normalized.map((trial) => trial?.activeResources?.mediaElements)
    ),
    peakLoadedMediaElements: maximum(
      normalized.map((trial) => trial?.activeResources?.loadedMediaElements)
    ),
    cleanupHeapGrowthMB: endpointGrowth(
      normalized.map((trial) => trial?.cleanupResources?.heapUsedMB)
    ),
    cleanupWorkingSetGrowthMB: endpointGrowth(
      normalized.map((trial) => trial?.cleanupResources?.workingSetMB)
    ),
  };
}

function summarizeDataset(dataset = {}) {
  const scenarios = {};
  for (const scenario of SCENARIOS) {
    scenarios[scenario] = summarizeScenario(dataset?.scenarios?.[scenario]);
  }
  const coldMedian = scenarios.cold.firstGridMedianMs;
  const speedup = (candidateMedian) => {
    if (!Number.isFinite(coldMedian) || coldMedian < 0) return null;
    if (!Number.isFinite(candidateMedian) || candidateMedian < 0) return null;
    if (candidateMedian === 0) return coldMedian > 0 ? Infinity : 1;
    return coldMedian / candidateMedian;
  };
  return {
    label: dataset?.label || "",
    declaredCount: Number(dataset?.declaredCount),
    diskFileCount: Number(dataset?.diskFileCount),
    scenarios,
    firstGridSpeedup: {
      warm: speedup(scenarios.warm.firstGridMedianMs),
      restart: speedup(scenarios.restart.firstGridMedianMs),
    },
  };
}

function evaluateFolderRevisitReport(report = {}, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const datasets = Array.isArray(report?.datasets) ? report.datasets : [];
  const summaries = datasets.map(summarizeDataset);
  const failures = [];
  const addFailure = (dataset, scenario, metric, actual, limit, comparison) => {
    failures.push({
      dataset: dataset?.label || "unknown",
      scenario: scenario || null,
      metric,
      actual,
      limit,
      comparison,
    });
  };

  if (!datasets.length) {
    addFailure(null, null, "datasets", 0, 1, ">=");
  }

  for (let datasetIndex = 0; datasetIndex < datasets.length; datasetIndex += 1) {
    const dataset = datasets[datasetIndex] || {};
    const summary = summaries[datasetIndex];
    const expectedCount = Number(dataset.declaredCount);
    const diskFileCount = Number(dataset.diskFileCount);
    const authoritativeDigests = [];

    if (!Number.isInteger(expectedCount) || expectedCount <= 0) {
      addFailure(dataset, null, "declaredCount", expectedCount, 1, ">=");
    }
    if (diskFileCount < expectedCount) {
      addFailure(
        dataset,
        null,
        "diskFileCount",
        diskFileCount,
        expectedCount,
        ">="
      );
    }

    for (const scenario of SCENARIOS) {
      const trials = Array.isArray(dataset?.scenarios?.[scenario])
        ? dataset.scenarios[scenario]
        : [];
      if (trials.length < limits.minTrialsPerScenario) {
        addFailure(
          dataset,
          scenario,
          "trialCount",
          trials.length,
          limits.minTrialsPerScenario,
          ">="
        );
      }
      const validProcessRunIds = trials
        .map((trial) => trial?.processRunId)
        .filter((value) => typeof value === "string" && value.length > 0);
      const expectedProcessRuns = scenario === "warm" ? 1 : trials.length;
      const actualProcessRuns = new Set(validProcessRunIds).size;
      if (
        validProcessRunIds.length !== trials.length ||
        actualProcessRuns !== expectedProcessRuns
      ) {
        addFailure(
          dataset,
          scenario,
          "processRunCount",
          actualProcessRuns,
          expectedProcessRuns,
          "==="
        );
      }

      trials.forEach((trial, trialIndex) => {
        const firstGridMs = numericMetric(trial?.timings?.firstGridMs);
        const refreshCompleteMs = numericMetric(
          trial?.timings?.refreshCompleteMs
        );
        if (!Number.isFinite(firstGridMs) || firstGridMs < 0) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].firstGridMs`,
            firstGridMs,
            0,
            ">="
          );
        }
        if (!Number.isFinite(refreshCompleteMs) || refreshCompleteMs < 0) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].refreshCompleteMs`,
            refreshCompleteMs,
            0,
            ">="
          );
        }

        if (scenario !== "cold") {
          const cachedPreviewMs = numericMetric(
            trial?.timings?.cachedPreviewMs
          );
          if (
            !Number.isFinite(cachedPreviewMs) ||
            cachedPreviewMs > firstGridMs
          ) {
            addFailure(
              dataset,
              scenario,
              `trials[${trialIndex}].timings.cachedPreviewBeforeFirstGrid`,
              { cachedPreviewMs, firstGridMs },
              "cachedPreviewMs <= firstGridMs",
              "valid"
            );
          }
          if (
            !Number.isFinite(firstGridMs) ||
            !Number.isFinite(refreshCompleteMs) ||
            firstGridMs >= refreshCompleteMs
          ) {
            addFailure(
              dataset,
              scenario,
              `trials[${trialIndex}].timings.cachedFirstGridBeforeRefresh`,
              { firstGridMs, refreshCompleteMs },
              "firstGridMs < refreshCompleteMs",
              "valid"
            );
          }
        }

        const milestoneCount = Number(trial?.milestoneRecordCount);
        if (milestoneCount !== diskFileCount) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].milestoneRecordCount`,
            milestoneCount,
            diskFileCount,
            "==="
          );
        }
        const finalCount = Number(trial?.finalCollectionCount);
        if (finalCount !== diskFileCount) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].finalCollectionCount`,
            finalCount,
            diskFileCount,
            "==="
          );
        }
        const authoritativeCount = Number(
          trial?.authoritativeCollection?.recordCount
        );
        if (authoritativeCount !== diskFileCount) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].authoritativeCollection.recordCount`,
            authoritativeCount,
            diskFileCount,
            "==="
          );
        }
        const authoritativeDigest =
          trial?.authoritativeCollection?.relativePathDigest;
        if (!/^[a-f0-9]{64}$/u.test(String(authoritativeDigest || ""))) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].authoritativeCollection.relativePathDigest`,
            authoritativeDigest || null,
            "sha256",
            "valid"
          );
        } else {
          authoritativeDigests.push(authoritativeDigest);
        }

        const previewObserved = trial?.cache?.previewObserved === true;
        const usablePreviewObserved =
          trial?.cache?.usablePreviewObserved === true;
        const completionReportedCache =
          trial?.cache?.completionReportedCache === true;
        if (scenario === "cold" && usablePreviewObserved) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].cachedPreview`,
            { previewObserved, usablePreviewObserved, completionReportedCache },
            false,
            "==="
          );
        }
        if (
          scenario !== "cold" &&
          (!previewObserved || !usablePreviewObserved || !completionReportedCache)
        ) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].cachedPreview`,
            { previewObserved, usablePreviewObserved, completionReportedCache },
            true,
            "==="
          );
        }
        if (
          scenario !== "cold" &&
          Number(trial?.cache?.previewRecordCount) !== diskFileCount
        ) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].cachedPreviewRecordCount`,
            Number(trial?.cache?.previewRecordCount),
            diskFileCount,
            "==="
          );
        }
        if (scenario !== "cold") {
          const firstGridRecordCount = Number(trial?.firstGridRecordCount);
          const smallCollection =
            diskFileCount <= limits.maxCachedFirstGridRecords;
          const validFirstGridCount = smallCollection
            ? firstGridRecordCount === diskFileCount
            : firstGridRecordCount > 0 &&
              firstGridRecordCount <= limits.maxCachedFirstGridRecords;
          if (!validFirstGridCount) {
            addFailure(
              dataset,
              scenario,
              `trials[${trialIndex}].firstGridRecordCount`,
              firstGridRecordCount,
              smallCollection
                ? diskFileCount
                : limits.maxCachedFirstGridRecords,
              smallCollection ? "===" : "1 <= actual <= limit"
            );
          }
          const reviewCheckpoint = trial?.reviewCheckpoint || {};
          if (
            reviewCheckpoint.verified !== true ||
            reviewCheckpoint.summaryObserved !== true ||
            reviewCheckpoint.checkpointObserved !== true
          ) {
            addFailure(
              dataset,
              scenario,
              `trials[${trialIndex}].reviewCheckpoint.evidence`,
              {
                verified: reviewCheckpoint.verified === true,
                summaryObserved:
                  reviewCheckpoint.summaryObserved === true,
                checkpointObserved:
                  reviewCheckpoint.checkpointObserved === true,
              },
              true,
              "==="
            );
          }

          const summaryCount = numericMetric(reviewCheckpoint.summaryCount);
          if (
            !Number.isFinite(summaryCount) ||
            summaryCount < 1 ||
            summaryCount > limits.maxReviewCheckpointSummaries
          ) {
            addFailure(
              dataset,
              scenario,
              `trials[${trialIndex}].reviewCheckpoint.summaryCount`,
              summaryCount,
              limits.maxReviewCheckpointSummaries,
              "1 <= actual <= limit"
            );
          }

          for (const metric of ["listMs", "getMs", "totalMs"]) {
            const actual = numericMetric(
              reviewCheckpoint?.readTimings?.[metric]
            );
            if (!Number.isFinite(actual) || actual < 0) {
              addFailure(
                dataset,
                scenario,
                `trials[${trialIndex}].reviewCheckpoint.readTimings.${metric}`,
                actual,
                0,
                ">="
              );
            }
          }

          const checkpointResources =
            reviewCheckpoint.inactiveResources || {};
          const checkpointResourceChecks = [
            [
              "inactiveRootCards",
              checkpointResources.inactiveRootCards,
              limits.maxInactiveRootCards,
            ],
            [
              "inactiveRootMasonrySlots",
              checkpointResources.inactiveRootMasonrySlots,
              limits.maxInactiveRootMasonrySlots,
            ],
            [
              "inactiveRootMediaElements",
              checkpointResources.inactiveRootMediaElements,
              limits.maxInactiveRootMediaElements,
            ],
            [
              "inactiveRootLoadedMediaElements",
              checkpointResources.inactiveRootLoadedMediaElements,
              limits.maxInactiveRootLoadedMediaElements,
            ],
            [
              "inactiveRootPlayingMediaElements",
              checkpointResources.inactiveRootPlayingMediaElements,
              limits.maxInactiveRootPlayingMediaElements,
            ],
            [
              "inactiveRootSelectedCards",
              checkpointResources.inactiveRootSelectedCards,
              limits.maxInactiveRootSelectedCards,
            ],
          ];
          for (const [metric, value, limit] of checkpointResourceChecks) {
            const actual = numericMetric(value);
            if (!Number.isFinite(actual) || actual > limit) {
              addFailure(
                dataset,
                scenario,
                `trials[${trialIndex}].reviewCheckpoint.inactiveResources.${metric}`,
                actual,
                limit,
                "<="
              );
            }
          }
        }

        const active = trial?.activeResources || {};
        const activeChecks = [
          ["mountedCards", active.mountedCards, limits.maxMountedCards],
          ["masonrySlots", active.masonrySlots, limits.maxMasonrySlots],
          ["mediaElements", active.mediaElements, limits.maxMediaElements],
          [
            "loadedMediaElements",
            active.loadedMediaElements,
            limits.maxLoadedMediaElements,
          ],
        ];
        for (const [metric, value, limit] of activeChecks) {
          const actual = numericMetric(value);
          if (!Number.isFinite(actual) || actual > limit) {
            addFailure(
              dataset,
              scenario,
              `trials[${trialIndex}].activeResources.${metric}`,
              actual,
              limit,
              "<="
            );
          }
        }

        const cleanup = trial?.cleanupResources || {};
        const cleanupChecks = [
          [
            "inactiveRootCards",
            cleanup.inactiveRootCards,
            limits.maxInactiveRootCards,
          ],
          [
            "inactiveRootMediaElements",
            cleanup.inactiveRootMediaElements,
            limits.maxInactiveRootMediaElements,
          ],
          [
            "inactiveRootMasonrySlots",
            cleanup.inactiveRootMasonrySlots,
            limits.maxInactiveRootMasonrySlots,
          ],
          [
            "inactiveRootLoadedMediaElements",
            cleanup.inactiveRootLoadedMediaElements,
            limits.maxInactiveRootLoadedMediaElements,
          ],
          [
            "inactiveRootPlayingMediaElements",
            cleanup.inactiveRootPlayingMediaElements,
            limits.maxInactiveRootPlayingMediaElements,
          ],
          [
            "inactiveRootSelectedCards",
            cleanup.inactiveRootSelectedCards,
            limits.maxInactiveRootSelectedCards,
          ],
          ["mountedCards", cleanup.mountedCards, limits.maxMountedCards],
          ["masonrySlots", cleanup.masonrySlots, limits.maxMasonrySlots],
          ["mediaElements", cleanup.mediaElements, limits.maxMediaElements],
        ];
        for (const [metric, value, limit] of cleanupChecks) {
          const actual = numericMetric(value);
          if (!Number.isFinite(actual) || actual > limit) {
            addFailure(
              dataset,
              scenario,
              `trials[${trialIndex}].cleanupResources.${metric}`,
              actual,
              limit,
              "<="
            );
          }
        }
        if (Number(cleanup.collectionCount) !== 1) {
          addFailure(
            dataset,
            scenario,
            `trials[${trialIndex}].cleanupResources.collectionCount`,
            Number(cleanup.collectionCount),
            1,
            "==="
          );
        }
      });
    }

    if (new Set(authoritativeDigests).size > 1) {
      addFailure(
        dataset,
        null,
        "authoritativeCollection.relativePathDigest",
        new Set(authoritativeDigests).size,
        1,
        "==="
      );
    }

    for (const scenario of ["warm", "restart"]) {
      const actual = summary.firstGridSpeedup[scenario];
      if (
        !Number.isFinite(actual) &&
        actual !== Infinity
      ) {
        addFailure(
          dataset,
          scenario,
          "firstGridSpeedup",
          actual,
          limits.minCachedFirstGridSpeedup,
          ">="
        );
      } else if (actual < limits.minCachedFirstGridSpeedup) {
        addFailure(
          dataset,
          scenario,
          "firstGridSpeedup",
          actual,
          limits.minCachedFirstGridSpeedup,
          ">="
        );
      }

      if (expectedCount >= 6000) {
        const checkpointP95 =
          summary.scenarios[scenario].reviewCheckpointRead.totalP95Ms;
        if (
          !Number.isFinite(checkpointP95) ||
          checkpointP95 > limits.maxReviewCheckpointReadP95Ms
        ) {
          addFailure(
            dataset,
            scenario,
            "reviewCheckpointRead.totalP95Ms",
            checkpointP95,
            limits.maxReviewCheckpointReadP95Ms,
            "<="
          );
        }
      }
    }

    const warmSummary = summary.scenarios.warm;
    if (warmSummary.cleanupHeapGrowthMB > limits.maxCleanupHeapGrowthMB) {
      addFailure(
        dataset,
        "warm",
        "cleanupHeapGrowthMB",
        warmSummary.cleanupHeapGrowthMB,
        limits.maxCleanupHeapGrowthMB,
        "<="
      );
    }
    if (
      warmSummary.cleanupWorkingSetGrowthMB >
      limits.maxCleanupWorkingSetGrowthMB
    ) {
      addFailure(
        dataset,
        "warm",
        "cleanupWorkingSetGrowthMB",
        warmSummary.cleanupWorkingSetGrowthMB,
        limits.maxCleanupWorkingSetGrowthMB,
        "<="
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    limits,
    summary: { datasets: summaries },
  };
}

module.exports = {
  DEFAULT_LIMITS,
  SCENARIOS,
  endpointGrowth,
  evaluateFolderRevisitReport,
  median,
  percentile,
  summarizeDataset,
  summarizeScenario,
};
