# Large Library, Playback, and Reliability Architecture

Status: Active design specification  
Last updated: 2026-07-13

## Purpose

This specification defines how Video Swarm should scale from hundreds to many
thousands of short video clips while remaining responsive on Linux systems that
often decode video in software. It also defines the reliability, memory, UX,
test, and observability work needed to support that scale.

The primary workload is reviewing dense folders of outputs from generative
video tools. Fast visual comparison remains the core product behavior. Library
features must add organization without forcing users to import, copy, or
rearrange their source files.

## Status convention

Every tracked deliverable has one of two states:

- **Implemented**: all acceptance criteria listed for that deliverable are in
  the repository and covered by appropriate verification.
- **Unimplemented**: one or more acceptance criteria remain. Code may exist,
  but the deliverable is not considered finished.

Status is intentionally binary. Notes may describe groundwork that has landed,
but unfinished parent deliverables remain Unimplemented.

## Goals

- Show a usable first screen without waiting for the entire directory tree to
  be fingerprinted, parsed, indexed, and cloned across IPC.
- Keep mounted React cards, live media elements, cache entries, worker jobs, and
  watcher activity bounded as the collection grows.
- Make folder changes and profile changes cancellable and latest-request-wins.
- Adapt simultaneous playback to measured decoder and event-loop capacity,
  especially on Linux software decode.
- Add explicit subfolder navigation and persistent library roots while keeping
  the flattened swarm view available.
- Turn memory, scan, layout, and playback behavior into measurable regression
  budgets.

## Non-goals

- Copying media into an application-managed catalog.
- Promising NVIDIA hardware video decoding on Linux.
- Replacing the filesystem with opaque album storage.
- Building near-duplicate or semantic video search in the initial phases.
- Preserving background playback while the application is minimized unless a
  future explicit user setting requires it.

## Design principles

1. **Filesystem remains the source of truth.** The database is an index and
   metadata store, not the owner of media files.
2. **Work is generation-owned.** Every long-running operation belongs to a
   renderer, root path, and profile generation. Results from stale generations
   are discarded and must never mutate the active profile.
3. **Visibility drives expense.** Enumeration may cover the whole root, but
   media creation, dimension parsing, thumbnails, and playback prioritize the
   viewport and explicit user intent.
4. **Collections are modeled, not mounted.** Selection, filters, metadata, and
   order operate over records; only a viewport window becomes React/DOM/media
   objects.
5. **Limits are observable and bounded.** Every process-lifetime cache, queue,
   timer, observer, and child process has an owner, limit, and reset path.
6. **Progress reflects real work.** Loading UI uses enumerated and enriched
   counts rather than artificial delays or fixed percentages.

## Target architecture

### 1. Scan coordinator and incremental folder opening

Folder opening becomes a job coordinated by the Electron main process.

Each job owns:

- A unique scan ID.
- The requesting `webContents.id`.
- The selected root and recursive scope.
- The active profile generation.
- A cancellation signal.
- Enumeration and enrichment counters.

The coordinator cancels the previous job for a renderer when a new root is
opened, when the user cancels, when the profile changes, when the renderer is
destroyed, or when the window closes. Main-process loops check cancellation
between directories and files. Database writes verify the profile generation
immediately before mutation.

Folder opening has two stages:

1. **Enumeration:** walk directory entries and collect cheap instance data such
   as path, relative path, name, size, and modification time. Emit batches as
   soon as they are available.
2. **Enrichment:** use bounded concurrency to reuse or calculate fingerprints,
   load metadata, parse dimensions when needed, and emit record patches.

The renderer accepts only events matching its current scan ID. It stores media
records by ID and applies batches without replacing the complete collection.
Cancellation is a normal result, not an error toast.

The watcher starts before enumeration. Events are buffered until enumeration
finishes, then reconciled against the scan result before live delivery begins.

Acceptance criteria:

- A scan can be explicitly cancelled from the loading overlay or Escape key.
- Opening B while A is in progress cannot allow A to replace B's state.
- Profile changes cancel scans before profile-backed services are reset.
- Renderer/window destruction stops associated main-process work.
- Cancellation checks occur between filesystem/enrichment operations.
- Enumeration records are emitted in bounded batches.
- Progress reports real discovered, enumerated, and enriched counts.
- Watcher events created during initialization are reconciled without loss.

### 2. Persistent content and file-instance index

The database separates content identity from filesystem instances:

- `library_roots`: pinned roots and refresh state.
- `directories`: root-relative hierarchy and aggregate review counts.
- `media_content`: fingerprint-keyed technical metadata, tags, rating, and
  thumbnail identity.
- `file_instances`: root plus relative path, size, modification time,
  fingerprint, and presence state.

An unchanged instance reuses its fingerprint and technical metadata across
process restarts. Deleted files are marked missing and can later be pruned;
identical content in different directories remains represented by distinct
instances.

Acceptance criteria:

- Unchanged instances do not reread fingerprint samples on every app start.
- Identical content can exist at multiple paths without overwriting one path.
- Watcher removal marks an instance missing.
- Library roots and directory counts survive restart and remain profile-local.
- Scan indexing uses batched reads and transactions.

### 3. Virtualized masonry renderer

The collection model contains every matching record, but the renderer mounts
only the viewport plus overscan. Masonry positions and total scroll height are
calculated from persisted or provisional aspect ratios. New measurements patch
positions without remounting the full collection.

Selection, keyboard range selection, filtering, sorting, and folder grouping
operate on collection IDs rather than mounted DOM nodes. Scroll anchoring keeps
the user's logical position when records arrive or dimensions are corrected.

Acceptance criteria:

- A 5,000-record collection has a bounded mounted-card count.
- Scrolling can reach every item and preserves order and selection semantics.
- Aspect-ratio corrections do not trigger an O(n) DOM query per React render.
- Observer options and per-card callbacks have stable identities.
- Persistent `will-change`, blur, and animations are not applied to thousands
  of offscreen placeholders.

### 4. Media lifecycle and scheduler

Media creation is owned by a cancelable scheduler. A card records its media
element immediately on creation, and every exit path pauses it, removes the
source, calls `load()` where appropriate, detaches it, and revokes owned blob
URLs. Scheduled initialization and retries carry a card generation token and
cannot execute after unmount or identity change.

The scheduler atomically reserves loader and decoder slots. React state mirrors
the scheduler but is not the authority for admission.

Acceptance criteria:

- No queued initialization can create media after its card unmounts.
- An in-flight element is reachable by cleanup before `loadeddata`.
- Failed recovery is reported rather than treated as success.
- Scheduler animation frames stop when the queue is empty.
- Loader reservations cannot overshoot through stale React snapshots.
- Fullscreen fallback URLs use the shared file URL helper and revoke owned blob
  URLs during navigation and close.

### 5. Linux-aware playback modes

Playback policy has three user-facing modes:

- **Balanced:** adaptive decoder cap with viewport-center, hover, selection,
  and fullscreen priority.
- **All Motion:** attempts to animate all visible cards within explicit safety
  limits.
- **Static + Hover:** uses cached still or motion previews and activates the
  original only on hover, selection, or fullscreen.

The adaptive budget incorporates hardware concurrency, event-loop/frame delay,
video pixel area, dropped-frame rate, measured working-set changes, and
available system memory. Minimized or hidden windows pause playback, loading,
thumbnail capture, and high-frequency polling.

Optional generated proxies are stored under a bounded disk quota and never
replace originals.

Acceptance criteria:

- Balanced mode reduces active decoders when dropped frames or long tasks rise.
- The minimum decoder target is not forced to 100 on weak systems.
- Hidden/minimized windows stop expensive media work by default.
- The UI states that Linux hardware decoding is detected, not guaranteed.
- Proxy generation has concurrency, timeout, cancellation, and disk limits.

### 6. Bounded caches, queues, and native work

Process-lifetime maps for fingerprints, dimensions, masonry ratios, and
thumbnail signatures use entry or byte bounded LRUs. Folder/profile changes
prune or reset generation-owned entries. In-flight promise caching deduplicates
repeated fingerprint and dimension work.

Thumbnail IPC is asynchronous. Disk writes and recency persistence are batched
outside renderer-critical work. Thumbnail tasks do not retain stale media DOM
nodes after a generation changes.

External `ffmpeg` work has concurrency, stdout/stderr caps, timeouts, and child
process cancellation on renderer destruction and shutdown.

Acceptance criteria:

- Every cache and queue has a documented limit and reset path.
- Repeated A/B folder switching reaches a stable post-GC memory plateau.
- Thumbnail reads/writes do not use synchronous renderer IPC.
- Thumbnail eviction accounts for bytes or pixels, not only entry count.
- Child processes cannot run indefinitely or buffer unlimited output.

### 7. Folder and lightweight library UX

The app supports both a flattened swarm and explicit navigation:

- Visible root breadcrumb and current path.
- Collapsible folder tree with matching-video and review counts.
- Scope control: All descendants, Current folder, Current subtree.
- Previous/next sibling-folder actions that skip empty filtered folders.
- Optional folder headers when the tree is hidden.
- Per-folder restoration of scroll, selection, sort, and filters.
- Pinned library roots backed by the persistent instance index.

Generative-video review adds pick/reject/reviewed state, saved smart views, and
optional sidecar/workflow parsing for prompt, seed, model, sampler, source
image, and generation run. The flattened swarm remains the default workflow.

Acceptance criteria:

- An empty folder remains an open root and displays its path.
- Changing recursive scope refreshes the active root safely.
- Folder grouping has visible structure rather than sort adjacency alone.
- Users can cycle sibling folders without reopening the native picker.
- Library roots do not copy or take ownership of source media.

### 8. Observability, testing, and CI

Performance measurements use stable marks for folder request, first batch,
first usable grid, scan completion, and enrichment completion. Electron tracing
and heap snapshots support local profiling. CI begins with baseline-relative
budgets and ratchets them as the architecture stabilizes.

Required suites:

- Scan cancellation, stale-result, profile-switch, and watcher-reconciliation
  integration tests.
- Media unmount-before-load, retry cancellation, failed recovery, and blob URL
  ownership tests.
- Watcher single-flight, empty-baseline, fallback, and listener-count tests.
- Electron-runtime SQLite integration tests that cannot silently skip.
- Electron smoke tests for folder open, scrolling, filtering, fullscreen,
  profiles, watcher changes, minimize/restore, and clean shutdown.
- Synthetic 1,000/5,000-card virtualization and render-count tests.
- Linux soak tests tracking RSS, post-GC heap, DOM/media counts, file handles,
  CPU, event-loop delay, dropped frames, watcher counts, and database growth.

Acceptance criteria:

- CI uses a Node version supported by the declared engine and Electron runtime.
- Coverage excludes generated output and has ratcheted thresholds.
- SQLite tests run against the Electron native-module ABI.
- Lint is a real static-analysis command.
- Performance failures report measured regressions rather than arbitrary sleeps.

### 9. Electron boundary and shutdown hardening

Local media should eventually use a registered application protocol so
`webSecurity` can be restored. IPC validates sender, payload type/size, and
filesystem scope for destructive operations. Window, watcher, cache, scan, and
child-process ownership all have explicit disposal during close and quit.

Acceptance criteria:

- `webSecurity` is enabled for production windows.
- Destructive file operations are restricted to authorized roots where
  feasible and use one tested implementation.
- Watcher/window listeners are disposed on close and do not retain destroyed
  windows.
- Settings writes are serialized, debounced, and atomic.
- Shutdown reliably cancels jobs and flushes bounded persistence.

## Delivery status

| Deliverable | Status | Notes |
| --- | --- | --- |
| Scan cancellation and latest-request-wins safety | **Implemented** | Request IDs, cooperative cancellation, stale-result rejection, profile/window/app teardown, and focused renderer tests landed in `062e23a`. The scan still returns one final array. |
| Loading overlay and Escape cancellation | **Implemented** | The overlay forwards one cancellation action and Escape uses the same path; landed in `062e23a`. |
| Incremental enumeration batches and real progress | **Unimplemented** | Requires scan protocol expansion. |
| Watch-before-scan reconciliation | **Unimplemented** | Requires buffered watcher generations. |
| Persistent content/file-instance schema | **Unimplemented** | Existing schema stores one last-known path. |
| Virtualized masonry | **Unimplemented** | Current renderer materializes all cards. |
| Stable masonry/observer/card callback identities | **Unimplemented** | Independent optimization after safety work. |
| Cancel-safe media initialization | **Implemented** | Queued and in-flight work is generation-owned and cleaned on unmount; failed recovery and the idle frame pump were fixed with regressions in `e85030a`. |
| Atomic media loader/decoder scheduler | **Unimplemented** | Current admission mirrors React Sets. |
| Fullscreen URL and keyboard lifecycle hardening | **Unimplemented** | Separate correctness slice. |
| Linux playback modes and adaptive decoder budget | **Unimplemented** | Requires telemetry and UX controls. |
| Hidden/minimized work suspension | **Unimplemented** | Background throttling is currently disabled. |
| Bounded process-lifetime caches and queues | **Unimplemented** | Main and renderer maps need ownership limits. |
| Asynchronous thumbnail IPC and persistence | **Unimplemented** | Current bridge uses synchronous IPC. |
| Folder tree, scope control, and sibling cycling | **Unimplemented** | Requires root/directory state. |
| Pinned lightweight libraries and smart views | **Unimplemented** | Depends on file-instance schema. |
| Electron smoke and performance soak harnesses | **Unimplemented** | Existing tests are primarily unit-level. |
| Electron-ABI SQLite test job | **Unimplemented** | Current suites can silently skip. |
| Production Electron boundary hardening | **Unimplemented** | Requires custom media protocol and IPC validation. |

## Initial implementation slice

The first implementation establishes ownership and cancellation before adding
streaming or virtualization:

1. **Implemented** — Assign a unique request ID to each renderer folder scan.
2. **Implemented** — Add explicit main/preload cancellation and main-loop
   cancellation checks.
3. **Implemented** — Make renderer folder selection latest-request-wins and
   expose one cancel action to the overlay and Escape key.
4. **Implemented** — Remove artificial folder-loading delays; landed in
   `bd793f8`.
5. **Implemented** — Make queued video initialization cancelable, track
   elements immediately, and stop the scheduler's animation frame while idle.
6. **Implemented** — Add focused regression tests for these guarantees.

The scan still returns one final array after this slice. Incremental batches,
enrichment workers, virtualization, library schema changes, and adaptive Linux
playback remain explicitly Unimplemented until their acceptance criteria land.

## Migration and compatibility

- Existing `readDirectory(folderPath, recursive)` callers remain supported
  during the scan-protocol transition.
- Schema evolution must be transactional and preserve profile isolation,
  ratings, and tags.
- Existing full-path video IDs can remain compatibility aliases while the
  collection moves toward stable file-instance IDs.
- Windows path encoding must continue to use the shared file URL helper.
- Generated caches, proxy files, and indexes remain rebuildable and must not be
  committed to the repository.
