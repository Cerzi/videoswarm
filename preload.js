const { contextBridge, ipcRenderer } = require("electron");

function normalizeDragPaths(value) {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : value && Array.isArray(value.paths)
        ? value.paths
        : [];
  return candidates.filter(
    (entry) => typeof entry === "string" && entry.trim().length > 0
  );
}

function startFileDrag(paths) {
  const payloadPaths = normalizeDragPaths(paths);
  if (!payloadPaths.length) return { ok: false, error: "NO_FILE" };
  ipcRenderer.send("dnd:start-file", { paths: payloadPaths });
  return { ok: true, queued: true };
}

function normalizePlaybackSourceRequest(payload) {
  const instanceId = Number(payload?.instanceId);
  const sourceUrl = typeof payload?.sourceUrl === "string"
    ? payload.sourceUrl
    : "";
  return {
    instanceId:
      Number.isSafeInteger(instanceId) && instanceId > 0 ? instanceId : null,
    sourceUrl:
      sourceUrl.length <= 2048 && sourceUrl.startsWith("videoswarm-media://")
        ? sourceUrl
        : null,
    enabled: Boolean(payload?.enabled),
  };
}

function normalizeAcceptedCopyPlanId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    ? value
    : "";
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Platform detection
  platform: process.platform,
  isElectron: true,

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  openDonationPage: () => ipcRenderer.invoke("support:open-donation"),

  onOpenDataLocation: (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = () => callback();
    ipcRenderer.on("ui:open-data-location", handler);
    return () => ipcRenderer.removeListener("ui:open-data-location", handler);
  },

  dataLocation: {
    getState: () => ipcRenderer.invoke("data-location:get-state"),
    browse: () => ipcRenderer.invoke("data-location:browse"),
    applySelection: (payload) => ipcRenderer.invoke("data-location:apply", payload),
  },

  // File manager integration
  showItemInFolder: async (filePath) => {
    return await ipcRenderer.invoke("show-item-in-folder", filePath);
  },

  // Directory reading with enhanced metadata
  readDirectory: async (
    folderPath,
    recursive = false,
    scanId = null,
    options = undefined
  ) => {
    return await ipcRenderer.invoke(
      "read-directory",
      folderPath,
      recursive,
      scanId,
      options
    );
  },

  readDirectoryCache: async (
    folderPath,
    recursive = false,
    scanId = null,
    options = undefined
  ) => {
    const args = ["read-directory-cache", folderPath, recursive, scanId];
    if (options !== undefined) args.push(options);
    return await ipcRenderer.invoke(...args);
  },

  cancelDirectoryScan: async (scanId) => {
    return await ipcRenderer.invoke("cancel-directory-scan", scanId);
  },

  onDirectoryScanProgress: (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on("directory-scan-progress", handler);
    return () =>
      ipcRenderer.removeListener("directory-scan-progress", handler);
  },

  onDirectoryScanRecords: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("directory-scan-records", handler);
    return () => ipcRenderer.removeListener("directory-scan-records", handler);
  },

  prioritizeDirectoryScan: (scanId, ids = []) => {
    ipcRenderer.send("prioritize-directory-scan", {
      scanId,
      ids: Array.isArray(ids) ? ids : [],
    });
  },

  // File system watching
  startFolderWatch: async (folderPath, recursive, options = undefined) => {
    return await ipcRenderer.invoke(
      "start-folder-watch",
      folderPath,
      recursive,
      options
    );
  },

  stopFolderWatch: async () => {
    return await ipcRenderer.invoke("stop-folder-watch");
  },

  // File system events
  onFileAdded: (callback) => {
    const handler = (_event, payload) =>
      callback(payload?.videoFile || payload, payload?.watch || null);
    ipcRenderer.on("file-added", handler);
    return () => ipcRenderer.removeListener("file-added", handler);
  },

  onFileRemoved: (callback) => {
    const handler = (_event, payload) =>
      callback(payload?.filePath || payload, payload?.watch || null);
    ipcRenderer.on("file-removed", handler);
    return () => ipcRenderer.removeListener("file-removed", handler);
  },

  onFileChanged: (callback) => {
    const handler = (_event, payload) =>
      callback(payload?.videoFile || payload, payload?.watch || null);
    ipcRenderer.on("file-changed", handler);
    return () => ipcRenderer.removeListener("file-changed", handler);
  },

  onFileWatchError: (callback) => {
    const handler = (_event, error) => callback(error);
    ipcRenderer.on("file-watch-error", handler);
    return () => ipcRenderer.removeListener("file-watch-error", handler);
  },

  // Folder selection dialog
  selectFolder: async () => {
    return await ipcRenderer.invoke("select-folder");
  },

  // Listen for folder selection from menu
  onFolderSelected: (callback) => {
    const handler = (_event, folderPath) => {
      callback(folderPath);
    };
    ipcRenderer.on("folder-selected", handler);
    return () => ipcRenderer.removeListener("folder-selected", handler);
  },

  onOpenAbout: (callback) => {
    const handler = () => {
      callback();
    };
    ipcRenderer.on("ui:open-about", handler);
    return () => ipcRenderer.removeListener("ui:open-about", handler);
  },

  // Settings management - existing methods
  saveSettings: async (settings) => {
    return await ipcRenderer.invoke("save-settings", settings);
  },

  loadSettings: async () => {
    return await ipcRenderer.invoke("load-settings");
  },

  saveSettingsPartial: async (partialSettings) => {
    return await ipcRenderer.invoke("save-settings-partial", partialSettings);
  },

  onSettingsLoaded: (callback) => {
    const handler = (_event, settings) => {
      callback(settings);
    };
    ipcRenderer.on("settings-loaded", handler);
    return () => ipcRenderer.removeListener("settings-loaded", handler);
  },

  profiles: {
    list: () => ipcRenderer.invoke("profiles:list"),
    getActive: () => ipcRenderer.invoke("profiles:get-active"),
    setActive: (profileId) => ipcRenderer.invoke("profiles:set-active", profileId),
    create: (name) => ipcRenderer.invoke("profiles:create", name),
    rename: (profileId, name) =>
      ipcRenderer.invoke("profiles:rename", profileId, name),
    delete: (profileId) => ipcRenderer.invoke("profiles:delete", profileId),
    onChanged: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("profile-changed", handler);
      return () => ipcRenderer.removeListener("profile-changed", handler);
    },
    onPromptInput: (callback) => {
      if (typeof callback !== "function") {
        return () => {};
      }
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("profiles:prompt-input", handler);
      return () => ipcRenderer.removeListener("profiles:prompt-input", handler);
    },
    respondToPrompt: (requestId, value) => {
      ipcRenderer.send("profiles:prompt-response", { requestId, value });
    },
  },

  // Settings management - NEW methods for faster loading
  getSettings: async () => {
    return await ipcRenderer.invoke("get-settings");
  },

  requestSettings: async () => {
    return await ipcRenderer.invoke("request-settings");
  },

  playback: {
    getCapabilities: () => ipcRenderer.invoke("playback:get-capabilities"),
    getWindowActivity: () =>
      ipcRenderer.invoke("playback:get-window-activity"),
    setRendererActive: (active) =>
      ipcRenderer.invoke("playback:set-renderer-active", Boolean(active)),
    resolveSource: (payload) =>
      ipcRenderer.invoke(
        "playback:resolve-source",
        normalizePlaybackSourceRequest(payload)
      ),
    onWindowActivity: (callback) => {
      if (typeof callback !== "function") return () => {};
      const handler = (_event, activity) => callback(activity);
      ipcRenderer.on("playback:window-activity", handler);
      return () =>
        ipcRenderer.removeListener("playback:window-activity", handler);
    },
  },

  // Additional file operations (from your main.js)
  bulkMoveToTrash: async (paths, confirmationToken) => {
    return await ipcRenderer.invoke("bulk-move-to-trash", {
      paths,
      confirmationToken,
    });
  },
  moveToTrash: async (filePath, confirmationToken) => {
    return await ipcRenderer.invoke("bulk-move-to-trash", {
      paths: [filePath],
      confirmationToken,
    });
  },

  onTrashProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("trash-progress", handler);
    return () => ipcRenderer.removeListener("trash-progress", handler);
  },

  confirmMoveToTrash: async (payload) => {
    const result = await ipcRenderer.invoke("confirm-move-to-trash", payload);
    if (result && typeof result === "object") return result;
    return { confirmed: result === true, token: null };
  },

  // External player integration
  openInExternalPlayer: async (filePath) => {
    return await ipcRenderer.invoke("open-in-external-player", filePath);
  },

  startFileDrag,
  // Compatibility alias for older renderer bundles. This is deliberately
  // fire-and-forget despite the legacy name so drag start never blocks IPC.
  startFileDragSync: startFileDrag,

  thumbs: {
    put: (payload) => ipcRenderer.invoke("thumb:put", payload),
    get: (payload) => ipcRenderer.invoke("thumb:get", payload),
  },

  // Clipboard operations
  copyToClipboard: async (text) => {
    return await ipcRenderer.invoke("copy-to-clipboard", text);
  },

  copyImageToClipboard: async (dataUrl) => {
    return await ipcRenderer.invoke("copy-image-to-clipboard", dataUrl);
  },

  copyLastFrameFromFile: async (filePath) => {
    return await ipcRenderer.invoke("copy-last-frame-from-file", filePath);
  },

  copyFrameAtTime: async (filePath, atSeconds) => {
    return await ipcRenderer.invoke("copy-frame-at-time", {
      filePath,
      atSeconds,
    });
  },



  metadata: {
    listTags: async () => ipcRenderer.invoke("metadata:list-tags"),
    addTags: async (fingerprints, tagNames) =>
      ipcRenderer.invoke("metadata:add-tags", fingerprints, tagNames),
    removeTag: async (fingerprints, tagName) =>
      ipcRenderer.invoke("metadata:remove-tag", fingerprints, tagName),
    setRating: async (fingerprints, rating) =>
      ipcRenderer.invoke("metadata:set-rating", fingerprints, rating),
    setReviewState: async (fingerprints, reviewState) =>
      ipcRenderer.invoke("metadata:set-review-state", fingerprints, reviewState),
    restoreReview: async (snapshots) =>
      ipcRenderer.invoke("metadata:restore-review", snapshots),
    get: async (fingerprints) =>
      ipcRenderer.invoke("metadata:get", fingerprints),
    getGeneration: async (instanceId, requestToken, options = {}) => {
      return ipcRenderer.invoke("metadata:get-generation", {
        instanceId,
        ...(requestToken === undefined || requestToken === null || requestToken === ""
          ? {}
          : { requestToken }),
        ...(options?.force === true ? { force: true } : {}),
      });
    },
    cancelGeneration: async (requestToken) =>
      ipcRenderer.invoke("metadata:cancel-generation", {
        requestToken,
      }),
  },

  library: {
    listTags: async () => ipcRenderer.invoke("library:list-tags"),
    taggedSnapshot: async (tags) =>
      ipcRenderer.invoke("library:tagged-snapshot", {
        tags: Array.isArray(tags) ? tags : [],
      }),
    listRoots: async (options = {}) =>
      ipcRenderer.invoke("library:list-roots", options),
    authorizeRoot: async (rootPath) =>
      ipcRenderer.invoke("library:authorize-root", { rootPath }),
    getTree: async (rootPath, options = {}) =>
      ipcRenderer.invoke("library:get-tree", {
        rootPath,
        includeMissing: Boolean(options?.includeMissing),
      }),
    setPinned: async (rootPath, pinned) =>
      ipcRenderer.invoke("library:set-pinned", {
        rootPath,
        pinned,
      }),
    listSavedViews: async () =>
      ipcRenderer.invoke("library:list-saved-views"),
    createSavedView: async (name, definition) =>
      ipcRenderer.invoke("library:create-saved-view", { name, definition }),
    updateSavedView: async (id, changes = {}) =>
      ipcRenderer.invoke("library:update-saved-view", { id, ...changes }),
    deleteSavedView: async (id) =>
      ipcRenderer.invoke("library:delete-saved-view", { id }),
  },

  review: {
    copyAccepted: {
      prepare: async (payload = {}) =>
        ipcRenderer.invoke("review:copy-accepted:prepare", {
          rootPath: payload?.rootPath,
          directory: payload?.directory ?? "",
          scope: payload?.scope,
          instanceIds: Array.isArray(payload?.instanceIds)
            ? payload.instanceIds
            : null,
          destinationPath:
            typeof payload?.destinationPath === "string"
              ? payload.destinationPath
              : null,
          layout: payload?.layout === "flat" ? "flat" : "structured",
          reusePlanId:
            typeof payload?.reusePlanId === "string"
              ? payload.reusePlanId
              : null,
        }),
      listDestinations: async () =>
        ipcRenderer.invoke("review:transfer-destinations"),
      start: async (planId, transferMode = "copy") =>
        ipcRenderer.invoke("review:copy-accepted:start", {
          planId: normalizeAcceptedCopyPlanId(planId),
          collisionPolicy: "skip",
          transferMode: transferMode === "move" ? "move" : "copy",
        }),
      cancel: async (planId) =>
        ipcRenderer.invoke("review:copy-accepted:cancel", {
          planId: normalizeAcceptedCopyPlanId(planId),
        }),
      onProgress: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = (_event, payload) => callback(payload);
        ipcRenderer.on("review:copy-accepted-progress", handler);
        return () =>
          ipcRenderer.removeListener("review:copy-accepted-progress", handler);
      },
    },
    sessions: {
      list: async () => ipcRenderer.invoke("review-sessions:list"),
      get: async (rootPath) =>
        ipcRenderer.invoke("review-sessions:get", { rootPath }),
      save: async (draft = {}) =>
        ipcRenderer.invoke("review-sessions:save", {
          rootPath: draft?.rootPath,
          directory: draft?.directory ?? "",
          scope: draft?.scope,
          view: draft?.view,
          anchorInstanceId: draft?.anchorInstanceId ?? null,
          anchorFingerprint: draft?.anchorFingerprint ?? null,
        }),
      clear: async (rootPath) =>
        ipcRenderer.invoke("review-sessions:clear", { rootPath }),
      onFlushRequested: (callback) => {
        if (typeof callback !== "function") return () => {};
        const handler = (_event, payload = {}) => {
          const requestId = typeof payload?.requestId === "string"
            ? payload.requestId
            : "";
          if (!requestId) return;
          callback(Object.freeze({ requestId }));
        };
        ipcRenderer.on("review-sessions:flush-requested", handler);
        return () =>
          ipcRenderer.removeListener("review-sessions:flush-requested", handler);
      },
      acknowledgeFlush: (requestId) => {
        if (typeof requestId !== "string" || !requestId) return false;
        ipcRenderer.send("review-sessions:flush-ack", { requestId });
        return true;
      },
    },
  },

  recent: {
    get: async () => ipcRenderer.invoke("recent:get"),
    add: async (folderPath) => ipcRenderer.invoke("recent:add", folderPath),
    remove: async (folderPath) =>
      ipcRenderer.invoke("recent:remove", folderPath),
    clear: async () => ipcRenderer.invoke("recent:clear"),
  },
});

contextBridge.exposeInMainWorld('appMem', {
  get: () => ipcRenderer.invoke('mem:get'),
});
