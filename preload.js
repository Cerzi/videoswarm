const { contextBridge, ipcRenderer } = require("electron");

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
  readDirectory: async (folderPath, recursive = false) => {
    return await ipcRenderer.invoke("read-directory", folderPath, recursive);
  },

  // File system watching
  startFolderWatch: async (folderPath, recursive) => {
    return await ipcRenderer.invoke(
      "start-folder-watch",
      folderPath,
      recursive
    );
  },

  stopFolderWatch: async () => {
    return await ipcRenderer.invoke("stop-folder-watch");
  },

  // File system events
  onFileAdded: (callback) => {
    const handler = (_event, videoFile) => callback(videoFile);
    ipcRenderer.on("file-added", handler);
    return () => ipcRenderer.removeListener("file-added", handler);
  },

  onFileRemoved: (callback) => {
    const handler = (_event, filePath) => callback(filePath);
    ipcRenderer.on("file-removed", handler);
    return () => ipcRenderer.removeListener("file-removed", handler);
  },

  onFileChanged: (callback) => {
    const handler = (_event, videoFile) => callback(videoFile);
    ipcRenderer.on("file-changed", handler);
    return () => ipcRenderer.removeListener("file-changed", handler);
  },

  onFileWatchError: (callback) => {
    const handler = (_event, error) => callback(error);
    ipcRenderer.on("file-watch-error", handler);
    return () => ipcRenderer.removeListener("file-watch-error", handler);
  },

  // Get file info
  getFileInfo: async (filePath) => {
    return await ipcRenderer.invoke("get-file-info", filePath);
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
    ipcRenderer.on("settings-loaded", (event, settings) => {
      callback(settings);
    });
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

  // Additional file operations (from your main.js)
  bulkMoveToTrash: async (paths) => {
    return await ipcRenderer.invoke('bulk-move-to-trash', paths);
  },
  moveToTrash: async (filePath) => {
    return await ipcRenderer.invoke("move-to-trash", filePath);
  },

  confirmMoveToTrash: async (payload) => {
    const result = await ipcRenderer.invoke("confirm-move-to-trash", payload);
    if (typeof result === "boolean") return result;
    if (result && typeof result.confirmed === "boolean") {
      return result.confirmed;
    }
    return !!result;
  },

  copyFile: async (sourcePath, destPath) => {
    return await ipcRenderer.invoke("copy-file", sourcePath, destPath);
  },

  getFileProperties: async (filePath) => {
    return await ipcRenderer.invoke("get-file-properties", filePath);
  },

  // External player integration
  openInExternalPlayer: async (filePath) => {
    return await ipcRenderer.invoke("open-in-external-player", filePath);
  },

  startFileDragSync: (paths) => {
    const normalize = (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") return [value];
      if (value && Array.isArray(value.paths)) return value.paths;
      return [];
    };
    const payloadPaths = normalize(paths).filter(
      (entry) => typeof entry === "string" && entry.trim().length > 0
    );
    if (!payloadPaths.length) {
      return { ok: false, error: "NO_FILE" };
    }
    return ipcRenderer.sendSync("dnd:start-file", { paths: payloadPaths });
  },

  thumbs: {
    put: (payload) => ipcRenderer.sendSync("thumb:put", payload),
    get: (payload) => ipcRenderer.sendSync("thumb:get", payload),
  },

  // Clipboard operations
  copyToClipboard: async (text) => {
    return await ipcRenderer.invoke("copy-to-clipboard", text);
  },



  metadata: {
    listTags: async () => ipcRenderer.invoke("metadata:list-tags"),
    addTags: async (fingerprints, tagNames) =>
      ipcRenderer.invoke("metadata:add-tags", fingerprints, tagNames),
    removeTag: async (fingerprints, tagName) =>
      ipcRenderer.invoke("metadata:remove-tag", fingerprints, tagName),
    setRating: async (fingerprints, rating) =>
      ipcRenderer.invoke("metadata:set-rating", fingerprints, rating),
    get: async (fingerprints) =>
      ipcRenderer.invoke("metadata:get", fingerprints),
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