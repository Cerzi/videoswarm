import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("review main-process integration", () => {
  it("delegates export to the single-flight bounded coordinator", () => {
    const coordinator = section(
      "const reviewManifestExportCoordinator =",
      'ipcMain.handle("library:list-roots"'
    );
    expect(coordinator).toContain("nativeOwnerLifecycle.capture(owner)");
    expect(coordinator).toContain("getReviewManifestSnapshot(rootPath");
    expect(coordinator).toContain("REVIEW_MANIFEST_MAX_RECORDS");

    const handler = section(
      'ipcMain.handle("review:export-manifest"',
      'ipcMain.handle("library:set-pinned"'
    );
    expect(handler).toContain("reviewManifestExportCoordinator.exportManifest");
    expect(handler).not.toContain("getCachedLibrarySnapshot");
  });

  it("drains exports across profile and shutdown ownership boundaries", () => {
    const profile = section(
      "async function runSerializedProfileOperation",
      "async function deleteProfileWithTransition"
    );
    expect(profile).toContain("reviewManifestExportCoordinator.pauseAndDrain()");
    expect(profile).toContain("reviewManifestExportCoordinator.resume()");

    const shutdown = section(
      "async function performNativeShutdown",
      "function beginNativeShutdown"
    );
    expect(shutdown).toContain("reviewManifestExportCoordinator.closeAndDrain()");
    expect(shutdown).toContain("manifestShutdownDrain");
  });

  it("routes bounded atomic undo and immediately reconciles trashed paths", () => {
    const restore = section(
      'ipcMain.handle("metadata:restore-review"',
      'ipcMain.handle("metadata:get-generation"'
    );
    expect(restore).toContain("normalizeReviewRestoreSnapshots(snapshots)");
    expect(restore).toContain("store.restoreReviewMetadata(normalizedSnapshots");
    expect(restore).toContain("assertMetadataContextActive(context)");

    const trash = section(
      'ipcMain.handle("bulk-move-to-trash"',
      "// Recent folders IPC"
    );
    expect(trash).toContain("const context = captureMetadataContext()");
    expect(trash).toContain("canonicalMovedPaths");
    expect(trash).toContain("mapTrashWorkBounded(");
    expect(trash).toContain("DEFAULT_TRASH_PREFLIGHT_CONCURRENCY");
    expect(trash).toContain("canonicalTrashPaths");
    expect(trash).toContain("context.metadataStore.markFilesMissing(");
    expect(trash.indexOf("markFilesMissing(")).toBeLessThan(
      trash.indexOf("const retryPaths")
    );
  });
});
