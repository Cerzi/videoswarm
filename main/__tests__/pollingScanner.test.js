import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { pollFolderForChanges } = require("../polling-scanner");

describe("pollFolderForChanges", () => {
  let tempDir;
  let rootPath;
  let metadataStore;
  let createVideoFileObject;
  let sendEvent;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "videoswarm-polling-"));
    rootPath = path.join(tempDir, "library");
    fs.mkdirSync(rootPath, { recursive: true });
    metadataStore = {
      getFileInstances: vi.fn(() => []),
      markFileMissing: vi.fn(),
    };
    createVideoFileObject = vi.fn(async (filePath) => ({ id: filePath }));
    sendEvent = vi.fn();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const run = (overrides = {}) =>
    pollFolderForChanges({
      rootPath,
      recursive: true,
      depth: 10,
      metadataStore,
      createVideoFileObject,
      isVideoFile: (name) => name.endsWith(".mp4"),
      isIgnoredDirectory: (name) => name === "ignored",
      sendEvent,
      assertActive: () => {},
      pollingState: {},
      ...overrides,
    });

  it("reconciles a persisted removal on the first poll", async () => {
    const missingPath = path.join(rootPath, "gone.mp4");
    metadataStore.getFileInstances.mockReturnValue([
      {
        absolutePath: missingPath,
        relativePath: "gone.mp4",
        size: 42,
        mtimeMs: 100,
      },
    ]);
    const pollingState = { initialized: false, lastFiles: new Map() };

    await run({ pollingState });

    expect(metadataStore.markFileMissing).toHaveBeenCalledWith(missingPath, {
      rootPath,
      assertActive: expect.any(Function),
    });
    expect(sendEvent).toHaveBeenCalledWith("file-removed", missingPath);
    expect(pollingState.initialized).toBe(true);
    expect(pollingState.lastFiles.size).toBe(0);
  });

  it("emits an add when an empty baseline discovers a file", async () => {
    const addedPath = path.join(rootPath, "new.mp4");
    fs.writeFileSync(addedPath, "video");
    const pollingState = { initialized: false, lastFiles: new Map() };

    await run({ pollingState });

    expect(createVideoFileObject).toHaveBeenCalledWith(
      addedPath,
      rootPath,
      expect.objectContaining({ rootPath, recursive: true, stats: expect.any(Object) })
    );
    expect(sendEvent).toHaveBeenCalledWith("file-added", { id: addedPath });
    expect(metadataStore.markFileMissing).not.toHaveBeenCalled();
    expect(pollingState.lastFiles.has(addedPath)).toBe(true);
  });

  it("keeps a non-recursive poll scoped to direct children", async () => {
    const directPath = path.join(rootPath, "direct.mp4");
    const nestedDir = path.join(rootPath, "nested");
    const nestedPath = path.join(nestedDir, "nested.mp4");
    const persistedNestedPath = path.join(nestedDir, "already-gone.mp4");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(directPath, "direct");
    fs.writeFileSync(nestedPath, "nested");
    metadataStore.getFileInstances.mockReturnValue([
      {
        absolutePath: persistedNestedPath,
        relativePath: "nested/already-gone.mp4",
        size: 1,
        mtimeMs: 1,
      },
    ]);

    await run({ recursive: false });

    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith("file-added", { id: directPath });
    expect(createVideoFileObject).not.toHaveBeenCalledWith(
      nestedPath,
      expect.anything(),
      expect.anything()
    );
    expect(metadataStore.markFileMissing).not.toHaveBeenCalled();
  });

  it("preserves prior state across a transient stat failure", async () => {
    const existingPath = path.join(rootPath, "existing.mp4");
    fs.writeFileSync(existingPath, "video");
    metadataStore.getFileInstances.mockReturnValue([
      {
        absolutePath: existingPath,
        relativePath: "existing.mp4",
        size: 5,
        mtimeMs: 123,
      },
    ]);
    const pollingState = { initialized: false, lastFiles: new Map() };
    const fsApi = {
      readdir: fs.promises.readdir.bind(fs.promises),
      stat: vi.fn(async () => {
        throw new Error("temporary stat failure");
      }),
    };

    await run({ pollingState, fsApi });

    expect(sendEvent).not.toHaveBeenCalled();
    expect(metadataStore.markFileMissing).not.toHaveBeenCalled();
    expect(pollingState.lastFiles.get(existingPath)).toEqual({
      size: 5,
      mtime: 123,
    });
  });

  it("does not mark or send after cancellation", async () => {
    const missingPath = path.join(rootPath, "gone.mp4");
    metadataStore.getFileInstances.mockReturnValue([
      {
        absolutePath: missingPath,
        relativePath: "gone.mp4",
        size: 1,
        mtimeMs: 1,
      },
    ]);
    const cancellation = new Error("stale polling session");
    let assertionCount = 0;
    const assertActive = vi.fn(() => {
      assertionCount += 1;
      if (assertionCount >= 3) throw cancellation;
    });
    const pollingState = { initialized: false, lastFiles: new Map() };

    await expect(run({ assertActive, pollingState })).rejects.toBe(cancellation);

    expect(metadataStore.markFileMissing).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(pollingState.initialized).toBe(false);
    expect(pollingState.lastFiles.size).toBe(0);
  });
});
