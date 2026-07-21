# 🐝 Video Swarm

[![GitHub release](https://img.shields.io/github/v/release/Cerzi/videoswarm?include_prereleases&sort=semver)](https://github.com/Cerzi/videoswarm/releases)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)


I got tired of manually opening tens or hundreds of ComfyUI video outputs to try and find an old workflow or get a quick overview of the quality of a large batch run. **Video Swarm** was born because I couldn't find any existing software that does this: tile a large number of videos, all playing at once, with seamless scrolling through subdirectories and quick file operations. I figured I'm not the only one who would find this useful, so I've open-sourced it.

If VideoSwarm has been helpful and you'd like to chip in, you can support development [here](https://ko-fi.com/videoswarm).

<img width="2226" height="1378" alt="image" src="https://github.com/user-attachments/assets/dfa870c7-5007-465e-9c01-457d4f049acb" />

https://github.com/user-attachments/assets/85845a4e-488d-4817-806c-a39bc290aabc
<p><em>new features overview</em></p>

---

## TL;DR

- Download the [latest release](https://github.com/Cerzi/videoswarm/releases).
- Open a folder or pin frequently reviewed roots in the Library.
- Browse thousands of short clips in a virtualized, live-motion masonry grid.
- Navigate recursive folder trees, change folder scope, and save filter/sort views.
- Review with one hand: `A` Accept, `S` Reviewed, `D` Reject, `F` Unreviewed,
  `1`–`5` rating, and `Z` undo.
- Resume saved review positions, trash rejected clips in bounded batches, or
  safely copy accepted clips to a new destination.
- Double-click for the fullscreen review loupe; use `Q`/`E` or `←`/`→` to
  navigate, Space to play/pause, `M` for audio, and `I` for Details.
- Inspect tags, ratings, audio presence, and supported embedded ComfyUI/VHS
  generation metadata.
- Press `?` for the complete shortcut guide.

---

## Purpose

Traditional file browsers show static thumbnails and provide limited ways to compare videos at scale. Video Swarm is designed for use cases where *motion* matters and where collections may contain hundreds or thousands of files, such as:

- Reviewing outputs from AI video generation workflows (e.g. ComfyUI)
- Seeing a clear overview of video training datasets for AI training
- Inspecting stock footage, B-roll, or archival datasets
- Comparing multiple generations or versions of the same source
- Research or analysis of large video corpora

---

## Features

### Playback and Layout

- Virtualized masonry mounts only the viewport and bounded overscan while
  retaining complete logical navigation for large collections.
- **Balanced**, **Adaptive Motion**, **All Motion**, and **Static + Hover**
  playback modes cover efficient review through fully uncapped visible motion.
- Optional bounded 720p playback proxies are available when native tooling is
  present; source media is never modified.
- Off-screen, hidden-window, and stale-collection media resources are released
  deterministically.
- Nine grid-size steps span approximately 150–650 px with scroll anchoring and
  automatic safety adjustment.
- Audio-bearing cards are identified, with a profile-persistent hover-audio
  toggle beside the filename toggle and separate fullscreen session controls.

### Navigation and Interaction

- Recursive folder tree, breadcrumbs, **Current folder**, **Current subtree**,
  and **All descendants** scopes, plus `[`/`]` sibling-folder cycling.
- Pinned library roots with passive total/unreviewed counts, a compact A–Z/Z–A
  folder-tree sort, and reusable saved views for filters, sort, grouping, and scope.
- Cancellable folder loading with live phase, progress, active path,
  elapsed-time, and working-set feedback.
- Fullscreen review loupe with complete-order navigation, tagging/rating/review
  controls, Details, safe file utilities, and immediate audio teardown.
- A draggable floating Details inspector or docked Library/Details workspace.
- Multi-selection and context-menu utilities for native trash, path/name copy,
  open externally, show in folder, and last-frame capture.
- A built-in, catalog-driven `?` shortcut reference.

### Review, Tags, Ratings, and Metadata

- Explicit **Accept**, **Reviewed**, **Reject**, and **Unreviewed** states remain
  separate from tags and ratings.
- Rating an Unreviewed clip marks it Reviewed; resetting to Unreviewed clears
  its rating but never its tags.
- One-handed shortcuts, optional advance-after-marking, one-step coupled undo,
  and stable scope progress.
- A profile-persistent review-mode toggle hides review UI, counts, actions, and
  shortcuts when review workflow features are not wanted.
- Persistent saved review positions with **Find Unreviewed** and **Resume saved
  view** across application restarts.
- **Process Results** supports bounded parallel Reject trashing plus explicit
  no-overwrite **Move** and **Copy** actions for accepted clips, preserving
  relative folders and optionally recognized adjacent JSON sidecars.
- Custom tags, bulk add/remove, ranked suggestions, five-star ratings, and
  profile-local SQLite persistence.
- Lazy embedded ComfyUI/VHS API-graph extraction for supported prompt, negative
  prompt, seed, model, sampler, LoRA, source, and provenance fields.
- Multiple profiles isolate libraries, tags, review state, ratings, settings,
  and saved review positions.

### File System Integration

- Incremental recursive scanning with a persistent SQLite-backed index and fast
  stale-while-revalidate revisits.
- Real-time monitoring with
  [Chokidar](https://github.com/paulmillr/chokidar) and bounded polling fallback
  when host watcher limits are exhausted.
- Profile-local pinned roots, empty-directory records, folder counts, saved
  views, review positions, and compact generation metadata.
- Recent folders, rich file facts including duration and frame rate,
  fingerprint-based metadata continuity, and
  configurable application data location.
- Sandboxed renderer, opaque local-media protocol, and main-process-authorized
  native file actions.
- Accepted-clip transfers never overwrite destinations. Copy keeps originals;
  Move removes a source only after its exclusive destination copy succeeds.

### Live Drag Thumbnails

- Drag clips directly into ComfyUI, video editors, and file managers.
- Bounded cached live-frame thumbnails keep dragging responsive without
  retaining unbounded media resources.

### Settings

- Atomic, profile-local settings stored in Electron's application data
  directory.
- Saved window position, playback mode, zoom, fullscreen Details, review, and
  inspector presentation preferences.
- Configurable data location with coordinated migration/relaunch behavior.
- Automatic zoom safety adjustment for high-DPI displays and large grids.

---

## Technical Overview

- **Frontend:** React 18 + hooks, Vite for bundling
- **Backend:** Electron main process with IPC for filesystem access
- **Layout:** Custom vertical masonry renderer
- **Storage:** Profile-local SQLite databases plus bounded atomic JSON settings
- **Performance:** Virtual masonry, cancellable scans, bounded schedulers/caches,
  and SQLite-first folder revisits
- **File formats:** Supports any codec/container playable by Chromium (tested with MP4/H.264; partial HEVC support depends on system codecs)
- **Release status:** Pre-1.0; expect ongoing platform validation and polish

---

## Known Limitations

- Linux NVIDIA hardware decoding is not guaranteed by Electron/Chromium.
  **Balanced** or **Static + Hover** is recommended on CPU-bound systems.
- **All Motion** intentionally requests every visible clip and can consume
  substantial CPU and memory.
- Desktop-only: no web version (requires unrestricted filesystem access)
- Codec support comes from the bundled Chromium build; HEVC/H.265 may not
  decode on every system.
- Embedded generation extraction currently relies on a compatible system
  `ffprobe`; exact adjacent JSON sidecars remain the fallback. Arbitrary custom
  nodes and visual-workflow-only composition may produce a transparent partial
  result rather than a guessed prompt.
- Accepted-clip Move/Copy does not transfer Video Swarm metadata and never
  overwrites an existing destination.
- Reject processing is limited to 2,000 local files per scoped batch.
- The app is designed primarily for many short clips. Long, high-resolution,
  or uncapped workloads remain hardware-sensitive even though 1,000- and
  6,000-item library gates are covered.
- Release artifacts currently target Windows x64 and Debian/Ubuntu x64. Linux
  releases are `.deb`-only; there is no portable Linux, macOS, mobile, or web
  release.

---

## Test the v0.6 Release Candidate

[Download v0.6.0-rc.3](https://github.com/Cerzi/videoswarm/releases/tag/v0.6.0-rc.3)
for Windows, or install its `.deb` on Debian/Ubuntu, then follow the
[RC feedback tracker](https://github.com/Cerzi/videoswarm/issues/80) for the
priority test areas and stable-release gate. Close VideoSwarm before upgrading
and back up irreplaceable profile data first.

Please file each reproducible problem through the
[structured bug-report form](https://github.com/Cerzi/videoswarm/issues/new?template=bug_report.yml&labels=rc%20feedback)
so platform, workload, playback, and diagnostic details stay attached to the
report. Feature ideas have a separate form in the issue chooser.

---

## Roadmap

Planned for upcoming versions:

- Generation-aware search and smart metadata filters
- A synchronized 2–4 clip comparison workspace
- A packaged cross-platform embedded-metadata reader
- Evidence-gated Linux motion sweep and further playback profiling
- Copied-metadata transfer

---

## Installation & Development

### Linux release installation

Video Swarm's supported Linux release is the Debian/Ubuntu x64 `.deb`. Download
it from the [latest release](https://github.com/Cerzi/videoswarm/releases), then
install and launch it with:

```bash
sudo apt install ./VideoSwarm-*-linux.deb
video-swarm
```

The package's post-installation hook gives the bundled Chromium
`chrome-sandbox` helper root ownership and mode `4755`, so the application can
retain its operating-system sandbox.

Portable AppImages are not published. Their temporary FUSE mount cannot
reliably preserve the helper's required root ownership and setuid mode, while
hardened Ubuntu installations may also block Chromium's unprivileged-user-
namespace fallback. Video Swarm does not silently disable the production
sandbox to work around that packaging conflict.

If `apt` returns an error after it has configured Video Swarm, check the
[Linux package troubleshooting guide](docs/troubleshooting/linux-deb-installation.md)
before reinstalling. Apt can finish installing this package and then fail while
retrying an unrelated pending kernel or DKMS transaction.

### Prerequisites
- **Node.js 22.12.0 or later**
  > Note: Electron 43 requires Node 22.12.0+, and some dependencies such as `better-sqlite3@12`, `conf@14`, and `electron-store@10` require Node 20+.

### Setup
```bash
git clone https://github.com/Cerzi/videoswarm.git
cd videoswarm
npm install
```

The install step automatically runs `electron-builder install-app-deps`, ensuring native modules
such as `better-sqlite3` are rebuilt against the bundled Electron runtime on Windows, macOS, and
Linux with no extra setup.

### Development
Run Vite + Electron together with hot reload:
```bash
npm run electron:dev
```

### Production Build
```bash
npm run electron:build   # packaged app for current platform
```

### Other build targets:
- `electron:dist` – build without publishing
- `electron:pack` – unpacked application directory for development/package
  smoke testing, not a portable release artifact

### Project Structure
```css
src/
  components/          React components (VideoCard, ContextMenu, FullScreenModal, RecentFolders)
  hooks/               React hooks (fullscreen logic, context menu, playback manager)
  App.jsx              Main React entry point
main.js                Electron main process
preload.js             IPC bridge
```

### Usage
1. Start the application
2. Open a folder and optionally pin it in the Library
3. Choose a folder scope and playback mode for the current workload
4. Review with `A`/`S`/`D`/`F`, ratings, tags, or the Details workspace
5. Use **Find Unreviewed** or **Resume saved view** for a persistent review pass
6. Press `?` at any time for the current shortcut reference

## License

Video Swarm is licensed under the [GNU General Public License v3.0](LICENSE).

This ensures the project remains free and open-source for everyone, and that any improvements or modifications made by others are also shared with the community. You are free to use, modify, and redistribute the software, but if you distribute a modified version you must also make the source code available under the same license.

## Contributing

Contributions are welcome! By submitting a pull request, you agree that your code will be licensed under the same GPLv3 license as the rest of the project.
