const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File manager integration
  showItemInFolder: async (filePath) => {
    return await ipcRenderer.invoke('show-item-in-folder', filePath);
  },

  // Directory reading
  readDirectory: async (folderPath, recursive = false) => {
    return await ipcRenderer.invoke('read-directory', folderPath, recursive);
  },

  // Get file info
  getFileInfo: async (filePath) => {
    return await ipcRenderer.invoke('get-file-info', filePath);
  },

  // Folder selection dialog
  selectFolder: async () => {
    return await ipcRenderer.invoke('select-folder');
  },

  // Listen for folder selection from menu
  onFolderSelected: (callback) => {
    ipcRenderer.on('folder-selected', (event, folderPath) => {
      callback(folderPath);
    });
  },

  saveSettings: async (settings) => {
    return await ipcRenderer.invoke('save-settings', settings);
  },

  loadSettings: async () => {
    return await ipcRenderer.invoke('load-settings');
  },

  saveSettingsPartial: async (partialSettings) => {
    return await ipcRenderer.invoke('save-settings-partial', partialSettings);
  },

  onSettingsLoaded: (callback) => {
    ipcRenderer.on('settings-loaded', (event, settings) => {
      callback(settings);
    });
  },

  // Platform detection
  platform: process.platform,
  isElectron: true
});
