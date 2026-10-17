#!/usr/bin/env node
// The Linux portable build (docs/architecture/portable-mode.md): the unpacked
// app from electron-builder (dist/linux-unpacked), plus the `portable`
// marker, a launcher that puts every folder inside VideoSwarmData/ before
// Electron starts, and a one-time setup for Chromium's sandbox helper,
// packed as dist/VideoSwarm-<version>-linux-portable.tar.gz.
//
// The .deb is built from the same unpacked folder, so nothing here may touch
// it: the portable files are added to a copy.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const EXECUTABLE_NAME = "video-swarm";

function createPortableLauncherScript(executableName = EXECUTABLE_NAME) {
  return `#!/bin/bash
# Video Swarm, portable: everything it writes stays in VideoSwarmData/ beside
# this script, and nothing anywhere else on the computer. Start it with this
# script, not ${executableName}-bin, so its folders are in place before Chromium
# starts. See README-PORTABLE.txt.
set -e

here="$(cd -P "$(dirname "\${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
data="$here/VideoSwarmData"

say() {
  echo "Video Swarm (portable): $1" >&2
  if [[ -z "\${VIDEOSWARM_NO_DIALOG:-}" ]]; then
    if command -v zenity >/dev/null 2>&1; then
      zenity --error --title="Video Swarm" --no-wrap --text="$1" >/dev/null 2>&1 || true
    elif command -v kdialog >/dev/null 2>&1; then
      kdialog --error "$1" >/dev/null 2>&1 || true
    fi
  fi
}

if ! mkdir -p "$data/temp" "$data/xdg/config" "$data/xdg/cache" "$data/xdg/data" "$data/xdg/state" 2>/dev/null \\
  || [[ ! -w "$data" ]]; then
  say "This portable copy keeps its data beside itself, in $data, but that folder cannot be written. Move Video Swarm to a folder you can write to."
  exit 1
fi

export VIDEOSWARM_PORTABLE_DIR="$here"
export TMPDIR="$data/temp" TMP="$data/temp" TEMP="$data/temp"
export XDG_CONFIG_HOME="$data/xdg/config"
export XDG_CACHE_HOME="$data/xdg/cache"
export XDG_DATA_HOME="$data/xdg/data"
export XDG_STATE_HOME="$data/xdg/state"
# GTK keeps what it remembers (file dialogs) in memory, not the desktop's
# settings database.
export GSETTINGS_BACKEND=memory

sandbox_args=()
helper="$here/chrome-sandbox"
proc_sys="\${VIDEOSWARM_PROC_SYS:-/proc/sys}"
if [[ "\${VIDEOSWARM_DISABLE_SANDBOX:-0}" == "1" ]]; then
  echo "Video Swarm warning: Chromium OS sandbox disabled by VIDEOSWARM_DISABLE_SANDBOX=1" >&2
  sandbox_args+=(--no-sandbox --disable-setuid-sandbox)
elif [[ ! -u "$helper" || "$(stat -c %u "$helper" 2>/dev/null)" != "0" ]]; then
  # Without its root-owned helper Chromium sandboxes itself with user
  # namespaces, which some systems (Ubuntu 24.04 and later) restrict.
  restricted=0
  if [[ "$(cat "$proc_sys/kernel/apparmor_restrict_unprivileged_userns" 2>/dev/null || echo 0)" == "1" ]]; then
    restricted=1
  fi
  if [[ "$(cat "$proc_sys/kernel/unprivileged_userns_clone" 2>/dev/null || echo 1)" == "0" ]]; then
    restricted=1
  fi
  if [[ "$restricted" == "1" ]]; then
    say "This computer needs Video Swarm's sandbox helper set up once. In a terminal, run:

  sudo \\"$here/setup-sandbox.sh\\"

then start Video Swarm again."
    exit 1
  fi
fi

exec "$here/${executableName}-bin" "\${sandbox_args[@]}" "$@"
`;
}

function createSandboxSetupScript() {
  return `#!/bin/bash
# Sets up Chromium's sandbox helper for this portable copy of Video Swarm,
# once: it must belong to root and run as root (mode 4755) to sandbox the
# app on systems that restrict user namespaces. Changes nothing else.
set -e

here="$(cd -P "$(dirname "\${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
helper="$here/chrome-sandbox"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo:  sudo \\"$here/setup-sandbox.sh\\"" >&2
  exit 1
fi
if [[ ! -f "$helper" ]]; then
  echo "No chrome-sandbox beside this script; is this a Video Swarm portable folder?" >&2
  exit 1
fi
if command -v findmnt >/dev/null 2>&1 \\
  && findmnt -no OPTIONS --target "$here" 2>/dev/null | tr ',' '\\n' | grep -qx nosuid; then
  echo "This folder is on a disk mounted with nosuid (as most USB sticks are), where the helper cannot work." >&2
  echo "Move the Video Swarm folder to a normal disk and run this again." >&2
  exit 1
fi
chown root:root -- "$helper"
chmod 4755 -- "$helper"
echo "Done. Start Video Swarm with $here/${EXECUTABLE_NAME}"
`;
}

const MARKER_TEXT = `This file makes this copy of Video Swarm portable: it keeps everything it
writes in VideoSwarmData/ beside it. Delete it to use the computer's usual
folders instead.
`;

function createPortableReadme(version) {
  return `Video Swarm ${version}, portable (Linux x64)
==========================================

Start Video Swarm with the "${EXECUTABLE_NAME}" script in this folder.

Everything it writes (settings, profiles, databases, thumbnails, proxies,
caches, temporary files) stays in VideoSwarmData/ beside it. Nothing goes
anywhere else on the computer, and it never mixes with an installed copy of
Video Swarm or another portable one; both can run at once. Move or copy the
whole folder to take everything with it; delete it to remove every trace.

First start
-----------
Video Swarm runs inside Chromium's sandbox. On systems that restrict user
namespaces (Ubuntu 24.04 and later, for example) the sandbox needs its
helper set up once, with administrator rights:

  sudo ./setup-sandbox.sh

This only makes chrome-sandbox, in this folder, belong to root. It does not
work on a disk mounted with nosuid, as most USB sticks are; keep this folder
on a normal disk. If the helper is needed, the launcher says so.

What the folder cannot hold
---------------------------
Files you open are read where they are. File dialogs are run by your
desktop, which may remember recently used folders on its own.
`;
}

function buildLinuxPortable({ unpackedDir, outDir, version }) {
  if (!fs.existsSync(path.join(unpackedDir, `${EXECUTABLE_NAME}-bin`))) {
    throw new Error(`No ${EXECUTABLE_NAME}-bin in ${unpackedDir}: build the Linux package first`);
  }
  const folderName = `VideoSwarm-${version}-portable`;
  const staging = fs.mkdtempSync(path.join(outDir, ".portable-"));
  const folder = path.join(staging, folderName);
  try {
    fs.cpSync(unpackedDir, folder, { recursive: true, verbatimSymlinks: true });
    const write = (name, text, mode) => {
      fs.writeFileSync(path.join(folder, name), text);
      fs.chmodSync(path.join(folder, name), mode);
    };
    // The Debian launcher becomes the portable one; same name, same place.
    write(EXECUTABLE_NAME, createPortableLauncherScript(), 0o755);
    write("setup-sandbox.sh", createSandboxSetupScript(), 0o755);
    write("portable", MARKER_TEXT, 0o644);
    write("README-PORTABLE.txt", createPortableReadme(version), 0o644);
    const archive = path.join(outDir, `VideoSwarm-${version}-linux-portable.tar.gz`);
    fs.rmSync(archive, { force: true });
    execFileSync("tar", ["--owner=0", "--group=0", "-czf", archive, "-C", staging, folderName]);
    return archive;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = {
  buildLinuxPortable,
  createPortableLauncherScript,
  createPortableReadme,
  createSandboxSetupScript,
};

if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const archive = buildLinuxPortable({
    unpackedDir: path.join(root, "dist", "linux-unpacked"),
    outDir: path.join(root, "dist"),
    version,
  });
  console.log(`Portable build: ${path.relative(root, archive)}`);
}
