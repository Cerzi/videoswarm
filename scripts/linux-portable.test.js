import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildLinuxPortable } = require("./linux-portable.cjs");

const linuxOnlyIt = process.platform === "linux" ? it : it.skip;
const made = new Set();
const temporary = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
};

// An unpacked Linux app as electron-builder leaves it after linux-fix.js: the
// Debian launcher, the real binary (here a script that reports what it got)
// and Chromium's sandbox helper.
function fakeUnpacked() {
  const dir = temporary("videoswarm-unpacked-");
  fs.writeFileSync(path.join(dir, "video-swarm"), "#!/bin/bash\necho debian-launcher\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(dir, "video-swarm-bin"),
    `#!/bin/bash
node -e 'console.log(JSON.stringify({ args: process.argv.slice(1), env: Object.fromEntries(["VIDEOSWARM_PORTABLE_DIR","TMPDIR","TMP","TEMP","XDG_CONFIG_HOME","XDG_CACHE_HOME","XDG_DATA_HOME","XDG_STATE_HOME","GSETTINGS_BACKEND"].map((k) => [k, process.env[k]])) }))' -- "$@"
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(dir, "chrome-sandbox"), "", { mode: 0o755 });
  fs.mkdirSync(path.join(dir, "resources"));
  fs.writeFileSync(path.join(dir, "resources", "app.asar"), "asar");
  return dir;
}

function extracted() {
  const unpacked = fakeUnpacked();
  const out = temporary("videoswarm-out-");
  const archive = buildLinuxPortable({ unpackedDir: unpacked, outDir: out, version: "9.9.9" });
  const target = temporary("videoswarm-extract-");
  execFileSync("tar", ["-xzf", archive, "-C", target]);
  return { unpacked, archive, folder: path.join(target, "VideoSwarm-9.9.9-portable") };
}

function fakeProcSys(restricted) {
  const dir = temporary("videoswarm-procsys-");
  fs.mkdirSync(path.join(dir, "kernel"));
  fs.writeFileSync(path.join(dir, "kernel", "apparmor_restrict_unprivileged_userns"), restricted ? "1\n" : "0\n");
  return dir;
}

function launch(folder, { args = [], env = {} } = {}) {
  const result = spawnSync(path.join(folder, "video-swarm"), args, {
    encoding: "utf8",
    env: { ...process.env, VIDEOSWARM_NO_DIALOG: "1", VIDEOSWARM_PROC_SYS: fakeProcSys(false), ...env },
  });
  return { status: result.status, stderr: result.stderr, report: result.status === 0 ? JSON.parse(result.stdout) : null };
}

afterEach(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  made.clear();
});

describe("Linux portable build", () => {
  linuxOnlyIt("packs the app with its marker, launcher, sandbox setup and readme, leaving the .deb's folder alone", () => {
    const { unpacked, archive, folder } = extracted();
    expect(path.basename(archive)).toBe("VideoSwarm-9.9.9-linux-portable.tar.gz");
    for (const name of ["portable", "setup-sandbox.sh", "README-PORTABLE.txt", "video-swarm", "video-swarm-bin", "chrome-sandbox", "resources/app.asar"]) {
      expect(fs.existsSync(path.join(folder, name))).toBe(true);
    }
    expect(fs.statSync(path.join(folder, "video-swarm")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(folder, "setup-sandbox.sh")).mode & 0o777).toBe(0o755);
    // The archive names no builder's account.
    const listing = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" });
    expect(listing.split("\n").filter(Boolean).every((line) => /\broot\/root\b|\b0\/0\b/u.test(line))).toBe(true);
    // The .deb is built from the same folder: it stays a normal install.
    expect(fs.existsSync(path.join(unpacked, "portable"))).toBe(false);
    expect(fs.readFileSync(path.join(unpacked, "video-swarm"), "utf8")).toContain("debian-launcher");
  });

  linuxOnlyIt("starts the app with every folder inside VideoSwarmData before it runs", () => {
    const { folder } = extracted();
    const { status, report } = launch(folder, { args: ["--example"] });
    expect(status).toBe(0);
    const data = path.join(folder, "VideoSwarmData");
    expect(report.args).toEqual(["--example"]);
    expect(report.env).toEqual({
      VIDEOSWARM_PORTABLE_DIR: folder,
      TMPDIR: path.join(data, "temp"),
      TMP: path.join(data, "temp"),
      TEMP: path.join(data, "temp"),
      XDG_CONFIG_HOME: path.join(data, "xdg", "config"),
      XDG_CACHE_HOME: path.join(data, "xdg", "cache"),
      XDG_DATA_HOME: path.join(data, "xdg", "data"),
      XDG_STATE_HOME: path.join(data, "xdg", "state"),
      GSETTINGS_BACKEND: "memory",
    });
    expect(fs.statSync(path.join(data, "xdg", "cache")).isDirectory()).toBe(true);
  });

  linuxOnlyIt("says how to set the sandbox up once where the system needs its helper", () => {
    const { folder } = extracted();
    const { status, stderr } = launch(folder, { env: { VIDEOSWARM_PROC_SYS: fakeProcSys(true) } });
    expect(status).toBe(1);
    expect(stderr).toContain(`sudo "${path.join(folder, "setup-sandbox.sh")}"`);
    // Switched off on purpose, it starts unsandboxed and says so.
    const forced = launch(folder, { env: { VIDEOSWARM_PROC_SYS: fakeProcSys(true), VIDEOSWARM_DISABLE_SANDBOX: "1" } });
    expect(forced.status).toBe(0);
    expect(forced.report.args).toEqual(["--no-sandbox", "--disable-setuid-sandbox"]);
    expect(forced.stderr).toContain("Chromium OS sandbox disabled");
  });

  linuxOnlyIt("refuses a folder it cannot write", () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    const { folder } = extracted();
    fs.chmodSync(folder, 0o555);
    try {
      const { status, stderr } = launch(folder);
      expect(status).toBe(1);
      expect(stderr).toContain("cannot be written");
    } finally {
      fs.chmodSync(folder, 0o755);
    }
  });

  linuxOnlyIt("asks for sudo before setting the helper up", () => {
    if (process.getuid?.() === 0) return;
    const { folder } = extracted();
    const result = spawnSync(path.join(folder, "setup-sandbox.sh"), [], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run this with sudo");
  });
});
