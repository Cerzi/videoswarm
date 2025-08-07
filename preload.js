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

  // Platform detection
  platform: process.platform,
  isElectron: true
});
