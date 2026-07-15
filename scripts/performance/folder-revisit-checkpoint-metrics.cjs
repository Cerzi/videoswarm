function finiteTimestamp(value, name) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError(`${name} must be a non-negative finite timestamp`);
  }
  return timestamp;
}

function createReviewCheckpointReadMeasurement({
  rootPath,
  startedAt,
  listedAt,
  completedAt,
  listSuccess,
  listError,
  sessionRootPaths,
  getSuccess,
  getError,
  checkpointRootPath,
} = {}) {
  if (typeof rootPath !== "string" || !rootPath) {
    throw new TypeError("A checkpoint benchmark root path is required");
  }
  if (listSuccess !== true) {
    throw new Error(listError || "Could not list review checkpoints");
  }
  if (getSuccess !== true) {
    throw new Error(getError || "Could not read review checkpoint");
  }

  const start = finiteTimestamp(startedAt, "startedAt");
  const listed = finiteTimestamp(listedAt, "listedAt");
  const completed = finiteTimestamp(completedAt, "completedAt");
  if (listed < start || completed < listed) {
    throw new RangeError("Checkpoint read timestamps must be monotonic");
  }

  const roots = Array.isArray(sessionRootPaths)
    ? sessionRootPaths.filter((value) => typeof value === "string")
    : [];
  return {
    verified: true,
    summaryCount: roots.length,
    summaryObserved: roots.includes(rootPath),
    checkpointObserved: checkpointRootPath === rootPath,
    readTimings: {
      listMs: listed - start,
      getMs: completed - listed,
      totalMs: completed - start,
    },
  };
}

module.exports = { createReviewCheckpointReadMeasurement };
