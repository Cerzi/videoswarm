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
  it("delegates Copy Accepted to the bounded profile-owned coordinator", () => {
    const coordinator = section(
      "const reviewCopyAcceptedCoordinator =",
      'ipcMain.handle("library:list-roots"'
    );
    expect(coordinator).toContain("nativeOwnerLifecycle.capture(owner)");
    expect(coordinator).toContain("getAcceptedExportSnapshot(rootPath");
    expect(coordinator).toContain("ACCEPTED_COPY_MAX_MEDIA");
    expect(coordinator).toContain("ACCEPTED_COPY_MAX_PATH_BYTES");
    expect(coordinator).toContain('properties: ["openDirectory", "createDirectory"]');
    expect(coordinator).toContain('owner.send("review:copy-accepted-progress"');

    const handlers = section(
      'ipcMain.handle("review:copy-accepted:prepare"',
      'ipcMain.handle("review-sessions:list"'
    );
    expect(handlers).toContain("reviewCopyAcceptedCoordinator.prepare");
    expect(handlers).toContain('ipcMain.handle("review:copy-accepted:start"');
    expect(handlers).toContain('ipcMain.handle("review:copy-accepted:cancel"');
    expect(handlers).toContain("normalizeReviewExportScope");
    // The root must be conditional. Normalizing it unconditionally rejected
    // every selection transfer, which the coordinator itself already allowed.
    expect(handlers).toContain("acceptedTransferRequiresRoot(payload)");
    expect(handlers).not.toMatch(
      /const requestedRoot = normalizeLibraryIpcRootPath\(payload\);/
    );
    expect(handlers).not.toContain("payload.records");
    expect(handlers).not.toContain("payload.videos");
  });

  it("cancels and drains accepted copies across every ownership boundary", () => {
    const profile = section(
      "async function runSerializedProfileOperation",
      "async function deleteProfileWithTransition"
    );
    expect(profile).toContain("reviewCopyAcceptedCoordinator.pauseAndDrain()");
    expect(profile).toContain("reviewCopyAcceptedCoordinator.resume()");

    const ownerLifecycle = section(
      "function invalidateNativeWorkOwner",
      "function assertProfileReconfigurationActive"
    );
    expect(ownerLifecycle.match(/reviewCopyAcceptedCoordinator\.cancelOwner\(sender\)/g))
      .toHaveLength(2);

    const shutdown = section(
      "async function performNativeShutdown",
      "function beginNativeShutdown"
    );
    expect(shutdown).toContain("reviewCopyAcceptedCoordinator.closeAndDrain()");
    expect(shutdown).toContain("acceptedCopyShutdownDrain");
  });

  it("does not retain the removed JSON review-manifest feature", () => {
    expect(source.toLowerCase()).not.toContain("review manifest");
    expect(source).not.toContain("review:export-manifest");
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
