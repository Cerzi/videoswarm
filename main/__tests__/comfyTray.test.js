import { createRequire } from "module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createQueueTray, describeQueue } = require("../comfy-tray");

function fakeElectron() {
  const trays = [];
  class Tray {
    constructor(image) {
      this.image = image;
      this.handlers = {};
      this.destroyed = false;
      trays.push(this);
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    setToolTip(text) {
      this.tooltip = text;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    trays,
    Tray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: (file) => ({ file, resize: (size) => ({ file, size }) }) },
  };
}

const snapshot = (overrides = {}) => ({
  active: true,
  running: true,
  comfyUp: true,
  items: [{ state: "rendering" }, { state: "ready" }, { state: "done" }, { state: "blocked" }],
  ...overrides,
});

describe("queue tray", () => {
  it("says what the queue is doing", () => {
    expect(describeQueue(snapshot())).toBe("Rendering — 2 left");
    expect(describeQueue(snapshot({ items: [{ state: "waiting" }] }))).toBe("Queue running — 1 left");
    expect(describeQueue(snapshot({ comfyUp: false }))).toBe("Waiting for ComfyUI — 2 left");
    expect(describeQueue(snapshot({ active: false, running: false, items: [{ state: "ready" }] }))).toBe("Queue stopped — 1 left");
    expect(describeQueue(snapshot({ active: false, items: [] }))).toBe("Queue finished");
  });

  it("offers show, stop queue and quit, and goes away when destroyed", () => {
    const electron = fakeElectron();
    const onShow = vi.fn();
    const onStopQueue = vi.fn();
    const onQuit = vi.fn();
    const tray = createQueueTray({ ...electron, iconPath: "/icon.png", onShow, onStopQueue, onQuit });
    expect(tray.visible).toBe(false);
    tray.show(snapshot());
    tray.show(snapshot());
    expect(electron.trays).toHaveLength(1);
    const [icon] = electron.trays;
    expect(icon.image).toEqual({ file: "/icon.png", size: { width: 16, height: 16 } });
    expect(icon.tooltip).toBe("Video Swarm — Rendering — 2 left");
    const item = (label) => icon.menu.find((entry) => entry.label === label);
    item("Show Video Swarm").click();
    item("Stop queue").click();
    item("Quit").click();
    icon.handlers.click();
    expect([onShow.mock.calls.length, onStopQueue.mock.calls.length, onQuit.mock.calls.length]).toEqual([2, 1, 1]);

    tray.update(snapshot({ running: false }));
    expect(item("Stop queue").enabled).toBe(false);
    tray.destroy();
    expect(icon.destroyed).toBe(true);
    expect(tray.visible).toBe(false);
  });
});
