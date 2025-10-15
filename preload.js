const { contextBridge, ipcRenderer } = require("electron");

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // Platform detection
  platform: process.platform,
  isElectron: true,

  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // File manager integration
  showItemInFolder: async (filePath) => {
    return await ipcRenderer.invoke("show-item-in-folder", filePath);
  },

  // Directory reading with enhanced metadata
  readDirectory: async (folderPath, recursive = false) => {
    return await ipcRenderer.invoke("read-directory", folderPath, recursive);
  },

  // File system watching
  startFolderWatch: async (folderPath) => {
    return await ipcRenderer.invoke("start-folder-watch", folderPath);
  },

  stopFolderWatch: async () => {
    return await ipcRenderer.invoke("stop-folder-watch");
  },

  // File system events
  onFileAdded: (callback) => {
    ipcRenderer.on("file-added", (event, videoFile) => callback(videoFile));
  },

  onFileRemoved: (callback) => {
    ipcRenderer.on("file-removed", (event, filePath) => callback(filePath));
  },

  onFileChanged: (callback) => {
    ipcRenderer.on("file-changed", (event, videoFile) => callback(videoFile));
  },

  onFileWatchError: (callback) => {
    ipcRenderer.on("file-watch-error", (event, error) => callback(error));
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
    ipcRenderer.on("folder-selected", (event, folderPath) => {
      callback(folderPath);
    });
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