const { contextBridge, ipcRenderer } = require("electron");

/** @typedef {"active"|"warm"|"cold"} Profile */

const api = {
  isAvailable: async () => {
    if (process.platform !== "linux") return false;
    try { return await ipcRenderer.invoke("nativeVideo:isAvailable"); }
    catch { return false; }
  },

  /** @param {{file:string, profile?:Profile, geom?:{x:number,y:number,width:number,height:number}}} args */
  create: (args) => ipcRenderer.invoke("nativeVideo:create", args),
  destroy: (id) => ipcRenderer.invoke("nativeVideo:destroy", id),
  play: (id) => ipcRenderer.invoke("nativeVideo:play", id),
  pause: (id) => ipcRenderer.invoke("nativeVideo:pause", id),
  seek: (id, seconds) => ipcRenderer.invoke("nativeVideo:seek", id, seconds),
  setProfile: (id, profile) => ipcRenderer.invoke("nativeVideo:setProfile", id, profile),

  getContentBounds: () => ipcRenderer.invoke("nativeVideo:getContentBounds"),
  attachToTile: (id, rect) => ipcRenderer.invoke("nativeVideo:attachToTile", id, rect),

  /** @param {DOMRect} rect */
  fromClientRect: async (rect) => {
    const cb = await api.getContentBounds();
    return {
      x: Math.round(cb.x + rect.left),
      y: Math.round(cb.y + rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  },

  onWindowMoved: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("nativeVideo:window-moved", handler);
    return () => ipcRenderer.off("nativeVideo:window-moved", handler);
  },
};

contextBridge.exposeInMainWorld("NativeVideo", api);
