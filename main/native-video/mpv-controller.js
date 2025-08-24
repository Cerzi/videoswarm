// main/native-video/mpv-controller.js
// mpv lifecycle, IPC JSON socket, GPU-first configuration (NVDEC), robust fallbacks.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function toInt(n, fb = 0) { const v = Number(n); return Number.isFinite(v) ? Math.round(v) : fb; }

function clampGeom(g) {
  const MIN_W = 160, MIN_H = 90;
  if (!g) return null;
  const { x, y, width, height } = g;
  const sane =
    Number.isFinite(x) && Number.isFinite(y) &&
    Number.isFinite(width) && Number.isFinite(height) &&
    width > 1 && height > 1;
  if (!sane) return null;
  return {
    x: toInt(x),
    y: toInt(y),
    width: Math.max(toInt(width), MIN_W),
    height: Math.max(toInt(height), MIN_H),
  };
}

const SOCK_BASE = '/tmp/mpv-video-swarm';
const LOG_BASE = '/tmp/mpv-vswarm';

async function pathExists(p) {
  try { await fsp.access(p, fs.constants.F_OK); return true; }
  catch { return false; }
}

class MpvInstance {
  constructor({ id, mpvPath, file, geom, profile }) {
    this.id = id;
    this.mpvPath = mpvPath;
    this.file = file;
    this.geom = clampGeom(geom);
    this.profile = profile;
    this.proc = null;
    this.ipcPath = `${SOCK_BASE}-${id}.sock`;
    this.logPath = `${LOG_BASE}-${id}.log`;
    this.socket = null;
  }

  _baseArgs() {
    const args = [
      '--no-config',
      '--msg-level=all=v',
      '--no-terminal',
      '--osc=no',
      '--osd-level=0',
      '--cursor-autohide=always',
      '--force-window=immediate',
      '--keep-open=always',
      '--idle=no',
      '--pause=no',
      '--no-border',
      '--ontop=yes',
      `--title=video-swarm-mpv-${this.id}`,
      `--input-ipc-server=${this.ipcPath}`,
      `--log-file=${this.logPath}`,
    ];

    // geometry only if sane
    const g = clampGeom(this.geom);
    if (g) {
      args.push(`--geometry=${g.width}x${g.height}+${g.x}+${g.y}`);
    } else {
      console.log('[mpv] invalid geometry, not passing --geometry:', this.geom);
    }

    if (this.profile) args.push(`--profile=${this.profile}`);

    args.push(this.file); // file last
    return args;
  }

  async _waitForIPC(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await pathExists(this.ipcPath)) {
        try {
          await new Promise((resolve, reject) => {
            const s = net.createConnection(this.ipcPath);
            s.setEncoding('utf8');
            const req = JSON.stringify({ command: ['get_property', 'pause'], request_id: 0 }) + '\n';
            s.once('connect', () => s.write(req));
            s.once('data', () => { s.end(); resolve(); });
            s.once('error', reject);
          });
          return true;
        } catch {}
      }
      await sleep(50);
    }
    return false;
  }

  async spawnOnce(extraArgs) {
    try { fs.unlinkSync(this.ipcPath); } catch {}
    const args = [...extraArgs, ...this._baseArgs().filter(a =>
      !a.startsWith('--vo=') && !a.startsWith('--hwdec=')
    )];

    console.log('[mpv] spawn', this.mpvPath, args.join(' '));
    console.log('[mpv] log file:', this.logPath);

    // Prefer NVDEC/NVIDIA paths in environment
    const env = {
      ...process.env,
      __GLX_VENDOR_LIBRARY_NAME: process.env.__GLX_VENDOR_LIBRARY_NAME || 'nvidia',
      LIBVA_DRIVER_NAME: process.env.LIBVA_DRIVER_NAME || 'nvidia',   // harmless if VAAPI isn’t used
      LIBVA_DRI3_DISABLE: process.env.LIBVA_DRI3_DISABLE || '1',
      NVD_BACKEND: process.env.NVD_BACKEND || 'direct',
    };

    this.proc = spawn(this.mpvPath, args, { stdio: 'ignore', env });

    this.proc.on('exit', (code, signal) => {
      console.log('[mpv] exited', { code, signal, id: this.id });
    });
    this.proc.on('error', (err) => {
      console.warn('[mpv] process error:', err?.message || err);
    });

    const ok = await this._waitForIPC(5000);
    if (!ok) throw new Error(`mpv IPC not ready after 5000ms @ ${this.ipcPath}`);
    return true;
  }

  async spawnWithFallbacks() {
    // Order: gpu-next+nvdec → gpu+nvdec → gpu+auto-safe → xv+no
    const tries = [
      ['--hwdec=nvdec', '--vo=gpu-next'],
      ['--hwdec=nvdec', '--vo=gpu'],
      ['--hwdec=auto-safe', '--vo=gpu'],
      ['--hwdec=no', '--vo=xv'],
    ];

    for (let i = 0; i < tries.length; i++) {
      try {
        console.log(`[mpv] spawn attempt ${i + 1}/${tries.length} -> ${this.mpvPath} ${tries[i].join(' ')} ...`);
        await this.spawnOnce(tries[i]);
        console.log('[mpv] IPC ready', this.ipcPath);
        return true;
      } catch (e) {
        console.warn('[mpv] exited quickly on attempt', i + 1, '– inspecting log next');
        try {
          const txt = await fsp.readFile(this.logPath, 'utf8');
          const tail = txt.split('\n').slice(-60).join('\n');
          console.log('[mpv log tail]\n' + tail);
        } catch {}
        if (i === tries.length - 1) {
          throw new Error(`mpv IPC not ready after fallbacks @ ${this.ipcPath} (see ${this.logPath})`);
        }
        await sleep(200);
      }
    }
    return false;
  }

  async connectIPC() {
    if (this.socket && !this.socket.destroyed) return this.socket;
    await new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.ipcPath, () => resolve());
      this.socket.setEncoding('utf8');
      this.socket.on('error', reject);
    });
    // Prime a no-op
    this.socket.write(JSON.stringify({ command: ['get_property', 'time-pos'] }) + '\n');
    return this.socket;
  }

  async cmd(command, args = []) {
    const s = await this.connectIPC();
    return new Promise((resolve, reject) => {
      const reqId = Math.floor(Math.random() * 1e9);
      const payload = JSON.stringify({ command: [command, ...args], request_id: reqId }) + '\n';
      const onData = (chunk) => {
        try {
          const parts = chunk.toString().split('\n').filter(Boolean);
          for (const line of parts) {
            const msg = JSON.parse(line);
            if (msg.request_id === reqId) {
              s.off('data', onData);
              if (msg.error === 'success') return resolve(msg.data ?? true);
              return reject(new Error(msg.error));
            }
          }
        } catch { /* ignore */ }
      };
      s.on('data', onData);
      s.write(payload);
      setTimeout(() => {
        s.off('data', onData);
        reject(new Error('mpv IPC command timeout'));
      }, 3000);
    });
  }

  async spawn() {
    return this.spawnWithFallbacks();
  }

  async play() {
    try {
      await this.cmd('set_property', ['pause', false]);
      return 'ok';
    } catch (e) {
      console.warn('[mpv] play failed:', e?.message || e);
      return 'error';
    }
  }

  async pause() {
    try {
      await this.cmd('set_property', ['pause', true]);
      return 'ok';
    } catch (e) {
      console.warn('[mpv] pause failed:', e?.message || e);
      return 'error';
    }
  }

  // mpv does not expose a stable "geometry" property over IPC; best we can do is pass --geometry at spawn.
  // We still accept setGeometry so the app can cache the next spawn target.
  async setGeometry(geom) {
    this.geom = clampGeom(geom) || this.geom;
    return this.geom ? { ok: true, geom: this.geom } : { ok: false, reason: 'invalid-geom' };
  }

  async destroy() {
    try {
      if (this.socket && !this.socket.destroyed) {
        try { await this.cmd('quit', [0]); } catch {}
        this.socket.destroy();
      }
      if (this.proc && !this.proc.killed) {
        this.proc.kill('SIGTERM');
      }
      try { fs.unlinkSync(this.ipcPath); } catch {}
      return 'ok';
    } catch (e) {
      console.warn('[mpv] destroy failed:', e?.message || e);
      return 'error';
    }
  }
}

class MpvController {
  constructor({ mpvPath = 'mpv' } = {}) {
    this.mpvPath = mpvPath;
    this.instances = new Map();
  }

  async isAvailable() {
    // lightweight probe: `mpv --version` stdout not required
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(this.mpvPath, ['--version'], { stdio: 'ignore' });
        p.on('exit', (code) => code === 0 ? resolve() : resolve()); // mpv returns 0
        p.on('error', reject);
      });
      return true;
    } catch {
      return false;
    }
  }

  async create({ file, geom, profile } = {}) {
    if (!file) throw new Error('file required');
    const id = crypto.randomUUID();
    const inst = new MpvInstance({
      id,
      mpvPath: this.mpvPath,
      file: path.resolve(String(file)),
      geom: geom || null,
      profile: profile || 'active'
    });
    await inst.spawn();
    this.instances.set(id, inst);
    console.log('[mpv] created instance', { id, file: inst.file, geom: inst.geom || null });
    return { id };
  }

  async setGeometry(id, geom) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error('no such instance');
    return inst.setGeometry(geom);
  }

  async play(id) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error('no such instance');
    return inst.play();
  }

  async pause(id) {
    const inst = this.instances.get(id);
    if (!inst) throw new Error('no such instance');
    return inst.pause();
  }

  async destroy(id) {
    const inst = this.instances.get(id);
    if (!inst) return 'ok';
    const res = await inst.destroy();
    this.instances.delete(id);
    return res;
  }
}

module.exports = { MpvController };
