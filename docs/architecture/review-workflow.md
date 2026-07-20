# Review Workflow and Result Processing

Status: **Implemented and verified; deferred extensions tracked below**
Last updated: 2026-07-20

## Summary

Video Swarm's review metadata is a fast triage workflow for large collections,
not a replacement for tags or star ratings. It must let a user classify clips
with one hand, move through the visible review queue without losing context,
undo mistakes, understand progress for the active folder scope, and explicitly
process the resulting rejects outside the classification action.

The persisted review values remain `unreviewed`, `reviewed`, `pick`, and
`reject` for database and saved-view compatibility. The UI presents `pick` as
**Accept**. **Reviewed** remains the neutral completed state: the user reviewed
the clip but did not accept or reject it.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.

## Review, rating, and tag invariants

Review state and rating remain distinct metadata fields, but a rating is
evidence that review occurred:

- Assigning a rating to `unreviewed` content promotes it to `reviewed`.
- Assigning a rating preserves an existing `pick` or `reject` decision.
- Clearing a rating alone does not change review state.
- Resetting review state to `unreviewed` also clears the rating, so persisted
  data cannot claim both rated and unreviewed.
- Review and rating actions never add, remove, or rewrite tags.
- Review/rating state is content-keyed by fingerprint. File operations are
  instance-keyed and act only on matching paths in the requested folder scope.

Existing rated-and-unreviewed rows are reconciled to `reviewed` when a profile
database opens. Existing `reviewed`, `pick`, and `reject` rows are preserved.
No content tags or tag associations participate in this migration.

## Interaction design

### Review toolbar and progress

Status: **Implemented** (2026-07-14)

A compact review toolbar sits below collection navigation and above active
filter chips. It is shown whenever a library root is active and contains:

- Stable **Reviewed N / M** progress plus Accept and Reject counts.
- Accept, Reviewed, Reject, and Unreviewed buttons with visible key hints.
- A profile-local **Advance after marking** toggle, default off.
- A one-step Undo action, disabled until a workflow mutation succeeds.
- A **Process results** action.

Counts use all videos in the current navigation scope before tag, rating, and
review filters. This keeps the denominator stable while an Unreviewed filter
removes newly classified clips. The toolbar remains one dense row and may
scroll horizontally on narrow windows rather than expanding into a tall
dashboard.

Toolbar buttons, keyboard shortcuts, context-menu actions, the floating or
docked selection Details editor, and the fullscreen review rail all use the
same serialized workflow mutation path. Context-menu mutations target the
invoked clip's fingerprint and suppress auto-advance; all of these surfaces
therefore share the coupled rating/review invariants and one-step undo history.

### One-handed shortcuts

Status: **Implemented** (2026-07-14)

| Action | Primary | Compatibility |
| --- | --- | --- |
| Accept | `A` | `P` |
| Reviewed | `S` | `R` |
| Reject | `D` | `X` |
| Reset to Unreviewed | `F` | `U` |
| Rate | `1`-`5` | — |
| Clear rating | `0` | — |
| Undo last workflow action | `Z` | — |

The shortcut catalog remains the single source for handlers, help, and visible
button hints. Plain shortcuts do not fire in inputs, editable content,
hotkey-exempt surfaces, fullscreen, dialogs, menus, or filter popovers.
Existing modified application shortcuts retain precedence. Operating-system
key-repeat events are ignored for review, rating, and undo actions so holding
a key cannot classify a run of clips accidentally.

### Advance and undo

Status: **Implemented** (2026-07-14)

With **Advance after marking** enabled, a successful single-clip Accept,
Reviewed, Reject, or rating action selects and centres the next clip in the
pre-mutation visual order. Resetting to Unreviewed, clearing a rating,
multi-selection changes, failed writes, and undo do not advance.

The successor is captured before mutation so an active Unreviewed filter
cannot erase navigation context. Other instances sharing the affected
fingerprint are skipped because the content-keyed mutation updates them too.
The queue never wraps. Reaching its end leaves a still-visible clip selected or
clears a filtered-out selection and announces completion.

Only one review/rating mutation runs at a time, with at most 32 running or
pending inputs retained during rapid input bursts. Further input is rejected
with one warning until the queue drains. Undo retains exactly the last successful
workflow mutation and restores every prior review-state/rating pair in one
main-process database transaction, then restores selection when its original
instances still exist. Failed restoration is not reported as a successful
undo. Undo history is renderer-only and is cleared on root, profile,
directory-navigation, or folder-scope ownership changes; it never retains
tags, media, or DOM objects.

## Process review results

Status: **Implemented** (2026-07-14)

The results dialog operates on the active navigation scope before active
filters. It opens only after an authoritative folder scan completes; cached
previews, background refresh, cancelled scans, errors, and partial scans keep
processing disabled. A nonrecursive root authorizes only its root-level
**Current folder** scope; All descendants remains disabled until subfolder
indexing provides authoritative coverage.

The dialog discloses:

- File-instance and unique-content totals.
- Exact Unreviewed, neutral Reviewed, Accept, and Reject counts.
- The combined reviewed total.
- The root, current directory, and direct/subtree/all-descendants scope.
- That visible filters do not change the processing set.

Marking Reject never performs a file operation. Result actions require a
separate explicit command.

### Move rejects to trash

Status: **Implemented** (2026-07-14)

The initial implementation reuses the hardened native trash confirmation and
identity-binding flow. It targets only present, local Electron-backed video
instances whose exact review state is `reject`; neutral Reviewed clips are
never treated as accepted or rejected. Rejected non-local instances remain in
the counts but are disclosed separately and are not submitted to the native
file action. The existing 2,000-local-file safety bound remains. A larger set
is not silently truncated: the action is disabled with guidance to narrow the
folder scope and process explicit batches.

Native confirmation, media-handle release, profile ownership, file-identity
rechecks, partial-failure reporting, catalog reconciliation, and shutdown
draining remain mandatory. Successfully moved paths are marked missing in one
bounded SQLite batch before the native result returns, while the watcher stays
the eventual filesystem reconciliation path. Successful trashing does not
erase content review metadata, which may still describe another indexed
instance of the content. Electron exposes trash as a single-file native call,
so confirmed batches use an eight-worker native pool on Linux (four elsewhere)
rather than serializing the platform overhead for every file. Canonical
authorization and identity checks use a separate 16-worker bounded pool;
failed-item retry grants retain their original identity and profile ownership
constraints.

### Copy Accepted

Status: **Implemented** (2026-07-19)

Copy Accepted turns the review result into a usable, non-destructive media
collection. It operates on the same authoritative, unfiltered navigation scope
shown by Process Results: the active indexed root, current directory, and
current-folder/current-subtree/all-descendants scope. An accepted file is a
present file instance whose content-keyed review state is exactly `pick`.
Ratings and neutral Reviewed state never make a file eligible. When duplicate
instances of accepted content are present in scope, each concrete instance is
planned and reported independently.

The renderer submits only the root identity, relative directory, scope, and
bounded options. The main process owns every native source and destination
path, validates the active profile/window owner and completed index coverage,
and obtains the destination through a native directory picker. Cancelling the
picker performs no database materialization or filesystem work. Renderer
records and renderer-supplied source or destination paths are never accepted
as authority.

The default copy preserves each media file's path relative to the library
root beneath the chosen destination. An optional **Include adjacent JSON
sidecars** choice is off by default. When enabled, the plan checks only the
three already-recognized exact adjacent candidates for each accepted clip, in
the established order:

1. `video.ext.json`
2. `stem.workflow.json`
3. `stem.json`

There is no directory scan or fuzzy sidecar matching. A sidecar reached by
more than one media item is copied at most once.

Copy Accepted never overwrites a destination file. Before copying, a bounded
main-process planner validates source containment and identity, normalizes
every relative destination, detects both existing-target and intra-plan
collisions, and reports the files that will be skipped. The user confirms the
preflight summary before the job begins. The copy operation uses exclusive
destination creation as a second collision check so a file appearing after
preflight is skipped rather than replaced.

Planning and execution have explicit tested limits for accepted media,
sidecar candidates, path and byte accounting, concurrent native copies,
retained error detail, and IPC payload size. A main-owned job ID drives
throttled progress containing planned, copied, skipped, failed, and byte
counts. Cancellation stops admitting new copy work, waits for bounded in-flight
operations, and returns a truthful partial result; files already copied remain
valid. Per-file failures do not abort unrelated copies, and overflow beyond the
bounded detailed failure list remains visible through aggregate counts.

The source files, their review/rating/tag metadata, and the source library
index are never changed. A successful copy does not automatically register the
destination as a library or transfer profile metadata. Profile changes, owner
destruction, source-root invalidation, application shutdown, and relaunch first
cancel the job and then drain its bounded in-flight work. Stale progress and
completion events are ignored by owner, profile generation, and job token.

## Deferred work

Status: **Unimplemented**

- Move accepted media. Cross-device move recovery and rollback need a separate
  destructive-operation design after copy behavior has been proven.
- Metadata transfer for copied content. Fingerprint v1 includes creation time,
  so a copied instance cannot yet be promised the same content identity.
- Result sets above 2,000 rejects without narrowing folder scope. A future
  main-owned streaming job would need bounded progress and cancellation while
  retaining the native confirmation and identity-binding guarantees.

## Acceptance and verification

- Ratings promote Unreviewed to Reviewed; Accept/Reject decisions (persisted as
  `pick`/`reject`) survive rating changes; reset-to-Unreviewed clears the rating
  and review state, never tags.
- Shortcut aliases, numeric ratings, editable/modal guards, and catalog-driven
  help remain synchronized.
- Auto-advance is profile-local, opt-in, single-item-only, filter-safe,
  duplicate-safe, non-wrapping, and failure-safe.
- Undo restores coupled rating/review state and never crosses root/profile
  ownership.
- Progress and processing scope ignore active filters but respect folder scope.
- Reject trashing is explicit, limited to local Electron-backed instances,
  bounded, identity-confirmed, and reports partial failures without touching
  sidecars.
- Copy Accepted satisfies the contract above: authoritative `pick` instances
  only, native path ownership,
  relative-tree preservation, no overwrite, bounded preflight/job/progress,
  cancellation, partial results, and no source or metadata mutation.

## Implementation and verification record

### 2026-07-14

At this checkpoint, all sections except Copy Accepted and the explicitly
deferred work were **Implemented**.

- Profile database migration and metadata writes enforce the rating/review
  invariant, preserve Accept/Reject decisions during rating changes, clear the
  rating during an Unreviewed reset, and leave tags untouched.
- The catalog-driven A/S/D/F primary keys, P/R/X/U compatibility aliases,
  numeric rating keys, clear-rating key, and undo key feed the same renderer
  workflow used by the toolbar, context menu, and floating inspector.
- The workflow serializes mutations through a 32-input queue bound, offers
  opt-in profile-local auto-advance, retains one bounded undo snapshot, and
  keeps progress independent of active filters.
- Undo crosses the preload boundary through a bounded restore payload and
  restores every review/rating pair in one profile-owned SQLite transaction;
  renderer-controlled tags are never admitted to that operation.
- Process Results summarizes the authoritative navigation scope, reuses the
  native bounded trash path for local rejected instances, and reconciles moved
  instances with SQLite immediately. Copy Accepted was not part of this
  earlier checkpoint.
- Focused automated coverage is provided by
  `src/App.test.jsx`,
  `main/__tests__/reviewLibrary.test.js`,
  `main/__tests__/reviewMetadataRestore.test.js`,
  `main/__tests__/reviewMainIntegration.test.js`,
  `main/__tests__/preloadNativeIpc.test.js`,
  `src/hooks/review/useReviewWorkflow.test.js`,
  `src/components/ReviewToolbar.test.jsx`,
  `src/components/ProcessReviewResultsDialog.test.jsx`,
  `src/review/reviewResults.test.js`,
  `src/hotkeys/shortcutCatalog.test.js`, and
  `src/hooks/selection/useHotkeys.test.js`. The normal completion gate also
  runs the full Vitest suite and Vite production build.

### 2026-07-19

Copy Accepted is **Implemented**.

- The renderer sends only the active root, relative directory, folder scope,
  and the optional sidecar flag. The main process reads present `pick`
  instances from profile-local SQLite and never accepts renderer media/path
  records as copy authority.
- Planning is bounded to 20,000 accepted media instances, 16 MiB of aggregate
  path material, eight expiring native plans, and 100 retained native issue
  samples. Renderer disclosure is further reduced to six safe relative-path
  samples.
- The native directory picker is followed by a complete preflight. It rejects
  destinations inside the source library, preserves root-relative paths,
  deduplicates the three exact recognized sidecars, validates regular-file and
  directory identities, reports missing sources and collisions, and returns
  no absolute destination or source paths.
- Execution uses a globally bounded two-worker pool and exclusive destination
  creation. Every source is identity-checked immediately before and after its
  copy; every concrete destination parent is revalidated before publication.
  A destination-directory replacement cannot redirect work through a symlink,
  and a source that changes mid-copy causes the exclusively owned destination
  to be removed and reported rather than retained as a valid result.
- Progress is throttled to 100 ms and keyed by the native plan. The dialog
  distinguishes preflight, copy, cancellation, success, and partial/fatal
  outcomes; it never overwrites, supports choosing another destination, and
  keeps originals plus all review/rating/tag metadata unchanged.
- Prepared and active work is owner/profile-generation bound. Root changes
  cancel renderer-held plans; renderer destruction cancels owner work; profile
  transitions and shutdown cancel and fully drain the native worker pool.
- Focused coverage is provided by
  `main/__tests__/reviewCopyAccepted.test.js`,
  `main/__tests__/reviewExportScope.test.js`,
  `main/__tests__/acceptedExportDatabase.test.js`,
  `main/__tests__/reviewMainIntegration.test.js`,
  `main/__tests__/preloadNativeIpc.test.js`,
  `src/components/ProcessReviewResultsDialog.test.jsx`,
  `src/review/reviewResults.test.js`, and `src/App.test.jsx`.
- Completion verification passed 1,042 standard Vitest tests, 51 Electron-ABI
  SQLite tests, ESLint, main/preload/native syntax checks, the Vite production
  build, and `git diff --check` on 2026-07-19.
