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

describe("sequence file actions in the main process", () => {
  it("authorizes every renumbered file like other native file actions", () => {
    const prepare = section(
      'ipcMain.handle("sequences:renumber:prepare"',
      'ipcMain.handle("sequences:renumber:apply"'
    );
    // Paths come from the catalog, never from the renderer, and each one is
    // still checked against the roots this window was granted.
    expect(prepare).toContain("authorizeSequenceFiles(");
    expect(prepare).toContain("ownerId: event.sender.id");
    expect(prepare).not.toContain("payload.paths");
    expect(prepare).not.toContain("payload.entries");

    const authorize = section(
      "async function authorizeSequenceFiles",
      'ipcMain.handle("sequences:render:availability"'
    );
    expect(authorize).toContain("getSequenceSnapshot(sequenceId");
    expect(authorize).toContain('assertRendererPath(event, instance.absolutePath, "file")');
    expect(authorize).toContain("absolutePath: authorized.path");
    expect(authorize).toContain("assertEntriesResolvable(");
  });

  it("exports one video only from authorized files into a natively chosen folder", () => {
    const prepare = section(
      'ipcMain.handle("sequences:render:prepare"',
      'ipcMain.handle("sequences:render:start"'
    );
    expect(prepare).toContain('action: "export"');
    expect(prepare).toContain("authorizeSequenceFiles(");
    expect(prepare).toContain("dialog.showOpenDialog(win");
    expect(prepare).toContain("sequenceRenderer.prepare(");
    expect(prepare).not.toContain("payload.destination");
    const lifecycle = section(
      "function invalidateNativeWorkOwner",
      "function assertProfileReconfigurationActive"
    );
    expect(lifecycle.match(/sequenceRenderer\.cancelOwner\(ownerId\)/g)).toHaveLength(2);
  });

  it("applies only a confirmed plan and records the new names in the catalog", () => {
    const apply = section(
      'ipcMain.handle("sequences:renumber:apply"',
      "async function authorizeSequenceFiles"
    );
    expect(apply).toContain("sequenceRenumberCoordinator.apply");
    expect(apply).toContain("assertMetadataContextActive(planContext)");
    expect(apply).toContain(
      "recordRenumberInCatalog(context.metadataStore, result.renamed"
    );
  });

  it("drops a renderer's pending renumber when the renderer goes away", () => {
    const ownerLifecycle = section(
      "function invalidateNativeWorkOwner",
      "function assertProfileReconfigurationActive"
    );
    expect(
      ownerLifecycle.match(/sequenceRenumberCoordinator\.discardOwner\(ownerId\)/g)
    ).toHaveLength(2);
  });

  it("exports a numbered copy through the transfer coordinator, rows resolved in main", () => {
    const coordinator = section(
      "const reviewCopyAcceptedCoordinator =",
      'ipcMain.handle("library:list-roots"'
    );
    expect(coordinator).toContain("resolveSequenceCopyRecords(context, sequenceId");
    const prepare = section(
      'ipcMain.handle("review:copy-accepted:prepare"',
      'ipcMain.handle("review:transfer-destinations"'
    );
    expect(prepare).toContain('assertInteger(payload.sequenceId, { name: "sequence id", min: 1 })');
    expect(prepare).toContain("sequenceId,");
  });
});
