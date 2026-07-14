const DEFAULT_LIMITS = Object.freeze({
  minSamples: 5,
  maxRssSlopeMBPerMinute: 32,
  maxHeapGrowthMB: 64,
  maxFileHandleGrowth: 32,
  maxEventLoopP95Ms: 120,
  maxDroppedFrameRatio: 0.5,
  maxRelativeRssPeakRatio: 1.2,
  relativeRssPeakAllowanceMB: 32,
  maxRelativeEventLoopRatio: 1.35,
  relativeEventLoopAllowanceMs: 5,
});

function finiteValues(values) {
  return values.filter((value) => Number.isFinite(value));
}

function percentile(values, ratio) {
  const sorted = finiteValues(values).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  );
  return sorted[index];
}

function seriesSummary(samples, readValue) {
  const points = samples
    .map((sample) => ({
      elapsedMs: Number(sample.elapsedMs),
      value: Number(readValue(sample)),
    }))
    .filter(
      (point) => Number.isFinite(point.elapsedMs) && Number.isFinite(point.value)
    );
  if (!points.length) return null;

  const first = points[0].value;
  const last = points[points.length - 1].value;
  const averageElapsed =
    points.reduce((total, point) => total + point.elapsedMs, 0) / points.length;
  const averageValue =
    points.reduce((total, point) => total + point.value, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const elapsedDelta = point.elapsedMs - averageElapsed;
    numerator += elapsedDelta * (point.value - averageValue);
    denominator += elapsedDelta * elapsedDelta;
  }
  const slopePerMinute = denominator > 0
    ? (numerator / denominator) * 60_000
    : 0;

  return {
    start: first,
    end: last,
    min: Math.min(...points.map((point) => point.value)),
    peak: Math.max(...points.map((point) => point.value)),
    growth: last - first,
    slopePerMinute,
  };
}

function summarizeSoak(samples = []) {
  const rss = seriesSummary(samples, (sample) => sample.system?.rssMB);
  const heap = seriesSummary(samples, (sample) => sample.renderer?.heapUsedMB);
  const fileHandles = seriesSummary(
    samples,
    (sample) => sample.system?.fileHandles
  );
  const databaseBytes = seriesSummary(
    samples,
    (sample) => sample.system?.databaseBytes
  );

  return {
    sampleCount: samples.length,
    durationMs: samples.length
      ? Math.max(0, Number(samples.at(-1)?.elapsedMs) || 0)
      : 0,
    rss,
    heap,
    fileHandles,
    databaseBytes,
    cpu: {
      averagePercent: percentile(
        samples.map((sample) => sample.system?.cpuPercent),
        0.5
      ),
      p95Percent: percentile(
        samples.map((sample) => sample.system?.cpuPercent),
        0.95
      ),
    },
    eventLoop: {
      p95Ms: percentile(
        samples.map((sample) => sample.renderer?.eventLoopP95Ms),
        0.95
      ),
      peakMs: percentile(
        samples.map((sample) => sample.renderer?.eventLoopMaxMs),
        1
      ),
    },
    media: {
      peakElements: percentile(
        samples.map((sample) => sample.renderer?.mediaElements),
        1
      ),
      peakLoadedElements: percentile(
        samples.map((sample) => sample.renderer?.loadedMediaElements),
        1
      ),
      peakPlayingElements: percentile(
        samples.map((sample) => sample.renderer?.playingMediaElements),
        1
      ),
      droppedFrameRatio: percentile(
        samples.map((sample) => sample.renderer?.droppedFrameRatio),
        0.95
      ),
    },
    watchers: {
      peakInotifyWatches: percentile(
        samples.map((sample) => sample.system?.inotifyWatches),
        1
      ),
    },
  };
}

function evaluateSoakBudget(summary, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const baseline = options.baseline?.summary || options.baseline || null;
  const failures = [];
  const check = (metric, actual, limit, predicate) => {
    if (!Number.isFinite(actual) || !Number.isFinite(limit)) return;
    if (predicate(actual, limit)) return;
    failures.push({ metric, actual, limit });
  };

  check(
    "sampleCount",
    summary.sampleCount,
    limits.minSamples,
    (actual, limit) => actual >= limit
  );
  check(
    "rss.slopePerMinute",
    summary.rss?.slopePerMinute,
    limits.maxRssSlopeMBPerMinute,
    (actual, limit) => actual <= limit
  );
  check(
    "heap.growth",
    summary.heap?.growth,
    limits.maxHeapGrowthMB,
    (actual, limit) => actual <= limit
  );
  check(
    "fileHandles.growth",
    summary.fileHandles?.growth,
    limits.maxFileHandleGrowth,
    (actual, limit) => actual <= limit
  );
  check(
    "eventLoop.p95Ms",
    summary.eventLoop?.p95Ms,
    limits.maxEventLoopP95Ms,
    (actual, limit) => actual <= limit
  );
  check(
    "media.droppedFrameRatio",
    summary.media?.droppedFrameRatio,
    limits.maxDroppedFrameRatio,
    (actual, limit) => actual <= limit
  );

  if (baseline?.rss?.peak > 0 && summary.rss?.peak != null) {
    const limit =
      baseline.rss.peak * limits.maxRelativeRssPeakRatio +
      limits.relativeRssPeakAllowanceMB;
    check("rss.peak.relative", summary.rss.peak, limit, (actual, cap) => actual <= cap);
  }
  if (baseline?.eventLoop?.p95Ms > 0 && summary.eventLoop?.p95Ms != null) {
    const limit =
      baseline.eventLoop.p95Ms * limits.maxRelativeEventLoopRatio +
      limits.relativeEventLoopAllowanceMs;
    check(
      "eventLoop.p95Ms.relative",
      summary.eventLoop.p95Ms,
      limit,
      (actual, cap) => actual <= cap
    );
  }

  return { passed: failures.length === 0, failures, limits };
}

module.exports = {
  DEFAULT_LIMITS,
  evaluateSoakBudget,
  percentile,
  seriesSummary,
  summarizeSoak,
};
