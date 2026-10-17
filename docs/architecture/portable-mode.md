# Portable Mode

Status: **App side implemented, unverified by a human** (2026-10-17).
Packaging (the portable artifacts and their launchers) is open: see
*Packaging* below.

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

## Packaging

Open, for the owner. Linux releases need Chromium's sandbox, and on Ubuntu
24.04 (unprivileged user namespaces restricted) an unpacked copy can only
sandbox itself through a root-owned helper (`AGENTS.md`):

- **Linux portable folder** (a `.tar.gz` with a launcher script and the
  `portable` marker): fully isolated; needs a one-time `sudo` to make the
  folder's `chrome-sandbox` root-owned and setuid, which only works on a
  disk mounted without `nosuid` (not most USB sticks).
- **Isolated launcher for the installed copy**: runs the installed,
  sandboxed binary with a separate `VideoSwarmData/` folder; no setup, data
  fully separate, but not a copy of the app itself.
- **AppImage**: needs `--no-sandbox` on such systems, which the project does
  not ship.
- **Windows**: the single-file portable .exe already works (it unpacks
  itself into the system's temporary folder each run); a zip of the unpacked
  app with a launcher would avoid even that.

## Verification

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
