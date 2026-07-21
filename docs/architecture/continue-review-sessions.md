# Persistent Continue Review Sessions

Status: **Implemented and verified** (2026-07-15)
Last updated: 2026-07-20

## Summary

Video Swarm remembers a lightweight review cursor for each indexed root
inside the active profile. A user can leave a large collection, restart the
application, and continue from the next Unreviewed clip in the same folder
scope and visual order without retaining video collections, DOM/media
elements, thumbnails, or decoded playback state in memory. The renderer keeps
only the bounded checkpoint summaries and current plain-data draft needed for
the workflow.

This is a checkpoint, not a second review database. Review state, ratings, and
tags remain content-keyed metadata. The checkpoint stores only where and how a
review pass was being viewed. One checkpoint is retained per root, with at
most 128 checkpoints per profile.

The implementation and its shared verification gate are complete. This
document is now the architecture, behavior, and verification record for v1.

## Goals

1. Resume a review pass across root switches, profile switches, and app
   restarts.
2. Reuse the existing SQLite-first folder hydration so Continue Review does
   not delay the cached first grid until a filesystem refresh finishes.
3. Restore a bounded, validated folder scope, filter, and sort definition.
4. Resolve stale or duplicate anchors without skipping remaining Unreviewed
   content.
5. Make remaining work and explicit review/resume actions visible in the
   library sidebar and review toolbar.
6. Keep all persistence profile-owned, bounded, and independent of media and
   DOM lifecycle.

## Non-goals

- Checkpoints do not duplicate review status, ratings, tags, thumbnails, or
  generation metadata.
- They do not store video records, selected-ID arrays, scroll offsets, DOM
  nodes, media elements, playback position, or decoded resources.
- They do not add an in-memory folder cache or bypass authoritative refresh.
- They do not create multiple named review passes for one root in v1.
- They do not change the existing rating/review invariant: assigning a rating
  implies Reviewed, and resetting to Unreviewed clears the rating but not tags.
- Checkpoint persistence does not own Copy Accepted, search indexing,
  comparison, or new Linux playback scheduling. Copy Accepted is implemented
  separately in [`review-workflow.md`](review-workflow.md).

## Persisted model

### SQLite schema

Add the following table through the existing additive profile-database
migration in `main/database.js`:

```sql
CREATE TABLE IF NOT EXISTS review_checkpoints (
  root_id INTEGER PRIMARY KEY,
  directory_relative_path TEXT NOT NULL DEFAULT '',
  scope_mode TEXT NOT NULL CHECK (
    scope_mode IN ('all-descendants', 'current-folder', 'current-subtree')
  ),
  view_json TEXT NOT NULL CHECK (
    length(CAST(view_json AS BLOB)) <= 8192
  ),
  anchor_instance_id INTEGER,
  anchor_fingerprint TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (root_id) REFERENCES library_roots(id) ON DELETE CASCADE,
  FOREIGN KEY (anchor_instance_id) REFERENCES file_instances(id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_review_checkpoints_updated
  ON review_checkpoints(updated_at DESC, root_id DESC);
```

The root foreign key makes the checkpoint profile-local and gives it the same
canonical root identity as the durable library catalog. The fingerprint is
deliberately not a foreign key: it remains useful as a stale-anchor fallback
if the original file instance disappears. `updated_at` is assigned by the main
process; renderer timestamps are never accepted.

An insert for a 129th root runs in the same transaction as the upsert and
deletes the oldest rows ordered by `updated_at ASC, root_id ASC`, excluding the
row just written, until 128 remain. Updating an existing root never evicts a
different row unless the database was already over the bound.

### Checkpoint wire shape

The full renderer-facing value is:

```js
{
  rootPath: string,
  directory: string,
  scope: "all-descendants" | "current-folder" | "current-subtree",
  view: {
    version: 1,
    filters: {
      includeTags: string[],
      excludeTags: string[],
      minRating: null | 1 | 2 | 3 | 4 | 5,
      exactRating: null | 0 | 1 | 2 | 3 | 4 | 5,
      reviewFilter: "any" | "unreviewed" | "reviewed" | "pick" | "reject"
    },
    sort: {
      key: "name" | "created" | "random",
      dir: "asc" | "desc",
      groupByFolders: boolean,
      randomSeed: null | integer
    }
  },
  anchorInstanceId: null | positiveSafeInteger,
  anchorFingerprint: null | string,
  updatedAt: integer
}
```

For a random sort, `randomSeed` is required to be an integer; `null` is valid
only for name/created sorts. The definition intentionally matches the
allowlisted portions of saved views.
It excludes transient UI state such as scroll, selection, sidebar expansion,
zoom, playback mode, and open dialogs. A random sort always
persists its already-generated seed so the next visual order is reproducible.

### Validation and normalization

The main process is the authoritative validator, even when the renderer has
already normalized a draft:

- Resolve `rootPath` with the existing catalog path rules and require a
  matching `library_roots` row.
- Normalize `directory` to root-relative `/` separators, reject NULs,
  absolute/escaping paths, and values over the IPC path limit. Saving requires
  a present indexed directory. `all-descendants` always stores directory `""`.
- Accept only the three existing `FolderScope` values.
- Require `view.version === 1`; apply the same tag, rating, review-filter, sort,
  direction, grouping, and 8 KiB bounds as saved views. Exact rating wins over
  minimum rating. Unknown keys are discarded.
- Limit each include/exclude tag list to 100 unique, trimmed values of at most
  80 characters, using deterministic case-insensitive ordering.
- Require and clamp a random seed to a signed safe integer when the sort is
  random. Store `null` when the sort is not random.
- Accept a null anchor or a positive safe instance ID and/or a non-empty
  fingerprint of at most 512 characters. When an instance is supplied, it
  must currently belong to the requested root; when both identifiers are
  supplied, its current fingerprint must match. An ID-only draft is enriched
  with that instance's current fingerprint before storage, so exact-instance
  resume never trusts an identity without its content check.
- Serialize only the normalized object and enforce the byte bound again after
  serialization.

Malformed rows read from an older or externally modified database are skipped
and logged once per app run; they must not prevent the profile from opening.
They are not silently deleted, so a newer schema is not destroyed by an older
application. A later valid save for that root replaces the row.

## Electron boundary

Expose a narrow bridge at `window.electronAPI.review.sessions`:

| Renderer call | IPC channel | Success payload |
| --- | --- | --- |
| `list()` | `review-sessions:list` | `{ sessions: ReviewCheckpointSummary[] }` |
| `get(rootPath)` | `review-sessions:get` | `{ checkpoint: ReviewCheckpoint \| null }` |
| `save(checkpointDraft)` | `review-sessions:save` | `{ checkpoint: ReviewCheckpoint }` |
| `clear(rootPath)` | `review-sessions:clear` | `{ deleted: boolean }` |

The same nested bridge exposes `onFlushRequested(callback)` and
`acknowledgeFlush(requestId)` for the bounded lifecycle handshake. The callback
receives only a frozen `{ requestId }` payload. The main process creates an
unpredictable, one-use request ID, accepts an acknowledgement only from the
live owning `WebContents`, and invalidates the ID after acknowledgement or
750 ms. The acknowledgement carries no checkpoint payload; persistence still
uses the validated `save()` operation above.

`ReviewCheckpointSummary` contains only `rootPath`, `directory`, `scope`, and
`updatedAt`. It omits `view` and anchor fields, keeping the profile-start list
small. The sidebar already receives root-wide `presentCount` and
`reviewedCount` from the catalog and derives `remainingUnreviewed` as
`max(0, presentCount - reviewedCount)`.

All four persistence handlers use `runMetadataContextOperation`, the active
profile generation, and the current metadata store. Save/get/clear require a
database-known root; they never grant filesystem authority. Opening a root
still passes through `library:authorize-root`. A profile transition, store
disposal, renderer-owner destruction, or shutdown invalidates any in-flight
result before it can update the renderer.

Errors use the existing structured `{ success: false, code, error, profileId,
generation }` envelope. Expected invalidation is ignored after the renderer
has changed profile/root; validation and disk errors are shown as a non-modal
toast and leave the previous checkpoint intact.

## Session lifecycle

### Starting

A checkpoint is created in either of these ways:

1. **Automatic start:** the first successful Accept, Reviewed, Reject, or
   non-null rating assignment in an indexed active root saves the current
   scope/view and affected cursor. Clearing a rating, resetting to Unreviewed,
   undo, and failed mutations do not create a new session.
2. **Explicit start:** **Find Unreviewed** captures the active directory,
   scope, validated view, and primary selection (when it belongs to the scope),
   then resolves and focuses the next candidate. From an inactive pinned-root
   row, **Review Unreviewed** first opens the root at All descendants, lets existing
   renderer settings/in-process folder state settle, and saves that resulting
   validated view.

One root has one checkpoint. Starting in another folder/view for a root that
already has a checkpoint uses the visible label **Save position here…** and the
expanded accessible name **Save current position instead…**. It requires
confirmation and overwrites only the checkpoint; review metadata is unaffected.

For a multi-item mutation, the anchor is the last successfully affected
instance in the pre-mutation visual order. For a context action, it is the
invoked instance. If no matching instance is available, save the affected
fingerprint with a null instance ID.

### Saving

While a root has a checkpoint:

- Successful review/rating changes and successful undo save immediately after
  the metadata result is applied. Undo or Reset to Unreviewed anchors the now
  Unreviewed item so resume returns to it rather than skipping it.
- While the saved root/directory/scope remains engaged, changes to selection,
  filters, grouping, or sort coalesce through one 400 ms trailing debounce.
  Scroll and playback changes never schedule a save.
- Explicit root, folder, and scope navigation flushes the engaged old
  location's latest valid draft before leaving it. The newly opened location
  remains passive and does not replace the saved position until an explicit
  **Find Unreviewed**, **Save position here…**, or **Resume** action engages a
  location again.
- Keep at most one save in flight. If state changes during that save, retain
  only the newest draft and issue one trailing save; do not build an unbounded
  promise queue.
- Cancel timers and ignore late responses on root/profile epoch changes and
  unmount. A profile switch never writes the old draft into the new profile.

A checkpoint is **engaged** in the renderer only after **Find Unreviewed**,
**Resume**, **Save position here…**, a qualifying automatic start,
or opening a location that already matches the saved root/directory/scope.
Passive navigation to a different location in the same root must not overwrite
a checkpoint; it keeps the explicit **Resume** and **Save current position
instead…** choices. Programmatic resume also baselines the save signature after
restoring state, so applying the saved view or falling back from a missing
directory does not immediately rewrite the checkpoint.

The renderer owns only the bounded checkpoint summaries and current plain-data
draft. It does not retain prior video arrays or card references to support
persistence.

### Clearing and completion

**Clear resume point…** removes the checkpoint after a confirmation that
review decisions, ratings, and tags will remain. It does not change the open
grid or the renderer-only folder view cache. A later forward review action can
start a new checkpoint.

Completion never deletes a checkpoint. A completed row continues to describe
the scope/view, and newly indexed Unreviewed files make the root actionable
again automatically. Completion is announced only after an authoritative
refresh establishes that no candidate remains in the saved work set.

## Resume algorithm

Resuming a saved review is an explicit user action and follows this sequence:

1. Load the checkpoint and authorize/open its root. Checkpoint lookup may run
   beside authorization, but it must not wait for a filesystem scan.
2. Apply directory, scope, filters, grouping, sort, and random seed before
   resolving the cached collection. Use existing SQLite stale-while-revalidate
   hydration and render the bounded cached first grid normally. Candidate
   resolution waits for the post-paint full-cache hydration readiness signal
   (or authoritative completion); it never treats the first 128-row preview as
   the complete saved work set.
3. Build the candidate order from the already sorted/filtered navigation scope;
   do not create another media collection. A candidate must be present and
   have exact review state `unreviewed`.
4. Resolve the anchor by exact instance ID only when its current fingerprint
   still matches the saved fingerprint. Otherwise use the first in-order
   instance with the saved fingerprint. If neither exists, treat the cursor as
   before index zero.
5. If the resolved anchor itself is still Unreviewed, select it first. This
   prevents a debounced navigation save or Undo from skipping the clip the user
   was on. Otherwise search strictly after it to the end.
6. If no candidate is found, wrap once and search from index zero up to the
   anchor. If there is no anchor, search from index zero without a second pass.
7. Select exactly one instance, centre it through the existing selection/focus
   path, and announce the restored location. Do not wrap repeatedly.
8. When authoritative refresh completes, repeat reconciliation against the
   fresh collection. Keep the current candidate when it remains present,
   visible, and Unreviewed. Otherwise resolve again from the persisted anchor.
   Only the authoritative pass may announce Review complete.

Review state is fingerprint-keyed, so classifying one duplicate normally makes
all instances with that fingerprint ineligible. The cursor remains
instance-first for spatial continuity; the fingerprint fallback handles a
moved/deleted instance. Duplicate instances are traversed in visual order but
never cause the same reviewed content to be selected again.

If the saved filters yield no Unreviewed candidate but the root-wide catalog
still reports Unreviewed files, show **Review complete for this saved view** and
offer **Review all Unreviewed**, which starts a root/all-descendants checkpoint
with default filters while preserving the current deterministic name/created
sort and grouping. A random sort is replaced with name ascending unless its
saved seed is retained explicitly. Do not silently discard the user's saved
filters.

When `reviewFilter: "unreviewed"` removes a now-reviewed anchor from the
filtered visual order, the anchor is intentionally treated as missing and the
one-wrap search starts at the beginning. This sacrifices spatial
after-anchor continuity but cannot reselect already reviewed content, and it
keeps candidate resolution on the one existing filtered order.

## User experience

### Library sidebar

Each pinned-root row adds a compact instance count and action:

- `N unreviewed in root` while the root-wide aggregate is authoritative.
- `N unreviewed in root · Updating…` while a scan/refresh is active.
- **Review Unreviewed** when no checkpoint exists and work remains.
- **Resume saved view** when a checkpoint exists and work remains.
- **Review complete** when the authoritative root count is zero; if newly
  indexed Unreviewed files appear, the retained checkpoint makes **Resume saved
  view** actionable again.

Counts are file instances, not unique fingerprints, and the tooltip states
that reviewing duplicate content may reduce the count by more than one. The
existing folder-tree `reviewed/total` badges remain; v1 does not add a separate
checkpoint per folder.

### Review toolbar

Add one dense resume-point group to the existing review toolbar. Review and
rating controls remain usable regardless of checkpoint state:

- With no checkpoint: **Ready to review**, an explanation that the first mark
  saves a resume point automatically, and optional **Find Unreviewed**.
- With a matching root/directory/scope checkpoint: a **Review position saved**
  status and last-saved time, with direct **Clear resume point…**.
- With a checkpoint elsewhere in the same root: **Resume** plus **Save position
  here…**.
- During resume: **Restoring saved review…**, followed by the candidate name or
  a completion message.

The group must not turn the toolbar into a second dashboard. On narrow windows
it follows the toolbar's existing horizontal-overflow behavior.

### Feedback and focus

- Cached results are labelled **Checking for newer files…** until refresh is
  authoritative; never present a cached empty queue as complete.
- A missing saved directory falls back to its nearest present ancestor with
  the same Current folder/subtree scope and announces the change. If no
  ancestor other than root remains, use root. All descendants always uses the
  root directory.
- A missing/unmounted anchor is normal and uses the fallback algorithm without
  an error dialog.
- An explicit review/resume action moves focus to the selected video card once
  mounted. Passive catalog refresh and profile restoration never steal focus.
- A logically selected candidate may be outside the mounted virtual window.
  Scroll to it directly and wait for the card to mount before moving focus.
  **Show review target** is only a retry affordance after mount/focus recovery
  times out; it never changes a user preference.
- Scan cancellation/error retains the checkpoint and says that completion
  could not yet be verified.

## Ownership and edge cases

- **Profile change:** cancel renderer timers/requests, clear session summaries,
  increment the profile epoch, and load the new profile's bounded list. Before
  the main process marks profile reconfiguration in progress or invalidates the
  old store, it runs the same owner-scoped 750 ms flush barrier used for window
  close. Renderer-originated and native-menu profile switches share this path.
  Never reuse an anchor from the prior profile.
- **Root switch:** flush the old root's latest draft, release its renderer/media
  resources through existing lifecycle code, and do not auto-resume the new
  root without an explicit review/resume action.
- **Unpinning:** does not delete a checkpoint. Removing a root from the catalog
  in a future API cascades its checkpoint.
- **Nonrecursive index:** root-level Current folder may resume after its scan.
  Current subtree/All descendants completion remains unavailable until
  recursive authoritative coverage exists. Keep the checkpoint and show an
  explicit **Index subfolders to continue** action; never toggle recursion or
  claim completion from partial rows without that user action.
- **Directory disappears:** use the nearest present ancestor rule and save the
  fallback only after the user performs another review/navigation action.
- **File replaced in place:** an instance/fingerprint mismatch rejects the
  exact-instance anchor; the old fingerprint fallback is tried, then the scan
  begins at the start.
- **Filters changed:** changes made during an active session become the saved
  work set after debounce. A later resume restores the persisted definition,
  not unrelated filters from the root being left.
- **New files:** authoritative refresh includes them in current visual order.
  The one-wrap search ensures newly inserted items before the anchor are not
  permanently skipped.
- **Mutation failure:** do not advance or save a new anchor. Preserve the last
  successful checkpoint.
- **Window close and shutdown:** before destroying an owning BrowserWindow,
  starting profile reconfiguration, or invalidating the profile/store for
  native shutdown, the main process sends one renderer flush request and waits
  for its acknowledgement or a 750 ms timeout. The close event is held during
  this barrier on every platform; on macOS the window may then close without
  quitting the app. The renderer cancels its debounce, submits at most the
  current in-flight save plus one newest trailing draft, and acknowledges in
  `finally`. Native shutdown/profile transition then continues even on timeout.
  Forced termination may lose only the most recent debounced navigation, not
  review metadata already committed.

## Performance and resource constraints

- The database retains at most 128 rows and at most 8 KiB of view JSON per row.
- `list()` reads at most 128 summaries and excludes view JSON/anchors; `get()`
  reads one row; `save()` and eviction are one SQLite transaction.
- Prepare checkpoint statements once per metadata store. Do not query per video
  to populate sidebar actions; merge summaries with existing root aggregates.
- Candidate resolution is one linear pass over the already materialized visual
  order, with bounded `Map`/`Set` indexes for that active collection only. Avoid
  repeated sorting, per-card effects, or O(n squared) searches.
- The bounded first-grid cache is never used as evidence of completion. One
  scan-owned, generation-checked full-cache follow-up may populate the active
  plain-record map after first paint; it is discarded on supersession and does
  not retain an inactive root.
- The 400 ms coalescer allows at most one active and one trailing write. No
  interval polling is added.
- The bounded renderer-bridge/IPC/SQLite checkpoint read performed after app
  launch and before a warm-root request must stay below 25 ms at the p95 in the
  6,000-clip harness, excluding filesystem refresh time.
- Switching away must leave no additional media elements, React card trees,
  decoder slots, thumbnails, or unbounded video arrays alive because of a
  checkpoint.

### Implementation benchmark

The implementation worktree passed the five-trial hardware gate on
2026-07-15 BST. The host ran Linux 6.17.0-35-generic on an Intel i9-13900K
with 32 logical CPUs and 128,570 MiB RAM. The recursive 1,000- and 6,000-clip
fixtures were measured cold, warm in one process, and after restart:

| Root | Scenario | First grid median | Authoritative refresh median | First-grid speedup | Checkpoint list + get p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| 1,000 | Cold | 229.3 ms | 332.1 ms | baseline | — |
| 1,000 | Warm | 25.0 ms | 144.7 ms | 9.17× | 2.9 ms |
| 1,000 | Restart | 69.1 ms | 236.5 ms | 3.32× | 2.3 ms |
| 6,000 | Cold | 220.5 ms | 1,330.2 ms | baseline | — |
| 6,000 | Warm | 19.8 ms | 875.8 ms | 11.14× | 0.8 ms |
| 6,000 | Restart | 71.0 ms | 936.9 ms | 3.11× | 1.8 ms |

All 20 cached trials produced the bounded 128-record first grid before the
authoritative refresh, and all 30 openings finished with the exact disk count
and stable relative-path digest for their root. Every checkpoint pre-open and
post-switch sample reported zero inactive-root cards, masonry slots,
selections, media elements, loaded media, and playing media. Active maxima
were 18 cards/slots, 16 media elements, and 9 playing elements. Same-process
cleanup growth also remained inside the existing 64 MiB heap and 256 MiB
working-set budgets.

The exact command used was:

```sh
npm run profile:folder-revisit -- \
  --folder-1000 /tmp/videoswarm-revisit-smoke-1000 \
  --folder-6000 /tmp/videoswarm-revisit-smoke-6000 \
  --trials 5 \
  --output /tmp/videoswarm-continue-review-revisit.json
```

The checkpoint figure is the controlled sequential renderer-bridge/IPC/SQLite
`list()` plus `get()` read after app launch. It does not measure preload
startup, total Continue-button-to-selection latency, or a worst-case
128-summary population. The hardware sampler observes DOM cards, masonry
slots, and media readiness/playback; focused bounded-resource tests cover queue
shape and plain-data retention that the sampler cannot see. The raw report
remains outside the repository because benchmark outputs are generated
artifacts.

## Accessibility

- Find/Resume buttons include the root or scope name and remaining count in
  their accessible name; visible text stays compact.
- Session state, provisional refresh, restored candidate, fallback directory,
  and completion use a polite live region. Error toasts expose an assertive
  `alert`; informational toasts expose a polite `status`.
- Do not communicate active/completed state by color alone. Preserve visible
  focus rings and a minimum 32 px desktop hit target.
- The confirmation for **Clear resume point** returns focus to its invoking
  control and explicitly states that review decisions remain.
- Resume's programmatic card focus occurs only after the explicit action and
  after the card mounts; reduced-motion users receive no smooth scroll or
  entrance animation.
- Any future shortcut must be added to `src/hotkeys/shortcutCatalog.js`; v1 adds
  no new shortcut.

## Verification record

The shared verification gate completed on 2026-07-15. Coverage is layered:
pure resolver tests exercised ordering and stale-anchor cases, renderer tests
exercised ownership and UI orchestration, Electron-ABI tests exercised real
SQLite, and the production Electron smoke exercised close/restart/resume. This
record does not imply that every resolver branch or restored-view permutation
has a dedicated App-level or Electron scenario; supplementary test-depth gaps
are called out below.

### Database and IPC

- Tests verified additive schema creation on new and existing profile
  databases.
- Tests covered upsert/get/list/clear behavior, deterministic 129th-row
  eviction, root cascade, malformed JSON tolerance, and the 8 KiB definition
  bound.
- Validation tests covered root/directory containment, scope/view allowlists,
  anchor ownership, and instance/fingerprint mismatch rejection.
- Real-database tests verified profile isolation across two databases and
  generation invalidation during save/get.
- Coordinator tests verified owner-scoped flush acknowledgement, wrong/late
  token rejection, the 750 ms timeout, and flush-before-window-close,
  profile-invalidation, and shutdown ordering.
- Preload static-contract tests covered all four invoke operations plus the
  flush listener/acknowledgement channels and payload shapes.

### Renderer logic

- Hook and App tests covered automatic and explicit start, 400 ms coalescing,
  single-flight/trailing save, ownership engagement, shutdown flush/timeout,
  cancellation, failure, Undo, and clear behavior.
- Pure resolver tests covered exact anchors, missing instances, fingerprint
  fallback, replaced files, still-Unreviewed anchors, after-anchor search,
  one-wrap search, no-candidate, and no-anchor cases.
- Resolver and workflow tests covered duplicate fingerprints and
  multi-selection anchor selection.
- Validation and resolver tests covered folder scope, filters,
  name/created/random ordering, stable random seeds, changed filters,
  missing-directory fallback, and recursive-coverage guards. Dedicated
  App-level Continue tests do not yet drive every non-default restored
  scope/filter/sort combination.
- Layered cached-hydration tests established the bounded first-grid and
  authoritative-refresh gates, while the production smoke covered one cached
  restart/resume path. Dedicated App-level scenarios do not yet force every
  authoritative keep, replacement, completion, or duplicate
  focus/announcement permutation.
- Component tests cover the **Show review target** recovery state. A dedicated
  App-level scenario for the complete virtual scroll, mount, and focus sequence
  remains supplementary regression-test depth.

### UX, integration, and performance

- Component and App tests cover passive pinned-root total/unreviewed counts,
  root-name sorting, toolbar review states, overwrite/forget confirmations,
  accessible labels, and status messages.
- The Electron smoke reviewed a clip, left its newest cursor inside the
  debounce, closed the app, reopened the same profile, continued, and verified
  that the cursor was flushed and restored from the cached first grid.
- Profile isolation and epoch invalidation were covered across two real SQLite
  databases and the renderer session hook. Resolver, ownership, and cascade
  tests covered stale/replaced anchors and removed roots. Separate
  profile-switch and removed-anchor Electron variants remain future smoke
  depth; they are not open or unimplemented v1 behavior.
- An App test confirmed that a completed checkpoint becomes actionable after a
  new file is indexed.
- The 1,000/6,000-clip harness verified that the cached first grid preceded
  authoritative refresh, checkpoint overhead met the 25 ms p95 bound, and
  inactive roots retained no checkpoint-induced renderer/media resources.
- The focused suites, full Vitest suite, Electron database suites, and
  `npm run vite:build` were run before the implementation rows were marked
  complete.

### Verification results

| Gate | Result |
| --- | --- |
| Focused Continue Review renderer/native/performance tests | **Passed** — 231 tests |
| Full Vitest suite | **Passed** — 889 passed, 18 Electron-ABI SQLite cases skipped in the Node run and exercised separately under Electron |
| Electron-ABI SQLite suite | **Passed** — 43 tests |
| Production Electron smoke | **Passed** — baseline lifecycle plus review/close/restart/resume |
| 1,000/6,000 five-trial hardware gate | **Passed** — see Implementation benchmark |
| Renderer production build | **Passed** — 123 modules transformed |
| ESLint, Node syntax checks, and `git diff --check` | **Passed** |

## Rollout and migration

The rollout is additive and enabled by default after its tests pass. Existing
profiles start with zero checkpoints; do not infer or backfill a persistent
cursor from the renderer-only `FolderViewStateCache`. Profile copy/data-location
migration naturally carries the table because it already moves the complete
profile database.

`view.version` provides future definition migration. Readers skip unknown
versions; writers always emit v1. Rolling back to a build without this feature
leaves an unused table and does not affect content metadata or the library
catalog.

## Implementation status

| Slice | Status |
| --- | --- |
| SQLite schema, validation, bound, and store methods | **Implemented** (2026-07-15) |
| Main-process handlers and preload bridge | **Implemented** (2026-07-15) |
| Renderer session persistence and resume resolver | **Implemented** (2026-07-15) |
| Sidebar and review-toolbar UX | **Implemented** (2026-07-15) |
| Accessibility, focused tests, Electron smoke, and performance gate | **Implemented** (2026-07-15) |

All slices passed their applicable focused or layered tests and the shared
completion gate before being marked Implemented. The additional App-level and
Electron permutations identified above are future regression-test depth, not
unimplemented v1 behavior.

## Subsequent product order

Continue Review and the non-destructive **Copy Accepted** workflow are now
verified. Destructive Move and metadata transfer remain deferred. Subsequent
product work proceeds in this order:

1. **Generation-aware search:** bounded background indexing of prompt, model,
   seed, sampler, source, and run metadata for filters, grouping, and smart
   views.
2. **Comparison workspace:** synchronized playback for two to four clips with
   metadata differences and review controls.
3. **Linux Motion Sweep:** only after playback baselines; rotate a bounded
   full-speed cohort while leaving All Motion behavior unchanged.

Fingerprint v2, automatic decoder derating, masonry refinements, interleaved
headers, and any in-memory folder cache remain evidence-gated architecture
research rather than implied dependencies of this feature.
