import fs from "fs";
import path from "path";
import vm from "vm";
import { describe, expect, it, vi } from "vitest";

function loadPreload() {
  const exposed = {};
  const ipcRenderer = {
    invoke: vi.fn(async (channel) => ({ channel })),
    send: vi.fn(),
    sendSync: vi.fn(() => {
      throw new Error("sendSync must not be used");
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const contextBridge = {
    exposeInMainWorld: vi.fn((name, value) => {
      exposed[name] = value;
    }),
  };
  const preloadPath = path.resolve(process.cwd(), "preload.js");
  const source = fs.readFileSync(preloadPath, "utf8");
  vm.runInNewContext(source, {
    Buffer,
    console,
    process,
    require(moduleId) {
      if (moduleId === "electron") return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
  });
  return { api: exposed.electronAPI, contextBridge, ipcRenderer };
}

describe("preload native-work bridge", () => {
  it("uses asynchronous thumbnail invokes", async () => {
    const { api, ipcRenderer } = loadPreload();
    const payload = { path: "/clip.mp4", signature: "sig" };

    await expect(api.thumbs.get(payload)).resolves.toEqual({
      channel: "thumb:get",
    });
    await expect(api.thumbs.put({ ...payload, base64: "abc=" })).resolves.toEqual({
      channel: "thumb:put",
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith("thumb:get", payload);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "thumb:put",
      { ...payload, base64: "abc=" }
    );
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled();
  });

  it("starts native drag through fire-and-forget IPC, including the legacy alias", () => {
    const { api, ipcRenderer } = loadPreload();

    expect(api.startFileDrag(["/one.mp4", "", null])).toEqual({
      ok: true,
      queued: true,
    });
    expect(api.startFileDragSync("/two.mp4")).toEqual({
      ok: true,
      queued: true,
    });
    expect(api.startFileDrag([])).toEqual({ ok: false, error: "NO_FILE" });
    expect(ipcRenderer.send).toHaveBeenNthCalledWith(1, "dnd:start-file", {
      paths: ["/one.mp4"],
    });
    expect(ipcRenderer.send).toHaveBeenNthCalledWith(2, "dnd:start-file", {
      paths: ["/two.mp4"],
    });
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled();
  });

  it("keeps generation-token validation in the main process", async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.metadata.getGeneration(42, "renderer-request-1");
    await api.metadata.getGeneration(43);
    await api.metadata.cancelGeneration("renderer-request-1");

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      "metadata:get-generation",
      { instanceId: 42, requestToken: "renderer-request-1" }
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "metadata:get-generation",
      { instanceId: 43 }
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      "metadata:cancel-generation",
      { requestToken: "renderer-request-1" }
    );
  });
});
