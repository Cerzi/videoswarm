const { app, BrowserWindow, shell, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

const defaultSettings = {
  recursiveMode: false,
  layoutMode: 'grid',
  autoplayEnabled: true,
  maxConcurrentPlaying: 30,
  zoomLevel: 1,
  windowBounds: {
    width: 1400,
    height: 900,
    x: undefined,
    y: undefined
  }
};



let mainWindow;

async function loadSettings() {
  try {
    const data = await fs.readFile(settingsPath, 'utf8');
    const settings = JSON.parse(data);
    console.log('Settings loaded:', settings);
    return { ...defaultSettings, ...settings };
  } catch (error) {
    console.log('No settings file found, using defaults');
    return defaultSettings;
  }
}

async function saveSettings(settings) {
  try {
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    console.log('Settings saved:', settings);
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

async function createWindow() {
  const settings = await loadSettings();

  mainWindow = new BrowserWindow({
    width: settings.windowBounds.width,
    height: settings.windowBounds.height,
    x: settings.windowBounds.x,
    y: settings.windowBounds.y,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    },
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default'
  });

  mainWindow.loadFile('index.html');

  // Send settings to renderer after page loads
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('settings-loaded', settings);
  });

  // Save window bounds when moved or resized
  mainWindow.on('moved', saveWindowBounds);
  mainWindow.on('resized', saveWindowBounds);

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// Create application menu with folder selection
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: 'Select Video Folder'
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('folder-selected', result.filePaths[0]);
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function saveWindowBounds() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    const settings = {
      windowBounds: bounds
    };

    // Don't wait for this async operation
    saveSettingsPartial(settings).catch(console.error);
  }
}

async function saveSettingsPartial(partialSettings) {
  try {
    const currentSettings = await loadSettings();
    const newSettings = { ...currentSettings, ...partialSettings };
    await saveSettings(newSettings);
  } catch (error) {
    console.error('Failed to save partial settings:', error);
  }
}

ipcMain.handle('save-settings', async (event, settings) => {
  await saveSettings(settings);
  return { success: true };
});

ipcMain.handle('load-settings', async (event) => {
  const settings = await loadSettings();
  return settings;
});

ipcMain.handle('save-settings-partial', async (event, partialSettings) => {
  await saveSettingsPartial(partialSettings);
  return { success: true };
});

ipcMain.handle('select-folder', async (event) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Video Folder'
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, folderPath: result.filePaths[0] };
    } else {
      return { success: false, canceled: true };
    }
  } catch (error) {
    console.error('Error showing folder dialog:', error);
    return { success: false, error: error.message };
  }
});

// Handle file manager opening
ipcMain.handle('show-item-in-folder', async (event, filePath) => {
  try {
    console.log('Attempting to show in folder:', filePath);
    shell.showItemInFolder(filePath);
    return { success: true };
  } catch (error) {
    console.error('Failed to show item in folder:', error);
    return { success: false, error: error.message };
  }
});

// Read directory and return video files
ipcMain.handle('read-directory', async (event, folderPath, recursive = false) => {
  try {
    console.log(`Reading directory: ${folderPath} (recursive: ${recursive})`);
    const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv', '.3gp', '.ogv'];
    const videoFiles = [];

    async function scanDirectory(dirPath, depth = 0) {
      const files = await fs.readdir(dirPath, { withFileTypes: true });

      for (const file of files) {
        const fullPath = path.join(dirPath, file.name);

        if (file.isFile()) {
          const ext = path.extname(file.name).toLowerCase();
          if (videoExtensions.includes(ext)) {
            videoFiles.push(fullPath);
          }
        } else if (file.isDirectory() && recursive && depth < 10) { // Limit depth to avoid infinite loops
          // Skip hidden directories and common non-media folders
          if (!file.name.startsWith('.') &&
              !['node_modules', 'System Volume Information', '$RECYCLE.BIN', '.git'].includes(file.name)) {
            try {
              await scanDirectory(fullPath, depth + 1);
            } catch (error) {
              console.warn(`Skipping directory ${fullPath}: ${error.message}`);
            }
          }
        }
      }
    }

    await scanDirectory(folderPath);

    console.log(`Found ${videoFiles.length} video files in ${folderPath} (recursive: ${recursive})`);
    return videoFiles.sort(); // Sort files alphabetically
  } catch (error) {
    console.error('Error reading directory:', error);
    throw error;
  }
});

// Get file info
ipcMain.handle('get-file-info', async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return {
      name: path.basename(filePath),
      size: stats.size,
      isFile: stats.isFile(),
      path: filePath
    };
  } catch (error) {
    console.error('Error getting file info:', error);
    return null;
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    await fs.unlink(filePath);
    return { success: true };
  } catch (error) {
    console.error('Failed to delete file:', error);
    return { success: false, error: error.message };
  }
});

// Move file to trash (safer than permanent deletion)
ipcMain.handle('move-to-trash', async (event, filePath) => {
  try {
    const result = await shell.trashItem(filePath);
    return { success: true };
  } catch (error) {
    console.error('Failed to move to trash:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('copy-file', async (event, sourcePath, destPath) => {
  try {
    await fs.copyFile(sourcePath, destPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-file-properties', async (event, filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      isDirectory: stats.isDirectory(),
      permissions: stats.mode
    };
  } catch (error) {
    return null;
  }
});

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('--no-sandbox');
}

app.whenReady().then(() => {
  createWindow();
  createMenu();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
