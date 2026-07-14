# Review Workflow and Result Processing

Status: Active design specification
Last updated: 2026-07-14

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

Toolbar buttons, keyboard shortcuts, context-menu actions, and review/rating
controls in the floating selection inspector all use the same serialized
workflow mutation path. Context-menu mutations target the invoked clip's
fingerprint and suppress auto-advance; all of these surfaces therefore share
the coupled rating/review invariants and one-step undo history.

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
instance of the content.

### JSON manifest export

Status: **Implemented** (2026-07-14)

The main process exports a deterministic, versioned audit manifest through a
native save dialog and atomic file replacement. Renderer code never chooses an
arbitrary output path.

Manifest v1 contains:

- `format: "videoswarm-review-manifest"` and `version: 1`.
- Export timestamp and active profile identity.
- A safe source-root display name, recursive-coverage and refresh metadata,
  plus the root-relative directory and selected scope.
- Exact state, reviewed-total, instance, and unique-content counts.
- Up to 20,000 sorted present instances with relative path, fingerprint,
  review state, rating, tags, size, timestamps, and dimensions.

The absolute source-root path and per-record absolute paths are deliberately
excluded so the audit is portable and does not disclose native paths. Raw
sidecar/workflow JSON and lazily parsed generation metadata are also excluded.
The native save dialog opens before any record query, so cancellation performs
no library materialization. A single-flight coordinator then reads only the
selected scope through bounded SQLite iterators: 20,000 records, 100,000 tag
assignments, 8 MiB of tag text, and 24 MiB of live query data. Serialized output
is limited to 32 MiB and the generated filename is bounded to 180 safe ASCII
bytes. Profile changes and shutdown pause and drain export ownership;
publication revalidates the owner immediately before atomic rename. The
persisted recursive-coverage flag and completed-scan timestamps prevent stale
or partially indexed descendants from entering a manifest.

## Deferred work

Status: **Unimplemented**

- Copy or move accepted media to a destination chosen by the user.
- Collision policy, cross-device move recovery, relative-tree preservation,
  bounded cancellation/progress, and optional sidecar handling.
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
- Manifest export is authorized, deterministic, bounded, atomic, cancellable,
  profile-isolated, excludes absolute native paths, and excludes stale
  recursive rows.

## Implementation and verification record

### 2026-07-14

All non-deferred sections in this specification are **Implemented**.

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
  native bounded trash path for local rejected instances, reconciles moved
  instances with SQLite immediately, and exports a deterministic, scoped,
  bounded, single-flight atomic manifest without absolute native paths.
- Focused automated coverage is provided by
  `src/App.test.jsx`,
  `main/__tests__/reviewLibrary.test.js`,
  `main/__tests__/reviewManifest.test.js`,
  `main/__tests__/reviewManifestDatabase.test.js`,
  `main/__tests__/reviewManifestExportCoordinator.test.js`,
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
