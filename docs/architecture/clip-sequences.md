# Clip Sequences

Status: **Implemented** — the store, the Sequences panel on the activity rail,
loupe play-through, renumber-in-place, numbered-copy export and one-video
export are built and verified. A few smaller items stay open; see *Open
items* below.
Last updated: 2026-09-29

## Summary

A **sequence** is a named, ordered, profile-local list of clips. It exists for
the workflow where short generated clips are shots in a longer story: the order
is a human decision that no sort key can express, and today there is no surface
that holds one.

Sorting cannot substitute for this. A sort is a total order over everything
present, so it can express neither an arbitrary permutation nor a subset — and
story order is always both. The grid orders *what you have*; a sequence orders
*what you chose*.

Sections 1 to 7 are built.

## Status convention

Matches the rest of `docs/architecture/`:

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Why this is not the selection

`useSelectionState` holds a `Set`, and every consumer treats it as an unordered
bag. It is tempting to reuse it, because `Set` does preserve insertion order and
`toggle` appends — so ctrl-clicking A, B, E, D, F really does leave those ids in
that order today.

**That order is not a contract and must not become one.** `selectRange` and
`useMasonryBoxSelection` both rebuild the set in grid order, so one shift-click
silently discards an order the user spent a minute building, with no visible
indication that it happened. An ordering surface whose state can vanish
invisibly is worse than no ordering surface.

So a sequence is a separate, explicit, persistent structure, and adding to it is
a deliberate act rather than a side effect of clicking.

## 1. What a sequence is made of

Status: **Implemented**

Entries reference **content fingerprints, not paths**.

This is forced by the feature's own purpose. Section 5 renames files to write
the order onto disk, and Section 6 copies them elsewhere; a path-keyed sequence
would be invalidated by the exact operations it exists to perform. Fingerprint
keying also inherits the semantics the catalog already has, where tags, ratings
and review state follow content through renames and moves.

Two consequences, both stated rather than discovered later:

- **Position is the identity, fingerprint is the payload.** A shot may
  legitimately recur — a cutaway returning to an earlier setup — so entries have
  their own ids and an explicit position, and the same fingerprint may appear
  more than once.
- **Byte-identical copies collapse.** Two identical files in different folders
  are one content row, so an entry resolves to *some present instance* of that
  content. Resolution prefers an instance under the currently open root, then
  any present instance, then reports the entry missing. This is already how
  review treats duplicate content.

```sql
CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  UNIQUE(sequence_id, position),
  FOREIGN KEY (sequence_id) REFERENCES sequences(id) ON DELETE CASCADE,
  FOREIGN KEY (fingerprint) REFERENCES media_content(fingerprint) ON DELETE CASCADE
);
```

Names are `UNIQUE COLLATE NOCASE` to match `saved_views`. Sequences are
profile-local like every other catalog feature.

**Bound: 500 entries per sequence.** At the five-second clip length this feature
targets that is roughly forty minutes of story, well past the point where the
work belongs in an editor. The cap is enforced in the store, not the UI, and
appending past it reports the refusal rather than truncating.

### Acceptance

- A sequence survives renaming, moving and re-scanning its clips.
- The same clip can occupy two positions without either entry disturbing the
  other.
- Appending beyond 500 entries fails with a reported reason and no partial
  write.
- Deleting a sequence removes its entries and nothing else.

## 2. Adding, in a defined order

Status: **Implemented**

Adding a multi-clip selection appends **in the collection's current sort order**,
not in click order.

Click order is the more flexible input and the worse contract, for the reason in
*Why this is not the selection*: it is invisible while being built and it resets
silently. Sort order is predictable, already visible on screen, and always the
same for the same grid. Arbitrary order is then produced by reordering in the
panel, where it is visible and correctable — which is the whole point of having
a panel.

Entries append to the end. Nothing about adding ever reorders existing entries.

### Acceptance

- Adding a box selection twice from the same grid appends the same order twice.
- Adding never mutates the position of an existing entry.

## 3. The panel, and the constraint that shapes it

Status: **Implemented** — as a **Sequences panel on the activity rail**
(`ux-redesign.md`, D7), not the strip under the grid it started as.

The sequence is a **bounded list**, not a mode over the grid.

**Reordering cannot use the grid's drag.** `VideoCard`'s `handleDragStart` calls
`preventDefault()` and hands off to Electron's native `startDrag` so clips can be
dragged into ComfyUI and editors. Once `startDrag` fires the HTML5 drag is over,
and no in-app drop target can receive it. Dragging a card into a panel is
therefore not merely unimplemented; it cannot be made to work without giving up
the drag-out that already exists.

So the two directions are split:

- **Into the sequence:** the card context menu, the **B** hotkey, and a
  **+ Sequence** button in Details (docked and floating). All three add the
  selection in the grid's sort order. No drag.
- **Within the sequence:** panel entries are plain DOM with no native drag
  binding, so ordinary HTML5 drag-and-drop reorders them. **Alt+↑ / Alt+↓**
  move the focused entry for anyone not using a pointer.

The panel is also what keeps this clear of the virtualized masonry. Reordering
inside a virtualized layout means dragging against a layout that re-flows and
recycles nodes underneath the pointer; a bounded list of at most 500 items,
scrolled inside the sidebar, does not have that problem and does not touch
the grid renderer at all.

### Acceptance

- Dragging a grid card still drops a real file into an external application.
  **Unchanged**: `VideoCard` is not modified by this feature.
- Dragging a panel entry never starts a native OS drag. **Verified**
  (`SequencePanel.test.jsx`).
- Reordering one entry leaves every other entry's relative order unchanged.
  **Verified**, by drag and by Alt+arrow, in unit tests and in the real app
  (`tests/electron/sequences.smoke.spec.cjs`).
- The masonry renderer is unmodified by this feature. **Verified**: no change
  under `src/hooks/video-collection/` or to `useMasonryLayout`.

## 4. Playing it through

Status: **Implemented**

The sequence plays in the existing fullscreen loupe, as one run.

This is the part that earns the feature before any export exists: it answers
"does the story actually flow?" without ffmpeg, without an editor, and without
leaving the app. `useFullScreenModal` already accepts
`{ collectionOwnerKey, orderedVideos }`, and rootless collections already
establish that an ordered array need not come from a folder. A sequence is one
more such array with its own owner key.

One real behavioral change: the loupe sets `element.loop = true`, so a clip
repeats until dismissed. Sequence playback needs loop off and an advance on
`ended`. `FullScreenModal.jsx` is flagged as sensitive in `AGENTS.md` because it
owns a separate media element and decoder lease, so **the lease and teardown
semantics do not change — only the disposition at end of clip does**, and it
changes only while a sequence session is active.

**Seamless playback is not promised.** A brief gap at each boundary is accepted
for the first version. Gapless chaining needs a second prepared media element,
which is exactly the kind of extra decoder lease the playback design bounds on
purpose; see Deferred.

### Acceptance

- Reaching the end of a clip advances to the next entry; the last entry ends the
  session rather than wrapping. **Verified.**
- Grid loupe playback still loops as it does today. **Verified**, including that
  the declarative `loop` attribute and the imperative assignment agree across a
  rerender -- disagreeing would silently restore looping mid-sequence.
- Exactly one decoder lease is held at a time during sequence playback.
  **Inherited, not separately verified.** Advancing calls the same
  `requestNavigate` path a Next press calls, so the lease hand-off is the
  existing one; nothing here opens a second lease. A focused assertion inside a
  sequence session would still be worth adding.
- Closing mid-sequence tears down synchronously, as any loupe session does.
  **Verified** for the end-of-sequence close and for unmount.

## 5. Writing the order onto disk

Status: **Implemented**, except the single-clip rename (see the end of this
section).

**Renumber** writes sequence positions into filenames. It is how the order
leaves the app for tools that only understand names.

- **Gap numbering.** Positions are written as `010`, `020`, `030`. Inserting a
  shot later then costs one rename instead of renumbering everything after it.
- **Two-phase renaming.** Target names collide with source names whenever the
  operation is a permutation — swapping two clips' numbers fails immediately if
  applied one at a time. Rename to temporary names, then to finals, so cycles
  resolve.
- **No overwrite, ever.** A target name that already exists on a file outside
  the sequence aborts the batch before the first rename, inheriting the
  collision policy in `review-workflow.md`. The batch is all-or-nothing;
  a partially renumbered folder is a worse state than an unrenumbered one.
- The sequence itself is unaffected, because entries are fingerprints.

**Renaming originals is not the default.** It rewrites files that external
workflows may already reference. The default is Section 6's numbered copy, which
produces the same downstream benefit without touching the source folder;
renumber-in-place stays available as an explicit choice.

This section was also meant to supply the single-clip rename the application
lacks — the only `rename` IPC is still `profiles:rename`. **That is not
built.** `main/sequence-renumber.js` plans and executes any batch of
renames, so a single-clip rename is one caller away, but it needs its own
UI and was left out rather than bolted on.

### Acceptance

- Renumbering a permutation of existing numbered files succeeds.
  **Verified**, swaps and a longer cycle included
  (`main/__tests__/sequenceRenumber.test.js`).
- A collision with a file outside the sequence aborts with nothing renamed.
  **Verified**, both at confirmation and when the name appears after it.
- Tags, ratings and review state are unchanged by a renumber. **Verified**
  against the real SQLite store (`sequenceRenumberCatalog.test.js`, in
  `test:electron-abi`), which also checks the sequence resolves to the new
  names in order with nothing missing.

### Implementation notes

- `main/sequence-renumber.js`. Numbers are `(position + 1) × 10`, three
  digits until a sequence needs four (100+ entries). A prefix is replaced
  only when it looks like one this feature wrote — three to five digits, a
  multiple of ten, then `_` — so `2024_take.mp4` and `001_take.mp4` keep
  their digits and a renumbered folder does not become `020_010_…`.
- **Refusals**, each naming positions: a missing entry (Section 7), and a
  file at two positions (a file carries one number; the numbered copy is
  the way to repeat a shot).
- **Two-phase with rollback.** Sources are renamed beside themselves to
  `<name>.vs-renumber-<tag>-<i>` (not a video extension, so scanners ignore
  it), then to their finals. Any failure renames every completed step
  back; if even that fails, the error names the folders and the temporary
  suffix to look for.
- **No overwrite.** Targets are checked at confirmation, again at apply,
  and again immediately before each final rename, by device and inode, so
  a case-insensitive volume or a hard link counts as "itself". Node's
  `rename` replaces an existing file, so a file created in the instant
  between that last check and the rename could still be replaced; no
  portable no-replace rename exists to close that gap.
- **Authorization.** Paths come from the catalog, never the renderer, and
  every one is checked with `assertRendererPath(event, path, "file")`, as
  other native file actions are. A clip in a root this window has not
  opened is refused with its position. Plans are bound to the renderer
  that asked, expire after five minutes, are spent by one apply, and are
  dropped when the renderer goes away.
- **Confirmation.** `sequences:renumber:prepare` returns every rename; the
  dialog lists them folder by folder and says the old names stop working
  for other tools. Nothing changes until `sequences:renumber:apply` names
  that plan.
- **Catalog.** After renaming, main indexes each new path and marks the old
  one missing (`recordRenumberInCatalog`) instead of waiting for a watcher
  that may not cover every root the sequence spans. Content rows are
  untouched.

## 6. Exporting

Status: **Implemented** — both tiers.

Two tiers, cheapest first.

**Numbered copy.** Copy the sequence into a destination folder with `010_`,
`020_` prefixes, plus an ffmpeg `concat.txt`. This reuses the existing transfer
flow and its no-overwrite policy, adds no native code, and matches the split
stated in `comfy-requeue.md`: Video Swarm chooses, another tool runs.

**Single file.** ffmpeg's concat demuxer, stream-copying when every entry shares
codec, resolution and frame rate — checkable from `media_content`, which already
stores `width`, `height`, `frame_rate` and `duration_ms` — and re-encoding
otherwise, with the mismatch reported before the run starts rather than
discovered in the output.

The daemon-shaped objection in `comfy-requeue.md` does not apply here and the
distinction is worth stating, because that document is the precedent for
refusing work like this. Its deciding argument was that a six-hour supervised
batch cannot live in a GUI you close. Concatenating forty five-second clips is
seconds of bounded, cancellable work with a definite end — the same shape as
proxy generation, which already runs in-process through
`child-process-runner`. Availability follows `ffmpegAvailable` in
`proxy-manager.js`; the control is absent, not broken, without it.

### Acceptance

- A stream-copy export of uniform clips produces a file whose duration equals
  the summed entry durations within one frame. **Verified** with the real
  ffmpeg (`main/__tests__/sequenceRender.test.js`; skipped where ffmpeg is
  not installed).
- Mixed formats are reported before any work starts. **Verified**: the plan
  lists each property that differs and at which positions, and the dialog
  shows it before the run.
- Cancelling leaves no partial output file. **Verified** for the one-video
  export, including a cancel that kills a running ffmpeg. The numbered copy
  keeps the transfer flow's rule instead: files already copied stay (they
  are complete files, not partial ones) and `concat.txt` is not written.
- Export is unavailable, with a stated reason, when ffmpeg is absent.
  **Verified**: the menu item is disabled and the reason is shown under it.

### Implementation notes — numbered copy

- A **sequence mode of the transfer coordinator**
  (`main/review-copy-accepted.js`), so the destination picker, recent
  folders, destination-inside-source refusal, symlink and identity checks,
  progress and cancel are the ones every transfer uses. Rows come from
  `buildSequenceCopyRecords` (`main/sequence-export.js`), resolved in main:
  one per position, so a recurring shot is copied once per position under
  each number.
- **All-or-nothing**, which is stricter than a transfer's skip-collisions
  rule: any taken name, `concat.txt` included, blocks the start with the
  reason, because a copy missing a shot is a different story and
  `concat.txt` would name someone else's file. Copy only; move and link are
  refused for a sequence.
- `concat.txt` is written with `wx` after every file has copied, with
  ffmpeg's quoting and a header giving the command to join it.

### Implementation notes — one video

- `main/sequence-render.js`, through `child-process-runner` like proxy
  generation: one run at a time, per-step timeouts, bounded output.
- **Why ffprobe, not `media_content`.** The catalog has frame size, frame
  rate and duration but no codec, pixel format or audio layout, and stream
  copy fails on any of those. So every clip is probed first; the plan is
  *copy* only when codec, frame size, frame rate, pixel format and audio all
  match.
- **Re-encode** normalizes each clip to the most common frame size and rate
  (H.264 + AAC; MPEG-4 Part 2 if this FFmpeg has no libx264), letterboxed,
  with silence for clips without sound when any clip has sound, then joins
  the results by stream copy. Clip-by-clip keeps command lines short and
  gives progress per clip.
- **Output** goes to a hidden `.<name>.partial-<id>` beside the target and
  takes its final name by hard link, which fails rather than replaces, with
  a checked rename where links are unsupported. The name is the sequence's,
  with ` (2)`, ` (3)` … if taken. Cancel or failure removes the partial and
  the temporary folder of intermediates.
- **Availability** is learned by running `ffmpeg -version` and `ffprobe
  -version`, the way `proxy-manager.js` learns it (ENOENT means absent).
  `ProxyManager.ffmpegAvailable` itself is not reused because it stays
  `null` until a proxy has been attempted.
- Sources are authorized like renumber's; the folder comes from the native
  picker. Missing entries refuse, naming positions.

## 7. Missing entries

Status: **Implemented** — entries keep their slot, the panel draws the gap,
playback skips it after saying how many are missing, and every export and
renumber refuses while any entry is missing, naming the positions.

An entry whose content has no present instance **keeps its position and renders
as a gap**. It is never silently dropped, because a sequence that quietly
shortens itself is a story edited by accident.

**Export refuses to run while any entry is missing.** This is the one place the
failure is invisible in the output: a shortened render looks like a finished
render. Playback is more forgiving and skips the gap with it marked in the
panel.

### Acceptance

- Deleting a clip on disk leaves a visible gap at its position, not a shorter
  sequence.
- Restoring the file to any indexed location refills the same position.
- Export refuses, naming the missing positions. **Verified** in main (the
  query behind the numbered copy, the one-video prepare and renumber all go
  through `assertEntriesResolvable`) and in the renderer, which says so
  before opening a folder picker (`src/app/sequenceFileActions.js`).

## Deferred

- **Gapless playback.** Needs a second prepared media element and a second
  decoder lease. Deferred until the boundary gap is measured on target hardware
  and shown to matter. `fullscreen-review-loupe.md` states the invariant it
  would break: the loupe holds exactly one external decoder lease.
- **Trimming, in/out points and transitions.** This is not an editor. The
  sequence chooses shots and their order; an NLE cuts them.
- **Multiple takes per position.** The natural home for this is
  `variant-grouping.md`, whose accepted specification already groups re-renders
  of one shot. A position holding N takes with one active is that feature seen
  from this side; neither should be built assuming the other.
- **Audio handling beyond passthrough.** No mixing, no ducking, no music bed.
- **Cross-profile sequences.** Profile-local, like the rest of the catalog.

## Implementation order

1. ~~Store and bounds: both tables, ordered read, append, reorder, remove, the
   500-entry cap, and focused database coverage.~~ Done, in `main/database.js`
   with `main/__tests__/clipSequences.test.js` registered in
   `test:electron-abi`. Position rewrites are two-phase for the reason
   Section 5 gives about filenames, and `rekeyContentFingerprint` carries
   entries across the v1 -> v2 migration — without that the cascade from
   `media_content` would silently shorten a sequence, which is the failure
   Section 7 exists to prevent.
2. ~~IPC and preload exposure, updating handler, bridge and call sites together
   as `AGENTS.md` requires.~~ Done. Nine `sequences:*` channels registered
   through the trusted registrar in `main.js`, bridged in `preload.js`, and
   consumed by `useSequences`. A name collision is reported as
   `SEQUENCE_NAME_TAKEN` rather than a raw SQLite constraint string, because a
   rename dialog has to say something useful about it.
3. ~~The panel: strip, in-panel drag reorder, add-from-selection in sort
   order.~~ Done. `SequencePanel` plus `useSequences`, reached from the card
   context menu, which creates a sequence on first use rather than prompting.
   The sort-order rule is `orderSelectedFingerprints` in
   `src/sorting/selectionOrder.js`, extracted so it is testable away from
   `App.jsx`. Since moved onto the activity rail; see the 2026-09-29 notes.
4. ~~Loupe play-through, with the end-of-clip disposition change scoped to
   sequence sessions.~~ Done. A sequence session swaps the controller's inputs
   rather than adding a second controller, and `advanceOnEnd` turns the loop
   off and advances on `ended`. Making the entries playable required the store
   to return the full catalog projection and `main/sequence-view.js` to build
   wire records through `createTaggedLibraryFiles`, pairing by resolved path so
   a record the projection refuses cannot slide every later entry onto the
   wrong clip.
5. ~~Renumber, two-phase and all-or-nothing~~. Done; the single-clip rename
   is not (see Section 5).
6. ~~Numbered copy export, then single-file concat behind ffmpeg
   availability.~~ Done.

Steps 1–4 are independently useful and should land before 5–6 are designed in
detail: play-through is what proves the ordering surface is right, and it is
cheaper to change the panel before anything writes to disk.

## Implementation notes

### 2026-09-29 — Sequences on the rail, renumber and export

- **The panel is a rail panel.** `buildWorkspacePanels` gains a Sequences
  entry whenever a folder is open, in both Details modes, with a badge
  counting the active sequence's clips. It is a vertical list at the
  sidebar's width; the strip under the grid is gone.
  - The first add in a session opens it; later adds only report which
    sequence they went to, so an add never pulls the sidebar away from
    another panel.
  - A new grid selection keeps Sequences in front, as it keeps Generation,
    because selecting clips to add is how the panel is used.
  - With sequences stored but none chosen (launch, profile switch), the most
    recently changed one is shown, so the next add continues it.
  - New and Rename name a sequence inline. They used `window.prompt`,
    which Electron does not implement, so both did nothing in the app.
  - The context menu used click order for a multi-clip selection; it now
    uses sort order, as Section 2 requires.
- **B** adds the selection; it is in `shortcutCatalog.js`, so the shortcut
  guide lists it.
- **Files menu** in the panel: *Copy as numbered files…*, *Export as one
  video…*, *Rename originals to this order…*.

### Open items

- **Thumbnails in the panel.** The list has a thumbnail column that appears
  only when images are supplied, and none are yet. The grid's thumbnail
  cache holds only clips that were hovered or dragged, and decoding a frame
  per entry would spend the decoder budget the grid depends on. A frame
  grab through the ffmpeg runner, cached per fingerprint, is the likely
  route.
- **Single-clip rename** (Section 5).
- **Sequence playback has no `fullPath`.** Entries are built by the same
  catalog projection as tag views, which carries no native path, so in a
  sequence session Copy frame falls back to the canvas capture. Tag views
  share the limitation.

## References

- Content identity and why metadata follows content: `main/fingerprint.js`,
  `file_instances` and `media_content` in `main/database.js`.
- Ordered-array loupe sessions: `useFullScreenModal` in
  `src/hooks/useFullScreenModal.js`; looping media element at
  `src/components/FullScreenModal.jsx`.
- Single-lease ownership and synchronous teardown:
  [`fullscreen-review-loupe.md`](fullscreen-review-loupe.md).
- The native drag hand-off that forbids in-grid drop targets:
  `handleDragStart` in `src/components/VideoCard/VideoCard.jsx`.
- Named profile-local catalog precedent: `saved_views` in `main/database.js`.
- Transfer bounds and collision policy: [`review-workflow.md`](review-workflow.md).
- Why long batches stay external: [`comfy-requeue.md`](comfy-requeue.md).
- Grouping re-renders of one shot: `variant-grouping.md` (on
  `claude/variant-grouping`, not yet on `main`).
