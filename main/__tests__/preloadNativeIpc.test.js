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

  it("forwards atomic review snapshots through one invoke", async () => {
    const { api, ipcRenderer } = loadPreload();
    const snapshots = [
      { fingerprint: "fp-a", reviewState: "reviewed", rating: 4 },
      { fingerprint: "fp-b", reviewState: "unreviewed", rating: null },
    ];

    await api.metadata.restoreReview(snapshots);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "metadata:restore-review",
      snapshots
    );
  });

  it("exposes asynchronous last-known folder hydration", async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.readDirectoryCache("/library", true, "scan-7");

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "read-directory-cache",
      "/library",
      true,
      "scan-7"
    );
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled();

    await api.readDirectoryCache("/large", true, "scan-8", { limit: 128 });
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
      "read-directory-cache",
      "/large",
      true,
      "scan-8",
      { limit: 128 }
    );
  });

  it("authorizes an indexed library root on demand", async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.library.authorizeRoot("/library/root-300");

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "library:authorize-root",
      { rootPath: "/library/root-300" }
    );
  });

  it("exports a review manifest by scope without accepting renderer records", async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.review.exportManifest({
      rootPath: "/library/root",
      directory: "batch/one",
      scope: "current-folder",
      clips: [{ absolutePath: "/private/clip.mp4" }],
    });

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "review:export-manifest",
      {
        rootPath: "/library/root",
        directory: "batch/one",
        scope: "current-folder",
      }
    );
  });

  it("exposes bounded nested review-session persistence operations", async () => {
    const { api, ipcRenderer } = loadPreload();
    const view = {
      version: 1,
      filters: { reviewFilter: "unreviewed" },
      sort: { key: "name", dir: "asc", groupByFolders: true },
    };

    await api.review.sessions.list();
    await api.review.sessions.get("/library/root");
    await api.review.sessions.save({
      rootPath: "/library/root",
      directory: "batch/one",
      scope: "current-folder",
      view,
      anchorInstanceId: 42,
      anchorFingerprint: "fingerprint",
      ignored: [{ video: true }],
      updatedAt: 1,
    });
    await api.review.sessions.clear("/library/root");

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, "review-sessions:list");
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "review-sessions:get",
      { rootPath: "/library/root" }
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      "review-sessions:save",
      {
        rootPath: "/library/root",
        directory: "batch/one",
        scope: "current-folder",
        view,
        anchorInstanceId: 42,
        anchorFingerprint: "fingerprint",
      }
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      4,
      "review-sessions:clear",
      { rootPath: "/library/root" }
    );
  });

  it("forwards a frozen lifecycle flush token and acknowledges without draft data", () => {
    const { api, ipcRenderer } = loadPreload();
    const callback = vi.fn();
    const dispose = api.review.sessions.onFlushRequested(callback);
    const handler = ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === "review-sessions:flush-requested"
    )[1];

    handler({}, { requestId: "one-use-token", draft: { forbidden: true } });
    const payload = callback.mock.calls[0][0];
    expect(payload).toEqual({ requestId: "one-use-token" });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(api.review.sessions.acknowledgeFlush(payload.requestId)).toBe(true);
    expect(ipcRenderer.send).toHaveBeenCalledWith(
      "review-sessions:flush-ack",
      { requestId: "one-use-token" }
    );
    expect(api.review.sessions.acknowledgeFlush("")).toBe(false);

    dispose();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "review-sessions:flush-requested",
      handler
    );
  });

  it("exposes disposable streamed scan records and viewport priorities", () => {
    const { api, ipcRenderer } = loadPreload();
    const callback = vi.fn();
    const dispose = api.onDirectoryScanRecords(callback);
    const handler = ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === "directory-scan-records"
    )[1];
    const payload = {
      scanId: "scan-9",
      sequence: 1,
      kind: "enumeration",
      records: [{ id: "/library/clip.mp4" }],
    };

    handler({}, payload);
    api.prioritizeDirectoryScan("scan-9", ["/library/clip.mp4"]);
    dispose();

    expect(callback).toHaveBeenCalledWith(payload);
    expect(ipcRenderer.send).toHaveBeenCalledWith(
      "prioritize-directory-scan",
      { scanId: "scan-9", ids: ["/library/clip.mp4"] }
    );
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "directory-scan-records",
      handler
    );
  });

  it("unwraps generation metadata from watcher events", () => {
    const { api, ipcRenderer } = loadPreload();
    const added = vi.fn();
    api.onFileAdded(added);
    const handler = ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === "file-added"
    )[1];
    const videoFile = { id: "/library/new.mp4" };
    const watch = { scanId: "scan-10", sessionId: "watch-2" };

    handler({}, { videoFile, watch });

    expect(added).toHaveBeenCalledWith(videoFile, watch);
  });

  it("only forwards the bounded opaque playback source contract", async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.playback.resolveSource({
      instanceId: 73,
      sourceUrl: "videoswarm-media://instance/73?v=100-200",
      filePath: "/private/library/clip.mp4",
      enabled: 1,
      ignored: "renderer-controlled",
    });

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "playback:resolve-source",
      {
        instanceId: 73,
        sourceUrl: "videoswarm-media://instance/73?v=100-200",
        enabled: true,
      }
    );
  });

  it("exposes disposable settings events", () => {
    const { api, ipcRenderer } = loadPreload();
    const callback = vi.fn();
    const dispose = api.onSettingsLoaded(callback);
    const handler = ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === "settings-loaded"
    )[1];

    handler({}, { recursiveMode: true });
    dispose();

    expect(callback).toHaveBeenCalledWith({ recursiveMode: true });
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "settings-loaded",
      handler
    );
  });

  it("binds destructive trash work to its main-process confirmation token", async () => {
    const { api, ipcRenderer } = loadPreload();
    ipcRenderer.invoke.mockResolvedValueOnce({
      confirmed: true,
      token: "a".repeat(64),
    });

    await expect(
      api.confirmMoveToTrash({ paths: ["/clip.mp4"], sampleName: "clip.mp4" })
    ).resolves.toMatchObject({ confirmed: true, token: "a".repeat(64) });
    await api.bulkMoveToTrash(["/clip.mp4"], "a".repeat(64));

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      "confirm-move-to-trash",
      { paths: ["/clip.mp4"], sampleName: "clip.mp4" }
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "bulk-move-to-trash",
      { paths: ["/clip.mp4"], confirmationToken: "a".repeat(64) }
    );
  });

});
