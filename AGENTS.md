# AGENTS.md

Guidance for coding agents working on Video Swarm.

## Project Snapshot

Video Swarm is an Electron desktop app for browsing large folders of short video clips in a live-playing masonry grid. It is aimed at reviewing AI/video datasets and supports recursive folder scans, metadata tags/ratings, profile-specific SQLite storage, drag-and-drop file payloads, native file actions, and fullscreen playback.

The app is desktop-only. There is no supported web-only production mode because normal use depends on unrestricted filesystem access through Electron IPC.

## Tech Stack

- Runtime: Electron 43.
- Renderer: React 18, Vite, plain CSS.
- Main process: CommonJS Electron code in `main.js` plus modules under `main/`.
- Storage: `better-sqlite3` database files in Electron `userData`/profile directories.
- Watching: `chokidar` with polling fallback for file watcher limits.
- Tests: Vitest with jsdom and Testing Library.
- Packaging: `electron-builder`.

Node.js `>=22.12.0` is required. Electron 43 requires this, and native modules must be rebuilt for Electron's ABI.

## Common Commands

- Install dependencies and rebuild native app deps:
  `npm install`
- Run Vite and Electron together for development:
  `npm run electron:dev`
- Run only the Electron entrypoint:
  `npm run dev`
- If a Linux development host cannot provide Chromium's sandbox, use the
  explicit development-only fallback `npm run electron:dev:no-sandbox` or
  `npm run dev:no-sandbox`; normal source and packaged launches remain
  sandboxed.
- Run the renderer dev server only:
  `npm run vite:dev`
- Build the renderer only:
  `npm run vite:build`
- Package for the current platform:
  `npm run electron:build`
- Build/package without publishing:
  `npm run electron:dist`
- Create unpacked app directory:
  `npm run electron:pack`
- Rebuild native dependencies for Electron:
  `npm run postinstall`
- Run tests:
  `npm test -- --run`
- Run zero-warning lint:
  `npm run lint`

## Verification Expectations

Run focused tests for the area changed, then run the full suite before handing off when practical:

- Full test suite: `npm test -- --run`
- Zero-warning lint: `npm run lint`
- Renderer build smoke test: `npm run vite:build`
- Native/Electron dependency check after dependency changes: `npm run postinstall`
- Package smoke test after packaging or Electron config changes: `npm run electron:pack` or `npm run electron:build`

Expected current test behavior: the suite passes, but some tests print known React `act(...)` warnings and intentional error logs. Do not treat those warnings as failures unless the command exits non-zero or new warnings clearly come from your change.

## Repository Map

- `main.js`: Electron main process, command-line flags, window creation, menus, settings, IPC handlers, directory scanning, metadata IPC, memory metrics, and file operations.
- `preload.js`: secure bridge exposing `window.electronAPI` and `window.appMem` to the renderer.
- `main/`: main-process helpers.
  - `database.js`: SQLite schema and metadata store.
  - `profile-manager.js`, `profile-migration.js`: profile lifecycle and migration.
  - `watcher.js`: chokidar watcher plus polling fallback.
  - `thumb-cache.js`, `drag-icon.js`, `videoDimensions.js`, `fingerprint.js`, `data-location-manager.js`: native-side support modules.
- `src/App.jsx`: top-level renderer orchestration and state wiring.
- `src/components/`: React UI components. `VideoCard/` contains the most sensitive playback/DOM handling.
- `src/hooks/video-collection/`: progressive rendering, playback orchestration, and resource/memory limits.
- `src/hooks/selection/`, `src/hooks/actions/`, `src/hooks/context-menu/`, `src/hooks/ui-perf/`: focused behavior hooks.
- `src/app/hooks/`: app-level hooks for Electron folder lifecycle, filters, masonry layout, metadata actions, and zoom controls.
- `src/services/thumbService.js`: renderer thumbnail capture/cache coordination for drag thumbnails.
- `src/config/`: feature flags and support/donation content.
- `scripts/linux-fix.js`: electron-builder Linux wrapper that preserves Chromium sandboxing by default and supports an explicit warned compatibility opt-out.
- `dist-react/`, `dist/`, `coverage/`, and `node_modules/` are generated and should not be edited by hand.

## Architecture Notes

- Keep the Electron boundary explicit. Renderer code should use `window.electronAPI` methods from `preload.js`; do not expose raw `ipcRenderer`.
- If adding or changing IPC, update all three surfaces together: the `ipcMain` handler in `main.js` or `main/`, the preload bridge in `preload.js`, and renderer call sites/tests.
- Local Electron media must use generation-bound `videoswarm-media://` `sourceUrl` values resolved by the main-process protocol. Keep `fullPath` only for authorized native actions; do not construct renderer `file://` media URLs. Preserve Windows/UNC path behavior at the IPC/native-action boundary.
- `VideoCard.jsx` manually creates, detaches, re-parents, and cleans up `<video>` elements. Be conservative there and keep tests close to any behavior changes.
- Fullscreen playback owns a separate modal media element and decoder lease; it never adopts a grid video node. Keep synchronous teardown and exact lease/source ownership covered when changing either playback surface.
- Resource limits are centralized in `useVideoResourceManager`; changes here affect memory pressure, concurrent loading, and eviction behavior across large collections.
- Metadata is keyed by file fingerprints and stored in profile-specific SQLite databases. Preserve profile isolation and migration behavior.
- Profile settings use bounded, atomic JSON files through
  `main/settings-writer.js`; `electron-store` remains only for the bounded
  recent-folder history.

## Testing Notes

- Tests live next to source files as `*.test.js`/`*.test.jsx`, under `src/**`, and under `main/__tests__/`.
- Vitest config is `vitest.config.mjs`; environment is `jsdom`; setup is `vitest.setup.js`.
- Main-process tests use temp directories and direct module calls where possible.
- Renderer tests commonly mock `window.electronAPI`, IntersectionObserver-like behavior, and large child components.
- Use Testing Library and `act(...)` for React state/timer updates. Prefer adding focused regression tests near the changed module.
- The host-Node suite intentionally skips Electron-ABI SQLite cases when the Electron-built `better-sqlite3` binary cannot load under Node. These are gated native suites, not placeholders; exercise them separately with `npm run test:electron-abi`.

## Dependency And Native Module Notes

- `better-sqlite3` is native and must be compatible with the active Electron version.
- After Electron or native dependency upgrades, run `npm install` and `npm run postinstall`.
- If `npx electron --version` reports the embedded Node version, verify Electron itself with:
  `node_modules/electron/dist/electron -e "console.log(process.versions.electron)"`
- Do not edit `package-lock.json` by hand; use npm commands.

## Linux/GPU Notes

- Linux is a priority platform, but NVIDIA hardware video decoding is not currently assumed to work in Electron/Chromium. Avoid promising GPU video decode support without fresh verification on target hardware.
- Current Linux startup flags in `main.js` use EGL/ANGLE/OpenGL-related Chromium switches and ignore the GPU blocklist. These affect compositing/GL behavior, not guaranteed hardware video decode.
- Packaged Linux launches keep Chromium sandboxing enabled by default. `VIDEOSWARM_DISABLE_SANDBOX=1` is an explicit warned compatibility escape hatch, not an acceptable release default or test assumption.

## Coding Conventions

- Match the existing style: React function components/hooks in the renderer, CommonJS in the Electron main process, semicolons used inconsistently but generally present in newer code.
- Keep changes narrowly scoped. This app is performance-sensitive; avoid broad refactors in playback, masonry, resource management, or IPC unless the task calls for it.
- Prefer small pure helpers for logic that needs tests.
- Keep UI dense and utilitarian. This is a working desktop tool, not a marketing page.
- Preserve cross-platform native paths, especially Windows/UNC containment and file operations; renderer media playback stays on opaque protocol URLs.
- User-facing keyboard shortcuts are catalogued in `src/hotkeys/shortcutCatalog.js`. When adding or changing a shortcut, update its handler and focused tests in the same change; shortcut help must render from the catalog rather than duplicating a second hard-coded list.
- Do not commit generated outputs, build artifacts, coverage, local databases, or caches.

## Git Workflow

- Check `git status --short` before editing and before committing.
- Do not overwrite or revert user changes unless explicitly asked.
- Commit after each completed change. Keep commits small and focused, with a message that describes the user-visible or maintenance outcome.
- If the worktree already contains unrelated changes, do not include them in your commit. Stage only the files you changed.
- If existing unrelated changes make a clean commit impossible, stop and explain what is blocking the commit.
