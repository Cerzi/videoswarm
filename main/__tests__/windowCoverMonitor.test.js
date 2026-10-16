import { EventEmitter } from "events";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createWindowCoverMonitor,
  nativeWindowId,
  parseGeometry,
  parseWindowIds,
  visibleFraction,
  x11CoverSupport,
} = require("../window-cover-monitor");

const X11 = { platform: "linux", env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" } };
const OWN = 0x5e0000a;

const xwininfo = ({ x, y, width, height, viewable = true }) => `
xwininfo: Window id: 0x0 "clip"

  Absolute upper-left X:  ${x}
  Absolute upper-left Y:  ${y}
  Relative upper-left X:  0
  Relative upper-left Y:  0
  Width: ${width}
  Height: ${height}
  Map State: ${viewable ? "IsViewable" : "IsUnMapped"}
`;

class FakeWindow extends EventEmitter {
  constructor(id = OWN) {
    super();
    this.focused = false;
    this.visible = true;
    this.minimized = false;
    this.handle = Buffer.alloc(8);
    this.handle.writeBigUInt64LE(BigInt(id));
  }
  isFocused() { return this.focused; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  isDestroyed() { return false; }
  getNativeWindowHandle() { return this.handle; }
}

// A fake X server: stacking bottom to top, and each window's geometry.
function fakeX11(layout) {
  const execFile = vi.fn((command, args, _options, callback) => {
    let stdout = "";
    if (command === "xprop") {
      stdout = `_NET_CLIENT_LIST_STACKING: window id # ${layout.stacking
        .map((id) => `0x${id.toString(16)}`)
        .join(", ")}`;
    } else if (command === "xwininfo" && args[0] === "-version") {
      stdout = "xwininfo 1.1.6";
    } else if (command === "xwininfo") {
      const geometry = layout.geometry[Number.parseInt(args[1], 16)];
      if (!geometry) {
        queueMicrotask(() => callback(new Error("BadWindow")));
        return;
      }
      stdout = xwininfo(geometry);
    }
    queueMicrotask(() => callback(null, stdout));
  });
  return execFile;
}

const settle = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

describe("window cover parsing and geometry", () => {
  it("reads window ids and xwininfo geometry", () => {
    expect(parseWindowIds("_NET_CLIENT_LIST_STACKING: window id # 0x2000011, 0xa0000a")).toEqual([
      0x2000011, 0xa0000a,
    ]);
    expect(parseWindowIds("_NET_CLIENT_LIST_STACKING:  not found.")).toEqual([]);
    expect(parseGeometry(xwininfo({ x: -10, y: 20, width: 300, height: 200 }))).toEqual({
      x: -10, y: 20, width: 300, height: 200, viewable: true,
    });
    expect(parseGeometry("garbage")).toBeNull();
  });

  it("measures the visible fraction under overlapping windows exactly", () => {
    const target = { x: 0, y: 0, width: 100, height: 100 };
    expect(visibleFraction(target, [])).toBe(1);
    expect(visibleFraction(target, [{ x: 0, y: 0, width: 50, height: 100 }])).toBe(0.5);
    // Two overlapping halves cover the whole window once, not twice.
    expect(
      visibleFraction(target, [
        { x: 0, y: 0, width: 60, height: 100 },
        { x: 40, y: 0, width: 60, height: 100 },
      ])
    ).toBe(0);
    // A window on another monitor does not touch it.
    expect(visibleFraction(target, [{ x: 200, y: 0, width: 500, height: 500 }])).toBe(1);
    expect(visibleFraction(target, [{ x: -50, y: -50, width: 200, height: 200 }])).toBe(0);
  });

  it("is supported only on X11 sessions", () => {
    expect(x11CoverSupport(X11).supported).toBe(true);
    expect(x11CoverSupport({ platform: "win32", env: {} }).supported).toBe(false);
    expect(
      x11CoverSupport({ platform: "linux", env: { DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" } })
        .supported
    ).toBe(false);
    expect(x11CoverSupport({ platform: "linux", env: {} }).supported).toBe(false);
  });

  it("reads the X11 id from the native window handle", () => {
    expect(nativeWindowId(new FakeWindow(OWN))).toBe(OWN);
    expect(nativeWindowId({ getNativeWindowHandle: () => Buffer.alloc(8) })).toBeNull();
    expect(nativeWindowId(null)).toBeNull();
  });
});

describe("window cover monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const OWN_RECT = { x: 0, y: 0, width: 1000, height: 800 };
  const COVER = { x: -20, y: -20, width: 2000, height: 2000 };
  const ELSEWHERE = { x: 3840, y: 0, width: 2560, height: 1440 };

  async function setup(layout, { enabled = true } = {}) {
    const execFile = fakeX11(layout);
    const monitor = createWindowCoverMonitor({ ...X11, execFile });
    const window = new FakeWindow();
    const changes = [];
    monitor.attach(window, (covered) => changes.push(covered));
    monitor.setEnabled(enabled);
    return { monitor, window, changes, execFile };
  }

  const tick = async (ms) => {
    vi.advanceTimersByTime(ms);
    await settle();
  };

  it("pauses only after the window stays fully covered, and resumes at once", async () => {
    const layout = {
      stacking: [OWN, 0xa1],
      geometry: { [OWN]: OWN_RECT, 0xa1: COVER },
    };
    const { window, changes } = await setup(layout);

    await tick(400); // first check: covered once
    expect(changes).toEqual([]);
    await tick(1500); // confirmed
    expect(changes).toEqual([true]);

    layout.geometry[0xa1] = ELSEWHERE; // the cover moves to another monitor
    await tick(1500);
    expect(changes).toEqual([true, false]);

    layout.geometry[0xa1] = COVER;
    await tick(1500);
    await tick(1500);
    expect(changes).toEqual([true, false, true]);

    window.focused = true;
    window.emit("focus");
    expect(changes).toEqual([true, false, true, false]);
  });

  it("keeps playing while visible on another monitor or partly uncovered", async () => {
    const { changes } = await setup({
      stacking: [OWN, 0xa1, 0xa2],
      geometry: {
        [OWN]: OWN_RECT,
        0xa1: ELSEWHERE,
        0xa2: { x: 0, y: 0, width: 1000, height: 700 }, // 12.5% stays visible
      },
    });
    await tick(400);
    await tick(1500);
    await tick(1500);
    expect(changes).toEqual([]);
  });

  it("ignores unmapped windows above and treats its own unmapping as hidden", async () => {
    const layout = {
      stacking: [OWN, 0xa1],
      geometry: { [OWN]: OWN_RECT, 0xa1: { ...COVER, viewable: false } },
    };
    const { changes } = await setup(layout);
    await tick(400);
    await tick(1500);
    expect(changes).toEqual([]);

    layout.geometry[OWN] = { ...OWN_RECT, viewable: false }; // another desktop
    await tick(1500);
    await tick(1500);
    expect(changes).toEqual([true]);
  });

  it("checks nothing while focused, minimized or disabled, and fails open", async () => {
    const layout = {
      stacking: [OWN, 0xa1],
      geometry: { [OWN]: OWN_RECT, 0xa1: COVER },
    };
    const disabled = await setup(layout, { enabled: false });
    await tick(5000);
    expect(disabled.execFile).not.toHaveBeenCalled();

    const { window, changes, execFile } = await setup(layout);
    window.focused = true;
    window.emit("focus");
    await tick(5000);
    expect(execFile).not.toHaveBeenCalled();

    window.focused = false;
    window.minimized = true;
    window.emit("blur");
    await tick(5000);
    expect(execFile).not.toHaveBeenCalled();

    // Our window missing from the stacking list counts as visible.
    window.minimized = false;
    layout.stacking = [0xa1];
    window.emit("restore");
    await tick(400);
    await tick(1500);
    expect(changes).toEqual([]);
  });

  it("reports unavailability without the X11 tools", async () => {
    const execFile = vi.fn((_command, _args, _options, callback) =>
      queueMicrotask(() => callback(Object.assign(new Error("spawn xprop ENOENT"), { code: "ENOENT" })))
    );
    const monitor = createWindowCoverMonitor({ ...X11, execFile });
    await expect(monitor.getAvailability()).resolves.toMatchObject({ available: false });
    const wayland = createWindowCoverMonitor({
      platform: "linux",
      env: { DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" },
      execFile,
    });
    await expect(wayland.getAvailability()).resolves.toMatchObject({
      available: false,
      reason: expect.stringContaining("Wayland"),
    });
  });
});
