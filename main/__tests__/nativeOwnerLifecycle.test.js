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
    const crashStart = source.indexOf(
      'mainWindow.webContents.on("render-process-gone"'
    );
    const crashEnd = source.indexOf(
      'mainWindow.webContents.on("unresponsive"',
      crashStart
    );
    const crashHandler = source.slice(crashStart, crashEnd);
    expect(crashStart).toBeGreaterThan(-1);
    expect(crashHandler).toContain(
      "invalidateNativeWorkOwner(createdWindow.webContents)"
    );

    const loadStart = source.indexOf(
      'mainWindow.webContents.on("did-finish-load"'
    );
    const loadEnd = source.indexOf(
      'mainWindow.webContents.on("dom-ready"',
      loadStart
    );
    const loadHandler = source.slice(loadStart, loadEnd);
    expect(loadStart).toBeGreaterThan(-1);
    expect(loadHandler).toContain(
      "activateNativeWorkOwner(createdWindow.webContents)"
    );
  });

  it("invalidates profile work and awaits its queue before native shutdown", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "main.js"), "utf8");
    const quitStart = source.indexOf('app.on("before-quit"');
    const quitHandler = source.slice(quitStart);
    expect(quitStart).toBeGreaterThan(-1);
    expect(quitHandler).toContain("nativeShutdownRequested = true");
    expect(quitHandler).toContain("metadataProfileGeneration += 1");
    expect(quitHandler).toContain(
      "const pendingProfileReconfiguration = profileReconfigureQueue"
    );
    expect(quitHandler).toContain(
      "await pendingProfileReconfiguration.catch(() => {})"
    );
    expect(quitHandler.indexOf("await pendingProfileReconfiguration")).toBeLessThan(
      quitHandler.indexOf("() => thumbnailCache.shutdown()")
    );

    const profileStart = source.indexOf("function reconfigureForProfile");
    const profileEnd = source.indexOf("async function createWindow", profileStart);
    const profileFunction = source.slice(profileStart, profileEnd);
    expect(profileFunction).toContain("if (nativeShutdownRequested)");
    expect(profileFunction).toContain("ApplicationShutdownRequestedError");
  });
});
