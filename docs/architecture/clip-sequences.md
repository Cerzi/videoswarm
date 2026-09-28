# Clip Sequences

Status: **Partially implemented** — the store, its IPC surface, the panel and
loupe play-through are built. Renumber and export are open. See Implementation
order.
Last updated: 2026-09-01

## Summary

A **sequence** is a named, ordered, profile-local list of clips. It exists for
the workflow where short generated clips are shots in a longer story: the order
is a human decision that no sort key can express, and today there is no surface
that holds one.

Sorting cannot substitute for this. A sort is a total order over everything
present, so it can express neither an arbitrary permutation nor a subset — and
story order is always both. The grid orders *what you have*; a sequence orders
*what you chose*.

Sections 1 to 4 are built.

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

Status: **Implemented**

The sequence is a **bounded strip**, not a mode over the grid.

**Reordering cannot use the grid's drag.** `VideoCard`'s `handleDragStart` calls
`preventDefault()` and hands off to Electron's native `startDrag` so clips can be
dragged into ComfyUI and editors. Once `startDrag` fires the HTML5 drag is over,
and no in-app drop target can receive it. Dragging a card into a panel is
therefore not merely unimplemented; it cannot be made to work without giving up
the drag-out that already exists.

So the two directions are split:

- **Into the sequence:** context menu, a hotkey, and a button in the selection
  inspector. No drag.
- **Within the sequence:** panel entries are plain DOM with no native drag
  binding, so ordinary HTML5 drag-and-drop reorders them.

The strip is also what keeps this clear of the virtualized masonry. Reordering
inside a virtualized layout means dragging against a layout that re-flows and
recycles nodes underneath the pointer; a bounded strip of at most 500 items,
scrolled horizontally, does not have that problem and does not touch the grid
renderer at all.

### Acceptance

- Dragging a grid card still drops a real file into an external application.
- Dragging a panel entry never starts a native OS drag.
- Reordering one entry leaves every other entry's relative order unchanged.
- The masonry renderer is unmodified by this feature.

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

Status: **Unimplemented**

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

This section also supplies the single-clip rename the application currently
lacks entirely — the only `rename` IPC today is `profiles:rename`.

### Acceptance

- Renumbering a permutation of existing numbered files succeeds.
- A collision with a file outside the sequence aborts with nothing renamed.
- Tags, ratings and review state are unchanged by a renumber.

## 6. Exporting

Status: **Unimplemented**

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
  the summed entry durations within one frame.
- Mixed formats are reported before any work starts.
- Cancelling leaves no partial output file.
- Export is unavailable, with a stated reason, when ffmpeg is absent.

## 7. Missing entries

Status: **Partially implemented** — entries keep their slot, the strip draws
the gap, and playback skips it after saying how many are missing. The export
refusal below is open because there is no export yet.

An entry whose content has no present instance **keeps its position and renders
as a gap**. It is never silently dropped, because a sequence that quietly
shortens itself is a story edited by accident.

**Export refuses to run while any entry is missing.** This is the one place the
failure is invisible in the output: a shortened render looks like a finished
render. Playback is more forgiving and skips the gap with it marked in the
strip.

### Acceptance

- Deleting a clip on disk leaves a visible gap at its position, not a shorter
  sequence.
- Restoring the file to any indexed location refills the same position.
- Export refuses, naming the missing positions.

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
   `App.jsx`. **Panel visibility is not persisted** — it opens on first add and
   closes with the session.
4. ~~Loupe play-through, with the end-of-clip disposition change scoped to
   sequence sessions.~~ Done. A sequence session swaps the controller's inputs
   rather than adding a second controller, and `advanceOnEnd` turns the loop
   off and advances on `ended`. Making the entries playable required the store
   to return the full catalog projection and `main/sequence-view.js` to build
   wire records through `createTaggedLibraryFiles`, pairing by resolved path so
   a record the projection refuses cannot slide every later entry onto the
   wrong clip.
5. Renumber, two-phase and all-or-nothing, including the single-clip rename.
   **Not built.**
6. Numbered copy export, then single-file concat behind `ffmpegAvailable`.
   **Not built.**

Steps 1–4 are independently useful and should land before 5–6 are designed in
detail: play-through is what proves the ordering surface is right, and it is
cheaper to change the panel before anything writes to disk.

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
