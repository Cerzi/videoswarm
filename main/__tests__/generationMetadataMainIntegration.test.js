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

describe("generation metadata main-process integration", () => {
  it("resolves one owned instance and forwards only validated request controls", () => {
    const handler = section(
      'ipcMain.handle("metadata:get-generation"',
      'ipcMain.handle("metadata:cancel-generation"'
    );
    expect(handler).toContain("context.metadataStore.getFileInstanceById(instanceId)");
    expect(handler).toContain(
      'force = assertBoolean(payload.force, "generation metadata force")'
    );
    expect(handler).toContain("generationMetadataService.getMetadata({");
    expect(handler).toContain("rendererId: event.sender.id");
    expect(handler).toContain("metadataStore: context.metadataStore");
    expect(handler).toContain("authorizePath: async (candidatePath)");
    expect(handler).not.toContain("payload.path");
    expect(handler).not.toContain("payload.filePath");
  });

  it("cancels renderer-owned work on crash/destruction", () => {
    const lifecycle = section(
      "function invalidateNativeWorkOwner",
      "function assertProfileReconfigurationActive"
    );
    expect(lifecycle.match(/generationMetadataService\.cancelRenderer\(ownerId\)/gu))
      .toHaveLength(2);
  });

  it("drains profile work before replacing SQLite ownership", () => {
    const profile = section(
      "async function performProfileReconfiguration",
      "function reconfigureForProfile"
    );
    expect(profile).toContain(
      "await generationMetadataService.cancelAllAndDrain("
    );
    expect(profile.indexOf("cancelAllAndDrain(")).toBeLessThan(
      profile.indexOf("initializeProfileRuntime(")
    );
  });

  it("drains and shuts down native probe work before app teardown", () => {
    const shutdown = section(
      "async function performNativeShutdown",
      "function beginNativeShutdown"
    );
    expect(shutdown).toContain(
      "generationMetadataService.cancelAllAndDrain("
    );
    expect(shutdown).toContain(
      "generationMetadata: () => generationMetadataService.shutdown()"
    );
    expect(shutdown.indexOf("generationMetadataDrain")).toBeLessThan(
      shutdown.indexOf("metadataProfileGeneration += 1")
    );
  });
});
