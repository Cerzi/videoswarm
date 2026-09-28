// The tray icon that keeps Video Swarm running while a re-render queue is
// active and its window is closed: Show, Stop queue, Quit. Electron's Tray,
// Menu and nativeImage are passed in, so the behaviour is testable.
// See docs/architecture/comfy-queue-integration.md, Section 7.

function describeQueue(snapshot) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const left = items.filter((item) => ['ready', 'waiting', 'rendering'].includes(item.state)).length;
  const rendering = items.some((item) => item.state === 'rendering');
  if (!snapshot?.active) return left ? `Queue stopped — ${left} left` : 'Queue finished';
  if (snapshot.comfyUp === false) return `Waiting for ComfyUI — ${left} left`;
  return `${rendering ? 'Rendering' : 'Queue running'} — ${left} left`;
}

function createQueueTray({ Tray, Menu, nativeImage, iconPath, onShow, onStopQueue, onQuit }) {
  let tray = null;

  function menuFor(snapshot) {
    return Menu.buildFromTemplate([
      { label: describeQueue(snapshot), enabled: false },
      { type: 'separator' },
      { label: 'Show Video Swarm', click: () => onShow() },
      { label: 'Stop queue', enabled: Boolean(snapshot?.running), click: () => onStopQueue() },
      { type: 'separator' },
      { label: 'Quit', click: () => onQuit() },
    ]);
  }

  return {
    show(snapshot) {
      if (!tray) {
        const image = nativeImage.createFromPath(iconPath);
        tray = new Tray(typeof image.resize === 'function' ? image.resize({ width: 16, height: 16 }) : image);
        tray.on?.('click', () => onShow());
      }
      this.update(snapshot);
    },
    update(snapshot) {
      if (!tray) return;
      tray.setToolTip(`Video Swarm — ${describeQueue(snapshot)}`);
      tray.setContextMenu(menuFor(snapshot));
    },
    destroy() {
      tray?.destroy();
      tray = null;
    },
    get visible() {
      return Boolean(tray);
    },
  };
}

module.exports = { createQueueTray, describeQueue };
