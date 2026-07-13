const path = require("path");
const { promises: defaultFs } = require("fs");

function requiredFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`pollFolderForChanges requires ${name}`);
  }
  return value;
}

function instanceIsInScope(instance, recursive, maxDepth, isIgnoredDirectory) {
  const relativePath = String(instance?.relativePath || "").replace(/\\/g, "/");
  const directoryParts = relativePath.split("/").filter(Boolean).slice(0, -1);
  if (directoryParts.some((part) => isIgnoredDirectory(part))) return false;
  return recursive ? directoryParts.length <= maxDepth : directoryParts.length === 0;
}

/**
 * Scan one watched root and emit the file-level difference from its prior state.
 *
 * Call signature:
 *   await pollFolderForChanges({
 *     rootPath,
 *     recursive,
 *     depth,
 *     metadataStore,
 *     createVideoFileObject,
 *     isVideoFile,
 *     isIgnoredDirectory,
 *     sendEvent,
 *     assertActive,
 *     pollingState,
 *     fsApi, // optional test/platform override; defaults to fs.promises
 *   });
 */
async function pollFolderForChanges({
  rootPath,
  recursive = true,
  depth = 10,
  metadataStore,
  createVideoFileObject,
  isVideoFile,
  isIgnoredDirectory,
  sendEvent,
  assertActive = () => {},
  pollingState = {},
  fsApi = defaultFs,
} = {}) {
  if (!rootPath) {
    throw new TypeError("pollFolderForChanges requires rootPath");
  }
  if (!metadataStore || typeof metadataStore.getFileInstances !== "function") {
    throw new TypeError("pollFolderForChanges requires metadataStore.getFileInstances");
  }
  if (typeof metadataStore.markFileMissing !== "function") {
    throw new TypeError("pollFolderForChanges requires metadataStore.markFileMissing");
  }

  requiredFunction(createVideoFileObject, "createVideoFileObject");
  requiredFunction(isVideoFile, "isVideoFile");
  requiredFunction(isIgnoredDirectory, "isIgnoredDirectory");
  requiredFunction(sendEvent, "sendEvent");
  requiredFunction(assertActive, "assertActive");
  requiredFunction(fsApi?.readdir, "fsApi.readdir");
  requiredFunction(fsApi?.stat, "fsApi.stat");

  const normalizedRoot = path.resolve(rootPath);
  const maxDepth = Math.max(0, Number.isFinite(depth) ? Math.floor(depth) : 10);
  let previousFiles =
    pollingState.lastFiles instanceof Map ? pollingState.lastFiles : new Map();

  if (pollingState.initialized !== true) {
    const persistedInstances =
      metadataStore.getFileInstances(normalizedRoot, { includeMissing: false }) || [];
    previousFiles = new Map(
      persistedInstances
        .filter((instance) =>
          instanceIsInScope(instance, recursive, maxDepth, isIgnoredDirectory)
        )
        .map((instance) => [
          instance.absolutePath,
          { size: instance.size, mtime: instance.mtimeMs },
        ])
    );
  }

  const currentFiles = new Map();

  async function scanDirectory(directoryPath, currentDepth) {
    assertActive();
    if (!recursive && currentDepth > 0) return;
    if (recursive && currentDepth > maxDepth) return;

    const entries = await fsApi.readdir(directoryPath, { withFileTypes: true });
    assertActive();

    for (const entry of entries) {
      assertActive();
      const fullPath = path.join(directoryPath, entry.name);

      if (entry.isFile() && isVideoFile(entry.name)) {
        try {
          const stats = await fsApi.stat(fullPath);
          assertActive();
          currentFiles.set(fullPath, {
            size: stats.size,
            mtime: stats.mtimeMs,
            stats,
          });
        } catch (error) {
          // Cancellation is authoritative; an ordinary stat failure is only
          // "unknown" and must not turn a known file into a removal.
          assertActive();
          const previous = previousFiles.get(fullPath);
          if (previous) currentFiles.set(fullPath, previous);
        }
        continue;
      }

      if (
        recursive &&
        entry.isDirectory() &&
        currentDepth < maxDepth &&
        !isIgnoredDirectory(entry.name)
      ) {
        await scanDirectory(fullPath, currentDepth + 1);
      }
    }
  }

  await scanDirectory(normalizedRoot, 0);
  assertActive();

  for (const [filePath, fileInfo] of currentFiles) {
    assertActive();
    const previous = previousFiles.get(filePath);
    const channel = !previous
      ? "file-added"
      : previous.mtime !== fileInfo.mtime || previous.size !== fileInfo.size
        ? "file-changed"
        : null;
    if (!channel) continue;

    const videoFile = await createVideoFileObject(filePath, normalizedRoot, {
      stats: fileInfo.stats,
      metadataStore,
      rootPath: normalizedRoot,
      recursive,
      assertActive,
    });
    assertActive();
    if (videoFile) {
      await sendEvent(channel, videoFile);
      assertActive();
    }
  }

  for (const filePath of previousFiles.keys()) {
    assertActive();
    if (currentFiles.has(filePath)) continue;
    metadataStore.markFileMissing(filePath, {
      rootPath: normalizedRoot,
      assertActive,
    });
    assertActive();
    await sendEvent("file-removed", filePath);
    assertActive();
  }

  assertActive();
  pollingState.lastFiles = currentFiles;
  pollingState.initialized = true;

  return currentFiles;
}

module.exports = {
  pollFolderForChanges,
};
