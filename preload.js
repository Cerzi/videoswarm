const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('electronAPI', {
  // File manager integration
  showItemInFolder: async (filePath) => {
    return await ipcRenderer.invoke('show-item-in-folder', filePath);
  },

  // Open external links
  openExternal: async (url) => {
    return await ipcRenderer.invoke('open-external', url);
  },

  // Get app info
  getAppVersion: () => process.env.npm_package_version || '1.0.0',

  // Platform detection
  platform: process.platform,

  // Path utilities for better file handling
  joinPath: (...args) => path.join(...args),
  basename: (filePath) => path.basename(filePath),
  dirname: (filePath) => path.dirname(filePath)
});

// Listen for folder selection from menu
ipcRenderer.on('folder-selected', (event, folderPath) => {
  // You can add custom logic here to handle folder selection from menu
  console.log('Folder selected from menu:', folderPath);
});
