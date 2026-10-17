# Portable Mode

Status: **Implemented, unverified by a human** (2026-10-17): the app side,
the Linux portable folder and the release workflow. Windows keeps its
single-file portable build.

## Summary

A portable copy of Video Swarm keeps everything it writes in one folder
beside itself, `VideoSwarmData/`, and writes nothing anywhere else on the
computer. It never shares settings, profiles, databases, thumbnails, proxies
or caches with an installed copy or another portable one, and it runs beside
them: the single-instance lock belongs to the data folder in use.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Detection

`main/portable-mode.js`, at the very top of `main.js`, before anything reads
or writes a system location. A copy is portable when, in order:

1. `VIDEOSWARM_PORTABLE_DIR` names its folder (a launcher, or testing);
2. on Windows, electron-builder's single-file portable build sets
   `PORTABLE_EXECUTABLE_DIR` (the folder of the .exe the user ran, not where
   it unpacks itself);
3. on Linux, it runs as an AppImage (`APPIMAGE`, the folder holding it);
4. a file named `portable` sits beside the executable (on macOS, beside the
   .app).

## What moves

Into `<folder>/VideoSwarmData/`:

| What | Where |
|---|---|
| Electron `userData`, `sessionData` (profiles, databases, settings, thumbnails, proxies, Chromium's caches, `local-api.json`) | `user-data/` |
| Electron `appData` | the folder itself |
| Temporary files (`temp`, and `TMPDIR`/`TMP`/`TEMP` for every process started) | `temp/` |
| Logs, crash dumps | `logs/`, `crash-dumps/` |
| Linux: `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` (graphics drivers' shader caches, fontconfig's cache, GTK's recently used files) | `xdg/` |

- **The data folder is fixed.** No bootstrap file is read or written (an
  installed copy's `~/.videoswarm` cannot steer a portable one), and
  Preferences › Data location says the copy is portable and does not offer
  to move it.
- **The single-instance lock** is now taken after the data folder is chosen,
  for every copy, so a copy whose data was moved also runs beside one that
  was not.
- **A folder that cannot be written** (a read-only stick) stops the copy with
  a message, rather than writing anywhere else.

## Before Electron starts

Chromium starts its helper processes and creates its default profile folder,
fontconfig its cache and the graphics driver its shader cache before
`main.js` runs. Measured on Ubuntu 24.04: a copy started directly with only
the portable marker still left fontconfig's cache, Mesa's and NVIDIA's
shader caches and an empty default profile folder in the user's folders,
even when it restarted itself with the right environment from `main.js`.
Started with the environment already set, nothing at all landed outside the
portable folder, with the graphics process on.

So a fully isolated portable copy is started by a **launcher** that sets
`VIDEOSWARM_PORTABLE_DIR`, `TMPDIR`/`TMP`/`TEMP` and the XDG folders before
Electron, as `portableEnvironment()` lists them. `main.js` sets them again
for anything started later, so a copy started without the launcher still
keeps all of its own data in the portable folder; only Chromium's and the
drivers' startup files escape.

Windows: graphics drivers keep their shader caches in the system's own
folders (known folders, not environment variables), which no launcher can
redirect; the only way to avoid them is to switch hardware acceleration off.

## The single-instance socket

Chromium's single-instance check listens on a Unix socket in a new
temporary folder (`<temp>/scoped_dirXXXXXX/SingletonSocket`), and a socket's
path is limited to 107 bytes on Linux (103 on macOS). A portable folder at
an ordinary depth goes past that, and Chromium aborts ("Socket path too
long"). While the lock is taken, and only when the portable temporary
folder is too deep, the socket's folder goes to the per-user runtime folder
(`$XDG_RUNTIME_DIR`, in memory and emptied at logout; else `/tmp`), and the
temporary folder is moved back straight after. Chromium removes the socket's
folder when the copy quits; nothing persists.

## Packaging (decided 2026-10-17)

Linux releases need Chromium's sandbox, and on Ubuntu 24.04 (unprivileged
user namespaces restricted) an unpacked copy can only sandbox itself through
a root-owned helper (`AGENTS.md`).

- **Linux: a portable folder**,
  `VideoSwarm-<version>-linux-portable.tar.gz`, made by
  `scripts/linux-portable.cjs` (`npm run linux:portable`) from the unpacked
  build, never touching it (the `.deb` is built from the same folder). It
  adds the `portable` marker, a `video-swarm` launcher, `setup-sandbox.sh`
  and `README-PORTABLE.txt`, and stores files as root's so no builder's
  account is named.
  - The launcher makes `VideoSwarmData/`, sets `VIDEOSWARM_PORTABLE_DIR`,
    the temporary and XDG folders and `GSETTINGS_BACKEND=memory`, then starts
    the app. It refuses a folder it cannot write. Where user namespaces are
    restricted and the helper is not root-owned and setuid, it says to run
    `sudo ./setup-sandbox.sh` once (in a dialog too, through zenity or
    kdialog, for a start from a file manager) and does not start
    unsandboxed. `VIDEOSWARM_DISABLE_SANDBOX=1` stays the diagnostic way out.
  - `setup-sandbox.sh` needs root, refuses a disk mounted `nosuid` (as most
    USB sticks are), and only makes `chrome-sandbox` root-owned with mode
    4755.
- **Windows: the single-file portable .exe** as before. It now keeps its
  data beside itself; the program files it unpacks still pass through the
  system's temporary folder each run.
- **AppImage**: not shipped (it would need `--no-sandbox`).

## Verification

- `scripts/linux-portable.test.js`: the archive's contents and owner; the
  launcher's environment, its refusal and explanation where the sandbox
  helper is needed, the diagnostic opt-out, a read-only folder; the setup
  script asking for sudo.
- `tests/electron/linux-portable-package.smoke.spec.cjs`: the shipped
  folder, extracted, started through its launcher; it writes nothing
  outside itself. The release workflow sets its sandbox up with `sudo` and
  requires the sandbox on.

- `main/__tests__/portableMode.test.js`: detection, the folders and the
  environment, a read-only folder.
- `main/__tests__/dataLocationManager.test.js`: no bootstrap file is read or
  written, the folder cannot be moved.
- `tests/electron/portable.smoke.spec.cjs`: a portable copy started as the
  launcher would, with the graphics process on, opens a folder and saves
  settings; afterwards the home, config, cache and temporary folders it was
  given are still empty, and everything is in `VideoSwarmData/`.

## Acceptance

- Started by its launcher, a portable copy writes nothing outside its folder.
- It runs beside an installed copy, each with its own data.
- An installed copy's settings never reach it, nor its settings an installed
  copy.
