// main/native-video/index.js
// IPC surface + instance management. Idempotent registration and no duplicates.

const { ipcMain, BrowserWindow } = require('electron');
const { MpvController } = require('./mpv-controller');

class NativeVideoManager {
  constructor({ mpvPath = 'mpv' } = {}) {
    this.controller = new MpvController({ mpvPath });
    this._wired = false;
  }

  async init() {
    if (this._wired) return;
    this._wired = true;

    const ok = await this.controller.isAvailable();
    console.log('[nativeVideo] mpv available:', ok, `(path=${this.controller.mpvPath})`);

    const register = (channel, handler) => {
      // ensure idempotent handlers (dev HMR etc.)
      try { ipcMain.removeHandler(channel); } catch {}
      ipcMain.handle(channel, handler);
    };

    register('nativeVideo:isAvailable', async () => this.controller.isAvailable());

    register('nativeVideo:getContentBounds', async (event) => {
      try {
        const wc = event.sender;
        const win = BrowserWindow.fromWebContents(wc) || wc.hostWebContents?.hostWindow;
        const b = win?.getContentBounds?.();
        if (!b) throw new Error('no content bounds');
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      } catch (e) {
        console.warn('[nativeVideo] getContentBounds failed:', e?.message || e);
        return { x: 100, y: 100, width: 640, height: 360 };
      }
    });

    register('nativeVideo:create', async (_e, opts) => this.controller.create(opts));
    register('nativeVideo:setGeometry', async (_e, id, geom) => this.controller.setGeometry(id, geom));
    register('nativeVideo:play', async (_e, id) => this.controller.play(id));
    register('nativeVideo:pause', async (_e, id) => this.controller.pause(id));
    register('nativeVideo:destroy', async (_e, id) => this.controller.destroy(id));

    console.log('[nativeVideo] IPC handlers registered');
  }
}

module.exports = { NativeVideoManager };
