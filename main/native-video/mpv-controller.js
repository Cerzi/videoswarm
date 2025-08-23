// Linux-only MPV controller (Phase 1): spawns and drives one mpv per player via JSON IPC.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/**
 * @typedef {"active"|"warm"|"cold"} Profile
 * @typedef {{x:number,y:number,width:number,height:number}} Rect
 * @typedef {{file: string, profile?: Profile, geom?: Rect}} CreateArgs
 */

/**
 * @typedef {Object} PlayerState
 * @property {string} id
 * @property {string} file
 * @property {Profile} profile
 * @property {string} sockPath
 * @property {import("node:child_process").ChildProcessWithoutNullStreams} proc
 * @property {string} mpvPath
 * @property {import("node:net").Socket|undefined} socket
 * @property {Rect|undefined} geom
 */

class MpvController {
  /**
   * @param {string=} mpvPathFromEnv
   */
  constructor(mpvPathFromEnv) {
    this.players = new Map();
    this.mpvPath = mpvPathFromEnv || process.env.CLIPB_MPV_PATH || "mpv";
  }

  list() {
    return [...this.players.values()];
  }

  /**
   * @param {CreateArgs} args
   * @returns {Promise<PlayerState>}
   */
  async create(args) {
    const id = randomUUID();
    const sockPath = path.join("/tmp", `clipb-mpv-${id}.sock`);

    const baseArgs = [
      "--no-config",
      "--idle=yes",
      "--force-window=yes",
      "--keep-open=yes",
      "--osc=no",
      "--no-input-default-bindings",
      "--really-quiet",
      "--mute=yes",
      "--loop-file=inf",
      "--hwdec=auto",
      "--vo=gpu-next",
      `--input-ipc-server=${sockPath}`,
      "--title=clipb-mpv",
      "--untimed",
      "--no-terminal",
      "--border=no",
    ];

    if (args.geom) {
      const { width, height, x, y } = args.geom;
      baseArgs.push(`--geometry=${width}x${height}+${x}+${y}`);
    }

    const proc = spawn(this.mpvPath, baseArgs, { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("exit", () => {
      try { fs.rmSync(sockPath); } catch {}
      this.players.delete(id);
    });

    /** @type {PlayerState} */
    const st = {
      id,
      file: args.file,
      profile: args.profile || "active",
      sockPath,
      proc,
      mpvPath: this.mpvPath,
      geom: args.geom,
      socket: undefined,
    };

    this.players.set(id, st);

    await this._waitForSocket(sockPath, 4000);
    st.socket = await this._connectSock(sockPath);

    await this._send(st, ["set", "pause", "yes"]);
    await this._applyProfile(st, st.profile);
    await this._loadFile(st, args.file);

    return st;
  }

  async destroy(id) {
    const st = this.players.get(id);
    if (!st) return;
    try { await this._send(st, ["quit"]); } catch {}
    try { st.socket && st.socket.destroy(); } catch {}
    try { st.proc.kill("SIGTERM"); } catch {}
    this.players.delete(id);
  }

  async play(id) {
    const st = this.players.get(id);
    if (!st) return;
    await this._send(st, ["set", "pause", "no"]);
  }

  async pause(id) {
    const st = this.players.get(id);
    if (!st) return;
    await this._send(st, ["set", "pause", "yes"]);
  }

  async seek(id, seconds) {
    const st = this.players.get(id);
    if (!st) return;
    await this._send(st, ["seek", seconds, "absolute", "exact"]);
  }

  /** @param {string} id @param {Profile} p */
  async setProfile(id, p) {
    const st = this.players.get(id);
    if (!st) return;
    st.profile = p;
    await this._applyProfile(st, p);
  }

  /** @param {string} id @param {Rect} geom */
  async setGeometry(id, geom) {
    const st = this.players.get(id);
    if (!st) return;
    st.geom = geom;
    const g = `${geom.width}x${geom.height}+${geom.x}+${geom.y}`;
    await this._setProp(st, "geometry", g);
  }

  // --- internals ---

  /** @param {PlayerState} st @param {string} file */
  async _loadFile(st, file) {
    await this._command(st, ["loadfile", file, "replace"]);
    await this._setProp(st, "loop-file", "inf");
    await this._setProp(st, "volume", 0);
    await this._setProp(st, "aid", "no");
    await this._setProp(st, "hwdec", "auto");
  }

  /** @param {PlayerState} st @param {Profile} p */
  async _applyProfile(st, p) {
    if (p === "cold") {
      await this.pause(st.id);
      return;
    }
    if (p === "warm") {
      await this._setFilters(st, { longEdge: 360 });
      await this._setProp(st, "video-sync", "display-resample");
      await this._setProp(st, "mf-fps", "10");
      return;
    }
    // active
    await this._setFilters(st, { longEdge: 720 });
    await this._setProp(st, "video-sync", "display-resample");
    await this._setProp(st, "mf-fps", "30");
  }

  /** @param {PlayerState} st @param {{longEdge:number}} opts */
  async _setFilters(st, opts) {
    const f = `scale=w=${opts.longEdge}:h=-2`;
    await this._setProp(st, "vf", f);
  }

  async _setProp(st, name, value) {
    await this._command(st, ["set_property", name, value]);
  }

  async _command(st, args) {
    await this._send(st, args);
  }

  _waitForSocket(sockPath, timeoutMs) {
    return new Promise((res, rej) => {
      const start = Date.now();
      const t = setInterval(() => {
        if (fs.existsSync(sockPath)) {
          clearInterval(t);
          res();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(t);
          rej(new Error("mpv IPC socket not found"));
        }
      }, 50);
    });
  }

  _connectSock(sockPath) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(sockPath);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  }

  _send(st, args) {
    return new Promise((resolve, reject) => {
      if (!st.socket) return reject(new Error("socket not ready"));
      const payload = JSON.stringify({ command: args }) + "\n";
      st.socket.write(payload, (err) => (err ? reject(err) : resolve()));
    });
  }
}

module.exports = { MpvController };
