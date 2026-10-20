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
    await api.metadata.getGeneration(44, "renderer-request-2", { force: true });
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
      "metadata:get-generation",
      { instanceId: 44, requestToken: "renderer-request-2", force: true }
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      4,
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

  it("sends similar-prompt requests as prompt keys and a threshold only", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.stacks.similarPrompts({ promptKeys: ["pk2-a"], threshold: 0.8, rootPath: "/nope" });
    await api.stacks.similarPrompts({ promptKeys: "bad", threshold: "0.9" });
    await api.prompts.search(["pk2-a"], "lighthouse");
    await api.prompts.search("bad", 5);
    await api.stacks.frameFingerprints([1, 2]);
    await api.stacks.frameStills("bad");
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["stacks:similar-prompts", { promptKeys: ["pk2-a"], threshold: 0.8 }],
      ["stacks:similar-prompts", { promptKeys: [], threshold: 0.9 }],
      ["prompts:search", { promptKeys: ["pk2-a"], query: "lighthouse" }],
      ["prompts:search", { promptKeys: [], query: "" }],
      ["stacks:frame-fingerprints", { instanceIds: [1, 2] }],
      ["stacks:frame-stills", { instanceIds: [] }],
    ]);
    const callback = vi.fn();
    const unsubscribe = api.stacks.onFrameFingerprints(callback);
    const [channel, handler] = ipcRenderer.on.mock.calls.at(-1);
    expect(channel).toBe("stacks:frame-fingerprints");
    handler({}, { hashes: { 1: "00ff00ff00ff00ff" } });
    expect(callback).toHaveBeenCalledWith({ hashes: { 1: "00ff00ff00ff00ff" } });
    unsubscribe();
  });

  it("asks for tag suggestions by catalog row, fingerprint and tag name only", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.tagSuggestions.status();
    await api.tagSuggestions.forClips([4, 5]);
    await api.tagSuggestions.forClips("bad");
    await api.tagSuggestions.mightBe([4], "dance");
    await api.tagSuggestions.mightBe(null, 7);
    await api.tagSuggestions.dismiss(["fp-1"], "dance");
    await api.library.taggedSnapshot([], "all", { mightBe: " dance " });
    await api.library.taggedSnapshot([], "all", { mightBe: "  " });
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["tag-suggestions:status"],
      ["tag-suggestions:for-clips", { instanceIds: [4, 5] }],
      ["tag-suggestions:for-clips", { instanceIds: [] }],
      ["tag-suggestions:might-be", { instanceIds: [4], tag: "dance" }],
      ["tag-suggestions:might-be", { instanceIds: [], tag: "" }],
      ["tag-suggestions:dismiss", { fingerprints: ["fp-1"], tag: "dance" }],
      ["library:tagged-snapshot", { tags: [], matchMode: "all", mightBe: "dance" }],
      ["library:tagged-snapshot", { tags: [], matchMode: "all" }],
    ]);
  });

  it("exposes generation-version indexing with ids or library scope only", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.generationVersions.index({ instanceIds: [1, 2], rootPath: "/nope" });
    await api.generationVersions.index({ library: true, instanceIds: [3] });
    await api.generationVersions.index({ instanceIds: "bad" });
    await api.generationVersions.cancel();
    await api.generationVersions.summaries(["gk1-x"]);
    await api.generationVersions.summaries(null);
    await api.generationVersions.siblings(7);
    await api.generationVersions.open(7);
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["generation-versions:index", { instanceIds: [1, 2] }],
      ["generation-versions:index", { library: true }],
      ["generation-versions:index", { instanceIds: [] }],
      ["generation-versions:cancel"],
      ["generation-versions:summaries", { keys: ["gk1-x"] }],
      ["generation-versions:summaries", { keys: [] }],
      ["generation-versions:siblings", { instanceId: 7 }],
      ["generation-versions:open", { instanceId: 7 }],
    ]);

    const callback = vi.fn();
    const unsubscribe = api.generationVersions.onProgress(callback);
    const [channel, handler] = ipcRenderer.on.mock.calls.at(-1);
    expect(channel).toBe("generation-versions:progress");
    handler({}, { jobId: "gk-1" });
    expect(callback).toHaveBeenCalledWith({ jobId: "gk-1" });
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "generation-versions:progress",
      handler
    );
  });

  it("talks to companion apps by id, catalog row and action id only", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.companion.getConnections();
    await api.companion.setConnections([
      { id: "c1", enabled: "yes", url: "http://127.0.0.1:9", extra: 1 },
      { enabled: true, url: "http://localhost:8" },
    ]);
    await api.companion.setConnections("bad");
    await api.companion.testConnection();
    await api.companion.testConnection("http://localhost:9");
    await api.companion.describe("c2");
    await api.companion.lookup("c1", [1, 2]);
    await api.companion.lookup(null, "bad");
    await api.companion.send({ companionId: "c2", action: "polish", instanceIds: [3], dryRun: true, paths: ["/x"] });
    await api.companion.targets("c2", "add");
    await api.companion.send({ companionId: "c2", action: "add", instanceIds: [3], target: { handle: "t4", id: "/x" } });
    await api.companion.send({ companionId: "c2", action: "add", instanceIds: [3], target: { new: "Fresh" } });
    await api.companion.withdraw({ companionId: "c2", action: "add", instanceIds: [3], target: "/raw/path" });
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["companion:connections:get"],
      [
        "companion:connections:set",
        {
          connections: [
            { id: "c1", enabled: false, url: "http://127.0.0.1:9" },
            { enabled: true, url: "http://localhost:8" },
          ],
        },
      ],
      ["companion:connections:set", { connections: [] }],
      ["companion:connection:test", { url: "" }],
      ["companion:connection:test", { url: "http://localhost:9" }],
      ["companion:describe", { companionId: "c2" }],
      ["companion:lookup", { companionId: "c1", instanceIds: [1, 2] }],
      ["companion:lookup", { companionId: "", instanceIds: [] }],
      [
        "companion:send",
        { companionId: "c2", action: "polish", instanceIds: [3], dryRun: true, again: false },
      ],
      ["companion:targets", { companionId: "c2", action: "add" }],
      // A target is a handle or a new name, never an id or path.
      [
        "companion:send",
        { companionId: "c2", action: "add", instanceIds: [3], dryRun: false, again: false, target: { handle: "t4" } },
      ],
      [
        "companion:send",
        { companionId: "c2", action: "add", instanceIds: [3], dryRun: false, again: false, target: { new: "Fresh" } },
      ],
      ["companion:withdraw", { companionId: "c2", action: "add", instanceIds: [3] }],
    ]);
    const callback = vi.fn();
    const unsubscribe = api.companion.onConnectionsChanged(callback);
    const [channel, handler] = ipcRenderer.on.mock.calls.at(-1);
    expect(channel).toBe("companion:connections-changed");
    handler({}, [{ id: "c1", enabled: true }]);
    expect(callback).toHaveBeenCalledWith([{ id: "c1", enabled: true }]);
    unsubscribe();
  });

  it("reads and changes the local API setting with plain values only", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.localApi.get();
    await api.localApi.set({ enabled: "yes", port: "50000", token: "x" });
    await api.localApi.newToken();
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["local-api:get"],
      ["local-api:set", { enabled: false, port: 50000 }],
      ["local-api:new-token"],
    ]);
  });

  it("creates, lists, opens and forgets review passes with plain values", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.reviewPasses.create({ name: "A1", source: "results", definition: { version: 1 }, clips: [{ fingerprint: "f", instanceId: 2 }] });
    await api.reviewPasses.create({ source: "elsewhere", clips: "x" });
    await api.reviewPasses.list();
    await api.reviewPasses.open(4);
    await api.reviewPasses.setCursor(4, 7);
    await api.reviewPasses.finish(4);
    await api.reviewPasses.remove(4);
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["review-passes:create", { name: "A1", source: "results", definition: { version: 1 }, location: null, clips: [{ fingerprint: "f", instanceId: 2 }] }],
      ["review-passes:create", { name: "", source: "results", definition: null, location: null, clips: [] }],
      ["review-passes:list"],
      ["review-passes:open", { id: 4 }],
      ["review-passes:cursor", { id: 4, position: 7 }],
      ["review-passes:finish", { id: 4 }],
      ["review-passes:delete", { id: 4 }],
    ]);
  });

  it("matches workflows with fingerprints, words and whole steps only", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.workflow.match({ fingerprints: ["fa"], include: ["upscale"], minSteps: 12, maxSteps: 2.5 });
    await api.workflow.match({ fingerprints: "fa", exclude: "turbo" });
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["workflow:match", { fingerprints: ["fa"], include: ["upscale"], exclude: [], minSteps: 12, maxSteps: null }],
      ["workflow:match", { fingerprints: [], include: [], exclude: [], minSteps: null, maxSteps: null }],
    ]);
  });

  it("reads background activity and pauses it with a plain flag", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.activity.get();
    await api.activity.setPaused("yes");
    await api.activity.setPaused(true);
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["activity:get"],
      ["activity:set-paused", { paused: false }],
      ["activity:set-paused", { paused: true }],
    ]);
    const callback = vi.fn();
    const unsubscribe = api.activity.onChange(callback);
    const [channel, handler] = ipcRenderer.on.mock.calls.at(-1);
    expect(channel).toBe("activity:changed");
    handler({}, { paused: true, activities: [] });
    expect(callback).toHaveBeenCalledWith({ paused: true, activities: [] });
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith("activity:changed", handler);
  });

  it("opens a clip's workflow by catalog row only", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.comfy.openWorkflow(12);
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["comfy:open-workflow", { instanceId: 12 }],
    ]);
  });

  it("exposes only ComfyUI's address and a read-only test", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.comfy.getConnection();
    await api.comfy.setConnection({ enabled: true, url: "http://127.0.0.1:8188", outputDir: "/o" });
    await api.comfy.setConnection({ url: 5 });
    await api.comfy.testConnection();
    await api.comfy.testConnection("http://localhost:8188");
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ["comfy:connection:get"],
      ["comfy:connection:set", { url: "http://127.0.0.1:8188" }],
      ["comfy:connection:set", { url: undefined }],
      ["comfy:connection:test", {}],
      ["comfy:connection:test", { url: "http://localhost:8188" }],
    ]);
    expect(Object.keys(api.comfy).sort()).toEqual([
      "getConnection",
      "openWorkflow",
      "setConnection",
      "testConnection",
    ]);
    expect(api.comfyQueue).toBeUndefined();
  });

  it("opens Preferences from the application menu", () => {
    const { api, ipcRenderer } = loadPreload();
    const callback = vi.fn();
    const unsubscribe = api.onOpenPreferences(callback);
    const [channel, handler] = ipcRenderer.on.mock.calls.at(-1);
    expect(channel).toBe("ui:open-preferences");
    handler({});
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith("ui:open-preferences", handler);
  });

  it("authorizes an indexed library root on demand", async () => {
    const { api, ipcRenderer } = loadPreload();

    await api.library.authorizeRoot("/library/root-300");

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "library:authorize-root",
      { rootPath: "/library/root-300" }
    );
  });

  it("exposes bounded Accepted-copy planning, progress, start, and cancellation", async () => {
    const { api, ipcRenderer } = loadPreload();
    const onProgress = vi.fn();

    await api.review.copyAccepted.prepare({
      rootPath: "/library/root",
      directory: "batch/one",
      scope: "current-folder",
      clips: [{ absolutePath: "/private/clip.mp4" }],
    });
    await api.review.copyAccepted.start("native-plan-1", "move");
    await api.review.copyAccepted.cancel("native-plan-1");
    const unsubscribe = api.review.copyAccepted.onProgress(onProgress);

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      "review:copy-accepted:prepare",
      {
        rootPath: "/library/root",
        directory: "batch/one",
        scope: "current-folder",
        // Absent reuse hints are normalised rather than forwarded as
        // undefined, so the bounded main-side validator sees a stable shape.
        // A null selection means "use the review scope" rather than "no rows".
        instanceIds: null,
        destinationPath: null,
        layout: "structured",
        reusePlanId: null,
      }
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      "review:copy-accepted:start",
      {
        planId: "native-plan-1",
        collisionPolicy: "skip",
        transferMode: "move",
      }
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      "review:copy-accepted:cancel",
      { planId: "native-plan-1" }
    );

    const progressHandler = ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === "review:copy-accepted-progress"
    )[1];
    progressHandler({}, { planId: "native-plan-1", copiedMedia: 2 });
    expect(onProgress).toHaveBeenCalledWith({
      planId: "native-plan-1",
      copiedMedia: 2,
    });
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "review:copy-accepted-progress",
      progressHandler
    );
  });

  it("forwards link transfers and coerces unknown modes to copy", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.review.copyAccepted.start("native-plan-1", "link");
    await api.review.copyAccepted.start("native-plan-1", "hardlink");
    expect(ipcRenderer.invoke.mock.calls.map(([, payload]) => payload.transferMode)).toEqual([
      "link",
      "copy",
    ]);
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

describe("preload bridges", () => {
  it("forwards only in/out zoom-wheel directions and unsubscribes", () => {
    const { api, ipcRenderer } = loadPreload();
    const callback = vi.fn();

    const unsubscribe = api.onZoomWheel(callback);
    const [[channel, handler]] = ipcRenderer.on.mock.calls.filter(
      ([name]) => name === "ui:zoom-wheel"
    );
    expect(channel).toBe("ui:zoom-wheel");
    handler({}, "in");
    handler({}, "out");
    handler({}, "sideways");
    expect(callback.mock.calls).toEqual([["in"], ["out"]]);

    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "ui:zoom-wheel",
      handler
    );
    expect(api.onZoomWheel(null)()).toBeUndefined();
  });

  it("toggles the covered-window pause and forwards covered changes", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.playback.setPauseWhenCovered("yes");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "playback:set-pause-when-covered",
      true
    );

    const callback = vi.fn();
    const unsubscribe = api.playback.onWindowCovered(callback);
    const [[, handler]] = ipcRenderer.on.mock.calls.filter(
      ([name]) => name === "playback:window-covered"
    );
    handler({}, { covered: true });
    handler({}, { covered: "maybe" });
    expect(callback.mock.calls).toEqual([[true], [false]]);
    unsubscribe();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "playback:window-covered",
      handler
    );
  });

  it("sets a tag's parent through one invoke, with null for top level", async () => {
    const { api, ipcRenderer } = loadPreload();
    await api.metadata.setTagParent("bellydance", "dance");
    await api.metadata.setTagParent("bellydance");
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "metadata:set-tag-parent",
      "bellydance",
      "dance"
    );
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith(
      "metadata:set-tag-parent",
      "bellydance",
      null
    );
  });
});
