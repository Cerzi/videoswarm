"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  ACCEPTED_COPY_MAX_MEDIA,
  ACCEPTED_COPY_MAX_PATH_BYTES,
  ReviewExportError,
  assertReviewExportCoverage,
  normalizeReviewExportDirectory,
  normalizeReviewExportRelativePath,
  normalizeReviewExportScope,
} = require("./review-export-scope");

const ACCEPTED_COPY_CONCURRENCY = 2;
const ACCEPTED_COPY_MAX_PLANS = 8;
const ACCEPTED_COPY_PLAN_TTL_MS = 10 * 60 * 1000;
const ACCEPTED_COPY_MAX_SAMPLES = 100;
const ACCEPTED_COPY_PROGRESS_INTERVAL_MS = 100;
const REMOVED_SOURCE_FLUSH_SIZE = 256;

const ACCEPTED_COPY_CODES = Object.freeze({
  BUSY: "ACCEPTED_COPY_BUSY",
  CLOSED: "ACCEPTED_COPY_CLOSED",
  COLLISION_POLICY: "ACCEPTED_COPY_COLLISION_POLICY_INVALID",
  DESTINATION_INSIDE_ROOT: "ACCEPTED_COPY_DESTINATION_INSIDE_ROOT",
  DESTINATION_INVALID: "ACCEPTED_COPY_DESTINATION_INVALID",
  DESTINATION_UNSAFE: "ACCEPTED_COPY_DESTINATION_UNSAFE",
  INVALID_QUERY_RESULT: "ACCEPTED_COPY_INVALID_QUERY_RESULT",
  NO_PLAN_SLOTS: "ACCEPTED_COPY_PLAN_LIMIT",
  PAUSED: "ACCEPTED_COPY_PAUSED",
  PLAN_EXPIRED: "ACCEPTED_COPY_PLAN_EXPIRED",
  PLAN_INVALID: "ACCEPTED_COPY_PLAN_INVALID",
  PLAN_NOT_FOUND: "ACCEPTED_COPY_PLAN_NOT_FOUND",
  QUERY_TOO_LARGE: "ACCEPTED_COPY_QUERY_TOO_LARGE",
  SOURCE_CHANGED: "ACCEPTED_COPY_SOURCE_CHANGED",
  SOURCE_CHANGED_CLEANUP_FAILED:
    "ACCEPTED_COPY_SOURCE_CHANGED_CLEANUP_FAILED",
  SOURCE_INVALID: "ACCEPTED_COPY_SOURCE_INVALID",
});

class AcceptedCopyError extends Error {
  constructor(message, code = "ACCEPTED_COPY_ERROR") {
    super(message);
    this.name = "AcceptedCopyError";
    this.code = code;
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`createReviewCopyAcceptedCoordinator requires ${name}()`);
  }
  return value;
}

function normalizePlanId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_-]{8,128}$/u.test(value)
  ) {
    throw new AcceptedCopyError(
      "Copy plan identity is invalid",
      ACCEPTED_COPY_CODES.PLAN_INVALID
    );
  }
  return value;
}

/**
 * Returns null when the request is not selection-driven, so the caller can
 * distinguish "transfer the review scope" from "transfer these rows". An
 * explicitly empty list is an error rather than a silent whole-scope transfer.
 */
function normalizeSelectionInstanceIds(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new AcceptedCopyError(
      "Selected instance ids must be an array",
      ACCEPTED_COPY_CODES.PLAN_INVALID
    );
  }
  const ids = [
    ...new Set(
      value.map((entry) => {
        const id = Number(entry);
        if (!Number.isSafeInteger(id) || id <= 0) {
          throw new AcceptedCopyError(
            "Every selected instance id must be a positive integer",
            ACCEPTED_COPY_CODES.PLAN_INVALID
          );
        }
        return id;
      })
    ),
  ];
  if (ids.length === 0 || ids.length > ACCEPTED_COPY_MAX_MEDIA) {
    throw new AcceptedCopyError(
      `A transfer selection must name 1-${ACCEPTED_COPY_MAX_MEDIA} clips`,
      ACCEPTED_COPY_CODES.PLAN_INVALID
    );
  }
  return ids;
}

function normalizeRootPath(value, pathImpl = path) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    value.length > 32_768 ||
    !pathImpl.isAbsolute(value.trim())
  ) {
    throw new ReviewExportError(
      "A valid library root is required",
      "REVIEW_EXPORT_ROOT_INVALID"
    );
  }
  return pathImpl.resolve(value.trim());
}

function resolveAuthorizedRoot(result, pathImpl = path) {
  const candidate = typeof result === "string"
    ? result
    : result?.path || result?.rootPath;
  return normalizeRootPath(candidate, pathImpl);
}

function resolvePickedDirectory(result) {
  if (result?.canceled || result?.cancelled) return null;
  if (typeof result === "string") return result;
  if (typeof result?.path === "string") return result.path;
  if (Array.isArray(result?.filePaths) && typeof result.filePaths[0] === "string") {
    return result.filePaths[0];
  }
  return null;
}

function isPathInside(rootPath, targetPath, pathImpl = path) {
  const relative = pathImpl.relative(rootPath, targetPath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${pathImpl.sep}`) &&
    !pathImpl.isAbsolute(relative)
  );
}

function platformPathKey(value, caseInsensitive) {
  const normalized = String(value).normalize("NFC");
  return caseInsensitive ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function portablePathFromNative(rootPath, filePath, pathImpl = path) {
  const nativeRelative = pathImpl.relative(rootPath, filePath);
  if (
    !nativeRelative ||
    nativeRelative === ".." ||
    nativeRelative.startsWith(`..${pathImpl.sep}`) ||
    pathImpl.isAbsolute(nativeRelative)
  ) {
    throw new AcceptedCopyError(
      "A copy source is outside the authorized library root",
      ACCEPTED_COPY_CODES.SOURCE_INVALID
    );
  }
  return normalizeReviewExportRelativePath(
    nativeRelative.split(pathImpl.sep).join("/")
  );
}

function normalizeTransferLayout(value) {
  return value === "flat" ? "flat" : "structured";
}

/**
 * Structured keeps each clip's path relative to its library root, so the source
 * folder tree is recreated under the destination. Flat drops that tree and
 * writes basenames directly, which makes same-named clips from different source
 * folders collide - deliberately, so the existing preflight reports them
 * instead of one silently overwriting another.
 */
function destinationForRelative(
  destinationRoot,
  relativePath,
  pathImpl = path,
  layout = "structured"
) {
  const normalized = normalizeReviewExportRelativePath(relativePath);
  const segments = normalized.split("/");
  const targetSegments =
    normalizeTransferLayout(layout) === "flat"
      ? [segments[segments.length - 1]]
      : segments;
  const destination = pathImpl.resolve(destinationRoot, ...targetSegments);
  if (!isPathInside(destinationRoot, destination, pathImpl)) {
    throw new AcceptedCopyError(
      "A copy target escapes the selected destination",
      ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
    );
  }
  return destination;
}

function fileIdentity(stats) {
  if (!stats?.isFile?.() || stats?.isSymbolicLink?.()) {
    throw new AcceptedCopyError(
      "A copy source is not a regular file",
      ACCEPTED_COPY_CODES.SOURCE_INVALID
    );
  }
  return [
    Number(stats.dev) || 0,
    Number(stats.ino) || 0,
    Number(stats.size) || 0,
    Number(stats.mtimeMs) || 0,
    Number(stats.ctimeMs) || 0,
    Number(stats.birthtimeMs) || 0,
  ].join(":");
}

function directoryIdentity(stats) {
  if (!stats?.isDirectory?.() || stats?.isSymbolicLink?.()) {
    throw new AcceptedCopyError(
      "The selected destination is not a regular directory",
      ACCEPTED_COPY_CODES.DESTINATION_INVALID
    );
  }
  return [
    Number(stats.dev) || 0,
    Number(stats.ino) || 0,
    Number(stats.birthtimeMs) || 0,
  ].join(":");
}

function sameIndexedIdentity(record, stats) {
  const expectedSize = Number(record?.size);
  const expectedMtime = Number(record?.mtimeMs);
  return (
    Number.isFinite(expectedSize) &&
    expectedSize >= 0 &&
    Number(stats?.size) === expectedSize &&
    Number.isFinite(expectedMtime) &&
    expectedMtime >= 0 &&
    Math.abs(Number(stats?.mtimeMs) - expectedMtime) < 1
  );
}

function cancellationError(message = "Copy Accepted was cancelled") {
  return new AcceptedCopyError(message, "ACCEPTED_COPY_CANCELLED");
}

function expiredError() {
  return new AcceptedCopyError(
    "The Copy Accepted plan expired. Choose a destination again.",
    ACCEPTED_COPY_CODES.PLAN_EXPIRED
  );
}

function isMissingError(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function isUnavailableMediaError(error) {
  return isMissingError(error) || error?.code === ACCEPTED_COPY_CODES.SOURCE_CHANGED;
}

function safeErrorCode(error, fallback = "ACCEPTED_COPY_ERROR") {
  const value = typeof error?.code === "string" ? error.code : "";
  return /^[A-Z0-9_]{2,80}$/u.test(value) ? value : fallback;
}

function publicErrorMessage(error, fallback = "Copy Accepted could not be completed") {
  if (error instanceof AcceptedCopyError || error instanceof ReviewExportError) {
    return error.message;
  }
  const messages = {
    EACCES: "Permission was denied while copying the file.",
    EEXIST: "A destination file already exists.",
    EIO: "The filesystem reported an input/output error.",
    EMFILE: "Too many files are open. Try the operation again.",
    ENFILE: "The system file limit was reached. Try the operation again.",
    ENOENT: "A source file or destination folder is no longer present.",
    ENOSPC: "The destination does not have enough free space.",
    ENOTDIR: "Part of the selected path is not a directory.",
    EPERM: "Permission was denied while copying the file.",
    EROFS: "The selected destination is read-only.",
  };
  return messages[error?.code] || fallback;
}

function sampleFailure(relativePath, error) {
  return Object.freeze({
    relativePath:
      typeof relativePath === "string" ? relativePath.slice(0, 32_768) : "",
    kind: "media",
    code: safeErrorCode(error),
    message: publicErrorMessage(error),
  });
}

function sampleCollision(relativePath, reason = "exists") {
  return Object.freeze({
    relativePath:
      typeof relativePath === "string" ? relativePath.slice(0, 32_768) : "",
    kind: "media",
    reason: reason === "in-plan" ? "in-plan" : "exists",
  });
}

function boundedPush(target, value, limit = ACCEPTED_COPY_MAX_SAMPLES) {
  if (target.length < limit) target.push(value);
}

async function mapBounded(items, worker, concurrency, signal = null) {
  const source = Array.isArray(items) ? items : [];
  const results = new Array(source.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < source.length) {
      if (signal?.aborted) throw signal.reason || cancellationError();
      const index = cursor;
      cursor += 1;
      results[index] = await worker(source[index], index);
    }
  };
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, source.length)) },
    run
  );
  // A rejected worker must not detach another in-flight filesystem operation.
  // Drain every bounded slot before propagating the first failure so profile
  // changes and shutdown can rely on coordinator drain semantics.
  const settlements = await Promise.allSettled(workers);
  const rejected = settlements.find((entry) => entry.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}

function normalizeQueryResult(result) {
  const records = Array.isArray(result) ? result : result?.records;
  if (!Array.isArray(records)) {
    throw new AcceptedCopyError(
      "The accepted-media query returned an invalid result",
      ACCEPTED_COPY_CODES.INVALID_QUERY_RESULT
    );
  }
  if (result?.truncated || records.length > ACCEPTED_COPY_MAX_MEDIA) {
    throw new AcceptedCopyError(
      `Copy Accepted is limited to ${ACCEPTED_COPY_MAX_MEDIA.toLocaleString()} media files per operation`,
      "ACCEPTED_COPY_TOO_MANY_MEDIA"
    );
  }
  return records;
}

/**
 * `resolveSourceRoot` returns the authorized root a record must live under.
 * A selection can span roots, so containment and the relative-path identity
 * check are made against each record's own root rather than against one shared
 * root that would silently accept a file from somewhere else.
 */
function normalizeAcceptedRecords(records, resolveSourceRoot, pathImpl) {
  let pathBytes = 0;
  return records.map((record) => {
    const sourceRoot = typeof resolveSourceRoot === "function"
      ? resolveSourceRoot(record)
      : resolveSourceRoot;
    if (!sourceRoot) {
      throw new AcceptedCopyError(
        "An accepted-media source has no authorized library root",
        ACCEPTED_COPY_CODES.SOURCE_INVALID
      );
    }
    const relativePath = normalizeReviewExportRelativePath(record?.relativePath);
    const sourcePath = normalizeRootPath(record?.absolutePath, pathImpl);
    if (!isPathInside(sourceRoot, sourcePath, pathImpl)) {
      throw new AcceptedCopyError(
        "An accepted-media source is outside the authorized library root",
        ACCEPTED_COPY_CODES.SOURCE_INVALID
      );
    }
    const actualRelativePath = portablePathFromNative(
      sourceRoot,
      sourcePath,
      pathImpl
    );
    if (actualRelativePath !== relativePath) {
      throw new AcceptedCopyError(
        "An accepted-media record does not match its indexed relative path",
        ACCEPTED_COPY_CODES.SOURCE_INVALID
      );
    }
    pathBytes += Buffer.byteLength(relativePath, "utf8");
    pathBytes += Buffer.byteLength(sourcePath, "utf8");
    if (pathBytes > ACCEPTED_COPY_MAX_PATH_BYTES) {
      throw new AcceptedCopyError(
        "Accepted-media paths exceed the bounded query budget",
        ACCEPTED_COPY_CODES.QUERY_TOO_LARGE
      );
    }
    return {
      instanceId: Number.isSafeInteger(Number(record?.instanceId))
        ? Number(record.instanceId)
        : null,
      relativePath,
      sourcePath,
      size: Number(record?.size),
      mtimeMs: Number(record?.mtimeMs),
      fingerprint:
        typeof record?.fingerprint === "string" ? record.fingerprint : null,
    };
  });
}

function prepareFailureResult(error, context = null, planId = null) {
  return {
    success: false,
    cancelled: error?.code === "ACCEPTED_COPY_CANCELLED",
    planId,
    profileId: context?.profileId || null,
    generation: context?.generation ?? null,
    code: safeErrorCode(error),
    error: publicErrorMessage(error, "Copy Accepted could not be prepared"),
  };
}

function unavailableResult(code, error) {
  return Promise.resolve({
    success: false,
    cancelled: false,
    planId: null,
    profileId: null,
    generation: null,
    code,
    error,
  });
}

function createReviewCopyAcceptedCoordinator(options = {}) {
  const captureContext = requireFunction(options.captureContext, "captureContext");
  const assertActive = requireFunction(options.assertActive, "assertActive");
  const authorizeRoot = requireFunction(options.authorizeRoot, "authorizeRoot");
  const getRoot = requireFunction(options.getRoot, "getRoot");
  const showDirectoryPicker = requireFunction(
    options.showDirectoryPicker,
    "showDirectoryPicker"
  );
  const queryAcceptedInstances = requireFunction(
    options.queryAcceptedInstances,
    "queryAcceptedInstances"
  );
  const emitProgress = typeof options.emitProgress === "function"
    ? options.emitProgress
    : () => {};
  // A Move deletes its sources. The catalog is told which ones, and why, so a
  // deliberate transfer is not later reported as files that went missing.
  const onSourcesRemoved = typeof options.onSourcesRemoved === "function"
    ? options.onSourcesRemoved
    : () => {};
  // Destination reuse is host-owned on both sides: the host decides which
  // paths are offered back, and the host records new ones after a successful
  // preflight. Neither is inferred from renderer input.
  const listReusableDestinations =
    typeof options.listReusableDestinations === "function"
      ? options.listReusableDestinations
      : () => [];
  const onDestinationPrepared =
    typeof options.onDestinationPrepared === "function"
      ? options.onDestinationPrepared
      : () => {};
  const fsPromises = options.fsPromises || fs.promises;
  const pathImpl = options.pathImpl || path;
  const logger = options.logger || null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const createPlanId = typeof options.createPlanId === "function"
    ? options.createPlanId
    : () => crypto.randomBytes(24).toString("hex");
  const concurrency = ACCEPTED_COPY_CONCURRENCY;
  const maxPlans = Math.max(
    1,
    Math.min(ACCEPTED_COPY_MAX_PLANS, Number(options.maxPlans) || ACCEPTED_COPY_MAX_PLANS)
  );
  const planTtlMs = Math.max(
    1,
    Number(options.planTtlMs) || ACCEPTED_COPY_PLAN_TTL_MS
  );
  const progressIntervalMs = options.progressIntervalMs === undefined
    ? ACCEPTED_COPY_PROGRESS_INTERVAL_MS
    : Math.max(0, Number(options.progressIntervalMs) || 0);
  const caseInsensitivePaths = options.caseInsensitivePaths === undefined
    ? process.platform === "win32" || process.platform === "darwin"
    : Boolean(options.caseInsensitivePaths);
  const copyFileExclusiveFlag = options.copyFileExclusiveFlag === undefined
    ? fs.constants.COPYFILE_EXCL
    : options.copyFileExclusiveFlag;

  for (const method of [
    "copyFile",
    "lstat",
    "mkdir",
    "realpath",
    "stat",
    "unlink",
  ]) {
    if (typeof fsPromises?.[method] !== "function") {
      throw new TypeError(`Copy Accepted requires fsPromises.${method}()`);
    }
  }

  const plans = new Map();
  const trackedOperations = new Set();
  let activePreparation = null;
  let activeCopy = null;
  let admissionOpen = true;
  let closed = false;

  function trackOperation(operation) {
    const tracked = Promise.resolve(operation);
    trackedOperations.add(tracked);
    tracked.then(
      () => trackedOperations.delete(tracked),
      () => trackedOperations.delete(tracked)
    );
    return tracked;
  }

  function disposePlan(plan) {
    if (!plan) return false;
    if (plan.expiryTimer) clearTimeout(plan.expiryTimer);
    plan.expiryTimer = null;
    if (plans.get(plan.id) === plan) plans.delete(plan.id);
    return true;
  }

  function abortPlan(plan, error = cancellationError()) {
    if (!plan || plan.controller.signal.aborted) return false;
    plan.controller.abort(error);
    return true;
  }

  function assertPlanActive(plan, phase) {
    if (plan.controller.signal.aborted) {
      throw plan.controller.signal.reason || cancellationError();
    }
    try {
      assertActive({
        owner: plan.owner,
        context: plan.context,
        request: plan.request,
        planId: plan.id,
        phase,
      });
    } catch (error) {
      abortPlan(plan, error);
      throw error;
    }
  }

  function progressPayload(plan, phase, snapshot = {}) {
    return Object.freeze({
      planId: plan.id,
      phase,
      processed: Math.max(0, Number(snapshot.processed) || 0),
      total: Math.max(0, Number(snapshot.total) || 0),
      copiedMedia: Math.max(0, Number(snapshot.copiedMedia) || 0),
      skippedCollisions: Math.max(0, Number(snapshot.skippedCollisions) || 0),
      failedCount: Math.max(0, Number(snapshot.failedCount) || 0),
      bytesCopied: Math.max(0, Number(snapshot.bytesCopied) || 0),
      totalBytes: Math.max(0, Number(snapshot.totalBytes) || 0),
      currentRelativePath:
        typeof snapshot.currentRelativePath === "string"
          ? snapshot.currentRelativePath.slice(0, 32_768)
          : null,
    });
  }

  function reportProgress(plan, phase, snapshot, force = false) {
    const timestamp = now();
    if (
      !force &&
      timestamp - Number(plan.lastProgressAt || 0) < progressIntervalMs
    ) {
      return false;
    }
    plan.lastProgressAt = timestamp;
    try {
      emitProgress({
        owner: plan.owner,
        payload: progressPayload(plan, phase, snapshot),
      });
    } catch (error) {
      logger?.warn?.("[copy-accepted] Failed to emit progress", {
        code: safeErrorCode(error, "PROGRESS_ERROR"),
      });
    }
    return true;
  }

  function generateUniquePlanId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = normalizePlanId(String(createPlanId()));
      if (!plans.has(id)) return id;
    }
    throw new AcceptedCopyError(
      "Unable to allocate a Copy Accepted plan",
      ACCEPTED_COPY_CODES.PLAN_INVALID
    );
  }

  function expirePreparedPlan(plan) {
    if (plans.get(plan.id) !== plan || plan.state !== "prepared") return;
    abortPlan(plan, expiredError());
    disposePlan(plan);
  }

  function cleanupExpiredPlans() {
    const timestamp = now();
    for (const plan of plans.values()) {
      if (plan.state === "prepared" && plan.expiresAt <= timestamp) {
        expirePreparedPlan(plan);
      }
    }
  }

  async function canonicalDirectory(candidate, plan, phase) {
    if (
      typeof candidate !== "string" ||
      !candidate.trim() ||
      candidate.includes("\0") ||
      !pathImpl.isAbsolute(candidate.trim())
    ) {
      throw new AcceptedCopyError(
        "The selected destination is invalid",
        ACCEPTED_COPY_CODES.DESTINATION_INVALID
      );
    }
    const canonical = pathImpl.resolve(await fsPromises.realpath(candidate.trim()));
    assertPlanActive(plan, `${phase}:realpath`);
    const stats = await fsPromises.lstat(canonical);
    assertPlanActive(plan, `${phase}:stat`);
    return { path: canonical, identity: directoryIdentity(stats) };
  }

  function createExistingDirectoryInspector(destinationRoot) {
    const inspected = new Map();
    const inspect = (directoryPath) => {
      const resolved = pathImpl.resolve(directoryPath);
      if (!isPathInside(destinationRoot, resolved, pathImpl)) {
        return Promise.reject(new AcceptedCopyError(
          "A destination directory escapes the selected root",
          ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
        ));
      }
      if (resolved === destinationRoot) return Promise.resolve(true);
      if (inspected.has(resolved)) return inspected.get(resolved);
      const operation = (async () => {
        await inspect(pathImpl.dirname(resolved));
        try {
          const stats = await fsPromises.lstat(resolved);
          if (stats.isSymbolicLink?.() || !stats.isDirectory?.()) {
            throw new AcceptedCopyError(
              "A destination folder is a symbolic link or non-directory",
              ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
            );
          }
          return true;
        } catch (error) {
          if (isMissingError(error)) return false;
          throw error;
        }
      })();
      inspected.set(resolved, operation);
      return operation;
    };
    return inspect;
  }

  function createSafeDirectoryCreator(destinationRoot) {
    const created = new Map();
    const ensure = (directoryPath) => {
      const resolved = pathImpl.resolve(directoryPath);
      if (!isPathInside(destinationRoot, resolved, pathImpl)) {
        return Promise.reject(new AcceptedCopyError(
          "A destination directory escapes the selected root",
          ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
        ));
      }
      if (resolved === destinationRoot) return Promise.resolve(true);
      if (created.has(resolved)) return created.get(resolved);
      const operation = (async () => {
        await ensure(pathImpl.dirname(resolved));
        try {
          await fsPromises.mkdir(resolved);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        const stats = await fsPromises.lstat(resolved);
        if (stats.isSymbolicLink?.() || !stats.isDirectory?.()) {
          throw new AcceptedCopyError(
            "A destination folder is a symbolic link or non-directory",
            ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
          );
        }
        return true;
      })();
      created.set(resolved, operation);
      return operation;
    };
    return ensure;
  }

  async function inspectSource(record, plan) {
    const failures = [];
    const jobs = [];
    let mediaStats;
    try {
      mediaStats = await fsPromises.lstat(record.sourcePath);
      assertPlanActive(plan, "preflight:media-stat");
      const identity = fileIdentity(mediaStats);
      if (!sameIndexedIdentity(record, mediaStats)) {
        throw new AcceptedCopyError(
          "An accepted clip changed after it was indexed",
          ACCEPTED_COPY_CODES.SOURCE_CHANGED
        );
      }
      jobs.push({
        sourcePath: record.sourcePath,
        relativePath: record.relativePath,
        identity,
        size: Number(mediaStats.size) || 0,
      });
    } catch (error) {
      boundedPush(failures, sampleFailure(record.relativePath, error));
      return {
        jobs,
        failures,
        failureCount: Number(!isUnavailableMediaError(error)),
        missingCount: Number(isUnavailableMediaError(error)),
      };
    }

    return { jobs, failures, failureCount: 0, missingCount: 0 };
  }

  async function buildPlanJobs(plan, records) {
    let processed = 0;
    const inspected = await mapBounded(
      records,
      async (record) => {
        const result = await inspectSource(record, plan);
        processed += 1;
        reportProgress(plan, "preflight", {
          processed,
          total: records.length,
          totalBytes: 0,
          currentRelativePath: record.relativePath,
        });
        return result;
      },
      concurrency,
      plan.controller.signal
    );
    assertPlanActive(plan, "preflight:sources-complete");

    const failures = [];
    let failureCount = 0;
    let missingCount = 0;
    const candidateJobs = [];
    for (const result of inspected) {
      candidateJobs.push(...result.jobs);
      failureCount += result.failureCount;
      missingCount += result.missingCount;
      for (const failure of result.failures) boundedPush(failures, failure);
    }

    let pathBytes = 0;
    const deduplicated = [];
    const byDestination = new Map();
    const collisions = [];
    let collisionCount = 0;
    for (const job of candidateJobs) {
      pathBytes += Buffer.byteLength(job.sourcePath, "utf8");
      pathBytes += Buffer.byteLength(job.relativePath, "utf8");
      if (pathBytes > ACCEPTED_COPY_MAX_PATH_BYTES) {
        throw new AcceptedCopyError(
          "Accepted-media paths exceed the bounded plan budget",
          ACCEPTED_COPY_CODES.QUERY_TOO_LARGE
        );
      }
      const destinationPath = destinationForRelative(
        plan.destinationRoot,
        job.relativePath,
        pathImpl,
        plan.layout
      );
      const destinationKey = platformPathKey(destinationPath, caseInsensitivePaths);
      // Destination case sensitivity may differ from the source volume (for
      // example, a Linux library copied to a case-insensitive removable disk).
      // Dedupe only byte-identical source paths; otherwise conservatively
      // surface the target-key clash as an in-plan collision.
      const sourceKey = platformPathKey(job.sourcePath, false);
      const existing = byDestination.get(destinationKey);
      if (existing?.sourceKey === sourceKey) continue;
      const completedJob = { ...job, destinationPath, collision: false };
      if (existing) {
        completedJob.collision = true;
        completedJob.collisionReason = "in-plan";
        collisionCount += 1;
        boundedPush(
          collisions,
          sampleCollision(job.relativePath, "in-plan")
        );
      } else {
        byDestination.set(destinationKey, { sourceKey, job: completedJob });
      }
      deduplicated.push(completedJob);
    }

    const inspectDestinationDirectory = createExistingDirectoryInspector(
      plan.destinationRoot
    );
    await mapBounded(
      deduplicated,
      async (job) => {
        if (job.collision) return;
        try {
          await inspectDestinationDirectory(pathImpl.dirname(job.destinationPath));
          assertPlanActive(plan, "preflight:destination-parent");
          try {
            await fsPromises.lstat(job.destinationPath);
            job.collision = true;
            job.collisionReason = "exists";
            collisionCount += 1;
            boundedPush(
              collisions,
              sampleCollision(job.relativePath, "exists")
            );
          } catch (error) {
            if (!isMissingError(error)) throw error;
          }
        } catch (error) {
          job.invalid = true;
          failureCount += 1;
          boundedPush(failures, sampleFailure(job.relativePath, error));
        }
      },
      concurrency,
      plan.controller.signal
    );
    assertPlanActive(plan, "preflight:destinations-complete");

    const jobs = deduplicated.filter((job) => !job.invalid);
    const totalBytes = jobs.reduce(
      (sum, job) => sum + (job.collision ? 0 : Math.max(0, Number(job.size) || 0)),
      0
    );
    return {
      jobs,
      failures,
      failureCount,
      missingCount,
      collisions,
      collisionCount,
      totalBytes,
    };
  }

  /**
   * Turn a renderer-named destination into a usable path only when the host's
   * own record of previously used destinations contains it. An unknown path is
   * ignored rather than rejected, so the flow simply falls back to the native
   * picker instead of failing.
   */
  async function resolveReusableDestination({
    owner,
    context,
    requestedDestination,
  }) {
    if (typeof requestedDestination !== "string" || !requestedDestination.trim()) {
      return null;
    }
    const requested = pathImpl.resolve(requestedDestination.trim());
    let known = [];
    try {
      known = (await listReusableDestinations({ owner, context })) || [];
    } catch {
      return null;
    }
    if (!Array.isArray(known)) return null;
    const match = known.find(
      (candidate) =>
        typeof candidate === "string" &&
        pathImpl.resolve(candidate) === requested
    );
    return match ? requested : null;
  }

  /**
   * Read the destination from a prepared plan that this request replaces, then
   * retire it. Ownership is required, so one renderer cannot inherit another's
   * destination, and the path never crosses the process boundary.
   */
  function takeSupersededDestination(reusePlanId, owner) {
    if (typeof reusePlanId !== "string" || !reusePlanId) return null;
    const previous = plans.get(reusePlanId);
    if (
      !previous ||
      previous.owner !== owner ||
      previous.state !== "prepared" ||
      typeof previous.destinationRoot !== "string" ||
      !previous.destinationRoot
    ) {
      return null;
    }
    const destinationRoot = previous.destinationRoot;
    disposePlan(previous);
    return destinationRoot;
  }

  async function runPrepare(request = {}) {
    let context = null;
    let plan = null;
    try {
      const owner = request?.owner;
      if (!owner || (typeof owner !== "object" && typeof owner !== "function")) {
        throw new AcceptedCopyError(
          "A live renderer owner is required",
          ACCEPTED_COPY_CODES.PLAN_INVALID
        );
      }
      // A selection names exact rows, so it carries no scope of its own and
      // must not be held to the review export's tree-coverage requirement. It
      // may also span roots, or come from a rootless collection with no active
      // root at all, so its source roots are derived from the resolved rows
      // rather than supplied.
      const instanceIds = normalizeSelectionInstanceIds(request?.instanceIds);
      const selectionDriven = instanceIds !== null;
      const rootPath = selectionDriven && !request?.rootPath
        ? null
        : normalizeRootPath(request?.rootPath, pathImpl);
      const scope = selectionDriven
        ? "all-descendants"
        : normalizeReviewExportScope(request?.scope);
      const directory = selectionDriven || scope === "all-descendants"
        ? ""
        : normalizeReviewExportDirectory(request?.directory ?? "");
      context = captureContext({ owner, request });
      const planId = generateUniquePlanId();
      plan = {
        id: planId,
        owner,
        context,
        request,
        rootPath,
        directory,
        scope,
        instanceIds,
        selectionDriven,
        state: "preparing",
        controller: new AbortController(),
        expiryTimer: null,
        expiresAt: 0,
        lastProgressAt: 0,
      };
      plans.set(planId, plan);
      assertPlanActive(plan, "captured");

      // Every contributing root is authorized and canonicalized. A selection
      // gathered from a library-wide view can touch several, and each one is a
      // separate grant rather than something implied by the first.
      const authorizeSourceRoot = async (candidate, label) => {
        const authorized = await authorizeRoot({
          owner,
          context,
          rootPath: candidate,
          request,
        });
        assertPlanActive(plan, label);
        return (
          await canonicalDirectory(
            resolveAuthorizedRoot(authorized, pathImpl),
            plan,
            label
          )
        ).path;
      };

      let initialRoot = null;
      let selectionRecords = null;
      // Records name their root as the catalog stores it; containment must be
      // checked against the canonical form the grant actually resolved to.
      plan.sourceRootByRawPath = new Map();
      if (rootPath) {
        plan.sourceRoot = await authorizeSourceRoot(rootPath, "source-root");
        plan.sourceRoots = [plan.sourceRoot];
        plan.sourceRootByRawPath.set(rootPath, plan.sourceRoot);
        initialRoot = await getRoot({
          owner,
          context,
          rootPath: plan.sourceRoot,
          request,
        });
        assertPlanActive(plan, "root-loaded");
        if (!selectionDriven) {
          assertReviewExportCoverage(initialRoot, directory, scope);
        }
      }

      if (selectionDriven && !rootPath) {
        // Resolve the rows first: their owning roots are the only thing that
        // says which grants and containment checks this transfer needs.
        const resolved = await queryAcceptedInstances({
          owner,
          context,
          root: null,
          rootPath: null,
          directory,
          scope,
          instanceIds,
          limit: ACCEPTED_COPY_MAX_MEDIA + 1,
          maxRecords: ACCEPTED_COPY_MAX_MEDIA,
          maxPathBytes: ACCEPTED_COPY_MAX_PATH_BYTES,
          assertActive: () => assertPlanActive(plan, "selection-query"),
        });
        assertPlanActive(plan, "selection-resolved");
        selectionRecords = resolved;
        const contributing = [
          ...new Set(
            (Array.isArray(resolved?.records) ? resolved.records : [])
              .map((record) => record?.rootPath)
              .filter(Boolean)
          ),
        ];
        if (contributing.length === 0) {
          throw new AcceptedCopyError(
            "None of the selected clips are still available to transfer",
            ACCEPTED_COPY_CODES.PLAN_INVALID
          );
        }
        plan.sourceRoots = [];
        for (const candidate of contributing) {
          const canonical = await authorizeSourceRoot(candidate, "source-root");
          plan.sourceRootByRawPath.set(candidate, canonical);
          plan.sourceRoots.push(canonical);
        }
        plan.sourceRoot = plan.sourceRoots[0];
      }

      // Re-running preflight for an existing plan (a layout change) must not
      // make the user pick the same folder again. The path is read from the
      // superseded plan inside the host, so it is never handed to the renderer.
      let selectedDirectory = takeSupersededDestination(
        request?.reusePlanId,
        owner
      );

      // A destination the renderer names is only honoured when the host
      // recognises it as one this profile already used. Authority for which
      // paths are reusable stays outside the renderer; the shortcut just skips
      // re-navigating to somewhere the user has already chosen before.
      if (!selectedDirectory) {
        selectedDirectory = await resolveReusableDestination({
          owner,
          context,
          requestedDestination: request?.destinationPath ?? null,
        });
      }
      assertPlanActive(plan, "destination-resolved");
      if (!selectedDirectory) {
        const pickerResult = await showDirectoryPicker({
          owner,
          context,
          root: initialRoot,
          rootPath: plan.sourceRoot,
          directory,
          scope,
          request,
        });
        assertPlanActive(plan, "picker-closed");
        selectedDirectory = resolvePickedDirectory(pickerResult);
      }
      if (!selectedDirectory) {
        disposePlan(plan);
        return {
          success: true,
          cancelled: true,
          planId: null,
          profileId: context?.profileId || null,
          generation: context?.generation ?? null,
        };
      }

      const destination = await canonicalDirectory(
        selectedDirectory,
        plan,
        "destination"
      );
      // Checked against every contributing root, not just the first: writing a
      // multi-root gather back inside any of its own sources would make the
      // transfer its own input.
      if (
        (plan.sourceRoots || [plan.sourceRoot]).some(
          (sourceRoot) =>
            sourceRoot && isPathInside(sourceRoot, destination.path, pathImpl)
        )
      ) {
        throw new AcceptedCopyError(
          "Choose a destination outside the source library",
          ACCEPTED_COPY_CODES.DESTINATION_INSIDE_ROOT
        );
      }
      plan.destinationRoot = destination.path;
      plan.layout = normalizeTransferLayout(request?.layout);
      plan.destinationIdentity = destination.identity;
      plan.destinationLabel = pathImpl.basename(destination.path) || "Destination";

      // Reuse the rows already resolved to discover the source roots rather
      // than reading them a second time.
      const queryResult = selectionRecords || await queryAcceptedInstances({
        owner,
        context,
        root: initialRoot,
        rootPath: plan.sourceRoot,
        directory,
        scope,
        instanceIds,
        limit: ACCEPTED_COPY_MAX_MEDIA + 1,
        maxRecords: ACCEPTED_COPY_MAX_MEDIA,
        maxPathBytes: ACCEPTED_COPY_MAX_PATH_BYTES,
        assertActive: () => assertPlanActive(plan, "query"),
      });
      assertPlanActive(plan, "query-complete");
      const liveRoot = queryResult?.root || initialRoot;
      if (!selectionDriven) {
        assertReviewExportCoverage(liveRoot, directory, scope);
      }
      // Rows the selection named that no longer resolve are the same kind of
      // outcome as a source that vanishes during preflight, so they are
      // reported through the existing unavailable count rather than a new one.
      const unresolvedSelection = selectionDriven
        ? Math.max(0, Number(queryResult?.unavailableCount) || 0)
        : 0;
      const records = normalizeAcceptedRecords(
        normalizeQueryResult(queryResult),
        (record) =>
          record?.rootPath
            ? plan.sourceRootByRawPath?.get(record.rootPath) || null
            : plan.sourceRoot,
        pathImpl
      );

      reportProgress(plan, "preflight", {
        processed: 0,
        total: records.length,
      }, true);
      const prepared = await buildPlanJobs(plan, records);
      assertPlanActive(plan, "preflight-complete");
      plan.jobs = prepared.jobs;
      plan.preflightFailures = prepared.failures;
      plan.preflightFailureCount = prepared.failureCount;
      plan.missingCount = prepared.missingCount + unresolvedSelection;
      plan.collisions = prepared.collisions;
      plan.collisionCount = prepared.collisionCount;
      plan.totalBytes = prepared.totalBytes;
      plan.totalMedia = records.length;
      plan.state = "prepared";
      plan.expiresAt = now() + planTtlMs;
      plan.expiryTimer = setTimeout(() => expirePreparedPlan(plan), planTtlMs);
      plan.expiryTimer.unref?.();
      reportProgress(plan, "preflight", {
        processed: records.length,
        total: records.length,
        failedCount: prepared.failureCount,
        skippedCollisions: prepared.collisionCount,
        totalBytes: prepared.totalBytes,
      }, true);

      // Only a destination that survived canonicalisation and preflight is
      // worth offering again, so it is recorded here rather than at selection.
      try {
        onDestinationPrepared({
          owner,
          context,
          destinationPath: plan.destinationRoot,
        });
      } catch (error) {
        logger?.warn?.("[copy-accepted] Failed to record destination", {
          code: safeErrorCode(error),
        });
      }

      const copyableCount = plan.jobs.reduce(
        (count, job) => count + Number(!job.collision),
        0
      );
      return {
        success: true,
        cancelled: false,
        planId: plan.id,
        profileId: context?.profileId || null,
        generation: context?.generation ?? null,
        expiresAt: plan.expiresAt,
        destinationLabel: plan.destinationLabel,
        layout: plan.layout,
        mediaCount: plan.totalMedia,
        totalMedia: plan.totalMedia,
        totalFiles:
          plan.jobs.length + plan.preflightFailureCount + plan.missingCount,
        copyableCount,
        canStart: copyableCount > 0,
        totalBytes: plan.totalBytes,
        collisionCount: plan.collisionCount,
        collisionSamples: [...plan.collisions],
        collisions: [...plan.collisions],
        omittedCollisionCount: Math.max(
          0,
          plan.collisionCount - plan.collisions.length
        ),
        failureCount: plan.preflightFailureCount,
        missingCount: plan.missingCount,
        failureSamples: [...plan.preflightFailures],
        failures: [...plan.preflightFailures],
        omittedFailureCount: Math.max(
          0,
          plan.preflightFailureCount + plan.missingCount -
            plan.preflightFailures.length
        ),
      };
    } catch (error) {
      if (plan) disposePlan(plan);
      logger?.error?.("[copy-accepted] Failed to prepare", {
        code: safeErrorCode(error),
      });
      return prepareFailureResult(error, context, plan?.id || null);
    }
  }

  function prepare(request = {}) {
    cleanupExpiredPlans();
    if (closed) {
      return unavailableResult(
        ACCEPTED_COPY_CODES.CLOSED,
        "Copy Accepted is closed"
      );
    }
    if (!admissionOpen) {
      return unavailableResult(
        ACCEPTED_COPY_CODES.PAUSED,
        "Copy Accepted is paused"
      );
    }
    if (activePreparation) {
      return unavailableResult(
        ACCEPTED_COPY_CODES.BUSY,
        "Another Copy Accepted plan is being prepared"
      );
    }
    if (plans.size >= maxPlans) {
      return unavailableResult(
        ACCEPTED_COPY_CODES.NO_PLAN_SLOTS,
        "Too many Copy Accepted plans are awaiting confirmation"
      );
    }

    const operation = trackOperation(runPrepare(request));
    activePreparation = operation;
    operation.then(
      () => {
        if (activePreparation === operation) activePreparation = null;
      },
      () => {
        if (activePreparation === operation) activePreparation = null;
      }
    );
    return operation;
  }

  async function assertDestinationStillOwned(plan) {
    const canonical = pathImpl.resolve(
      await fsPromises.realpath(plan.destinationRoot)
    );
    assertPlanActive(plan, "start:destination-realpath");
    if (canonical !== plan.destinationRoot) {
      throw new AcceptedCopyError(
        "The selected destination changed after preflight",
        ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
      );
    }
    const stats = await fsPromises.lstat(canonical);
    assertPlanActive(plan, "start:destination-stat");
    if (directoryIdentity(stats) !== plan.destinationIdentity) {
      throw new AcceptedCopyError(
        "The selected destination changed after preflight",
        ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
      );
    }
  }

  async function assertConcreteDestinationParent(plan, directoryPath) {
    const expected = pathImpl.resolve(directoryPath);
    if (!isPathInside(plan.destinationRoot, expected, pathImpl)) {
      throw new AcceptedCopyError(
        "A destination directory escapes the selected root",
        ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
      );
    }

    const before = await fsPromises.lstat(expected);
    assertPlanActive(plan, "copy:destination-parent-lstat");
    const beforeIdentity = directoryIdentity(before);
    const canonical = pathImpl.resolve(await fsPromises.realpath(expected));
    assertPlanActive(plan, "copy:destination-parent-realpath");
    if (
      platformPathKey(canonical, caseInsensitivePaths) !==
        platformPathKey(expected, caseInsensitivePaths) ||
      !isPathInside(plan.destinationRoot, canonical, pathImpl)
    ) {
      throw new AcceptedCopyError(
        "A destination folder changed or became a symbolic link",
        ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
      );
    }
    const after = await fsPromises.lstat(expected);
    assertPlanActive(plan, "copy:destination-parent-recheck");
    if (directoryIdentity(after) !== beforeIdentity) {
      throw new AcceptedCopyError(
        "A destination folder changed during validation",
        ACCEPTED_COPY_CODES.DESTINATION_UNSAFE
      );
    }
    return true;
  }

  async function removeUnstableDestination(job, destinationIdentity) {
    try {
      const currentDestination = await fsPromises.lstat(job.destinationPath);
      if (fileIdentity(currentDestination) !== destinationIdentity) {
        throw new AcceptedCopyError(
          "The incomplete destination changed before it could be removed",
          ACCEPTED_COPY_CODES.SOURCE_CHANGED_CLEANUP_FAILED
        );
      }
      await fsPromises.unlink(job.destinationPath);
    } catch (error) {
      if (isMissingError(error)) return;
      if (error?.code === ACCEPTED_COPY_CODES.SOURCE_CHANGED_CLEANUP_FAILED) {
        throw error;
      }
      throw new AcceptedCopyError(
        "The source changed and the incomplete destination could not be removed",
        ACCEPTED_COPY_CODES.SOURCE_CHANGED_CLEANUP_FAILED
      );
    }
  }

  async function copyPreparedPlan(plan) {
    const transferMode = plan.transferMode === "move" ? "move" : "copy";
    const moving = transferMode === "move";
    const failures = [...plan.preflightFailures];
    let failureCount = plan.preflightFailureCount;
    let missingCount = plan.missingCount || 0;
    const collisionSamples = [...plan.collisions];
    let skippedCollisions = plan.collisionCount;
    let copiedMedia = 0;
    let bytesCopied = 0;
    let processed = plan.preflightFailureCount + (plan.missingCount || 0);
    // Reporting removals in bounded batches keeps a large Move from holding
    // every source path in memory, and keeps a cancelled run's completed
    // transfers recorded rather than lost.
    const removedSources = [];
    const flushRemovedSources = (activePlan) => {
      if (removedSources.length === 0) return;
      const batch = removedSources.splice(0, removedSources.length);
      try {
        onSourcesRemoved({ plan: activePlan, paths: batch, reason: "moved" });
      } catch (error) {
        // The filesystem outcome stays authoritative; a catalog hiccup must not
        // fail a transfer that already happened.
        logger?.warn?.("[copy-accepted] Failed to record moved sources", {
          code: safeErrorCode(error),
        });
      }
    };
    const runnable = [];
    for (const job of plan.jobs) {
      if (job.collision) {
        processed += 1;
        continue;
      }
      runnable.push(job);
    }
    const total =
      plan.jobs.length + plan.preflightFailureCount + (plan.missingCount || 0);

    reportProgress(plan, "copying", {
      processed,
      total,
      copiedMedia,
      skippedCollisions,
      failedCount: failureCount,
      bytesCopied,
      totalBytes: plan.totalBytes,
    }, true);

    const ensureDirectory = createSafeDirectoryCreator(plan.destinationRoot);
    await mapBounded(
      runnable,
      async (job) => {
        if (plan.controller.signal.aborted) {
          throw plan.controller.signal.reason || cancellationError();
        }
        try {
          assertPlanActive(plan, "copy:before-source-stat");
          const stats = await fsPromises.lstat(job.sourcePath);
          assertPlanActive(plan, "copy:after-source-stat");
          if (fileIdentity(stats) !== job.identity) {
            throw new AcceptedCopyError(
              "A copy source changed after preflight",
              ACCEPTED_COPY_CODES.SOURCE_CHANGED
            );
          }
          await ensureDirectory(pathImpl.dirname(job.destinationPath));
          await assertConcreteDestinationParent(
            plan,
            pathImpl.dirname(job.destinationPath)
          );
          assertPlanActive(plan, "copy:before-file");
          await fsPromises.copyFile(
            job.sourcePath,
            job.destinationPath,
            copyFileExclusiveFlag
          );
          const destinationStats = await fsPromises.lstat(job.destinationPath);
          const copiedDestinationIdentity = fileIdentity(destinationStats);
          let sourceStable = false;
          try {
            const copiedSourceStats = await fsPromises.lstat(job.sourcePath);
            sourceStable = fileIdentity(copiedSourceStats) === job.identity;
          } catch {
            sourceStable = false;
          }
          if (!sourceStable) {
            await removeUnstableDestination(job, copiedDestinationIdentity);
            throw new AcceptedCopyError(
              "A copy source changed while it was being copied",
              ACCEPTED_COPY_CODES.SOURCE_CHANGED
            );
          }
          if (moving) {
            await fsPromises.unlink(job.sourcePath);
            removedSources.push(job.sourcePath);
            if (removedSources.length >= REMOVED_SOURCE_FLUSH_SIZE) {
              flushRemovedSources(plan);
            }
          }
          // The native copy may finish concurrently with cancellation. It is a
          // completed partial result and is intentionally not rolled back.
          copiedMedia += 1;
          bytesCopied += Math.max(0, Number(job.size) || 0);
        } catch (error) {
          if (plan.controller.signal.aborted) throw error;
          if (error?.code === "EEXIST") {
            skippedCollisions += 1;
            boundedPush(
              collisionSamples,
              sampleCollision(job.relativePath, "exists")
            );
          } else {
            if (isUnavailableMediaError(error)) {
              missingCount += 1;
            } else {
              failureCount += 1;
            }
            boundedPush(
              failures,
              sampleFailure(job.relativePath, error)
            );
            logger?.warn?.("[copy-accepted] File copy failed", {
              code: safeErrorCode(error),
            });
          }
        } finally {
          processed += 1;
          reportProgress(plan, "copying", {
            processed,
            total,
            copiedMedia,
            skippedCollisions,
            failedCount: failureCount,
            bytesCopied,
            totalBytes: plan.totalBytes,
            currentRelativePath: job.relativePath,
          });
        }
      },
      concurrency,
      plan.controller.signal
    ).catch((error) => {
      if (!plan.controller.signal.aborted) throw error;
    });

    flushRemovedSources(plan);

    const cancelled = plan.controller.signal.aborted;
    const result = {
      success: !cancelled && failureCount === 0 && missingCount === 0,
      cancelled,
      planId: plan.id,
      profileId: plan.context?.profileId || null,
      generation: plan.context?.generation ?? null,
      code: cancelled ? "ACCEPTED_COPY_CANCELLED" : null,
      destinationLabel: plan.destinationLabel,
      transferMode,
      totalMedia: plan.totalMedia,
      totalFiles: total,
      copiedCount: copiedMedia,
      copiedMedia,
      movedCount: moving ? copiedMedia : 0,
      movedMedia: moving ? copiedMedia : 0,
      bytesCopied,
      skippedCount: skippedCollisions,
      skippedCollisions,
      collisionSamples,
      collisions: collisionSamples,
      omittedCollisionCount: Math.max(
        0,
        skippedCollisions - collisionSamples.length
      ),
      failedCount: failureCount,
      missingCount,
      failureSamples: failures,
      failures,
      omittedFailureCount: Math.max(
        0,
        failureCount + missingCount - failures.length
      ),
    };
    reportProgress(plan, "complete", {
      processed,
      total,
      copiedMedia,
      skippedCollisions,
      failedCount: failureCount,
      bytesCopied,
      totalBytes: plan.totalBytes,
    }, true);
    return result;
  }

  async function runStart(plan) {
    try {
      assertPlanActive(plan, "start:captured");
      await assertDestinationStillOwned(plan);
      return await copyPreparedPlan(plan);
    } catch (error) {
      const cancelled = plan.controller.signal.aborted;
      logger?.error?.("[copy-accepted] Failed to start", {
        code: safeErrorCode(error),
      });
      return {
        ...prepareFailureResult(error, plan.context, plan.id),
        cancelled,
        destinationLabel: plan.destinationLabel,
        transferMode: plan.transferMode === "move" ? "move" : "copy",
        totalMedia: plan.totalMedia || 0,
        totalFiles:
          (plan.jobs?.length || 0) +
          (plan.preflightFailureCount || 0) +
          (plan.missingCount || 0),
        copiedCount: 0,
        copiedMedia: 0,
        bytesCopied: 0,
        skippedCount: plan.collisionCount || 0,
        skippedCollisions: plan.collisionCount || 0,
        collisionSamples: [...(plan.collisions || [])],
        collisions: [...(plan.collisions || [])],
        missingCount: plan.missingCount || 0,
        failedCount: plan.preflightFailureCount || 0,
        failureSamples: [...(plan.preflightFailures || [])],
        failures: [...(plan.preflightFailures || [])],
        omittedFailureCount: Math.max(
          0,
          (plan.preflightFailureCount || 0) +
            (plan.missingCount || 0) -
            (plan.preflightFailures?.length || 0)
        ),
      };
    } finally {
      disposePlan(plan);
    }
  }

  function start(request = {}) {
    cleanupExpiredPlans();
    if (closed) {
      return unavailableResult(
        ACCEPTED_COPY_CODES.CLOSED,
        "Copy Accepted is closed"
      );
    }
    if (!admissionOpen) {
      return unavailableResult(
        ACCEPTED_COPY_CODES.PAUSED,
        "Copy Accepted is paused"
      );
    }
    if (request?.collisionPolicy !== "skip") {
      return unavailableResult(
        ACCEPTED_COPY_CODES.COLLISION_POLICY,
        "Copy Accepted currently supports only skipping collisions"
      );
    }
    const transferMode = request?.transferMode ?? "copy";
    if (!['copy', 'move'].includes(transferMode)) {
      return unavailableResult(
        ACCEPTED_COPY_CODES.PLAN_INVALID,
        "Accepted clip transfer mode must be copy or move"
      );
    }
    let planId;
    try {
      planId = normalizePlanId(request?.planId);
    } catch (error) {
      return Promise.resolve(prepareFailureResult(error));
    }
    const plan = plans.get(planId);
    if (!plan || plan.owner !== request?.owner || plan.state !== "prepared") {
      return unavailableResult(
        ACCEPTED_COPY_CODES.PLAN_NOT_FOUND,
        "The Copy Accepted plan is unavailable or expired"
      );
    }
    if (plan.expiresAt <= now()) {
      expirePreparedPlan(plan);
      return unavailableResult(
        ACCEPTED_COPY_CODES.PLAN_EXPIRED,
        "The Copy Accepted plan expired. Choose a destination again."
      );
    }
    if (activeCopy) {
      return unavailableResult(
        ACCEPTED_COPY_CODES.BUSY,
        "Another Copy Accepted operation is running"
      );
    }

    if (plan.expiryTimer) clearTimeout(plan.expiryTimer);
    plan.expiryTimer = null;
    plan.state = "running";
    plan.transferMode = transferMode;
    const operation = trackOperation(runStart(plan));
    activeCopy = operation;
    operation.then(
      () => {
        if (activeCopy === operation) activeCopy = null;
      },
      () => {
        if (activeCopy === operation) activeCopy = null;
      }
    );
    return operation;
  }

  function cancel(request = {}) {
    let planId;
    try {
      planId = normalizePlanId(request?.planId);
    } catch (error) {
      return { success: false, cancelled: false, code: error.code };
    }
    const plan = plans.get(planId);
    if (!plan || plan.owner !== request?.owner) {
      return {
        success: false,
        cancelled: false,
        code: ACCEPTED_COPY_CODES.PLAN_NOT_FOUND,
      };
    }
    abortPlan(plan);
    if (plan.state === "prepared") disposePlan(plan);
    return {
      success: true,
      cancelled: true,
      pending: plan.state === "preparing" || plan.state === "running",
      planId,
    };
  }

  function cancelOwner(owner) {
    let cancelled = 0;
    for (const plan of [...plans.values()]) {
      if (plan.owner !== owner) continue;
      if (abortPlan(plan)) cancelled += 1;
      if (plan.state === "prepared") disposePlan(plan);
    }
    return cancelled;
  }

  function cancelAll() {
    let cancelled = 0;
    for (const plan of [...plans.values()]) {
      if (abortPlan(plan)) cancelled += 1;
      if (plan.state === "prepared") disposePlan(plan);
    }
    return cancelled;
  }

  async function drain() {
    while (trackedOperations.size > 0) {
      await Promise.allSettled([...trackedOperations]);
    }
    return {
      drained: true,
      active: Boolean(activePreparation || activeCopy),
      plans: plans.size,
      closed,
    };
  }

  async function pauseAndDrain() {
    admissionOpen = false;
    cancelAll();
    return drain();
  }

  function resume() {
    if (closed) return false;
    admissionOpen = true;
    return true;
  }

  async function closeAndDrain() {
    closed = true;
    admissionOpen = false;
    cancelAll();
    return drain();
  }

  function state() {
    cleanupExpiredPlans();
    let prepared = 0;
    let preparing = 0;
    let running = 0;
    for (const plan of plans.values()) {
      if (plan.state === "prepared") prepared += 1;
      else if (plan.state === "preparing") preparing += 1;
      else if (plan.state === "running") running += 1;
    }
    return Object.freeze({
      admissionOpen,
      closed,
      plans: plans.size,
      prepared,
      preparing,
      running,
      active: Boolean(activePreparation || activeCopy),
      concurrency,
      maxPlans,
    });
  }

  return Object.freeze({
    prepare,
    start,
    cancel,
    cancelOwner,
    pauseAndDrain,
    resume,
    closeAndDrain,
    state,
  });
}

module.exports = {
  ACCEPTED_COPY_CODES,
  ACCEPTED_COPY_CONCURRENCY,
  ACCEPTED_COPY_MAX_PLANS,
  ACCEPTED_COPY_MAX_SAMPLES,
  ACCEPTED_COPY_PLAN_TTL_MS,
  AcceptedCopyError,
  createReviewCopyAcceptedCoordinator,
  destinationForRelative,
  isPathInside,
  mapBounded,
  normalizeTransferLayout,
};
