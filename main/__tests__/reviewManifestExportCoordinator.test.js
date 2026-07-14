import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const {
  EXPORT_CODES,
  createReviewManifestExportCoordinator,
} = require("../review-manifest-export-coordinator");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clip(relativePath = "batch/clip.mp4") {
  return {
    relativePath,
    fingerprint: `fp:${relativePath}`,
    reviewState: "pick",
    rating: 5,
    tags: ["candidate"],
  };
}

function createHarness(overrides = {}) {
  const context = {
    profileId: "profile-a",
    profileName: "Editorial",
    generation: 7,
    token: "context-a",
  };
  const root = {
    rootPath: "/library",
    label: "Library",
    recursive: true,
    refreshState: "idle",
    lastScanCompletedAt: 1_700_000_000_000,
  };
  const calls = [];
  const dependencies = {
    captureContext: vi.fn(() => {
      calls.push("capture");
      return context;
    }),
    assertActive: vi.fn(() => {
      calls.push("assert");
    }),
    authorizeRoot: vi.fn(async () => {
      calls.push("authorize");
      return { path: "/library" };
    }),
    getRoot: vi.fn(async () => {
      calls.push("root");
      return root;
    }),
    showSaveDialog: vi.fn(async () => {
      calls.push("dialog");
      return { canceled: false, filePath: "/exports/review.json" };
    }),
    queryScopeRecords: vi.fn(async () => {
      calls.push("query");
      return { root, records: [clip()] };
    }),
    createManifest: vi.fn((input) => {
      calls.push("build");
      return {
        input,
        summary: { instanceCount: input.records.length },
      };
    }),
    writeManifest: vi.fn(async (_destination, _manifest, writeOptions) => {
      calls.push("write");
      writeOptions.assertActive();
      return { bytes: 321 };
    }),
    ...overrides,
  };
  return {
    calls,
    context,
    root,
    dependencies,
    coordinator: createReviewManifestExportCoordinator(dependencies),
  };
}

const request = Object.freeze({
  owner: { id: 42 },
  rootPath: "/library",
  directory: "batch",
  scope: "current-subtree",
});

describe("review manifest export coordinator", () => {
  it("stops at a coded authorization failure", async () => {
    const authorizationError = Object.assign(new Error("Root is not authorized"), {
      code: "PATH_NOT_AUTHORIZED",
    });
    const harness = createHarness({
      authorizeRoot: vi.fn().mockRejectedValue(authorizationError),
    });

    await expect(harness.coordinator.exportManifest(request)).resolves.toMatchObject({
      success: false,
      cancelled: false,
      profileId: "profile-a",
      generation: 7,
      code: "PATH_NOT_AUTHORIZED",
    });
    expect(harness.dependencies.getRoot).not.toHaveBeenCalled();
    expect(harness.dependencies.showSaveDialog).not.toHaveBeenCalled();
    expect(harness.dependencies.queryScopeRecords).not.toHaveBeenCalled();
    expect(harness.dependencies.writeManifest).not.toHaveBeenCalled();
  });

  it("opens the native dialog before querying and cancellation does no query or write", async () => {
    const harness = createHarness({
      showSaveDialog: vi.fn(async () => {
        harness.calls.push("dialog");
        return { canceled: true };
      }),
    });

    await expect(harness.coordinator.exportManifest(request)).resolves.toEqual({
      success: true,
      cancelled: true,
      profileId: "profile-a",
      generation: 7,
    });
    expect(harness.dependencies.showSaveDialog).toHaveBeenCalledOnce();
    expect(harness.dependencies.queryScopeRecords).not.toHaveBeenCalled();
    expect(harness.dependencies.createManifest).not.toHaveBeenCalled();
    expect(harness.dependencies.writeManifest).not.toHaveBeenCalled();
  });

  it("does not open a save dialog without a completed persisted scan", async () => {
    const harness = createHarness({
      getRoot: vi.fn(async () => ({
        rootPath: "/library",
        recursive: true,
        refreshState: "idle",
        lastScanCompletedAt: null,
      })),
    });

    await expect(harness.coordinator.exportManifest(request)).resolves.toMatchObject({
      success: false,
      code: "REVIEW_MANIFEST_INCOMPLETE_INDEX",
    });
    expect(harness.dependencies.showSaveDialog).not.toHaveBeenCalled();
    expect(harness.dependencies.queryScopeRecords).not.toHaveBeenCalled();
    expect(harness.dependencies.writeManifest).not.toHaveBeenCalled();
  });

  it("does not open a save dialog when a newer scan has not completed", async () => {
    const harness = createHarness({
      getRoot: vi.fn(async () => ({
        rootPath: "/library",
        recursive: true,
        refreshState: "idle",
        lastScanStartedAt: 1_700_000_000_001,
        lastScanCompletedAt: 1_700_000_000_000,
      })),
    });

    await expect(harness.coordinator.exportManifest(request)).resolves.toMatchObject({
      success: false,
      code: "REVIEW_MANIFEST_INCOMPLETE_INDEX",
    });
    expect(harness.dependencies.showSaveDialog).not.toHaveBeenCalled();
    expect(harness.dependencies.queryScopeRecords).not.toHaveBeenCalled();
    expect(harness.dependencies.writeManifest).not.toHaveBeenCalled();
  });

  it("admits only one export while the global coordinator slot is active", async () => {
    const dialog = deferred();
    const harness = createHarness({
      showSaveDialog: vi.fn(() => dialog.promise),
    });

    const first = harness.coordinator.exportManifest(request);
    await vi.waitFor(() => {
      expect(harness.dependencies.showSaveDialog).toHaveBeenCalledOnce();
    });

    await expect(harness.coordinator.exportManifest(request)).resolves.toMatchObject({
      success: false,
      cancelled: false,
      code: EXPORT_CODES.BUSY,
    });
    expect(harness.dependencies.authorizeRoot).toHaveBeenCalledOnce();

    dialog.resolve({ canceled: true });
    await expect(first).resolves.toMatchObject({ success: true, cancelled: true });
  });

  it("revalidates profile and owner lifecycle immediately after the dialog", async () => {
    let active = true;
    const invalidated = Object.assign(new Error("Profile changed"), {
      code: "PROFILE_OPERATION_INVALIDATED",
    });
    const harness = createHarness({
      assertActive: vi.fn(() => {
        if (!active) throw invalidated;
      }),
      showSaveDialog: vi.fn(async () => {
        active = false;
        return { canceled: false, filePath: "/exports/stale.json" };
      }),
    });

    await expect(harness.coordinator.exportManifest(request)).resolves.toMatchObject({
      success: false,
      cancelled: false,
      code: "PROFILE_OPERATION_INVALIDATED",
    });
    expect(harness.dependencies.queryScopeRecords).not.toHaveBeenCalled();
    expect(harness.dependencies.createManifest).not.toHaveBeenCalled();
    expect(harness.dependencies.writeManifest).not.toHaveBeenCalled();
  });

  it("rejects a query-time root that began refreshing while the dialog was open", async () => {
    const harness = createHarness({
      queryScopeRecords: vi.fn(async () => ({
        root: {
          rootPath: "/library",
          recursive: true,
          refreshState: "scanning",
          lastScanCompletedAt: 1_700_000_000_000,
        },
        records: [clip()],
      })),
    });

    await expect(harness.coordinator.exportManifest(request)).resolves.toMatchObject({
      success: false,
      code: "REVIEW_MANIFEST_INDEX_NOT_READY",
    });
    expect(harness.dependencies.createManifest).not.toHaveBeenCalled();
    expect(harness.dependencies.writeManifest).not.toHaveBeenCalled();
  });

  it("queries only after save selection, builds, and atomically publishes a normal export", async () => {
    const harness = createHarness();

    await expect(harness.coordinator.exportManifest(request)).resolves.toEqual({
      success: true,
      cancelled: false,
      profileId: "profile-a",
      generation: 7,
      fileCount: 1,
      bytes: 321,
    });

    expect(harness.calls.indexOf("dialog")).toBeLessThan(
      harness.calls.indexOf("query")
    );
    expect(harness.calls.indexOf("query")).toBeLessThan(
      harness.calls.indexOf("build")
    );
    expect(harness.calls.indexOf("build")).toBeLessThan(
      harness.calls.indexOf("write")
    );
    expect(harness.dependencies.queryScopeRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/library",
        directory: "batch",
        scope: "current-subtree",
        limit: 20_001,
        assertActive: expect.any(Function),
      })
    );
    expect(harness.dependencies.createManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: { id: "profile-a", name: "Editorial" },
        root: harness.root,
        records: [expect.objectContaining({ relativePath: "batch/clip.mp4" })],
      })
    );
    expect(harness.dependencies.writeManifest).toHaveBeenCalledWith(
      "/exports/review.json",
      expect.objectContaining({ summary: { instanceCount: 1 } }),
      {
        assertActive: expect.any(Function),
        writeOptions: { assertActive: expect.any(Function) },
      }
    );
  });

  it("pause-and-drain waits for active work, rejects new admission, and can resume", async () => {
    const query = deferred();
    const harness = createHarness({
      queryScopeRecords: vi.fn(() => query.promise),
    });
    const activeExport = harness.coordinator.exportManifest(request);
    await vi.waitFor(() => {
      expect(harness.dependencies.queryScopeRecords).toHaveBeenCalledOnce();
    });

    let drained = false;
    const draining = harness.coordinator.pauseAndDrain().then((result) => {
      drained = true;
      return result;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(harness.coordinator.exportManifest(request)).resolves.toMatchObject({
      code: EXPORT_CODES.PAUSED,
    });

    query.resolve({ root: harness.root, records: [clip()] });
    await expect(activeExport).resolves.toMatchObject({ success: true, cancelled: false });
    await expect(draining).resolves.toMatchObject({
      drained: true,
      active: false,
      closed: false,
    });
    expect(harness.coordinator.resume()).toBe(true);
    expect(harness.coordinator.state()).toEqual({
      admissionOpen: true,
      active: false,
      closed: false,
    });
  });

  it("close-and-drain permanently closes admission", async () => {
    const harness = createHarness();
    await expect(harness.coordinator.closeAndDrain()).resolves.toMatchObject({
      drained: true,
      closed: true,
    });
    expect(harness.coordinator.resume()).toBe(false);
    await expect(harness.coordinator.exportManifest(request)).resolves.toMatchObject({
      code: EXPORT_CODES.CLOSED,
    });
    expect(harness.dependencies.captureContext).not.toHaveBeenCalled();
  });
});
