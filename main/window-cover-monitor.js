const { execFile: defaultExecFile } = require("child_process");

// Whether the main window is hidden behind other windows, for the optional
// "pause while covered" playback setting.
//
// Chromium tracks window occlusion only on Windows and macOS. On X11 the
// window manager publishes the stacking order (EWMH
// _NET_CLIENT_LIST_STACKING), and each client's geometry and map state are
// readable with xprop and xwininfo in a few milliseconds. Wayland deliberately
// exposes none of this, so the setting is unavailable there.
//
// Checks run only while the setting is on and the window is visible and
// unfocused: a focused window is on top. The window counts as covered when
// the mapped windows stacked above it leave less than 1% of it visible on two
// consecutive checks. Any visible part resumes playback at once, so working
// on another monitor never pauses a grid that is still in view. Anything the
// monitor cannot establish counts as visible.

const WINDOW_COVER_DEFAULTS = Object.freeze({
  intervalMs: 1500,
  firstCheckDelayMs: 400,
  confirmChecks: 2,
  maxVisibleFraction: 0.01,
  maxWindowsAbove: 48,
  commandTimeoutMs: 1000,
});

const WINDOW_EVENTS = ["focus", "blur", "minimize", "restore", "show", "hide"];

function parseWindowIds(text) {
  const list = String(text || "").split("#")[1] || "";
  return (list.match(/0x[0-9a-f]+/gi) || []).map((id) => Number.parseInt(id, 16));
}

function parseGeometry(text) {
  const value = (label) => {
    const match = String(text || "").match(new RegExp(`${label}:\\s*(-?\\d+)`));
    return match ? Number(match[1]) : null;
  };
  const x = value("Absolute upper-left X");
  const y = value("Absolute upper-left Y");
  const width = value("Width");
  const height = value("Height");
  if ([x, y, width, height].some((part) => part === null)) return null;
  return {
    x,
    y,
    width,
    height,
    viewable: /Map State:\s*IsViewable/.test(String(text)),
  };
}

/** The fraction of `target` that none of `covers` overlap, from 0 to 1. */
function visibleFraction(target, covers) {
  const area = target.width * target.height;
  if (!(area > 0)) return 0;
  const right = target.x + target.width;
  const bottom = target.y + target.height;
  const clipped = covers
    .map((rect) => ({
      left: Math.max(target.x, rect.x),
      top: Math.max(target.y, rect.y),
      right: Math.min(right, rect.x + rect.width),
      bottom: Math.min(bottom, rect.y + rect.height),
    }))
    .filter((rect) => rect.left < rect.right && rect.top < rect.bottom);
  if (!clipped.length) return 1;

  // Few windows overlap, so exact union area by coordinate compression.
  const xs = [...new Set([target.x, right, ...clipped.flatMap((r) => [r.left, r.right])])]
    .sort((a, b) => a - b);
  const ys = [...new Set([target.y, bottom, ...clipped.flatMap((r) => [r.top, r.bottom])])]
    .sort((a, b) => a - b);
  let coveredArea = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < ys.length - 1; j += 1) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      if (clipped.some((r) => cx > r.left && cx < r.right && cy > r.top && cy < r.bottom)) {
        coveredArea += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      }
    }
  }
  return Math.max(0, (area - coveredArea) / area);
}

/** Whether this session can be checked at all, before probing the tools. */
function x11CoverSupport({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "linux") {
    return { supported: false, reason: "Available on Linux with X11." };
  }
  if (String(env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland") {
    return { supported: false, reason: "Wayland does not report covered windows." };
  }
  if (!env.DISPLAY) {
    return { supported: false, reason: "No X11 display was found." };
  }
  return { supported: true, reason: null };
}

function nativeWindowId(window) {
  try {
    const handle = window?.getNativeWindowHandle?.();
    if (!Buffer.isBuffer(handle) || handle.length < 4) return null;
    const id = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

class WindowCoverMonitor {
  constructor(options = {}) {
    this.limits = { ...WINDOW_COVER_DEFAULTS, ...(options.limits || {}) };
    this.execFile = options.execFile || defaultExecFile;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.support = x11CoverSupport({ platform: options.platform, env: options.env });
    this.toolsAvailable = null; // unknown until probed
    this.enabled = false;
    this.window = null;
    this.onChange = null;
    this.detachWindow = null;
    this.timer = null;
    this.generation = 0;
    this.coveredStreak = 0;
    this.covered = false;
  }

  #run(command, args) {
    return new Promise((resolve, reject) => {
      this.execFile(
        command,
        args,
        { timeout: this.limits.commandTimeoutMs, maxBuffer: 256 * 1024, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(String(stdout)))
      );
    });
  }

  /** Whether the setting can work here; probes xprop and xwininfo once. */
  async getAvailability() {
    if (!this.support.supported) {
      return { available: false, reason: this.support.reason };
    }
    if (this.toolsAvailable === null) {
      try {
        await this.#run("xprop", ["-root", "-notype", "_NET_CLIENT_LIST_STACKING"]);
        await this.#run("xwininfo", ["-version"]);
        this.toolsAvailable = true;
      } catch {
        this.toolsAvailable = false;
      }
    }
    return this.toolsAvailable
      ? { available: true, reason: null }
      : { available: false, reason: "Needs xprop and xwininfo (the x11-utils package)." };
  }

  attach(window, onChange) {
    this.detach();
    this.window = window;
    this.onChange = typeof onChange === "function" ? onChange : null;
    const update = () => this.#update();
    for (const name of WINDOW_EVENTS) window?.on?.(name, update);
    const closed = () => this.detach();
    window?.once?.("closed", closed);
    this.detachWindow = () => {
      for (const name of WINDOW_EVENTS) window?.removeListener?.(name, update);
      window?.removeListener?.("closed", closed);
    };
    this.#update();
    return () => {
      if (this.window === window) this.detach();
    };
  }

  detach() {
    this.detachWindow?.();
    this.detachWindow = null;
    this.window = null;
    this.#stop();
    this.covered = false;
    this.onChange = null;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.#update();
    return this.getSnapshot();
  }

  getSnapshot() {
    return { enabled: this.enabled, covered: this.covered, supported: this.support.supported };
  }

  #shouldWatch() {
    const window = this.window;
    if (!this.enabled || !this.support.supported || this.toolsAvailable === false) return false;
    if (!window || window.isDestroyed?.()) return false;
    return !window.isFocused?.() && window.isVisible?.() !== false && !window.isMinimized?.();
  }

  #update() {
    if (!this.#shouldWatch()) {
      this.#stop();
      this.#report(false);
      return;
    }
    if (this.timer === null) this.#schedule(this.limits.firstCheckDelayMs);
  }

  #stop() {
    this.generation += 1;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.coveredStreak = 0;
  }

  #schedule(delay) {
    const generation = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (generation !== this.generation) return;
      this.#check(generation);
    }, delay);
  }

  async #check(generation) {
    let covered = false;
    try {
      if (this.toolsAvailable === null) await this.getAvailability();
      covered = await this.#isCovered();
    } catch {
      covered = false;
    }
    if (generation !== this.generation || !this.#shouldWatch()) return;
    this.coveredStreak = covered ? this.coveredStreak + 1 : 0;
    // Pause only once covering has lasted; resume as soon as anything shows.
    if (!covered) this.#report(false);
    else if (this.coveredStreak >= this.limits.confirmChecks) this.#report(true);
    this.#schedule(this.limits.intervalMs);
  }

  async #isCovered() {
    const ownId = nativeWindowId(this.window);
    if (!ownId || this.toolsAvailable === false) return false;
    const stacking = parseWindowIds(
      await this.#run("xprop", ["-root", "-notype", "_NET_CLIENT_LIST_STACKING"])
    );
    const index = stacking.indexOf(ownId);
    if (index < 0) return false;
    const above = stacking.slice(index + 1);
    if (above.length > this.limits.maxWindowsAbove) return false;

    const geometries = await Promise.all(
      [ownId, ...above].map((id) =>
        this.#run("xwininfo", ["-id", `0x${id.toString(16)}`])
          .then(parseGeometry)
          .catch(() => null)
      )
    );
    const [own, ...others] = geometries;
    if (!own) return false;
    // An unmapped window (another virtual desktop) shows nothing at all.
    if (!own.viewable) return true;
    const covers = others.filter((geometry) => geometry?.viewable);
    return visibleFraction(own, covers) < this.limits.maxVisibleFraction;
  }

  #report(covered) {
    if (this.covered === covered) return;
    this.covered = covered;
    try {
      this.onChange?.(covered);
    } catch {
      // A destroyed renderer cannot be told; detach handles cleanup.
    }
  }
}

function createWindowCoverMonitor(options) {
  return new WindowCoverMonitor(options);
}

module.exports = {
  WINDOW_COVER_DEFAULTS,
  WindowCoverMonitor,
  createWindowCoverMonitor,
  nativeWindowId,
  parseGeometry,
  parseWindowIds,
  visibleFraction,
  x11CoverSupport,
};
