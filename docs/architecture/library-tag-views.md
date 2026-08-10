# Library-wide Tag Views

Status: **Implemented**
Last updated: 2026-08-09

## Summary

Tags are profile-wide but only reachable one folder at a time. To see every clip
tagged `#keeper` a user must already know which roots contain them and open each
one. The tag data is global; only the browsing model is not.

This adds a collection scoped to a **tag set across every indexed root**, as a
bounded SQLite snapshot with an explicit refresh, and widens the existing smart
view so a saved recipe can apply library-wide instead of to the open folder.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## What smart views are today, and what changes

`saved_views` stores a name and a `definition_json` holding filters, sort,
grouping and folder scope. It carries **no root reference**. A smart view is
therefore a *recipe*, and it is evaluated against whichever root happens to be
open — so a saved `#keeper` view still shows only the keepers in the current
folder.

The change is one axis, not a new browsing mode: a view's scope becomes either
**folder** (today's behaviour, unchanged and the default) or **library**
(evaluated across every indexed root in the profile). Everything else about
smart views — naming, saving, applying, deleting — is untouched.

## 1. The query

Status: **Implemented**

`getCachedLibrarySnapshot(rootPath)` already builds the complete renderer
collection — instance id, paths, size, mtime, created time, fingerprint, tags,
rating, review state, dimensions, audio — entirely from SQLite with no
filesystem access. A library-wide tag query is that same projection with the
root predicate replaced by a tag join, so it reuses the shape rather than
inventing a second one.

- Only `is_present` instances in present directories are returned, matching the
  cached-grid predicate. Deliberate removals and missing files stay out.
- Tag matching is by name, case-insensitively, against the profile's tag table,
  and honours the include-tags match mode: **All** intersects, **Any** unions.
  One statement serves both by requiring `>= n` matches, where `n` is the tag
  count for All and 1 for Any — and 0 when no tags are selected, which is the
  no-constraint case.
- The result is bounded by an explicit record cap and an aggregate path-byte
  budget, in the same style as the accepted-export snapshot, and reports when it
  truncated rather than silently returning a partial library.
- An empty tag set means *no tag constraint*, so a library search with nothing
  selected returns everything within the bound. No separate tag catalog is
  needed: the filter panel already lists profile-wide tags with usage counts.

### Acceptance

- A tagged clip is returned regardless of which indexed root holds it.
- A clip whose instance is absent, or whose directory is absent, is not returned.
- Exceeding the record or byte bound is reported, not truncated silently.

## 2. Snapshot, not a live collection

Status: **Implemented**

A library-wide view is a **snapshot with an explicit refresh**, not a watched
collection.

Watching every contributing root simultaneously is precisely the cost the
bounded watcher design exists to avoid: watcher state is capped at 2 active
roots and 2,048 pending events, and a library view could span far more. The
cached-grid path already establishes the precedent that a SQLite-derived
collection is a point-in-time read.

- The view is queried once when opened and when refreshed.
- A visible refresh control re-runs the query. The control states that the view
  is a snapshot rather than implying live tracking.
- Tag edits made **inside the app while the view is open** re-run the query,
  because otherwise removing a tag would leave the clip visibly present in a
  view defined by that tag.
- External filesystem changes are not tracked. A clip deleted on disk remains in
  the snapshot until refresh, and behaves like any other missing source.

### Acceptance

- Opening a library view starts no filesystem watcher.
- Removing a tag from a visible clip removes it from the view without a manual
  refresh.
- A stale entry whose file has vanished fails gracefully as a missing source.

## 2a. Where the scope lives

Status: **Implemented**

The entry point is a **scope control in the existing filter panel**, not a
separate tag browser.

The first attempt added a tag list to the sidebar. That was wrong twice over: it
duplicated a control the filter panel already provides — a search box, a bounded
"Popular tags (top 10)" list, per-tag usage counts and Include/Exclude per tag —
and it was unbounded, so a profile with many tags pushed pinned roots and smart
views out of view. It also contradicted this document, which had already said
this is one axis rather than a new browsing mode.

So the only thing genuinely missing was the axis itself: **Search: This folder /
Entire library**, placed above the filters it governs. Tags narrow the library
query itself; everything else in the panel narrows the loaded collection, exactly
as in a folder. Leaving a library search returns to the folder it was entered
from, and the control is disabled when there is none to return to.

The snapshot caveat and the result count sit next to that control, with the
refresh, rather than as permanent chrome elsewhere.

## 2b. Boolean tag matching without a query language

Status: **Implemented**

Include was an intersection and Exclude a negation, so `A AND B NOT C` was
expressible and `A OR B` was not.

Rather than a query syntax or nested condition groups, the include group gains a
two-value **Match: All / Any**. Combined with Exclude, which continues to mean
"none of these", that covers the ordinary questions at the cost of one control
and no new concepts. It is also the convention users of comparable photo and
media managers already know.

This deliberately stops short of arbitrary boolean expressions: `(A OR B) AND C`
is not expressible in one pass. That case is rare enough that a parser, its
error states and its discoverability problem are not worth paying for, and a
saved view covers the recurring instances of it.

The mode defaults to **All**, so every existing saved view and folder view state
means exactly what it meant before the mode existed. The mode is not itself a
filter and does not count toward the active-filter badge.

## 3. A collection without a root

Status: **Implemented**

The renderer already models a rootless collection: `collectionOwnerKey` is
`root:${activeRootPath}` or `web:${webCollectionEpoch}` for drag-dropped files.
A library view adds a third kind rather than special-casing the absence of a
root.

Root-specific surfaces have no meaning here and must be explicitly neutralized
rather than left to render something misleading:

- **Folder tree, breadcrumbs and folder scope** are hidden. There is no single
  tree the results belong to.
- **Continue Review is unavailable.** Review checkpoints are keyed by `root_id`,
  so a library view has no checkpoint to resume; the control states why rather
  than silently doing nothing.
- **Grouping by folder** groups by the owning root, since relative paths from
  different roots can collide.
- Review, rating and tagging all continue to work: they are content-keyed and
  never needed a root.

Playback requires no change. The media protocol resolves instances by id, which
is root-independent; each contributing root is granted on demand through the
existing indexed-root regrant path.

### Acceptance

- No root-scoped control renders as active in a library view.
- Rating, review and tag edits work identically to a folder view.
- Playback works for clips from several roots in one collection.

## 4. Transferring a cross-root selection

Status: **Implemented**

This is a real gap the feature exposes rather than creates. Selection transfer
resolves instance ids with `WHERE fi.root_id = @root_id`, so a selection
spanning roots currently reports the other roots' clips as unavailable. It
degrades honestly, but gathering scattered clips and sending them somewhere is
exactly what a library view is for, so honest failure is not good enough.

One plan spans the roots rather than one plan per root: the planner already
worked on root-relative records, so the change is that the coordinator derives
its source roots from the resolved rows, authorizes each as a separate grant,
and refuses a destination inside *any* of them. A selection now carries no root
at all — a rootless tag view has none to send — so the rows are resolved first
and the roots follow from them. Containment and the relative-path identity check
are made against each record's own root, so a record claiming a root it does not
physically live under is rejected rather than accepted by a neighbour's grant. Layout keeps its meaning per root: **structured**
recreates each clip's path relative to *its own* root, and **flat** is unchanged
and becomes the more useful default for a multi-root gather.

Collision handling gets stricter, not looser: structured layout can now produce
the same destination path from two different roots, and that must be reported as
a collision exactly like any other rather than resolved by ordering.

### Acceptance

- A selection spanning several roots transfers every eligible clip.
- Two roots yielding the same destination path is reported as a collision.
- Per-root planning stays inside the existing media and path-byte bounds.

## Deferred

- **Filtering the library view by anything other than tags** (rating, review
  state, resolution) applies through the existing filter panel once the
  collection is loaded; a query-level predicate is deferred until a library
  large enough to need it exists.
- **Live watching across roots.** See Section 2.
- **Cross-profile views.** Profile-local only, like every other catalog feature.

## Implementation order

1. Cross-root tagged snapshot and tag catalog in the metadata store, bounded and
   reported, with focused database coverage.
2. Bounded IPC and preload exposure.
3. Rootless collection wiring, neutralized root chrome, refresh control.
4. Smart-view scope, defaulting to folder so existing saved views are unchanged.
5. Per-root transfer planning.

## References

- Cached collection projection: `getCachedLibrarySnapshot` in `main/database.js`.
- Rootless collection precedent: `collectionOwnerKey` in `src/App.jsx`.
- Watcher bounds and cached-grid semantics:
  [`large-library-performance.md`](large-library-performance.md).
- Transfer bounds and collision policy: [`review-workflow.md`](review-workflow.md).
