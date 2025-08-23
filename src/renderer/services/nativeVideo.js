// Thin wrapper around window.NativeVideo for nicer imports
export const NativeVideo = {
  isAvailable: async () => (window.NativeVideo?.isAvailable?.() ?? false),
  create: (args) => window.NativeVideo.create(args),
  destroy: (id) => window.NativeVideo.destroy(id),
  play: (id) => window.NativeVideo.play(id),
  pause: (id) => window.NativeVideo.pause(id),
  seek: (id, s) => window.NativeVideo.seek(id, s),
  setProfile: (id, p) => window.NativeVideo.setProfile(id, p),
  attachToTile: (id, rect) => window.NativeVideo.attachToTile(id, rect),
  fromClientRect: (r) => window.NativeVideo.fromClientRect(r),
  onWindowMoved: (cb) => window.NativeVideo.onWindowMoved(cb),
};
