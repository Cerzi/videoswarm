import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
const preload = fs.readFileSync(path.resolve(process.cwd(), "preload.js"), "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ComfyUI main-process integration", () => {
  it("changes the address only through its validated IPC", () => {
    const set = section('ipcMain.handle("comfy:connection:set"', 'ipcMain.handle("comfy:connection:test"');
    expect(set).toContain("validateComfyConnection({ url: payload.url })");
    expect(set).toContain("saveSettingsPartial({ comfyConnection: value }");
    const generic = section('ipcMain.handle("save-settings"', 'ipcMain.handle("playback:get-capabilities"');
    expect(generic).toContain("...withoutComfyConnection(settings)");
    expect(generic).toContain("saveSettingsPartial(withoutComfyConnection(partialSettings)");
    expect(source).toContain("comfyConnection: normalizeComfyConnection(source.comfyConnection)");
  });

  it("tests the connection read-only", () => {
    const test = section('ipcMain.handle("comfy:connection:test"', 'ipcMain.handle("comfy:open-workflow"');
    expect(test).toContain("parseComfyUrl(");
    expect(test).toContain(".test()");
  });

  it("opens a workflow from an authorized catalog row", () => {
    const open = section('ipcMain.handle("comfy:open-workflow"', 'ipcMain.handle("generation-versions:summaries"');
    expect(open).toContain("assertInteger(payload.instanceId");
    expect(open).toContain('await assertRendererPath(event, instance.absolutePath, "file")');
    expect(open).toContain("includeWorkflow: true");
    expect(open).toContain("comfyWorkflowWindow.open(");
    expect(open).not.toMatch(/payload\.path/u);
    const closed = section('createdWindow.once("closed"', "function ");
    expect(closed).toContain("comfyWorkflowWindow.close()");
    const shutdown = section("async function performNativeShutdown", "function beginNativeShutdown");
    expect(shutdown).toContain("comfyWorkflowWindow.close()");
  });

  it("has no re-render queue: nothing is ever sent to ComfyUI", () => {
    for (const text of [source, preload]) {
      expect(text).not.toMatch(/comfy:queue:|comfy:recipes:|comfy-queue:changed|comfy:connection:choose-output-dir/u);
    }
    expect(source).not.toMatch(/comfy-runner|comfy-recipe|comfy-tray|comfy-safety|comfy-queue-store/u);
  });
});
