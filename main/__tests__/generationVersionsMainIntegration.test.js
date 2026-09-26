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

describe("generation versions main-process integration", () => {
  it("accepts catalog ids or the library scope, never a path", () => {
    const handler = section(
      'ipcMain.handle("generation-versions:index"',
      'ipcMain.handle("generation-versions:cancel"'
    );
    expect(handler).toContain("assertInstanceIdArray(payload?.instanceIds");
    expect(handler).toContain("maxEntries: GENERATION_VERSION_INDEX_MAX_INSTANCES");
    expect(handler).toContain("generationKeyIndexer.start(sender.id");
    expect(handler).toContain("assertActive: () => assertMetadataContextActive(context)");
    expect(handler).toContain("registerNativeWorkOwner(sender)");
    expect(handler).not.toContain("payload.path");
    expect(handler).not.toContain("payload.filePath");
  });

  it("bounds summary and sibling requests", () => {
    const handlers = section(
      'ipcMain.handle("generation-versions:summaries"',
      'ipcMain.handle("metadata:get"'
    );
    expect(handlers).toContain("maxEntries: GENERATION_VERSION_SUMMARY_MAX_KEYS");
    expect(handlers).toContain(".filter(isGenerationKey)");
    expect(handlers).toContain("assertInteger(payload?.instanceId");
  });

  it("cancels a renderer's job on crash and destruction", () => {
    const lifecycle = section(
      "function invalidateNativeWorkOwner",
      "function assertProfileReconfigurationActive"
    );
    expect(lifecycle.match(/generationKeyIndexer\.cancelOwner\(ownerId\)/gu)).toHaveLength(2);
  });

  it("drains before the profile generation advances and shuts down on exit", () => {
    const profile = section(
      "async function performProfileReconfiguration",
      "function reconfigureForProfile"
    );
    expect(profile).toContain("await generationKeyIndexer.cancelAllAndDrain()");
    expect(profile.indexOf("generationKeyIndexer.cancelAllAndDrain")).toBeLessThan(
      profile.indexOf("++metadataProfileGeneration")
    );
    const shutdown = section(
      "async function performNativeShutdown",
      "function beginNativeShutdown"
    );
    expect(shutdown).toContain("generationKeys: () => generationKeyDrain");
    expect(shutdown).toContain("generationKeys: () => generationKeyIndexer.shutdown()");
  });
});
