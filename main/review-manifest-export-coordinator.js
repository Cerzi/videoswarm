"use strict";

const {
  REVIEW_MANIFEST_MAX_RECORDS,
  ReviewManifestError,
  assertPersistedCoverage,
  createReviewManifest,
  normalizeManifestDirectory,
  normalizeManifestScope,
  reviewManifestDefaultName,
  writeReviewManifest,
} = require("./review-manifest");

const EXPORT_CODES = Object.freeze({
  BUSY: "REVIEW_MANIFEST_EXPORT_BUSY",
  PAUSED: "REVIEW_MANIFEST_EXPORT_PAUSED",
  CLOSED: "REVIEW_MANIFEST_EXPORT_CLOSED",
  ROOT_MISSING: "REVIEW_MANIFEST_ROOT_MISSING",
  INVALID_ROOT: "REVIEW_MANIFEST_EXPORT_INVALID_ROOT",
  INVALID_QUERY_RESULT: "REVIEW_MANIFEST_EXPORT_INVALID_QUERY_RESULT",
});

class ReviewManifestExportError extends Error {
  constructor(message, code = "REVIEW_MANIFEST_EXPORT_ERROR") {
    super(message);
    this.name = "ReviewManifestExportError";
    this.code = code;
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`createReviewManifestExportCoordinator requires ${name}()`);
  }
  return value;
}

function unavailableResult(code, error) {
  return Promise.resolve({
    success: false,
    cancelled: false,
    profileId: null,
    generation: null,
    code,
    error,
  });
}

function failureResult(error, context) {
  return {
    success: false,
    cancelled: false,
    profileId: context?.profileId || null,
    generation: context?.generation ?? null,
    code: error?.code || "REVIEW_MANIFEST_EXPORT_ERROR",
    error: error?.message || String(error),
  };
}

function resolveAuthorizedRootPath(result) {
  const rootPath =
    typeof result === "string"
      ? result
      : typeof result?.path === "string"
        ? result.path
        : typeof result?.rootPath === "string"
          ? result.rootPath
          : "";
  if (!rootPath || rootPath.includes("\0")) {
    throw new ReviewManifestExportError(
      "Filesystem authorization did not return a valid library root",
      EXPORT_CODES.INVALID_ROOT
    );
  }
  return rootPath;
}

function profileFromContext(context) {
  if (context?.profile && typeof context.profile === "object") {
    return context.profile;
  }
  return {
    id: context?.profileId,
    name: context?.profileName || context?.profileId,
  };
}

function assertRootCoverage(root, directory, scope) {
  if (!root || typeof root !== "object") {
    throw new ReviewManifestExportError(
      "The selected library root has not been indexed",
      EXPORT_CODES.ROOT_MISSING
    );
  }
  assertPersistedCoverage(root, directory, scope);
}

function normalizeRecordsResult(result) {
  const records = Array.isArray(result) ? result : result?.records;
  if (!Array.isArray(records)) {
    throw new ReviewManifestExportError(
      "The review manifest query returned an invalid result",
      EXPORT_CODES.INVALID_QUERY_RESULT
    );
  }
  if (result?.truncated || records.length > REVIEW_MANIFEST_MAX_RECORDS) {
    throw new ReviewManifestError(
      `Review manifests are limited to ${REVIEW_MANIFEST_MAX_RECORDS.toLocaleString()} files`,
      "REVIEW_MANIFEST_TOO_MANY_RECORDS"
    );
  }
  return records;
}

/**
 * Coordinates the complete native review-manifest export boundary without
 * importing Electron. The caller supplies renderer/profile authorization,
 * dialog, and bounded database-query adapters.
 *
 * The injected writer must invoke options.assertActive (also supplied as
 * options.writeOptions.assertActive for writeReviewManifest-compatible
 * adapters) immediately before its atomic publication/rename boundary.
 */
function createReviewManifestExportCoordinator(options = {}) {
  const captureContext = requireFunction(options.captureContext, "captureContext");
  const assertActive = requireFunction(options.assertActive, "assertActive");
  const authorizeRoot = requireFunction(options.authorizeRoot, "authorizeRoot");
  const getRoot = requireFunction(options.getRoot, "getRoot");
  const showSaveDialog = requireFunction(options.showSaveDialog, "showSaveDialog");
  const queryScopeRecords = requireFunction(
    options.queryScopeRecords,
    "queryScopeRecords"
  );
  const buildManifest = options.createManifest || createReviewManifest;
  const writeManifest = options.writeManifest || writeReviewManifest;
  const validateCoverage = options.validateCoverage || assertRootCoverage;
  const resolveProfile = options.resolveProfile || profileFromContext;
  const defaultNameForRoot = options.defaultNameForRoot || reviewManifestDefaultName;
  const logger = options.logger || null;

  requireFunction(buildManifest, "createManifest");
  requireFunction(writeManifest, "writeManifest");
  requireFunction(validateCoverage, "validateCoverage");
  requireFunction(resolveProfile, "resolveProfile");
  requireFunction(defaultNameForRoot, "defaultNameForRoot");

  let admissionOpen = true;
  let closed = false;
  let activeOperation = null;

  async function runExport(request) {
    let context = null;
    try {
      const owner = request?.owner;
      const requestedRootPath = request?.rootPath;
      if (
        typeof requestedRootPath !== "string" ||
        !requestedRootPath ||
        requestedRootPath.includes("\0")
      ) {
        throw new ReviewManifestExportError(
          "A valid library root is required",
          EXPORT_CODES.INVALID_ROOT
        );
      }
      const directory = normalizeManifestDirectory(request?.directory ?? "");
      const scope = normalizeManifestScope(request?.scope);

      context = captureContext({ owner, request });
      const assertOperationActive = (phase) =>
        assertActive({ owner, context, request, phase });
      assertOperationActive("captured");

      const authorized = await authorizeRoot({
        owner,
        context,
        rootPath: requestedRootPath,
        request,
      });
      assertOperationActive("authorized");
      const rootPath = resolveAuthorizedRootPath(authorized);
      const root = await getRoot({ owner, context, rootPath, request });
      assertOperationActive("root-loaded");
      validateCoverage(root, directory, scope);
      const profile = resolveProfile(context);

      const dialogResult = await showSaveDialog({
        owner,
        context,
        profile,
        root,
        rootPath,
        directory,
        scope,
        defaultName: defaultNameForRoot(root),
      });

      // A native dialog yields the event loop. Revalidate every owner boundary
      // before accepting its result, including the cancellation path.
      assertOperationActive("dialog-closed");
      if (dialogResult?.canceled || dialogResult?.cancelled || !dialogResult?.filePath) {
        return {
          success: true,
          cancelled: true,
          profileId: context.profileId,
          generation: context.generation,
        };
      }

      const queryResult = await queryScopeRecords({
        owner,
        context,
        root,
        rootPath,
        directory,
        scope,
        // One extra row lets the adapter signal overflow without ever
        // materializing an unbounded profile snapshot.
        limit: REVIEW_MANIFEST_MAX_RECORDS + 1,
        assertActive: () => assertOperationActive("query"),
      });
      assertOperationActive("query-complete");
      // The save dialog can remain open while a watcher refresh starts or the
      // indexed coverage changes. The bounded query returns its transaction's
      // root row so publication is based on that live snapshot, not pre-dialog
      // catalog state.
      const liveRoot = queryResult?.root;
      validateCoverage(liveRoot, directory, scope);
      const records = normalizeRecordsResult(queryResult);
      const manifest = buildManifest({
        profile,
        root: liveRoot,
        directory,
        scope,
        records,
      });

      const assertPublicationActive = () =>
        assertOperationActive("before-publication");
      assertPublicationActive();
      const written = await writeManifest(dialogResult.filePath, manifest, {
        assertActive: assertPublicationActive,
        writeOptions: { assertActive: assertPublicationActive },
      });

      return {
        success: true,
        cancelled: false,
        profileId: context.profileId,
        generation: context.generation,
        fileCount: manifest?.summary?.instanceCount ?? records.length,
        bytes: Number(written?.bytes) || 0,
      };
    } catch (error) {
      logger?.error?.("Failed to export review manifest", error);
      return failureResult(error, context);
    }
  }

  function exportManifest(request = {}) {
    if (closed) {
      return unavailableResult(
        EXPORT_CODES.CLOSED,
        "Review manifest export is closed"
      );
    }
    if (!admissionOpen) {
      return unavailableResult(
        EXPORT_CODES.PAUSED,
        "Review manifest export is paused"
      );
    }
    if (activeOperation) {
      return unavailableResult(
        EXPORT_CODES.BUSY,
        "Another review manifest export is already active"
      );
    }

    const operation = runExport(request);
    activeOperation = operation;
    operation.then(
      () => {
        if (activeOperation === operation) activeOperation = null;
      },
      () => {
        if (activeOperation === operation) activeOperation = null;
      }
    );
    return operation;
  }

  function pause() {
    admissionOpen = false;
    return { paused: true, active: Boolean(activeOperation), closed };
  }

  function resume() {
    if (closed) return false;
    admissionOpen = true;
    return true;
  }

  async function drain() {
    const operation = activeOperation;
    if (operation) await Promise.allSettled([operation]);
    return { drained: true, active: Boolean(activeOperation), closed };
  }

  async function pauseAndDrain() {
    pause();
    return drain();
  }

  async function closeAndDrain() {
    closed = true;
    admissionOpen = false;
    return drain();
  }

  function state() {
    return Object.freeze({
      admissionOpen,
      active: Boolean(activeOperation),
      closed,
    });
  }

  return Object.freeze({
    exportManifest,
    pause,
    resume,
    pauseAndDrain,
    closeAndDrain,
    state,
  });
}

module.exports = {
  EXPORT_CODES,
  ReviewManifestExportError,
  createReviewManifestExportCoordinator,
};
