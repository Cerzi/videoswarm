# Fullscreen Review Loupe

Status: **Implemented and verified**
Last updated: 2026-07-15

## Summary

Fullscreen becomes a focused, single-clip review workspace rather than only a
large video overlay. It retains one modal-owned media element and one external
decoder lease while adding full-order navigation, explicit review targeting,
a profile-persistent Details dock, safe file utilities, complete keyboard and
accessibility behavior, and synchronous media teardown on every exit path.

The interaction follows an active-item Loupe model: one visible clip is the
sole logical selection, review actions apply to that exact content identity,
and closing returns focus to that clip in the grid. The surface is a native
modal `dialog`; background content is inert and no backdrop blur is used.

This document is the implementation contract and verification record. A slice
is marked **Implemented** only after its acceptance tests and applicable
project gates have passed.

## Goals

1. Guarantee that fullscreen audio and decoder ownership stop synchronously
   before the grid resumes or collection ownership changes.
2. Navigate the complete current filtered/sorted order independently of the
   masonry render cap and mounted DOM.
3. Make classification, rating, tagging, metadata inspection, and safe file
   utilities available without leaving the active clip.
4. Prevent delayed metadata or native-action results from drifting to a newer
   clip, profile, root, web selection, or fullscreen session.
5. Provide a keyboard-efficient, accessible modal that remains practical on
   narrow screens and Linux software-decoding systems.

## Non-goals

- Do not reparent or borrow a grid `VideoCard` media node.
- Do not prefetch adjacent media or retain a second collection snapshot.
- Do not add Trash, Move, or other destructive file actions.
- Do not add a filmstrip, playback-speed control, frame stepping, A/B loops,
  comparison, customizable shortcuts, or a rotating playback cohort.
- Do not create a Continue Review session merely by opening or navigating.

## 1. Media and decoder ownership

Status: **Implemented**

The modal owns exactly one `<video>` and, while that video has a source,
exactly one external decoder lease. It never adopts a grid media element. The
player exposes a narrow imperative `releaseNow()` method whose implementation
is idempotent and synchronous:

1. Mark the current source generation released so later media callbacks are
   ignored.
2. Set `muted = true` and pause.
3. Clear `srcObject`, remove `src`, and remove native-path/source bookkeeping
   attributes.
4. Call `load()` to detach Chromium's media pipeline.
5. Revoke only blob URLs created and owned by this player.
6. Release the exact external decoder lease once.

`releaseNow()` runs before Close, Escape, backdrop dismissal, Previous/Next,
root/profile/folder-scope/web-collection transitions, source invalidation,
work suspension, and scheduler reset. React effect cleanup remains a fallback.
The grid playback scheduler may resume only after the synchronous release.

Playback effects are keyed by a stable media identity made from collection
owner, instance/file identity, source URL/generation, and web-file identity.
Replacing a metadata record after a tag, rating, or review mutation must not
reload or restart playback. A changed file or source generation must reload.
A same-source logical transition settles from Loading using current ready
state rather than waiting for an event that may not fire. All `play()` calls,
including Space, handle rejected promises and report non-fatal feedback.

Every fullscreen session begins muted. `M` toggles audio and the choice carries
to subsequent clips in the same session only. Close, work suspension, or
ownership loss resets the session audio preference to muted.

### Acceptance

- Every exit path immediately leaves the old element paused, muted, without a
  source or source object, and with no owned blob or external lease.
- Grid playback resumes strictly after release.
- Metadata-only record updates do not disturb playback.
- Repeated open, navigation, suspension, and close leak zero external leases.

## 2. Collection ownership and controller

Status: **Implemented**

The controller accepts a `collectionOwnerKey` covering profile plus local-root
or web-selection ownership, and the complete `orderedVideos` array. A same-ID
record from another owner closes the session; it never silently replaces the
playing clip. Root, profile, scope, and web-selection handlers close and
release synchronously before awaiting persistence, watcher, authorization, or
scan work.

Web-file instance IDs include normalized relative path, size, modification
time, and selection ordinal so duplicate names and sizes cannot collide.

The controller retains only:

- the current record and its stable identity;
- the last known full-order index;
- immediate previous and next IDs;
- owner key and an unpredictable/monotonic fullscreen session token.

It does not copy the full collection. Its public model supplies current index
and count, boundary state, current-view membership, direct navigation, close,
and session token. Navigation uses the complete filtered/sorted order, never
wraps, disables unavailable directions, and announces Start/End of current
view.

Opening and navigating make the active instance the sole logical selection.
Closing leaves it selected and returns focus to its card or the gallery. If a
visited item is outside the current masonry cap, closing raises the cap only
to the smallest existing step needed to mount and focus it, with a short toast.
The obsolete fullscreen card pin and effect-delayed fullscreen-ID mirror are
removed.

If an active filter removes the current clip after review and auto-advance is
off, the modal retains its captured record, labels it as no longer matching
the view, and manual navigation follows the captured immediate neighbor. A
removed source advances to a still-valid captured/current neighbor where
possible; otherwise it closes with feedback.

### Acceptance

- Navigation reaches records beyond the render cap without mounting them.
- Boundaries do not wrap and provide live feedback.
- Same-ID records cannot cross root/profile/web ownership.
- Removed and filtered current items follow the defined retention/fallback
  behavior without retaining a collection snapshot.

## 3. Explicit review and metadata targeting

Status: **Implemented**

Before each mutation, capture the exact fingerprint, instance anchor,
successor ID, owner key, and session token. Review, rating, and tag APIs accept
these explicit targets rather than resolving the renderer's later selection.
A completion whose owner or session token is stale has no navigation or UI
effect.

Successful Accept, Reviewed, Reject, and positive rating actions obey the
profile-local **Advance after marking** setting. Failures remain on the current
clip. Automatic advance does not wrap and skips other instances sharing the
affected fingerprint; manual navigation still includes duplicates. Resetting
to Unreviewed clears rating but not tags, as defined by the review workflow.
Undo returns to the affected clip if that instance still exists.

Fullscreen navigation updates an already-engaged Continue Review checkpoint
through its existing debounce. Opening and navigation alone never create a
checkpoint. Successful mutations continue to use the workflow's immediate
checkpoint persistence.

### Acceptance

- Queued review, rating, tag, undo, and utility operations never drift to a
  newly active clip.
- Auto-advance on/off, mutation failure, boundaries, duplicate content, and
  stale async completion are covered by focused tests.
- Continue Review behavior distinguishes an engaged checkpoint from ordinary
  fullscreen browsing.

## 4. Interface

Status: **Implemented**

Replace the inline overlay with a responsive native modal `<dialog>` and
component CSS. The backdrop is opaque/translucent without `backdrop-filter`.

### Header

- Root-relative folder and filename.
- `N of M` full-order position.
- Review state and compact progress summary.
- Muted/audio toggle, Details toggle, safe-actions menu, and Close.

### Media stage

- Contained looping video with native playback controls.
- Portrait and landscape replaced-element sizing is explicitly allowed to
  shrink inside the stage, so `object-fit: contain` always bounds the complete
  frame to the available viewport instead of clipping intrinsic 9:16 height.
- Loading and error states, Retry, and non-overlapping Previous/Next buttons.
- Controls remain reachable at supported narrow sizes and reduced motion
  removes non-essential transition effects.
- The media element has no selection border or browser-default orange focus
  ring. Because the modal owns one unambiguous active clip and its shortcuts
  are global, focusing the native player also adds no outer focus box; the
  main grid uses a dedicated orange selection token instead.

### Review rail

- Accept, Reviewed, Reject, and Unreviewed.
- Each state uses the same semantic color as the rest of the app and renders
  its primary shortcut in the visible label (`Accept (A)`, `Reviewed (S)`,
  `Reject (D)`, and `Unreviewed (F)`).
- Rating 1–5 and clear rating.
- Undo.
- **Advance after marking** toggle.

### Details dock

- File facts and relative location.
- Existing tags, suggestions, and tag editor.
- Generation prompt, model, seed, sampler, run, source, and other supported
  sidecar facts.

Metadata content is extracted into reusable presentation/editor sections used
by both the existing floating grid inspector and the fullscreen dock. The
draggable inspector shell, placement, and behavior remain unchanged.
Generation sidecar data is requested only while the Details dock is open. On
narrow windows the dock becomes a bounded bottom sheet rather than overlapping
the media controls.

The compact grid inspector remains bounded to its top 15 tag suggestions.
Fullscreen may render up to 100 ranked suggestions: on desktop that list
expands into the dock's remaining height and scrolls only when it actually
overflows; on narrow layouts the bounded bottom sheet owns the single
scrollbar. The limit remains finite so profiles with very large tag
vocabularies cannot create an unbounded React subtree.

The Details dock defaults open for existing and new profiles. Its last state
is saved as bounded profile setting `fullscreenDetailsOpen: boolean` through
the existing settings normalization, load, and partial-save paths. Navigation
preserves it; later sessions use the profile preference.

### Safe actions

The overflow menu delegates through the existing action coordinator and always
passes the active fullscreen instance explicitly:

- Show in folder.
- Open externally.
- Copy path.
- Copy relative path.
- Copy filename.
- Retry playback.

Trash is intentionally absent.

## 5. Keyboard and accessibility

Status: **Implemented**

The fullscreen shortcut set is catalogued only in
`src/hotkeys/shortcutCatalog.js`, and the help surface renders from that
catalog:

| Action | Keys |
| --- | --- |
| Previous / Next | Left / Right, `Q` / `E` |
| Play / pause | Space |
| Mute / audio | `M` |
| Details | `I` |
| Accept / Reviewed / Reject / Unreviewed | `A` / `S` / `D` / `F` plus existing aliases |
| Rating / clear rating | `1`–`5` / `0` |
| Undo | `Z` |
| Help | `?` |
| Close | Escape |

Inputs, editable content, selects, and hotkey-exempt surfaces ignore these
shortcuts. Review and navigation ignore key repeat. Escape first closes a
transient actions menu or help surface, then closes fullscreen.

Media readiness is settled once per source generation. A later `canplay`
event cannot restart a clip that the user paused. Space is intercepted in the
capture phase and its keyup/repeat halves are consumed for the media element,
so a physical press performs exactly one toggle; ordinary buttons retain
their native Space activation.

On open, call `showModal()`, move focus inside, label and describe the dialog,
and make application content outside it inert. Tab and Shift-Tab remain inside
the modal. Preserve the previous body overflow value. Close restores inertness,
body overflow, and focus to the current connected card, falling back to the
gallery. Live regions announce boundaries, loading/error recovery, filtered
membership, and mutation results.

### Acceptance

- Modal semantics, inert background, focus containment/return, layered Escape,
  editable guards, live announcements, reduced motion, and narrow non-overlap
  pass focused tests.
- Shortcut help and behavior share one catalog definition.

## 6. Interfaces and persistence

Status: **Implemented**

- Add `fullscreenDetailsOpen: true` to defaults and boolean normalization; use
  existing settings IPC only. No database migration or new channel is needed.
- Extend the fullscreen controller with owner/full-order inputs and the bounded
  model described above.
- Expose `releaseNow()` through a narrow imperative player ref.
- Permit review and metadata helpers to receive explicit fingerprint and
  instance targets.
- Reuse extracted metadata sections without importing floating-inspector
  geometry or selection ownership into the modal.

## 7. Verification plan

Status: **Implemented; verification passed**

### Unit and renderer integration

- Immediate teardown for Close, Escape, backdrop, navigation, invalidation,
  suspension, scheduler reset, root/profile/scope/web changes, and unmount.
- Owned blob and exact decoder lease accounting; grid-resume ordering.
- Same-source transition, metadata-only update, rejected `play()`, and repeated
  lifecycle.
- Full-order navigation, no-wrap boundaries, filtered retention, source
  removal, duplicate handling, owner changes, same-ID cross-root records,
  collision-safe web IDs, and stale completions.
- Sole selection, Details preference and lazy loading, explicit action targets,
  auto-advance/failure/Undo, Continue Review engagement, and render-cap return.
- Modal accessibility, layered surfaces, responsive layout, and shortcut
  guards/help.

### Electron smoke

1. Open fullscreen, unmute, retain a reference to its media element, close,
   then prove it is paused, muted, source-detached, and cannot overlap resumed
   grid playback.
2. Classify, rate, tag, navigate, close, and verify the selected grid clip and
   persisted metadata.
3. Exercise root/profile switching and repeated open/navigate/close with no
   stale source, decoder, renderer error, or destroyed-window error.
4. Load a real 90×160 portrait fixture and prove its media box is contained
   without stage overflow; pause with Space, dispatch a later readiness event,
   prove it remains paused, then resume with the next Space press.

### Required gates

- Focused Vitest suites.
- Full `npm test -- --run`.
- Electron/native SQLite suites and ABI check where applicable.
- `npm run lint` and applicable CommonJS syntax checks.
- `npm run vite:build`.
- Electron smoke suites.
- `git diff --check`.

Only slices whose applicable checks pass may be changed to **Implemented**.
Any unavailable hardware-specific check must remain explicitly unverified.

### Verification record — 2026-07-15

- Focused renderer and integration coverage passed: 194 tests across the
  fullscreen player, controller, App wiring, review workflow, metadata
  sections/actions, folder lifecycle, web identity, and shortcut catalog.
- Full Vitest passed: 115 files and 951 tests, with the repository's 18
  intentional native-ABI skips reported separately.
- Electron-ABI SQLite coverage passed: 5 files and 43 tests.
- `npm run lint`, CommonJS syntax checks for `main.js`, `preload.js`, and the
  fullscreen Electron smoke, plus `git diff --check`, all passed.
- `npm run vite:build` passed. The pre-existing Vite large-chunk advisory
  remains informational and is not caused by a failed build.
- The complete Electron smoke set passed: application lifecycle, Continue
  Review restart/resume, and Fullscreen Review Loupe (3 tests total).
- The focused fullscreen smoke retained old media nodes and verified immediate
  mute, pause, source/source-object detachment, empty media pipeline state,
  root and profile replacement, repeated-session ownership, review/rating/tag
  persistence, Undo, selection/focus return, and narrow-window panel/control
  non-overlap.
- Follow-up fullscreen polish verification passed 31 focused tests, the full
  115-file / 956-test Vitest suite (plus the repository's 18 intentional
  native-ABI skips), lint, CommonJS smoke-fixture syntax checks, renderer
  build, `git diff --check`, and the real Electron portrait/Space smoke.

The Electron smoke exercises Chromium's software-decoded path. It does not
claim Linux NVIDIA hardware decode support or measure fullscreen FPS; neither
is part of this feature's acceptance scope.

## Rollout and commits

1. Commit this design specification alone.
2. Commit media ownership and controller hardening with their focused tests.
3. Commit the review-loupe interface, settings, shared metadata content,
   integration/smoke coverage, and final verified status record.

The first release preserves the current All Motion behavior and does not add
adjacent-media prefetch. Performance regressions are evaluated against Linux
software-decoding baselines before any broader media scheduling change.
