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

Status: **Unimplemented** (live scan feedback is implemented; incremental
delivery and watcher reconciliation remain outstanding)

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

The live-progress portion of this section is **Implemented**: scan-owned phase
events now report real discovery, indexing, reconciliation, and enrichment
activity. The parent deliverable remains **Unimplemented** because enumeration
still returns one final array and the watcher does not yet buffer events before
the initial scan.

### 2. Persistent content and file-instance index

Status: **Implemented** (2026-07-13)

The database separates content identity from filesystem instances:

- `library_roots`: indexed roots, explicit pin state, and refresh state.
- `directories`: root-relative hierarchy and aggregate review counts.
- `media_content`: fingerprint-keyed technical metadata and thumbnail identity.
  Existing fingerprint-keyed tag/rating tables remain the compatibility
  storage surface for the same content identity.
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

Status: **Implemented** (2026-07-13)

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
| Live scan telemetry | **Implemented** | Scan-ID-scoped, throttled phase events expose real discovery, indexing, reconciliation, enrichment, warning, path, reuse, and timing data. Main-process loops yield regularly so feedback and cancellation stay responsive; landed in `e1d5504`. |
| Informative loading dialog and Escape cancellation | **Implemented** | The accessible dialog shows honest determinate/indeterminate state, phase activity, live counters, paths, elapsed/heartbeat feedback, whole-app working-set memory, persistent errors, and one Cancel/Escape path; landed in `062e23a` and `e1d5504`. |
| Incremental enumeration batches | **Unimplemented** | The scan protocol still returns one final array after enumeration and enrichment. |
| Watch-before-scan reconciliation | **Unimplemented** | Requires buffered watcher generations. |
| Persistent content/file-instance schema and lifecycle | **Implemented** | Profile-local roots, pin state, empty directories, distinct instances, restart fingerprint reuse, safe reconciliation, and watcher missing-state updates landed in `ef923ed`, `842e0a2`, and `4eaf2e4`. |
| Virtualized masonry | **Implemented** | Complete logical geometry, viewport-plus-overscan mounting, ID-based reachability/selection, logical anchoring, and 5,000-item bounds landed in `157ecf3` and `331a360`. |
| Stable masonry/observer/card callback identities | **Implemented** | Observer thresholds, collection callbacks, and per-card handlers remain stable across scroll-driven parent renders; landed in `331a360`. |
| Cancel-safe media initialization | **Implemented** | Queued and in-flight work is generation-owned and cleaned on unmount; failed recovery and the idle frame pump were fixed with regressions in `e85030a`. |
| Atomic media loader/decoder scheduler | **Unimplemented** | Current admission mirrors React Sets. |
| Fullscreen URL and keyboard lifecycle hardening | **Implemented** | Fullscreen now owns its media element and blob URL, navigates by current record ID, has one keyboard owner, and declaratively suspends/resumes grid playback; landed in `331a360`. |
| Linux playback modes and adaptive decoder budget | **Unimplemented** | Requires telemetry and UX controls. |
| Hidden/minimized work suspension | **Unimplemented** | Background throttling is currently disabled. |
| Bounded process-lifetime caches and queues | **Unimplemented** | Main and renderer maps need ownership limits. |
| Asynchronous thumbnail IPC and persistence | **Unimplemented** | Current bridge uses synchronous IPC. |
| Folder tree, scope control, and sibling cycling | **Unimplemented** | Requires root/directory state. |
| Pinned lightweight libraries and smart views | **Unimplemented** | Pin state now persists, but pin management, navigation, and saved-view UX have not landed. |
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
bounded enrichment workers, and adaptive Linux playback remain explicitly
**Unimplemented** until their acceptance criteria land. Live phase telemetry is
implemented in the following slice without claiming incremental delivery.

## Live scan feedback implementation slice

1. **Implemented** — Add a scan-owned, throttled progress reporter with
   sequence numbers, elapsed time, timestamps, scan/root identity, and forced
   phase transitions for enumeration, indexing, reconciliation, enrichment,
   finalization, cancellation, and errors.
2. **Implemented** — Report monotonic lifetime counters plus phase-local
   current/total values for visited directories, checked entries, discovered
   videos, indexed/enriched files, reused fingerprints, warnings, and the
   current location.
3. **Implemented** — Yield from main-process enumeration, indexing, and
   enrichment loops at bounded intervals so the loading dialog, heartbeat, and
   cancellation IPC remain responsive during large recursive scans.
4. **Implemented** — Extend batch database indexing with safe progress
   callbacks and fingerprint-reuse counts without allowing a telemetry
   observer failure to abort indexing.
5. **Implemented** — Expose a disposable preload progress listener and accept
   events in the renderer only when both scan ID and monotonic sequence match
   the active request. Late events after cancellation cannot revive the
   dialog or replace active state.
6. **Implemented** — Replace artificial percentages with an honest phase rail:
   discovery is indeterminate when its total is unknowable, while indexing and
   enrichment display real current/total progress and percentages.
7. **Implemented** — Redesign the loading dialog as a compact, responsive,
   accessible status surface with live counts, root/current locations,
   elapsed time, last-update heartbeat, warning feedback, focus management,
   persistent error state, and a shared Cancel/Escape action.
8. **Implemented** — Display the existing whole-application working set in MB
   and label unavailable data as “Measuring…” rather than presenting an
   unsupported renderer heap reading as `0%`.
9. **Implemented** — Add native reporter/database regressions, lifecycle tests
   for stale events and cancellation, and component/application tests for
   progress semantics, memory labels, focus, errors, and status wiring.

The following adjacent work remains **Unimplemented**:

- Enumeration batches and record patches are not streamed to the renderer;
  the first grid still waits for the final scan result.
- The watcher does not start before enumeration or reconcile a buffered event
  generation with the initial result.
- Enrichment does not yet use a bounded worker pool that prioritizes the first
  visible viewport.
- Folder-open performance marks, Electron-runtime smoke coverage, and Linux
  CPU/RSS/event-loop soak budgets remain part of Section 8.

## Persistent index implementation slice

1. **Implemented** — Add additive, transactional `library_roots`,
   `directories`, `media_content`, and `file_instances` tables without
   discarding the existing fingerprint metadata/tag/rating surface.
2. **Implemented** — Persist root pin/refresh state, empty directories,
   file-instance presence, and direct/subtree aggregate counts per profile.
3. **Implemented** — Reuse a persisted fingerprint when root-relative path,
   size, and modification time are unchanged, including across restart.
4. **Implemented** — Enumerate cheap file stats first, index the scan in a
   batch transaction, then construct renderer records without fingerprinting a
   second time.
5. **Implemented** — Reconcile only complete or explicitly successful
   directory coverage; cancelled, unreadable, and depth-truncated work cannot
   mark uncertain branches missing.
6. **Implemented** — Propagate captured root/profile ownership through native
   and polling watcher sessions. Native unlink and polling deltas update
   instance presence, stale sessions are dropped, and polling reconciles its
   first pass against persisted state.
7. **Implemented** — Serialize profile reconfiguration with latest-request
   ownership and dispose watcher/window listeners on close.
8. **Implemented** — Add database, cancellation, copied-instance, recursive
   reconciliation, watcher-session, and polling-baseline regressions.

The following adjacent work remains **Unimplemented**:

- User-facing pin/unpin management, folder navigation, smart views, and an
  explicit reviewed state remain part of Section 7. Until then,
  `reviewed_count` means a present item with a rating.
- Watch-before-scan buffering and renderer-side incremental batches remain
  part of Section 1.
- Fingerprint format `v1` includes creation time. Ordinary byte-identical
  copies are safely represented as distinct instances but may occupy distinct
  content rows; a versioned content-digest migration is deferred.
- Watcher bursts still refresh directory aggregates per event. Debounced or
  incremental aggregate maintenance and its burst benchmark remain part of
  Sections 6 and 8.
- The SQLite suites execute successfully through Electron's ABI locally, but
  a mandatory non-skippable Electron-ABI CI job remains part of Section 8.

## Virtual masonry implementation slice

1. **Implemented** — Build deterministic, DOM-independent masonry geometry for
   every displayed ID, including complete positions, total height, visual
   order, direct ID lookup, and per-column binary-search windowing.
2. **Implemented** — Mount only the viewport plus one viewport of overscan in
   lightweight absolute slots. A bounded pinned-ID path preserves the active
   fullscreen source card without expanding the normal activation window.
3. **Implemented** — Keep scrolling and observer roots reactive when the
   conditional grid mounts, support direct scrolling to any logical item, and
   preserve the first surviving visible ID while dimensions, zoom, filtering,
   or sorting change.
4. **Implemented** — Batch aspect-ratio corrections once per animation frame,
   key them to file signatures, and refresh only mounted observer targets. No
   card-query pass is performed during React layout.
5. **Implemented** — Base range selection, filtering reconciliation, focus,
   render-limit reachability, and fullscreen navigation on the displayed ID
   model rather than mounted DOM nodes.
6. **Implemented** — Stabilize observer options and collection-level card
   callbacks, explicitly clear media/resource membership on virtual unmount,
   and remove persistent offscreen `will-change`, blur, and placeholder
   animation costs.
7. **Implemented** — Make fullscreen media modal-owned, revoke only owned blob
   URLs, use the shared file URL helper, and suspend/resume the bounded grid's
   desired playback declaratively.
8. **Implemented** — Add deterministic 1,000/5,000-record layout and hook
   regressions covering bounded mounts, top/middle/bottom reachability, visual
   order, selection ranges, aspect batching, logical anchoring, late mounting,
   callback stability, unmount cleanup, and fullscreen lifecycle behavior.

The following adjacent work remains **Unimplemented**:

- A dedicated memoized virtual-grid child that keeps scroll-window state out
  of the top-level `App` render remains a possible follow-up if Electron trace
  data shows parent reconciliation is material on Linux.
- Aspect corrections currently recompute logical geometry once per animation
  frame batch. Incremental suffix/column repair remains a possible follow-up
  if profiling shows the bounded JavaScript pass is significant.
- Electron-runtime scroll smoke tests and Linux CPU/RSS/DOM/media soak budgets
  remain part of Section 8; the current 5,000-record coverage is deterministic
  Vitest/jsdom coverage rather than an Electron benchmark.
- Explicit folder headers, a directory tree, sibling-folder cycling, and
  per-folder view restoration remain part of Section 7.

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
