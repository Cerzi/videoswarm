// Linux-only NativeVideoManager: bridges Electron IPC to MpvController.

const { BrowserWindow, ipcMain } = require("electron");
const { MpvController } = require("./mpv-controller");

const isLinux = process.platform === "linux";

class NativeVideoManager {
  /**
   * @param {import('electron').BrowserWindow} mainWindow
   */
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.mpv = new MpvController(process.env.CLIPB_MPV_PATH);
  }

  async init() {
    if (!isLinux) return;

    ipcMain.handle("nativeVideo:isAvailable", () => true);

    ipcMain.handle("nativeVideo:create", async (e, args) => {
      const st = await this.mpv.create(args);
      return st.id;
    });

    ipcMain.handle("nativeVideo:destroy", async (e, id) => this.mpv.destroy(id));
    ipcMain.handle("nativeVideo:play", async (e, id) => this.mpv.play(id));
    ipcMain.handle("nativeVideo:pause", async (e, id) => this.mpv.pause(id));
    ipcMain.handle("nativeVideo:seek", async (e, id, s) => this.mpv.seek(id, s));
    ipcMain.handle("nativeVideo:setProfile", async (e, id, p) => this.mpv.setProfile(id, p));

    ipcMain.handle("nativeVideo:getContentBounds", (e) => {
      const win = BrowserWindow.fromWebContents(e.sender) || this.mainWindow;
      return win.getContentBounds();
    });

    ipcMain.handle("nativeVideo:attachToTile", async (e, id, rect) => {
      await this.mpv.setGeometry(id, rect);
    });

    this.mainWindow.on("move", () => this.mainWindow.webContents.send("nativeVideo:window-moved"));
    this.mainWindow.on("resize", () => this.mainWindow.webContents.send("nativeVideo:window-moved"));
  }
}

module.exports = { NativeVideoManager };
