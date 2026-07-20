import { describe, expect, it } from "vitest";
import budget from "./linux-soak-budget.cjs";

const { evaluateSoakBudget, seriesSummary, summarizeSoak } = budget;

function sample(index, overrides = {}) {
  return {
    elapsedMs: index * 10_000,
    system: {
      rssMB: 500 + index,
      cpuPercent: 40 + index,
      fileHandles: 80 + index,
      databaseBytes: 1024,
      inotifyWatches: 12,
      ...overrides.system,
    },
    renderer: {
      heapUsedMB: 100 + index,
      eventLoopP95Ms: 20 + index,
      eventLoopMaxMs: 35 + index,
      mediaElements: 24,
      loadedMediaElements: 8,
      playingMediaElements: 8,
      droppedFrameRatio: 0.02,
      ...overrides.renderer,
    },
  };
}

describe("Linux soak budgets", () => {
  it("calculates a time-normalized series slope", () => {
    const summary = seriesSummary(
      [sample(0), sample(1), sample(2)],
      (entry) => entry.system.rssMB
    );
    expect(summary).toMatchObject({ start: 500, end: 502, growth: 2 });
    expect(summary.slopePerMinute).toBeCloseTo(6);
  });

  it("accepts a stable bounded run", () => {
    const summary = summarizeSoak(Array.from({ length: 8 }, (_, index) => sample(index)));
    expect(evaluateSoakBudget(summary)).toMatchObject({ passed: true, failures: [] });
  });

  it("reports sustained memory and handle growth as measured failures", () => {
    const samples = Array.from({ length: 8 }, (_, index) =>
      sample(index, {
        system: { rssMB: 500 + index * 20, fileHandles: 80 + index * 8 },
        renderer: { heapUsedMB: 100 + index * 12 },
      })
    );
    const evaluation = evaluateSoakBudget(summarizeSoak(samples));
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining([
        "rss.slopePerMinute",
        "heap.growth",
        "fileHandles.growth",
      ])
    );
  });

  it("supports baseline-relative RSS and event-loop ratchets", () => {
    const summary = summarizeSoak(Array.from({ length: 8 }, (_, index) => sample(index)));
    summary.rss.peak = 900;
    summary.eventLoop.p95Ms = 100;
    const evaluation = evaluateSoakBudget(summary, {
      baseline: {
        rss: { peak: 500 },
        eventLoop: { p95Ms: 20 },
      },
    });
    expect(evaluation.failures.map((failure) => failure.metric)).toEqual(
      expect.arrayContaining(["rss.peak.relative", "eventLoop.p95Ms.relative"])
    );
  });
});
