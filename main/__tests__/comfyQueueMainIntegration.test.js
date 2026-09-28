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

describe("re-render queue main-process integration", () => {
  it("changes the connection only through its validated IPC", () => {
    const set = section('ipcMain.handle("comfy:connection:set"', 'ipcMain.handle("comfy:connection:test"');
    expect(set).toContain("await validateComfyConnection(");
    expect(set).toContain("saveSettingsPartial({ comfyConnection: value }");
    expect(set).toContain("comfyRunner?.reconfigure()");
    const generic = section('ipcMain.handle("save-settings"', 'ipcMain.handle("playback:get-capabilities"');
    expect(generic).toContain("...withoutComfyConnection(settings)");
    expect(generic).toContain("saveSettingsPartial(withoutComfyConnection(partialSettings)");
    expect(source).toContain("comfyConnection: normalizeComfyConnection(source.comfyConnection)");
  });

  it("tests the connection read-only", () => {
    const test = section('ipcMain.handle("comfy:connection:test"', "const comfyQueueStore");
    expect(test).toContain("parseComfyUrl(");
    expect(test).toContain(".test()");
    expect(test).not.toMatch(/submitPrompt|deleteQueued|free\(/u);
  });

  it("authorizes every clip path before reading or queueing it", () => {
    const learn = section('ipcMain.handle("comfy:recipes:learn"', 'ipcMain.handle("comfy:queue:add"');
    expect(learn.match(/assertRendererPath\(event, example\.(finalPath|draftPath), "file"\)/gu)).toHaveLength(2);
    const add = section('ipcMain.handle("comfy:queue:add"', 'ipcMain.handle("comfy:queue:list"');
    expect(add).toContain('assertRendererPath(event, clip.fullPath, "file")');
    expect(add).toContain("COMFY_MAX_QUEUE_ADD");
    expect(add).not.toMatch(/payload\.(prompt|graph|url)/u);
  });

  it("gives each profile its own runner, disposed before the profile changes and at shutdown", () => {
    const runtime = section("async function initializeProfileRuntime", "async function performProfileReconfiguration");
    expect(runtime).toContain("startComfyRunnerForProfile(settings)");
    const profile = section("async function performProfileReconfiguration", "function reconfigureForProfile");
    expect(profile.indexOf("await disposeComfyRunner()")).toBeGreaterThan(-1);
    expect(profile.indexOf("await disposeComfyRunner()")).toBeLessThan(profile.indexOf("++metadataProfileGeneration"));
    const shutdown = section("async function performNativeShutdown", "function beginNativeShutdown");
    expect(shutdown).toContain("comfyQueue: () => disposeComfyRunner()");
    expect(shutdown).toContain("comfyTray: () => comfyTray?.destroy()");
  });

  it("stays in the tray while a queue is active, and asks before quitting under a render", () => {
    const closed = section('app.on("window-all-closed"', "applicationInitializationPromise = ");
    expect(closed).toContain("comfyRunner?.isActive()");
    expect(closed.indexOf("showComfyTray()")).toBeLessThan(closed.indexOf("app.quit()"));
    const quit = section('app.on("before-quit"', "beginNativeShutdown().finally");
    expect(quit).toContain("comfyRunner?.hasPromptInComfy()");
    expect(quit).toContain("confirmQuitDuringComfyRender()");
    expect(section("function createWindow", "const createdWindow")).toContain("comfyTray?.destroy()");
  });
});
