# Large Library, Playback, and Reliability Architecture

Status: Core architecture implemented; deferred research tracked below
Last updated: 2026-07-14

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
- Bound simultaneous playback from platform, CPU, memory, and source-pixel
  capacity while exposing decoder and event-loop health for profiling,
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

Status: **Implemented** (2026-07-14)

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

The complete coordinator is now **Implemented**. Opt-in protocol version 1
streams an initial batch of 32 cheap records, then bounded 128-record
enumeration batches and 32-record enrichment patches. Indexing uses
64-record transactions with four bounded fingerprint workers; rich record
enrichment uses two workers. The renderer keeps one scan-owned ID map, applies
only monotonic batches from the active scan, prioritizes up to 256 viewport
IDs, waits for the final record sequence, and performs an authoritative stale
record prune without cloning a final full array across IPC. Legacy callers
that do not request streaming still receive the original final-array response.

The watcher is started before enumeration. During initialization, chokidar
captures its bounded 16,384-entry observed baseline with stat signatures,
coalesces changes until ready, compares those signatures with the scan, and
drains changes to quiescence before entering live delivery. Polling fallback
is seeded from the scan baseline, and overflow performs one authoritative
reconciliation rather than replaying every known file as newly added.
Cancellation, profile/window ownership, pre-ready watcher failures, response
versus event ordering, cached stale-row removal, and buffered add/remove races
have focused regressions.

#### Folder revisit acceleration

Status: **Implemented** (2026-07-14)

A previously indexed root should be able to hydrate a last-known collection
directly from its profile-local SQLite `file_instances` and content metadata,
then run the normal generation-owned scan in the background. The UI labels the
collection as refreshing until that scan reconciles additions, changes, and
removals; cached rows are a fast preview, never a replacement for filesystem
validation.

This should not keep inactive React trees, media elements, blob URLs, decoded
frames, or thumbnails in memory. SQLite remains the primary cache. If profiling
later justifies a memory tier, it contains only serializable record/layout/view
state, is limited by both bytes and root count, and is cleared on profile
changes. It must not extend the current process-lifetime metadata map without
first replacing that map with a bounded LRU under Section 6.

Acceptance criteria:

- Revisiting an indexed root can show a virtualized last-known grid without
  waiting for its full recursive scan, including after an application restart.
- The grid clearly indicates background refresh and safely patches or removes
  stale records as validation completes.
- Cached hydration, refresh events, and watcher events remain profile- and
  scan-generation-owned; switching again cannot resurrect stale state.
- Inactive roots retain no media/DOM resources, and any optional memory tier
  has tested byte and root-count limits.
- Folder-switch profiling demonstrates a meaningful first-grid improvement
  before an in-memory tier is enabled.

The SQLite hydration path is now **Implemented**: an indexed root is read with
two bulk profile-owned queries, mapped to the normal serializable renderer
record shape, and displayed only when its request/scan generation still owns
the folder open. Missing instances are excluded, direct-only opens exclude
nested records, no inactive media/DOM state is retained, and the ordinary
filesystem scan continues as the authoritative background refresh. Cache read
failure falls back to the normal scan, while refresh failure leaves an already
hydrated grid usable. The lifecycle exposes `isRefreshingFolder`, and the
navbar renders a compact, reduced-motion-safe “Refreshing index” status until
validation finishes.

The real-hardware acceptance gate is also **Implemented**. The local Linux
harness runs five cold, same-process warm, and post-restart trials for both
1,000- and 6,000-clip roots. It records request-to-first-grid and authoritative
refresh completion separately, requires identical final counts and relative
path digests, checks virtual-card/media bounds, switches to a sentinel root to
detect retained inactive resources, and rejects same-process heap or
working-set growth beyond explicit budgets. The measured record and exact
reproduction command are kept below under “Folder-revisit hardware record.”

##### Folder-revisit hardware record

Recorded 2026-07-14 on Linux 6.17, an Intel Core i9-13900K host with 32
logical CPUs and 128 GB RAM. The inputs were stable nested roots containing
exactly 1,000 and 6,000 playable short-video hard links. Each cell is the
median of five trials on the same landed code. “Warm” revisits in one Electron
process; “restart” reads the same profile-local SQLite index from a new
Electron process.

| Root | Cold first grid | Warm first grid | Warm speedup | Restart first grid | Restart speedup | Cold / warm / restart refresh |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 clips | 198.7 ms | 14.6 ms | 13.61× | 38.3 ms | 5.19× | 314.7 / 150.8 / 224.3 ms |
| 6,000 clips | 215.4 ms | 14.7 ms | 14.65× | 53.3 ms | 4.04× | 1,354.8 / 731.6 / 1,104.3 ms |

All 30 measured opens produced the exact on-disk count and one stable sorted
relative-path digest for their root. Cached first grids contained no more than
128 serializable records; the complete SQLite snapshot hydrated only after
the first usable grid commit and remained subordinate to watcher/scan deltas.
The active virtual surface peaked at 18 cards, 18 masonry slots, and 18 media
elements. After switching to the one-clip sentinel, every trial reported zero
cards, slots, and media elements belonging to the inactive root. The
same-process warm cleanup delta was +0.18 MB heap / +130 MB working set for the
1,000 root and +3.43 MB / +124 MB for the 6,000 root, below the harness's 64 MB
heap and 256 MB working-set budgets. The collection lifecycle retains only its
active scan-owned record map; the existing bounded 128-root view-state LRU is
serializable and owns no React tree, media element, thumbnail, or decoded
resource. These results do not justify an in-memory media cache.

The two exact commands used for the recorded reports were:

```text
npm run profile:folder-revisit -- --folder-1000 /tmp/videoswarm-revisit-smoke-1000 --trials 5 --output /tmp/videoswarm-revisit-1000-5-final.json
npm run profile:folder-revisit -- --folder-6000 /tmp/videoswarm-revisit-smoke-6000 --trials 5 --output /tmp/videoswarm-revisit-6000-5-final-coherent.json
```

The JSON reports remain machine-local `/tmp` evidence and are not repository
artifacts. The reusable runner and deterministic budget evaluator live under
`scripts/performance/`; `npm run profile:folder-revisit -- --help` documents
portable input paths and optional scenarios.

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

Status: **Implemented** (2026-07-13)

Media creation is owned by a scoped, cancelable scheduler. A card records its
media element immediately on creation, and every exit path pauses it, removes
the source, calls `load()` where appropriate, detaches it, and revokes owned
blob URLs. Scheduled initialization, queue admission, recovery, and retries
carry opaque generation leases and cannot execute after unmount or identity
change.

The scheduler atomically reserves each loader together with its future resident
slot. Denied visible cards enter a priority queue and are awakened as capacity
is released. Decoder ownership is separate: a replacement is not admitted
until the previous card has physically paused and acknowledged its stop lease.
React state mirrors scheduler decisions but is not the authority for admission.

Fullscreen playback and one-shot media work use distinct bounded decoder lanes
so they cannot bypass grid limits without accounting. Folder/profile changes
invalidate a complete scheduler scope. Destructive file actions block affected
IDs, release native media handles before mutation, and cannot race an immediate
reload of the same path.

Acceptance criteria:

- No queued initialization can create media after its card unmounts.
- An in-flight element is reachable by cleanup before `loadeddata`.
- Failed recovery is reported rather than treated as success.
- Scheduler animation frames stop when the queue is empty.
- Loader reservations cannot overshoot through stale React snapshots.
- A visible card denied admission is queued, wakes automatically, and releases
  its wait lease on invisibility, identity change, or unmount.
- Decoder handoff does not free physical capacity until pause acknowledgement.
- Pause acknowledgement requires the exact non-null decoder lease; a stale
  render or delayed media event cannot release a lease granted by a newer
  scheduler pass.
- Stale loader, resident, decoder, recovery, and event callbacks cannot mutate
  the current card generation.
- Electron grid and fullscreen media use generation-bound opaque protocol URLs;
  imported web files revoke only blob URLs they own during navigation/close.
- Fullscreen and frame-capture decoder lanes are bounded and release their
  leases on success, failure, timeout, navigation, and teardown.
- Trash operations prevent affected IDs from being re-admitted until the
  native result is reconciled.

### 5. Linux-aware playback modes

Status: **Implemented** (2026-07-14)

Playback policy has four user-facing modes:

- **Balanced:** conservative structural decoder cap with viewport-center,
  hover, selection, and fullscreen priority.
- **Adaptive Motion:** uses the higher motion-oriented structural decoder
  budget while retaining platform, memory, and source-pixel limits.
- **All Motion:** requests a decoder for every visible card, matching the
  pre-mode behavior and retained-decoder ordering without telemetry derating,
  viewport-center churn, or Chromium background throttling. This is an
  explicit user opt-in to higher CPU and memory use.
- **Static + Hover:** retains a paused first-frame preview and activates motion
  only on hover, selection, or fullscreen.

The Balanced and Adaptive Motion budgets are structural: they incorporate
platform, hardware concurrency, video pixel area, system memory, and available
memory. Event-loop/frame delay, long-task occupancy, dropped-frame rate, and
working-set changes remain diagnostic signals because whole-application
pressure cannot currently distinguish decoder saturation from folder loading,
masonry work, or a cold scroll. Minimized or hidden windows pause playback,
loading, thumbnail capture, and high-frequency polling.

Optional generated proxies are stored under a bounded disk quota and never
replace originals.

One collection-wide sampler measures p95 animation-frame delay, long-task
occupancy, decoded/dropped frame deltas from the exact registered media
elements, source pixel area, whole-application working-set growth, and
available system memory. The sampler classifies runtime health and exposes the
result for diagnostics, but it does not change the Balanced or Adaptive Motion
decoder target. Their targets are recomputed from the structural safety cap,
so consecutive adverse whole-app samples cannot recursively decay an 8- or
14-decoder budget toward one. All Motion bypasses structural decoder caps and
sets its target to the complete visible set; it still obeys visibility,
scheduler ownership, physical cleanup, fullscreen, and app-suspension
lifecycles.
Static + Hover retains paused first-frame media for nearby cards and admits
decoders only for hovered or selected cards; fullscreen uses its separate
scheduler lane.

Decoder pause acknowledgements are exact ownership mutations. Cards never
acknowledge with a null lease, and delayed `pause` events are ignored after a
new play request has made the element desirable again. All Motion also retains
already-admitted decoders ahead of recent and newly visible candidates instead
of rebuilding its order from viewport center on every scroll. Together these
rules prevent a stale card render or media event from releasing a newly granted
decoder and entering a scroll-triggered pause/play loop.

Chromium owns media-clock synchronization and normally drops decoded frames
while keeping `currentTime` at normal playback speed. Video Swarm does not
periodically seek playing tiles to simulate frame dropping: forced catch-up
seeks flush decoder state, can create a visible slow/jump cadence, and add work
under software-decode pressure. Detailed per-element quality and
policy memory polling is disabled in All Motion because it cannot
influence that mode; the independent resource-ownership memory limit,
lightweight long-task signal, and lifecycle safeguards remain active.

Review badges remain opaque/translucent CSS overlays without `backdrop-filter`.
Avoiding per-card backdrop blur prevents that Section 7 affordance from adding
software-compositing work over a grid of live videos on Linux.

Page Visibility and main-process BrowserWindow activity jointly suspend work.
Suspension physically detaches grid/fullscreen sources, drives every scheduler
lane to zero, cancels queued initialization and thumbnail work, pauses
progressive growth, telemetry, and memory polling, and cancels renderer-owned
proxy jobs. The BrowserWindow is constructed with Chromium background
throttling disabled, matching the stable pre-mode media scheduling baseline;
playback-mode changes never flip that process-wide scheduling state. Physical
hidden/minimized suspension remains the sole background-work control. Restoring
the window resumes from current collection state rather than rebuilding the
folder.

The optional profile-local proxy cache returns the original immediately while
one background ffmpeg worker runs. It permits four additional pending jobs,
uses a 120-second timeout, caps stdout/stderr at 1 MiB/256 KiB, cancels work on
owner, profile, window, or app teardown, and uses atomic publication. Completed
proxies are capped at 512 entries and 1 GiB with disk-byte LRU eviction. A
proxy is selected only on a subsequent media load after it is cached; originals
remain untouched and are always the fallback.

Acceptance criteria:

- Balanced uses a conservative platform/core/memory/pixel safety cap.
- Adaptive Motion preserves the higher structural safety-capped policy.
- Whole-application health telemetry remains diagnostic and cannot recursively
  reduce either structural decoder target toward one.
- All Motion targets every visible card and is not silently telemetry-derated.
- All Motion retains already-admitted decoders across viewport-center changes.
- The BrowserWindow starts with background throttling disabled and mode changes
  do not reconfigure existing or newly admitted Chromium media players.
- Only an exact non-null lease can acknowledge decoder pause, and a delayed
  stale pause event cannot revoke a newly granted lease.
- All Motion leaves frame dropping and media-clock synchronization to Chromium
  without forced seek-based catch-up.
- The minimum decoder target is not forced to 100 on weak systems.
- Hidden/minimized windows stop expensive media work by default.
- The UI states that Linux hardware decoding is detected, not guaranteed.
- Proxy generation has concurrency, timeout, cancellation, and disk limits.

Causal decoder-specific automatic derating and stabilized recovery are
**Unimplemented**. Reintroducing automatic runtime control requires telemetry
that can attribute pressure to active media decoding and exclude scan, layout,
admission-settling, and other whole-app work; repeated samples must converge to
a stable target rather than feed the prior reduced target back into the next
decision.

### 6. Bounded caches, queues, and native work

Status: **Implemented** (2026-07-13)

Process-lifetime maps for fingerprints, dimensions, masonry ratios, and
thumbnail signatures use entry or byte bounded LRUs. Collection/root changes
prune renderer ratios and dimensions; metadata-store/profile disposal resets
fingerprints. Fingerprint and dimension work is deduplicated, limited to 64
outstanding operations per cache, and cannot start or repopulate after its
generation is cleared.

Thumbnail IPC is asynchronous. Disk writes and recency persistence are batched
outside renderer-critical work. Thumbnail tasks do not retain stale media DOM
nodes after a generation changes. The renderer has one capture lane and 64
pending requests; the native cache has two read lanes plus 64 pending reads and
one serialized write lane plus 64 pending writes. Native thumbnails are capped
by entry count, encoded bytes, decoded pixels, and index bytes. Index failures
receive three bounded exponential retries before waiting for a later mutation
or explicit flush.

External `ffmpeg` work has concurrency, stdout/stderr caps, timeouts, and child
process cancellation on renderer destruction and shutdown. Watcher enrichment,
change debouncing, overflow reconciliation, playback waiters, proxy ownership,
and one-shot frame capture also have explicit admission and disposal rules.
BrowserWindow-owned native work captures its `WebContents` while the window is
alive; close cleanup uses that stable reference rather than dereferencing a
destroyed `BrowserWindow`.

Acceptance criteria:

- Every cache and queue has a documented limit and reset path.
- Repeated folder/profile generations keep deterministic cache and queue
  snapshots within their limits and stale generations cannot repopulate them.
- Thumbnail reads/writes do not use synchronous renderer IPC.
- Thumbnail eviction accounts for bytes or pixels, not only entry count.
- Child processes cannot run indefinitely or buffer unlimited output.
- Closing a window disposes native ownership without reading
  `BrowserWindow.webContents` after destruction or showing a main-process
  JavaScript error dialog.

Live Electron RSS/post-GC plateau measurement remains part of the Section 8
Linux soak harness; it is not inferred from deterministic unit tests.

### 7. Folder and lightweight library UX

Status: **Implemented** (2026-07-14)

The app supports both a flattened swarm and explicit navigation:

- Visible root breadcrumb and current path.
- Collapsible folder tree with matching-video and review counts.
- Scope control: All descendants, Current folder, Current subtree.
- Previous/next sibling-folder actions that skip empty filtered folders.
- Optional folder headers when the tree is hidden.
- Per-folder restoration of scroll, selection, sort, and filters.
- Pinned library roots backed by the persistent instance index.

Generative-video review presents the persisted `pick` state as **Accept**, with
Reject, neutral Reviewed, and Unreviewed states, saved smart views, and
optional sidecar/workflow parsing for prompt, seed, model, sampler, source
image, and generation run. Ratings remain independent metadata while implying
that review occurred. Resetting to Unreviewed clears the rating but never tags.
The flattened swarm remains the default workflow.

The completed high-throughput workflow adds stable scope progress, one-handed
A/S/D/F primary shortcuts, compatibility aliases, numeric ratings, opt-in
auto-advance, one-step undo, and an explicit Process Results dialog. Result
processing can move a bounded set of local rejects through the native trash
path or export a deterministic JSON manifest without absolute native paths.
The full contract is specified in
[`review-workflow.md`](review-workflow.md).

The implementation keeps this library deliberately lightweight. Pinned roots,
saved views, directory rows, and metadata remain profile-local references to
source files; Video Swarm never copies or takes ownership of the media. Folder
view restoration is a 128-entry in-memory LRU containing only serializable
scroll offsets, bounded ID selections, filters, and sort state. It never
retains media elements, React nodes, blobs, or inactive video records.

Sidecar metadata is parsed only when the details panel requests one indexed
instance. Candidate lookup is exact and ordered (`video.ext.json`, then
`stem.workflow.json`, then `stem.json`) rather than scanning or guessing across
the directory. Parsing is bounded to 2 MiB, depth 32, 10,000 nodes, two active
jobs, 64 queued jobs, and five seconds; only compact extracted fields are
stored. Profile changes, renderer destruction, and shutdown cancel owned work.

The sandboxed preload remains self-contained: it imports Electron only, while
generation-request validation stays in the main-process IPC trust boundary. A
preload failure must not make native context actions silently disappear. Open,
Show in Explorer, and Move to Recycle Bin remain discoverable with an explicit
disabled state when desktop integration is unavailable. Copy, review, and
rating actions use compact submenus; root menus and submenus clamp to the
viewport and scroll internally when space is constrained.

Selection metadata now uses the renderer-local floating inspector specified in
[`floating-selection-inspector.md`](floating-selection-inspector.md). It opens
beside the primary selected card without changing masonry padding, moves to the
side opposite a fitted context menu, supports bounded pointer and keyboard
movement, updates with selection, and falls back to a compact bottom sheet in a
narrow gallery. It does not retain virtualized cards or create another media
element or Electron renderer.

Acceptance criteria:

- An empty folder remains an open root and displays its path.
- Changing recursive scope refreshes the active root safely.
- Folder grouping has visible structure rather than sort adjacency alone.
- Users can cycle sibling folders without reopening the native picker.
- Library roots do not copy or take ownership of source media.
- Electron's sandboxed preload initializes without arbitrary local module
  imports and exposes profile, metadata, filesystem, and settings bridges.
- Every historical video context action remains reachable and the menu cannot
  extend irretrievably beyond the viewport.
- Selection details remain spatially connected to the active clip without
  changing grid geometry, and close/deselect/context-target behavior cannot
  leave displayed and mutated metadata targets out of sync.
- A rating promotes Unreviewed content to Reviewed, an Unreviewed reset clears
  its rating without changing tags, and Accept/Reject decisions survive rating
  changes.
- Toolbar, shortcut, context-menu, and floating-inspector review/rating actions
  share one serialized workflow and its bounded undo history.
- Result processing ignores active filters, requires an authoritative scan,
  bounds native trash work, and exports no absolute source or record paths.

### 8. Observability, testing, and CI

Status: **Implemented** (2026-07-14)

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

Stable User Timing marks and bounded `videoswarm:folder-performance` events now
cover request, SQLite preview, first streamed batch, first committed usable
grid, enrichment completion, scan completion, cancellation, and failure. The
production Electron smoke suite waits on those events and exercises preload
startup, folder opening, bounded virtual scrolling, filters, fullscreen,
watcher add/remove, profile isolation, minimize/restore, and clean shutdown.
A Linux-only local soak runner records RSS/private memory, optional post-GC
renderer heap, CPU, event-loop delay, long tasks, DOM/media/playing counts,
dropped frames, file descriptors, inotify watches, database growth, folder
timings, and optional Chromium traces/heap snapshots; its pure budget evaluator
supports absolute plateau/slope limits and baseline-relative ratchets.

CI and release use Node 22.12 via repository version files. CI runs a zero-skip
Electron-ABI coverage suite with generated output excluded and ratcheted
thresholds, real ESLint static analysis, an explicit renderer build, the Linux
Electron smoke under Xvfb, and unpacked packaging. SQLite suites fail rather
than silently skip when the required Electron ABI gate is active.

### 9. Electron boundary and shutdown hardening

Status: **Implemented** (2026-07-14)

Local media uses the privileged `videoswarm-media://` application protocol, so
production windows keep `webSecurity`, renderer sandbox preferences, context
isolation, and a restrictive content-security policy enabled. Media elements
and playback-source responses use profile-generation-bound opaque instance or
proxy URLs instead of renderer `file://` URLs; records still retain `fullPath`
for explicitly authorized native actions. The main process resolves the active
profile's instance, validates its authorized library root, and serves only
`GET`/`HEAD` single-range responses. Profile-owned proxy URLs resolve only
signature-derived files whose canonical paths remain inside the current proxy
cache.

All static inbound IPC channels pass through one registrar that accepts only
the live application window's main frame at the canonical packaged document
URL or selected development origin, applies a default serialized payload
ceiling, and disposes its registrations on shutdown. Per-channel validators
bound paths, arrays, settings, metadata, scan priorities, and other larger
inputs. Clipboard PNG input is bounded by encoded size and pre-decode width,
height, and pixel count. Native folder selection, recents, and on-demand
indexed-library selection grant canonical, owner-and-profile-scoped filesystem
authority through a bounded LRU. Existing canonical paths outside those grants,
including existing symlink escapes, are rejected before file playback,
watching, thumbnail, drag, shell, capture, or trash work. Data-location changes
accept only the exact canonical directory returned by that renderer's native
picker. A trash dialog names and authorizes the actual canonical file identities
with a bounded, 30-second, owner/profile/generation capability; execution and
each bounded retry consume one exact-path grant.

Settings use an allowlisted schema and a profile-scoped serialized writer.
Partial updates merge in order; resize/move updates debounce; every write uses
a same-directory mode-0600 temporary file, file sync, atomic rename, and
best-effort directory sync. Reads use a single file handle and a 64 KiB hard
limit, including growth-race detection. The profile catalog uses an equivalent
same-handle bounded read and atomic replacement, validates contained IDs, caps
profiles at 64, reconstructs valid contained IDs from intact profile
directories when the catalog is unreadable, and quarantines a directory around
catalog deletion so a crash cannot expose a half-deleted profile. Reconstructed
display names and the active choice safely reset because those cannot be
inferred from directory names. A failed profile creation removes its new empty
directory. Deleting the active profile first quiesces its watcher/jobs, closes
its SQLite store, and switches to a fallback profile; a pre-commit deletion
failure restores the original runtime or publishes the actual safe fallback.

Profile changes flush settings and directory aggregates before invalidating
ownership. Data-location bootstrap files use monotonic revisions plus a
source-signature supersession marker, so a newer home-directory fallback wins
over the exact readable-but-unwritable app-folder copy it replaced without
overriding an unrelated portable configuration. Quit and data-location restart
share one coordinated shutdown that stops the watcher, drains confirmed trash,
flushes bounded persistence, cancels media streams/scans/native jobs, awaits
profile work, disposes native
services, and only then permits process exit or relaunch. Flush/disposal
failures are named and logged, with a final settings retry rather than silent
discard. One application-instance lock prevents concurrent processes from
mutating the same SQLite stores, catalogs, settings, and cache indexes. Startup,
macOS activation, and second-instance restoration share one window-creation
single flight; fatal startup failure releases the invisible primary rather than
leaving the lock-owning process headless.

The packaged Linux launcher no longer disables Chromium's OS sandbox by
default. A user can explicitly set `VIDEOSWARM_DISABLE_SANDBOX=1` as a
diagnostic compatibility escape hatch, which emits a warning and must not be
treated as the production security baseline. Development and CI launchers may
still opt out where their container forbids user namespaces; the packaged
default is the acceptance surface here.

Acceptance criteria:

- `webSecurity` is enabled for production windows.
- Media trash operations are restricted to authorized roots, require a
  main-issued identity-bound exact-path confirmation capability, and use one
  tested implementation.
- Watcher/window listeners are disposed on close and do not retain destroyed
  windows.
- Settings writes are serialized, debounced, and atomic.
- Settings/profile/bootstrap reads are bounded; catalog reconstruction keeps
  valid intact profile IDs discoverable after catalog corruption.
- A second application process cannot concurrently write the active data root.
- Shutdown reliably cancels jobs and flushes bounded persistence.

The production Electron smoke verifies sandboxed renderer globals, CSP,
blocked popup creation, opaque media URLs, byte-range protocol delivery,
active-profile deletion, settings persistence, and clean shutdown in addition
to the Section 8 app lifecycle. Focused tests cover sender/frame/origin
rejection, payload/image bounds, canonical root authority and existing symlink
escape, media URL/range parsing, proxy cache containment, confirmation
capabilities, atomic write failure, bounded/growing reads, concurrent settings
updates, catalog recovery/profile isolation, and shutdown ownership.

## Delivery status

| Deliverable | Status | Notes |
| --- | --- | --- |
| Scan cancellation and latest-request-wins safety | **Implemented** | Request IDs, cooperative cancellation, stale-result rejection, profile/window/app teardown, streamed sequence settlement, and focused renderer/native tests prevent older work from replacing the active collection. |
| Live scan telemetry | **Implemented** | Scan-ID-scoped, throttled phase events expose real discovery, indexing, reconciliation, enrichment, warning, path, reuse, and timing data. Main-process loops yield regularly so feedback and cancellation stay responsive; landed in `e1d5504`. |
| Informative loading dialog and Escape cancellation | **Implemented** | The accessible dialog shows honest determinate/indeterminate state, phase activity, live counters, paths, elapsed/heartbeat feedback, whole-app working-set memory, persistent errors, and one Cancel/Escape path; landed in `062e23a` and `e1d5504`. |
| Incremental enumeration batches | **Implemented** | Opt-in scan protocol version 1 streams bounded cheap-record batches and rich patches into a scan-owned renderer ID map, while legacy callers retain the final-array response. |
| SQLite-backed folder revisit hydration | **Implemented** | Bulk, profile/scan-owned SQLite hydration provides a stale-while-revalidate first grid with a visible refresh status and no retained inactive media resources. A five-trial Linux harness now enforces identical authoritative collections, bounded resources, and at least a 2× warm/restart median first-grid speedup over cold opening for 1,000- and 6,000-clip roots. |
| Watch-before-scan reconciliation | **Implemented** | A bounded watcher generation captures the pre-ready baseline, coalesces initialization changes, seeds polling fallback, reconciles overflow, and drains atomically before live delivery. |
| Persistent content/file-instance schema and lifecycle | **Implemented** | Profile-local roots, pin state, empty directories, distinct instances, restart fingerprint reuse, safe reconciliation, and watcher missing-state updates landed in `ef923ed`, `842e0a2`, and `4eaf2e4`. |
| Coalesced watcher directory aggregates | **Implemented** | Watcher and polling mutations defer full directory-count recomputation into a profile/generation-owned 150 ms debounce with a one-second maximum wait, 128-root bound, serialized refresh lane, bounded retries, and explicit flushes before cached-grid/tree correctness reads, profile changes, watcher stop, and shutdown. A 1,000-event burst regression requires one refresh. |
| Virtualized masonry | **Implemented** | Complete logical geometry, viewport-plus-overscan mounting, ID-based reachability/selection, logical anchoring, and 5,000-item bounds landed in `157ecf3` and `331a360`. |
| Stable masonry/observer/card callback identities | **Implemented** | Observer thresholds, collection callbacks, and per-card handlers remain stable across scroll-driven parent renders; landed in `331a360`. |
| Cancel-safe media initialization | **Implemented** | Queued and in-flight work is generation-owned and cleaned on unmount; recovery, identity replacement, and stale callback handling landed in `e85030a` and `17ced36`. |
| Atomic media loader/decoder scheduler | **Implemented** | Opaque scoped leases, exact loader/resident caps, priority wake-up, exact non-null pause acknowledgement, stale-event rejection, bounded auxiliary lanes, and React-mirror integration prevent newly granted decoders from being released by stale scroll renders or media events. The base scheduler landed in `e804b97` and `17ced36`. |
| Fullscreen URL and keyboard lifecycle hardening | **Implemented** | Fullscreen owns its element, source, blob URL, timeout, and dedicated decoder lease; navigation, close, and failure release every owned resource. Grid suspension remains declarative; landed in `331a360` and `17ced36`. |
| Destructive and one-shot media lifecycle | **Implemented** | Trash blocks affected scheduler IDs while physical handles are released, and serialized frame capture uses a bounded auxiliary lease with deterministic cleanup; landed in `17ced36`. |
| Linux playback modes and structural decoder budgets | **Implemented** | Balanced and Adaptive Motion use conservative and higher platform/core/memory/pixel caps without recursive telemetry decay; Static + Hover limits eligibility; explicit All Motion restores the uncapped visible set, retained-decoder legacy ordering, and original construction-time Chromium scheduling. Runtime health stays visible as diagnostics, and focused policy, telemetry, scheduler, card, and app regressions cover the mode contracts. |
| Causal decoder-specific automatic derating | **Unimplemented** | Whole-app dropped-frame, long-task, frame-delay, and memory signals cannot yet distinguish decoder saturation from scanning, layout, or cold-scroll work. Any future controller must use attributable, stabilized signals and converge without recursively feeding back a reduced target. |
| Hidden/minimized work suspension | **Implemented** | Page Visibility plus BrowserWindow activity drive scheduler limits to zero, physically release media, cancel thumbnail/proxy work, and stop progressive/high-frequency polling. The BrowserWindow remains unthrottled from construction so mode changes cannot destabilize media scheduling. |
| Bounded process-lifetime caches and queues | **Implemented** | Fingerprint, dimensions, masonry, thumbnail, playback-history, waiter, watcher, and native-work state now have explicit entry/work limits, generation invalidation, snapshots, and disposal. Window-close cleanup uses a live-captured `WebContents` reference and does not dereference a destroyed `BrowserWindow`. |
| Asynchronous thumbnail IPC and persistence | **Implemented** | Thumbnail reads/writes use asynchronous IPC, bounded read/write lanes, byte/pixel-aware memory and disk LRUs, atomic files, and coalesced bounded index persistence. |
| Folder tree, scope control, and sibling cycling | **Implemented** | Empty-root-safe breadcrumbs, counted collapsible tree, three scopes, filtered sibling cycling, and optional visible group strips are integrated with the virtual grid. |
| Pinned lightweight libraries and smart views | **Implemented** | Profile-local path-only pins and validated saved filter/sort/group/scope views are available from the library sidebar. |
| Review workflow and result processing | **Implemented** | Content-keyed Accept (`pick`), neutral Reviewed, Reject, and Unreviewed states share coupled rating semantics across toolbar, context, inspector, and catalog-driven shortcuts. Stable progress, optional auto-advance, one-step undo, bounded local-reject trashing, and manifest export without absolute native paths are implemented; see [`review-workflow.md`](review-workflow.md). |
| Generation sidecars | **Implemented** | Bounded, instance-keyed extraction of prompt, seed, model, sampler, source-image, and generation-run fields remains on demand and profile-owned. |
| Sandboxed preload and context-action regression guard | **Implemented** | Preload imports only Electron, request validation remains native-side, historical desktop actions stay discoverable, dense actions use submenus, and all menus clamp/scroll within the viewport. |
| Floating selection inspector | **Implemented** | The former bottom dock is a selection-scoped, context-aware overlay with fitted-menu avoidance, bounded pointer/keyboard movement, narrow-sheet fallback, one-shot explicit focus, and no masonry padding or media ownership changes. |
| Electron smoke and performance soak harnesses | **Implemented** | Production Electron lifecycle smoke is CI-gated under Xvfb; the local Linux runner emits measured plateau/slope and baseline-relative diagnostics with optional traces and heap snapshots. |
| Electron-ABI SQLite test job | **Implemented** | Coverage and focused native suites run through Electron's Node runtime with an environment gate that converts ABI load failures into test failures rather than skips. |
| Node, lint, coverage, and build CI gates | **Implemented** | Node 22.12 repository/workflow pins, zero-warning ESLint, cleaned ratcheted coverage, explicit Vite build, Electron smoke, and unpacked packaging are mandatory. |
| Production Electron boundary hardening | **Implemented** | Sandboxed, web-secure windows now use opaque range-capable media URLs, one trusted and bounded IPC registrar, profile/owner-scoped path grants, confirmation-bound trash, atomic/bounded settings and profile catalogs, single-instance ownership, denied popup/navigation/permissions, and coordinated native shutdown/relaunch. |

## Production boundary and deferred-work implementation slice

1. **Implemented** — Register a privileged opaque media protocol before app
   readiness and resolve current-profile file instances without returning raw
   paths from playback-source resolution or constructing renderer `file://`
   media URLs. Support bounded MIME allowlisting, `GET`, `HEAD`, and one
   RFC-compatible byte range while cancelling open streams and pending
   preflights on profile change and shutdown.
2. **Implemented** — Keep proxy playback opaque as well. Resolve only current
   cache signatures and reject canonical proxy paths that escape the
   profile-local cache, including through a replaced symlink.
3. **Implemented** — Enable production `webSecurity`, renderer sandbox
   preferences, context isolation, and a secure-by-default packaged Linux
   launcher; deny popups, webviews, unexpected navigation, redirects, and
   permission requests. Production CSP removes Vite's localhost WebSocket
   sources, while the development HTML transform adds only those local HMR
   endpoints.
4. **Implemented** — Put every static inbound IPC handler behind live-window,
   main-frame, exact-origin trust and a default payload-size ceiling. Add
   channel-specific shape/count/string bounds and dispose registrations with
   the native owner.
5. **Implemented** — Grant filesystem roots only from trusted native/recent/
   indexed-library sources, with indexed roots regranted on demand rather than
   through an unbounded catalog list. Scope the bounded LRU by renderer and
   profile, resolve existing symlinks before containment checks, and require
   grants for filesystem reads, playback, watching, thumbnails, drag, shell
   actions, capture, and trash.
6. **Implemented** — Consolidate trash into one injected, authorized,
   bounded implementation. Bind execution to a short-lived exact-path
   confirmation capability and drain active operations at ownership changes.
   Serialize allowlisted settings through bounded reads and debounced, atomic,
   profile-isolated writes; atomically persist and recover the bounded profile
   catalog as well.
7. **Implemented** — Coordinate profile transition, normal quit, and
   data-location relaunch so watcher mutation stops before persistence flush;
   scans, streams, trash, queues, caches, listeners, and child work are then
   cancelled or drained before Electron exits. Active profile deletion switches
   and closes SQLite before quarantining its directory, shutdown persistence
   failures are surfaced and retried, and a single-instance lock excludes
   competing writers.
8. **Implemented** — Replace per-event watcher directory-count recomputation
   with a generation-owned aggregate batcher. A 150 ms debounce and one-second
   maximum wait coalesce bursts, one lane serializes roots, 128 dirty roots and
   three retries bound retained work, and correctness-sensitive reads and
   lifecycle transitions flush outstanding roots.
9. **Deferred by evidence** — Do not add the optional masonry child split,
   incremental geometry repair, or decoder auto-derating without an Electron
   trace or attributable decoder signal demonstrating the need. Do not change
   fingerprint identity without a versioned migration. These remain listed in
   the outstanding-work section rather than being marked implemented by
   unrelated optimization work.

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

That original slice deliberately returned one final array. The later
incremental-scan slice below now completes bounded streaming, priority
enrichment, and watch-before-scan reconciliation while preserving this legacy
call contract. Adaptive Linux playback remains documented in its dedicated
slice.

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

The formerly adjacent incremental delivery, watcher initialization, bounded
priority enrichment, folder-open marks, Electron smoke, and Linux profiling
harnesses are now **Implemented** in Sections 1 and 8.

## Incremental scan and verification implementation slice

1. **Implemented** — Stream a 32-record first enumeration batch, subsequent
   128-record batches, and 32-record rich patches under one scan ID and
   monotonic record sequence. Preserve the legacy final-array call unless the
   renderer opts into protocol version 1 behavior.
2. **Implemented** — Merge batches into a scan-owned renderer ID map, preserve
   cached rich metadata while cheap records arrive, wait for the advertised
   final record sequence, and prune stale cached IDs only after authoritative
   completion.
3. **Implemented** — Run fingerprint preparation with four bounded workers in
   64-record transactions and rich enrichment with two workers. Re-read up to
   256 virtual-viewport IDs between batches so visible work is preferred
   without creating an unbounded native queue.
4. **Implemented** — Start the watcher before enumeration, capture and compare
   a bounded pre-ready signature baseline, coalesce initialization mutations,
   seed polling fallback from the scan, and drain buffered generations before
   live delivery. Overflow performs one full reconciliation.
5. **Implemented** — Add response/event-order settlement plus regressions for
   cancellation, stale scans, cached pruning, watcher add/remove survival,
   6,000-record-safe initialization capacity, pre-ready changes/errors, and
   polling fallback.
6. **Implemented** — Publish stable folder-open User Timing milestones and
   require Electron-ABI coverage, zero-warning lint, an explicit renderer
   build, production Electron lifecycle smoke, and unpacked packaging in
   Node 22.12 CI. Add a local baseline-relative Linux soak/profiling runner.

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

- Fingerprint format `v1` includes creation time. Ordinary byte-identical
  copies are safely represented as distinct instances but may occupy distinct
  content rows; a versioned content-digest migration is deferred.

Watcher aggregate maintenance is now **Implemented** as a bounded, debounced,
serialized refresh lane. A deterministic 1,000-event burst regression verifies
one refresh; focused batcher drain/retry and watcher close-overlap tests cover
queue semantics, while main wiring flushes cached-grid/tree correctness reads
and ownership boundaries. Watch-before-scan streaming and the
mandatory non-skippable Electron-ABI CI gate are also implemented in Sections
1 and 8.

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
   URLs, use the profile-generation-bound opaque media protocol for native
   clips, and suspend/resume the bounded grid's desired playback declaratively.
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
- Electron-runtime scroll smoke and Linux CPU/RSS/DOM/media soak tooling are
  implemented in Section 8. The deterministic 5,000-record suite remains the
  CI geometry bound; hardware playback budgets are baseline-relative and local.
- Interleaved, full-width headers inside masonry geometry remain a possible
  follow-up. Section 7 uses a lightweight visible folder-group strip when the
  tree is hidden so current virtualization geometry stays unchanged.

## Media lifecycle and scheduler implementation slice

1. **Implemented** — Make one scoped scheduler the admission authority for
   loaders, future resident media, and grid decoders. Opaque leases and scope
   generations reject delayed work after folder/profile reset.
2. **Implemented** — Reserve loader and resident capacity atomically, queue
   denied visible cards by priority, wake them as capacity becomes available,
   and cancel waiters on invisibility, identity replacement, or unmount.
3. **Implemented** — Track each media element before asynchronous loading,
   promote it to resident only after `loadeddata`, and physically pause, clear,
   reload, detach, and release it on every failure or ownership transition.
4. **Implemented** — Require physical pause acknowledgement before a stopped
   decoder lease frees capacity. Make runtime recovery single-flight, bounded,
   generation-owned, and explicit about terminal versus transient failures.
5. **Implemented** — Give fullscreen playback and serialized frame capture
   separate bounded decoder lanes. Use opaque native media URLs, preserve
   cross-platform native paths only for authorized file actions, and release
   sources, owned blob URLs, timers, callbacks, and leases on all exit paths.
6. **Implemented** — Block IDs during trash operations, release matching media
   handles before native mutation, reconcile moved and failed paths, and avoid
   unsafe suffix or case matching across POSIX, drive-letter, and UNC paths.
7. **Implemented** — Add focused scheduler, card-integration, playback,
   recovery, fullscreen, capture, trash, URL, and native-handle regressions,
   including stale generations and physical cleanup ordering.

Electron smoke coverage and Linux CPU/RSS/file-handle/playback soak tooling are
now implemented in Section 8. Capability reporting remains deliberately
observational and does not promise Linux/NVIDIA hardware video decoding; local
hardware baselines are not portable CI thresholds.

## Section 5 implementation record — Linux-aware playback modes

1. **Implemented** — Add persisted Balanced, Adaptive Motion, All Motion, and
   Static + Hover controls with live decoder target/cap feedback and explicit
   Linux wording that acceleration is detected, not guaranteed.
2. **Implemented** — Derive conservative decoder ceilings from platform, cores,
   system/available memory, and average source pixel area. Balanced uses the
   conservative structural ceiling and Adaptive Motion uses the higher
   structural ceiling. Whole-app dropped-frame, p95 frame-delay, long-task,
   and working-set signals classify health for diagnostics but no longer
   mutate either decoder target.
3. **Implemented** — Prioritize hover, selected cards, then viewport-center
   order while preserving the scheduler's exact pause acknowledgement. Keep
   Static + Hover decoder eligibility limited to hover/selection and retain
   fullscreen's dedicated lane. All Motion instead restores the legacy order:
   retain already-admitted decoders, then admit recent and newly visible cards,
   so viewport-center changes do not churn healthy playback during scrolling.
4. **Implemented** — Register exact media elements with one bounded telemetry
   sampler, expose dropped-frame/long-task/frame-delay/memory health as
   diagnostics, and dispose registrations on every media ownership transition.
5. **Implemented** — Combine renderer visibility and BrowserWindow activity to
   suspend media, scheduler lanes, initialization, progressive rendering,
   thumbnails, telemetry, memory polling, frame capture, and proxy generation;
   retain the original construction-time unthrottled Chromium media scheduling
   baseline while using physical hidden/minimized suspension to stop work.
6. **Implemented** — Generate optional profile-local 720p proxies through one
   bounded child-process runner with concurrency, pending-work, timeout,
   output-buffer, owner-cancellation, atomic-publish, entry, and disk-byte
   limits. Missing ffmpeg and failed generation fall back to originals.
7. **Implemented** — Add policy, telemetry, capability, window-activity,
   suspension, proxy/child-runner, settings, card-lifecycle, scheduler,
   fullscreen, thumbnail, and application regressions; verify the full
   renderer suite, production build, and unpacked Electron package.
8. **Implemented** — Correct the user-facing All Motion contract after the
   original safety-capped implementation regressed pre-mode playback. Preserve
   that useful higher capped policy as Adaptive Motion, while true All Motion
   targets every visible card even under adverse telemetry. It does not bypass
   scheduler ownership, media cleanup, fullscreen suspension, or hidden-window
   suspension.
9. **Implemented** — Restore the exact pre-mode BrowserWindow scheduling
   baseline by setting `backgroundThrottling: false` when the renderer is
   created and removing runtime mode-dependent scheduling flips. Retain a
   synchronous activation-window decoder allowance in All Motion while
   candidates remain visibility-gated, and suppress detailed telemetry that
   cannot affect its uncapped decision. Keep one lightweight long-task loop,
   but do not use periodic media seeks as a frame-dropping mechanism because
   they can flush decoder state and create a slow/jump cadence.
10. **Implemented** — Remove recursive runtime-health derating from Balanced
    and Adaptive Motion. Each decision returns its current structural safety
    cap, so consecutive adverse whole-app samples remain visible as health
    diagnostics without turning 8 or 14 active decoders into 4, 2, then 1.
    Causal decoder-specific automatic derating and stabilized recovery remain
    explicitly **Unimplemented**.
11. **Implemented** — Remove eager drag-thumbnail lookup/capture from video
    `playing` and visibility transitions. Thumbnail work now begins only on
    hover or drag intent, so scrolling into uncached clips cannot add serialized
    video-frame readback, canvas PNG encoding, and native cache I/O to the
    software-decoding hot path; native drag retains its embedded-icon fallback.
12. **Implemented** — Require an exact non-null lease for every decoder pause
    acknowledgement. Ignore delayed `pause` events once playback is desired
    again, and never let a first stale `isPlaying=false` render acknowledge a
    decoder its parent granted in a newer layout pass. Focused orchestrator and
    card regressions cover null acknowledgements and delayed-event ownership.
13. **Implemented** — Remove the review badge's `backdrop-filter` blur so
    Section 7 review metadata does not force avoidable software compositing
    across many simultaneously playing cards on Linux.

Section 5 and its playback-fidelity follow-ups are verified by focused policy,
telemetry, scheduling, preload, card, and application regressions as well as
the repository's full host, production-build, Electron-ABI, and package gates.
The exact-lease and no-recursive-decay cases are part of that regression
surface rather than pending handoff work. The base implementation is recorded
in commit `af73872`; later commits restore the explicit All Motion contract and
correct stale pause ownership.

Hardware-specific Linux decode verification remains environment-dependent;
Section 8 now provides the soak and baseline-threshold tooling, while Section 5
still does not claim guaranteed GPU video decoding.

## Section 6 implementation record — Bounded caches, queues, and native work

1. **Implemented** — Replace process-lifetime fingerprint and video-dimension
   maps with 4,096-entry LRUs that deduplicate work, admit no more than 64
   outstanding operations each, reject excess work explicitly, and prevent a
   cleared generation from starting scheduled work or repopulating the cache.
   Metadata-store/profile disposal resets fingerprints; folder-root/profile
   changes and shutdown reset dimensions.
2. **Implemented** — Bound both active masonry aspect-ratio maps to 4,096
   entries and prune values outside the current collection signature. Cancel
   every chunk/layout animation frame on replacement or unmount. Bound loader
   waiters to 1,024 and playback start history to 1,024 while preserving
   already-admitted waiters as a configured target is lowered.
3. **Implemented** — Give renderer thumbnail work one active capture lane and
   64 pending requests, with at most 2,048 signature/path metadata entries.
   Requests expose settlement and cancellation handles, hold queued video
   nodes weakly, release media references before native I/O, and cancel on
   invisibility, media detachment, identity change, suspension, and unmount.
   Capture is interaction-lazy (hover/drag intent), rather than automatically
   running for every newly playing card during scroll.
4. **Implemented** — Move thumbnail reads, writes, and native drag startup off
   synchronous renderer IPC. The profile-local native cache is capped at 500
   entries/32 MiB decoded memory and 5,000 entries/256 MiB disk, with 512 KiB
   payload, 65,536-pixel image, and 8 MiB index limits. It uses two active plus
   64 pending reads and one active plus 64 pending writes, bounded file reads,
   atomic publication, coalesced index persistence, corrupt/orphan cleanup,
   one-to-one path/signature accounting, and generation/renderer-owner
   cancellation. Index persistence retries at most three times with 500 ms
   exponential backoff capped at four seconds, then waits for a structural
   mutation or explicit flush to rearm it.
5. **Implemented** — Bound watcher state to 2 active and 2,048 pending
   enrichment paths plus 2,048 change debouncers. No more than 8 raw
   `createVideoFileObject` operations may remain outstanding, including work
   logically retired by unlink or session replacement. Same-path events
   coalesce, unlink cancels active work, stale sessions cannot emit, and
   overflow marks a reconciliation generation that clears only after success.
   Failed reconciliation uses a 250 ms exponential backoff with three retries
   and is rearmed by later activity without an unbounded retry loop. Polling
   and reconciliation retain their own independent single-flight scan lane.
6. **Implemented** — Route last-frame extraction through the shared child
   runner with one active job, two pending jobs, a 30-second timeout, 64 MiB
   stdout, 256 KiB stderr, a 500 ms kill grace, `-nostdin`, and a no-upscale
   3,840 × 2,160 output box before native image decoding. Renderer crashes and
   destruction, profile changes, window teardown, and coordinated app shutdown
   cancel frame, thumbnail, watcher, and proxy ownership. Owner epochs prevent
   a pre-crash frame continuation from committing the clipboard after reload.
   Proxy owner epochs prevent delayed stat/cache continuations from queuing
   work after disposal, and at most 64 source/cache resolution preflights may
   remain outstanding before new requests return an explicit busy result.
7. **Implemented** — Add deterministic cache-capacity, generation-reset,
   queue-overflow, owner-cancellation, stale-continuation, unlink, retry,
   persistence, corrupt-file, asynchronous preload IPC, and bounded child-work
   regressions. Cache and queue snapshots expose their configured limits and
   current ownership for future profiling assertions. Shutdown permanently
   closes native thumbnail admission, invalidates profile generations, and
   waits the serialized profile-reconfiguration queue before the final native
   flush so profile work cannot reopen resources during quit.
8. **Implemented** — Capture the window's `WebContents` while its
   `BrowserWindow` is alive and reuse that reference for owner activation,
   crash invalidation, and idempotent close disposal. The `closed` callback no
   longer evaluates `createdWindow.webContents` after destruction, preventing
   the main-process `Object has been destroyed` shutdown dialog; a source-level
   lifecycle regression guards the ordering.

Section 8 now implements Real Electron folder timing and Linux soak automation
for RSS/post-GC heap when exposed, OS file handles, media/playing counts,
dropped frames, inotify watches, database growth, and CPU/event-loop trends.
Hardware-specific plateau values remain machine-local baselines rather than
universal limits.

## Folder and lightweight library implementation slice

1. **Implemented** — Return root and directory catalog data with each completed
   scan, retain empty folders as an open collection, persist directory
   presence timestamps, and retire unseen folders only after complete
   recursive coverage. Direct, partial, cancelled, unreadable, and
   depth-truncated scans preserve uncertain rows.
2. **Implemented** — Add profile-generation-owned library IPC for root listing,
   tree lookup, and path-only pin management. Pinning never copies, moves, or
   claims ownership of source media.
3. **Implemented** — Add a dense breadcrumb/scope bar and a collapsible folder
   tree with direct/subtree video, active-filter match, missing, and reviewed
   counts. Review mutations update only affected directory aggregates rather
   than rebuilding them across the whole collection. Current-folder and
   current-subtree sibling cycling wraps while skipping folders with no active
   matches.
4. **Implemented** — Keep the flattened swarm as the default, scope the
   existing virtual masonry model without mounting inactive cards, and expose
   a visible folder-group strip when grouping is enabled and the tree is
   hidden.
5. **Implemented** — Reload the active root with an explicit recursive value so
   the toggle cannot race stale React state. Folder navigation automatically
   indexes subfolders when a previously catalogued descendant is selected.
6. **Implemented** — Restore scroll, selection, sort, random seed, grouping,
   and filters per root/folder/scope using a 128-entry LRU. Selections are
   capped at 500 IDs, remain valid while filters hide their cards, profile
   switches clear the cache, and no DOM/media/blob ownership enters the cache.
7. **Implemented** — Add content-keyed `unreviewed`, `reviewed`, `pick`, and
   `reject` state while presenting `pick` as **Accept** in the UI. Ratings
   promote Unreviewed content to neutral Reviewed without overwriting an
   existing Accept/Reject choice; clearing a rating preserves review state,
   while resetting to Unreviewed clears the rating and leaves tags untouched.
   Toolbar, context-menu, and floating-inspector mutations share the serialized,
   32-input-bounded workflow. A/S/D/F primary shortcuts, P/R/X/U compatibility
   aliases, 1-5 ratings, 0 clear-rating, and Z undo render from the shared
   shortcut catalog.
8. **Implemented** — Add validated, profile-local smart-view CRUD. Version 1
   stores allowlisted tag/rating/review filters, sort direction/key, grouping,
   random seed, and scope; names, count, and UTF-8 definition size are bounded.
9. **Implemented** — Add on-demand, instance-ID-only sidecar extraction for
   prompt, seed, model, sampler, source image, and generation run. Candidate
   paths, input size, recursion depth, node count, field sizes, concurrency,
   queue depth, time, caching, and cancellation all have explicit bounds.
   Renderer requests are debounced and superseded requests are cancelled; raw
   workflow JSON is not retained.
10. **Implemented** — Add native and renderer regressions for directory
    reconciliation, pins, review/rating compatibility, reviewed counts, smart
    view validation/profile isolation, sidecar safety/concurrency/cancellation,
    empty roots, scopes, sibling navigation, bounded restoration, filters,
    panels, and application wiring.
11. **Implemented** — Repair the Section 7 sandbox regression by removing the
    local CommonJS import from `preload.js` and keeping request-token validation
    in the main process. A restricted-loader regression now rejects any preload
    dependency other than Electron, and a real Electron 43 launch reaches DOM
    ready with the complete bridge exposed. A read-only recovery audit confirms
    both registered profile databases are healthy and that every tag,
    tag-association, and rating in the older backup remains unchanged in the
    larger current database; replacing it with the backup would lose newer
    data, so no destructive restore is performed.
12. **Implemented** — Compare the video context menu against the immediate
    pre-Section-7 commit. No source action was deleted; the failed preload made
    the old capability gate hide Open, Show in Explorer, and Move to Recycle
    Bin. Keep those actions visible with a clear unavailable state, group Copy,
    Review, and Rating into submenus, and clamp/scroll root and nested menus on
    every viewport edge.
13. **Implemented** — Restore `all-descendants` scope whenever navigation
    returns to the library root, so selecting a child and then its parent does
    not silently narrow the root to direct files. A renderer regression covers
    the full child-to-root transition.
14. **Implemented** — Add `[` and `]` sibling-folder shortcuts, title hints on
    the matching-folder controls, and a navbar `?` button/shortcut opening an
    accessible, focus-managed shortcut guide. Review, selection, grid,
    application, and fullscreen bindings render from one declarative catalog;
    contributor guidance requires handlers, help, and tests to stay aligned.
15. **Implemented** — Replace the bottom metadata dock with the renderer-local
    floating selection inspector. Selection-scoped dismissal, deselect close,
    fitted context-menu avoidance, target correction, bounded pointer/keyboard
    movement, one-shot focus requests, narrow-sheet behavior, and the shared
    `I` shortcut are covered without retaining cards or changing virtual-grid
    geometry. See `floating-selection-inspector.md` for the detailed contract.
16. **Implemented** — Add the scope-stable review toolbar, profile-local opt-in
    auto-advance, one-step ownership-bound undo, and authoritative Process
    Results dialog. Local rejected instances reuse the hardened native trash
    path with a 2,000-file bound; manifest export is deterministic, atomic,
    limited to 20,000 records and 32 MiB, and deliberately excludes absolute
    native paths. See [`review-workflow.md`](review-workflow.md) for the full
    implementation and verification record.

The following work remains **Unimplemented** after this slice:

- Full-width interleaved masonry group headers remain optional follow-up work;
  the implemented group strip satisfies visible grouping without destabilizing
  the virtual layout.

Section 1 incremental delivery and Section 8 Electron smoke/Linux profiling
automation are now implemented.

## Deferred research and validation risks

The core large-library architecture in Sections 1-9 is closed and implemented.
The items below are deliberately deferred research or platform-validation
work, not unfinished parent deliverables. They should be reopened only when
their stated evidence exists:
- **Versioned content identity:** fingerprint `v1` includes creation time, so
  byte-identical copies may occupy distinct content rows. A creation-time-free
  content digest needs an explicit schema/data migration and compatibility
  period; it is not a safe opportunistic rewrite.
- **Causal adaptive derating:** automatic playback reduction remains
  unimplemented because current whole-app telemetry cannot attribute pressure
  specifically to decoding. Balanced and Adaptive Motion retain stable
  structural caps; All Motion retains its explicit full-visible contract.
- **Profiling-triggered masonry refinements:** a dedicated memoized grid child
  and incremental suffix/column geometry repair remain optional. Implement
  either only if Electron traces show parent reconciliation or the bounded
  geometry pass is material on target Linux hardware.
- **Interleaved folder headers:** full-width group headers inside virtual
  masonry remain an optional UX enhancement. The implemented folder tree and
  group strip already provide navigation and visible grouping without changing
  layout geometry.
- **Expanded review-result actions:** copy/move of accepted files, collision
  and cross-device recovery, sidecar policy, and streaming result jobs above
  the current 2,000-local-reject safety bound remain deferred. The implemented
  workflow requires users to narrow the active folder scope for larger trash
  sets; see [`review-workflow.md`](review-workflow.md).
- **Cross-platform packaged validation:** Linux production smoke now exercises
  the security boundary and custom media ranges. Windows and macOS packaged
  runs should be added when runners are available, particularly for custom
  protocol playback, atomic replacement semantics, native trash/shell actions,
  macOS activation, and shutdown/relaunch behavior. Add a true two-process
  single-instance smoke rather than relying only on focused lifecycle wiring
  coverage. A real-host Linux launch should also verify the secure-by-default
  package on distributions with supported user namespaces; the automated
  container smoke intentionally opts out of the OS sandbox. This is a
  validation gap, not a known application-boundary defect.
- **Descriptor-level filesystem race hardening:** canonical root validation
  rejects existing symlink escapes, but an external process can still replace
  a validated path between validation and some path-based shell/media/native
  operations. Where platform APIs permit it, future hardening should open once
  with no-follow semantics and validate/use the same descriptor. This is a
  residual local-filesystem race, not an observed ordinary-workflow defect.
- **Persistent-storage failure UX:** settings and catalogs retain the previous
  valid atomic file, report named shutdown failures, and retry the final
  settings flush once. A permanently read-only/full volume still has no
  interactive retry/export choice during quit; adding one is a reliability UX
  follow-up rather than silently claiming the newest in-memory state reached
  disk.
- **Very large profile deletion:** active-profile ordering and crash recovery
  are implemented, but final quarantine cleanup is synchronous. If profiling
  shows multi-gigabyte proxy/cache profiles block the main process, move that
  rebuildable-directory cleanup to a bounded asynchronous worker while keeping
  the catalog commit/quarantine boundary unchanged.
- **Hardware decode support:** guaranteed NVIDIA video decode on Linux remains
  a non-goal until Electron/Chromium exposes a verified target-hardware path.
  Existing capability reporting is observational only.

## Migration and compatibility

- Existing `readDirectory(folderPath, recursive)` callers remain supported
  during the scan-protocol transition.
- Schema evolution must be transactional and preserve profile isolation,
  ratings, and tags.
- Existing full-path video IDs can remain compatibility aliases while the
  collection moves toward stable file-instance IDs.
- Native Windows/UNC paths remain available only to authorized main-process
  file actions; Electron media elements use opaque instance URLs instead of
  renderer-generated file URLs.
- Generated caches, proxy files, and indexes remain rebuildable and must not be
  committed to the repository.
