import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createNativeOwnerLifecycle } = require("../native-owner-lifecycle");

describe("NativeOwnerLifecycle", () => {
  it("invalidates pre-crash epochs and allows only newly captured reload work", () => {
    const lifecycle = createNativeOwnerLifecycle();
    const webContents = { id: 42 };
    const beforeCrash = lifecycle.capture(webContents);
    expect(lifecycle.assertActive(beforeCrash)).toBe(true);

    lifecycle.invalidate(webContents);
    expect(lifecycle.getSnapshot(webContents)).toEqual({
      epoch: 2,
      active: false,
      disposed: false,
    });
    expect(() => lifecycle.assertActive(beforeCrash)).toThrowError(
      expect.objectContaining({ code: "NATIVE_OWNER_INVALIDATED" })
    );
    expect(() => lifecycle.capture(webContents)).toThrowError(
      expect.objectContaining({ code: "NATIVE_OWNER_INVALIDATED" })
    );

    expect(lifecycle.activate(webContents)).toBe(true);
    const afterReload = lifecycle.capture(webContents);
    expect(afterReload.epoch).toBe(2);
    expect(lifecycle.assertActive(afterReload)).toBe(true);
    expect(() => lifecycle.assertActive(beforeCrash)).toThrowError(
      expect.objectContaining({ code: "NATIVE_OWNER_INVALIDATED" })
    );

    lifecycle.dispose(webContents);
    expect(lifecycle.activate(webContents)).toBe(false);
    expect(() => lifecycle.assertActive(afterReload)).toThrowError(
      expect.objectContaining({ code: "NATIVE_OWNER_INVALIDATED" })
    );
  });

  it("wires crash invalidation and did-finish-load reactivation in main", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    expect(source).toContain(
      "const createdWebContents = createdWindow.webContents"
    );
    const crashStart = source.indexOf(
      'createdWebContents.on("render-process-gone"'
    );
    const crashEnd = source.indexOf(
      'createdWebContents.on("unresponsive"',
      crashStart
    );
    const crashHandler = source.slice(crashStart, crashEnd);
    expect(crashStart).toBeGreaterThan(-1);
    expect(crashHandler).toContain(
      "invalidateNativeWorkOwner(createdWebContents)"
    );

    const loadStart = source.indexOf(
      'createdWebContents.on("did-finish-load"'
    );
    const loadEnd = source.indexOf(
      'createdWebContents.on("dom-ready"',
      loadStart
    );
    const loadHandler = source.slice(loadStart, loadEnd);
    expect(loadStart).toBeGreaterThan(-1);
    expect(loadHandler).toContain(
      "activateNativeWorkOwner(createdWebContents)"
    );
  });

  it("does not dereference a destroyed BrowserWindow during owner cleanup", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    const closedStart = source.indexOf('createdWindow.once("closed"');
    const closedEnd = source.indexOf("if (isDev)", closedStart);
    const closedHandler = source.slice(closedStart, closedEnd);

    expect(closedStart).toBeGreaterThan(-1);
    expect(closedHandler).toContain(
      "disposeNativeWorkOwner(createdWebContents)"
    );
    expect(closedHandler).not.toContain("createdWindow.webContents");
  });

  it("binds trash prompts and retry grants to the live canonical owner", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    const confirmStart = source.indexOf(
      'ipcMain.handle("confirm-move-to-trash"'
    );
    const bulkStart = source.indexOf('ipcMain.handle("bulk-move-to-trash"');
    const recentStart = source.indexOf("// Recent folders IPC", bulkStart);
    const confirmHandler = source.slice(confirmStart, bulkStart);
    const bulkHandler = source.slice(bulkStart, recentStart);

    expect(confirmStart).toBeGreaterThan(-1);
    expect(confirmHandler).toContain(
      "const sampleName = path.basename(canonicalPaths[0])"
    );
    expect(confirmHandler).not.toContain("payload?.sampleName");
    expect(bulkHandler).toContain("!requester.isDestroyed?.()");
    expect(bulkHandler).toContain("mainWindow.webContents === requester");
    expect(bulkHandler).toContain(
      "assertProfileGenerationContextActive(context)"
    );
  });

  it("invalidates profile work and awaits its queue before native shutdown", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    const shutdownStart = source.indexOf("async function performNativeShutdown");
    const quitStart = source.indexOf('app.on("before-quit"');
    const shutdownHandler = source.slice(shutdownStart, quitStart);
    expect(shutdownStart).toBeGreaterThan(-1);
    expect(quitStart).toBeGreaterThan(-1);
    expect(shutdownHandler).toContain("nativeShutdownRequested = true");
    expect(shutdownHandler).toContain("metadataProfileGeneration += 1");
    expect(shutdownHandler).toContain(
      "const pendingProfileReconfiguration = profileReconfigureQueue"
    );
    expect(shutdownHandler).toContain(
      "await pendingProfileReconfiguration.catch(() => {})"
    );
    expect(shutdownHandler.indexOf("await pendingProfileReconfiguration")).toBeLessThan(
      shutdownHandler.indexOf("() => thumbnailCache.shutdown()")
    );

    const profileStart = source.indexOf("function reconfigureForProfile");
    const profileEnd = source.indexOf("async function createWindow", profileStart);
    const profileFunction = source.slice(profileStart, profileEnd);
    expect(profileFunction).toContain(
      "if (nativeShutdownPreparing || nativeShutdownRequested)"
    );
    expect(profileFunction).toContain("ApplicationShutdownRequestedError");
  });

  it("single-flights startup, activation, and second-instance window creation", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    const createStart = source.indexOf("async function createWindow");
    const ensureStart = source.indexOf("function ensureMainWindow", createStart);
    const profilePromptStart = source.indexOf(
      "async function promptForProfileName",
      ensureStart
    );
    const createAndEnsure = source.slice(createStart, profilePromptStart);
    const lifecycleStart = source.indexOf("// App lifecycle");
    const lifecycle = source.slice(lifecycleStart);

    expect(createAndEnsure).toContain("const settings = await loadSettings()");
    expect(createAndEnsure).toMatch(
      /await loadSettings\(\)[\s\S]*nativeShutdownPreparing[\s\S]*new BrowserWindow/
    );
    expect(createAndEnsure).toContain("if (windowCreationPromise)");
    expect(createAndEnsure).toContain("applicationInitializationPromise.then");
    expect(source.slice(0, createStart)).toContain(
      'app.on("second-instance"'
    );
    expect(source.slice(0, createStart)).toContain("ensureMainWindow()");
    expect(lifecycle).toContain("applicationInitializationComplete = true");
    expect(lifecycle).toContain("await ensureMainWindow()");
    expect(lifecycle).toContain('app.on("activate"');
    expect(lifecycle).toContain("void ensureMainWindow().catch");
    expect(lifecycle).toContain("app.exit(1)");
  });

  it("restores profile/UI state after an active-profile deletion failure", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    const deleteStart = source.indexOf(
      "async function deleteProfileWithTransition"
    );
    const deleteEnd = source.indexOf("// ===== Window/Menu =====", deleteStart);
    const deleteFlow = source.slice(deleteStart, deleteEnd);
    const startupCatch = source.slice(
      source.indexOf("void applicationInitializationPromise.catch"),
      source.indexOf('app.on("activate"')
    );

    expect(deleteFlow).toContain("switchedFromDeletedProfile");
    expect(deleteFlow).toContain(
      "await performProfileReconfiguration(requestedProfileId, false)"
    );
    expect(deleteFlow).toContain("broadcastProfileChange(currentSettings)");
    expect(startupCatch).toContain("nativeShutdownPreparing");
    expect(startupCatch).toContain(
      'error?.code === "APPLICATION_SHUTDOWN_REQUESTED"'
    );
    expect(startupCatch.indexOf("APPLICATION_SHUTDOWN_REQUESTED")).toBeLessThan(
      startupCatch.indexOf("dialog.showErrorBox")
    );
  });
});
