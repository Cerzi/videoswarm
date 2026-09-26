# Generation Versions and Link Transfer

Status: **Unimplemented — accepted design; slices below are recorded as they
land**
Last updated: 2026-09-26

## Summary

Generative workflows produce several files that are all *the same generation*:
a draft and its re-render at a higher resolution or more steps, an upscale, an
interpolation pass, a settings sweep, an A/B test. Content identity correctly
refuses to merge them, because their bytes differ. Browsing them as unrelated
clips hides the one question a reviewer keeps asking: *which of these is the
version I keep, and which drafts have not been re-rendered yet?*

This document specifies two producer-neutral features:

1. **Generation versions.** A cheap, deliberately dumb **generation key** groups
   clips that are versions of one generation. The grid shows an "N versions"
   badge, the details panel lists the siblings, and two filters — *has a
   higher-resolution version* and its inverse *best version* — turn the
   existing resolution filter into a "drafts not yet re-rendered" worklist.
2. **Transfer as links.** The existing transfer flow gains a third action that
   creates symbolic links instead of copies, so clips can be handed to another
   tool's watched folder without duplicating them or moving them out of the
   folders they are organised in.

Both were motivated by one ComfyUI re-render loop (see
[`comfy-requeue.md`](comfy-requeue.md)), and neither depends on it. Nothing
here special-cases a producer, a node class or a filename convention.

This is a living implementation record. A slice is marked **Implemented** only
after its focused acceptance tests pass, and **Verified** only after
`npm test -- --run`, `npm run lint` and `npm run vite:build` also pass.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Verified** means the repository-wide gates also passed on that change.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Goals

- Group versions of one generation without tracing the generation graph.
- Fail toward *not grouping*: a clip that cannot be keyed is simply ungrouped,
  never an error and never grouped with a guess.
- Compute each key once per content, survive moves and renames, and keep every
  unit of work bounded, cancellable and profile-owned.
- Make "which drafts still need a re-render" one filter combination.
- Let a selection be handed to an external tool as links, with explicit
  platform behavior and without the library showing the same content twice.

## Non-goals

These are inherited from
[`embedded-generation-metadata.md`](embedded-generation-metadata.md) and apply
unchanged:

- No raw `prompt` or `workflow` graph in SQLite, React state, logs or a
  process-lifetime cache. Only the derived key is stored.
- No eager whole-library scan on folder open. Key work is background work that
  starts after the collection is shown, and is bounded and cancellable.
- No producer-specific adapters, and no dependence on the Generation panel's
  graph resolver.
- No network access, no ComfyUI installation, and no mutation of source media.

Specific to this document:

- **Not deduplication.** Byte-identical files already share one content row
  under fingerprint v2. A *version* is a different file of the same generation;
  the word "duplicate" is not used for it anywhere in the UI.
- **Not a claim of quality.** "Best version" means *no higher-resolution version
  exists*. It does not claim the render is better, and a re-render at the same
  seed can differ in composition (see `comfy-requeue.md`, "What a re-queue is").
- **No dependency on the `requeue` tag.** See *Prior art*.

## Why not the Generation panel's resolver

The Generation panel traces the execution graph from the output node back to
"the" sampler, "the" positive prompt and "the" model. That is inherently fragile
on arbitrary ComfyUI graphs — custom nodes, `Any Switch`, subgraphs, wrappers,
and composers that keep the prompt in half a dozen fields. When the resolver
misses, the panel shows a partial result; that is acceptable for a read-only
panel and unacceptable for grouping, where a miss silently splits a set.

The earlier specification, `variant-grouping.md` (kept only on the
`claude/variant-grouping` branch, commit `79df9e6`), built the key from the
resolver's normalized fields. This document supersedes it for that reason. Two
of its conclusions survive:

- **Do not hash the graph.** Bypassing a node deletes it from the API prompt, so
  a draft and its cache-free re-render have different node sets. The key below
  reads values, never node sets or topology.
- **Model and LoRA filenames are not identity.** Swapping a checkpoint is a
  different render of the same generation. The key never reads them, because
  they are single tokens rather than four-word text.

A further finding while building this: ComfyUI writes Python's non-standard
`NaN` into the API prompt (`is_changed: [NaN]` on several core nodes). Strict
`JSON.parse` rejects the whole payload. The key parser retries with `NaN` and
`Infinity` replaced by `null` outside string literals. The Generation panel's
parser has no such handling today, which is a plausible cause of some of its
failures; it is tracked in [`../outstanding-work.md`](../outstanding-work.md)
rather than fixed here.

## 1. The generation key

Status: **Implemented and Verified** (2026-09-26)

`main/generation-key.js` is a pure function from the embedded API-format
`prompt` payload to a key or to nothing. It never traces links beyond one hop
and never looks at node class names.

- **Seeds.** Every input whose name contains `seed`, case-insensitively. An
  integer literal is taken as its exact source text, so 64-bit seeds beyond
  `Number.MAX_SAFE_INTEGER` never collapse onto a neighbour. A link
  `[node_id, slot]` is followed exactly **one** hop: if the source node has
  exactly one integer-literal input, that value is taken — which covers
  `PrimitiveInt` and `Seed (rgthree)` nodes feeding `noise_seed`. Anything else
  is ignored.
- **Texts.** Every string input value with at least four whitespace-separated
  words, whitespace-collapsed and lowercased. This finds prompt text wherever a
  custom node keeps it, without knowing which node is "the prompt".
- **Input media.** Every string input value ending in `.mp4`, `.mov`, `.webm`,
  `.png`, `.jpg`, `.jpeg`, `.webp`, `.wav`, `.mp3` or `.flac`, reduced to its
  basename. This keeps video-to-video runs with the same prompt but a different
  source video apart. A media string is never also counted as text.
- **Key.** `gk1-` followed by the first 128 bits of SHA-256 over the versioned,
  sorted, de-duplicated seed, text and media lists. De-duplication means a seed
  reached both directly and through the hop counts once.
- **No key** when there is no seed or no text. Seedless processing workflows
  (masking, interpolation-only, upscaling-only graphs) therefore stay
  ungrouped, which is correct: without a seed there is no evidence two runs are
  the same generation.

The function is **total**: malformed JSON, a non-object graph, a pre-parsed
object (whose integers are no longer exact), too many nodes,
inputs or values, or an unsafe integer without source-text access all return
no key. It never throws and never produces a user-visible error. Bounds: 2 MiB
payload, two decode layers (legacy double-stringified payloads), 4,096 nodes,
256 inputs per node, and 256 seeds, 512 texts and 256 media names per graph.
Exceeding a bound returns no key rather than a key over a truncated graph.

The collected parts contain prompt text. They exist only inside the function
call; only the hash leaves it.

### Validation

A Python prototype of exactly this rule, minus the media guard, was run against
a real library on 2026-09-26:

- 900 random MiniMax H3 outputs: 97% keyed (every miss had no `prompt` tag);
  37 groups covering 110 clips. On inspection every group was a true version
  set — A/B tests, sweeps, drafts with their re-renders.
- 99 other outputs (LTX, VR180, V2V, masking workflows): the one-hop seed rule
  took V2V clips from unkeyed to keyed. The remaining misses were seedless
  processing workflows. Grouped V2V runs shared the same input video.

The committed fixtures are reduced copies of four real sets: a draft with two
re-renders (seed reached through `RandomNoise → Seed (rgthree)`), a
three-clip settings sweep, a V2V pair keyed through a `PrimitiveInt` hop with
two input media, and a seedless masking workflow that must not key. They
preserve graph topology, seeds and the equality structure of every string, but
replace prompt text, paths, model names and hashes with neutral placeholders,
following the fixture rule in `embedded-generation-metadata.md`.

### Acceptance

- The three real version sets each share one key; the seedless workflow has
  none; the sets have three distinct keys.
- A 64-bit seed differing only beyond 2^53 yields a different key.
- The one-hop rule takes a sole integer literal and ignores a source node with
  zero or several.
- Two runs differing only in input media do not share a key.
- `NaN`/`Infinity` payloads key; malformed, oversized and hostile shapes return
  no key without throwing.

## 2. Reading the tag cheaply

Status: **Unimplemented**

The prototype paid about 34 ms per file to spawn `ffprobe`. A folder of 3,000
clips would occupy the single probe lane for close to two minutes, and the
Generation panel shares that lane.

- **ISO-BMFF (`.mp4`, `.m4v`, `.mov`, `.qt`) is read in-process.**
  `main/container-tags.js` walks top-level box headers — seeking over `mdat`, so
  `moov` placed after the media is still found — reads `moov` under the same
  8 MiB bound the dimension parser already applies, and decodes
  `udta/meta/keys+ilst` string items. That is where ComfyUI's `SaveVideo`
  (`mdta` keys) and VHS (`©cmt` comment envelopes) put their payloads. Only
  items named `prompt`, `comment` or `description` are decoded; the visual
  `workflow` graph, usually four times larger, is skipped without being
  converted to a string.
- **Tag recognition is shared, not reimplemented.** The recognized tag names
  and the comment-envelope unwrapping are exactly those of
  `main/embedded-metadata-probe.js`, factored into one exported function that
  both the ffprobe path and the in-process path call.
- **Other containers** (`.webm`, `.mkv`, …) use `ffprobe` through a dedicated
  single-lane probe owned by the indexer, so background work never queues
  behind or ahead of an interactive Generation-panel request. A missing
  `ffprobe` leaves those clips unkeyed and unretried until the next index
  request; it is not reported as an error.

The in-process read is two to three orders of magnitude cheaper than spawning a
process, and moves ComfyUI's common case off the system-`ffprobe` dependency
that `embedded-generation-metadata.md` lists as unresolved portability work.

### Acceptance

- Tags are read from `mdta`/`keys` items and from `©cmt` envelopes, with
  `moov` before or after `mdat`.
- Truncated, oversized, looping and non-ISO inputs return *no tags* without
  throwing and without reading beyond the stated bounds.
- A direct `prompt` tag wins over a comment envelope, as it does in the ffprobe
  path.

## 3. Storage

Status: **Unimplemented**

The key is a property of content, so it lives on `media_content`, next to the
technical metadata it resembles:

- `generation_key TEXT` — the key, or `NULL`.
- `generation_key_version INTEGER` — the key-algorithm version that produced
  the row, or `NULL` when never computed. A row with a version and a `NULL` key
  means *computed, no key*, and is not recomputed.
- `idx_media_content_generation_key` on `generation_key`.

The migration is additive in the usual `PRAGMA table_info` style. Because the
row is keyed by fingerprint, the key survives moves, renames and copies, and is
computed once per content no matter how many instances share it. Fingerprint
rekeying (the v1 → v2 content migration) carries both columns across.

Bumping `GENERATION_KEY_VERSION` makes every older row eligible again. Keys
carry their version in the `gkN-` prefix, so keys from two algorithm versions
can never collide while a library is part-way through recomputation.

Only definitive outcomes are persisted: a key, or *no key* because the payload
is absent, unparseable or unkeyable. Transient outcomes — cancellation,
`ffprobe` missing or timing out, I/O errors, or a file whose size or
modification time no longer matches its catalogued instance — leave the row
untouched so a later request retries it.

### Acceptance

- Existing profiles migrate without losing rows; new columns default to *not
  computed*.
- Keys survive rekeying and are shared by every instance of one content.
- Transient failures never persist a *no key* result.
- Covered under Electron's SQLite ABI (`npm run test:electron-abi`).

## 4. Background indexing

Status: **Unimplemented**

Grouping needs keys for a whole collection, and a key needs a file read. The
decision is that **keys are computed after the collection is on screen, in
bounded background batches, and never on the folder-open path.**

- **Delivery with records.** Every record builder (streamed scan patches, the
  cached snapshot, tag views and watcher events) already joins
  `media_content`, so a stored key arrives with the record at no extra cost.
  Reopening a folder whose keys are known shows its groups immediately.
- **What is pending.** A record carries `generationKey` when keyed and
  `generationKeyChecked` when its content has been evaluated under the current
  algorithm. A record with a fingerprint and no `generationKeyChecked` is
  pending.
- **Trigger.** The renderer starts one index request after the collection
  settles — never while a scan is still running — for the pending records'
  instance ids, capped at 20,000 per request. A later settle picks up the rest,
  so larger collections are covered in successive requests. New pending
  records from the watcher re-trigger after a short debounce; a fingerprint
  that was already attempted in this collection is not requested again, so a
  transient failure cannot loop.
- **Explicit library scope.** The Versions filter offers *Find versions across
  the library*, which pages through every present catalogued instance whose key
  is not computed. It is the only path that reads files outside the open
  collection, and it runs only on that explicit request.
- **One job per renderer, latest wins.** A new request cancels the renderer's
  previous job. Changing folder or profile, closing the window, renderer
  destruction and shutdown all cancel it; profile changes and shutdown drain it
  before the profile generation advances, exactly like the generation-metadata
  service.
- **Bounded work.** One file at a time, in-process where possible; candidates
  are read from SQLite in pages of 256 and de-duplicated by fingerprint;
  results are written in transactions of at most 64 rows and published as one
  event per written batch. Each file is opened read-only, rejected if it is a
  symbolic link, and its size and modification time must still match the
  catalogued instance, so a key is never attributed to content that has since
  changed.
- **Authority.** The renderer sends instance ids only — never a path — and
  receives only fingerprints and keys. The indexer reads only files the profile
  catalog already records as present instances, and re-checks that the file's
  real path is still inside its own library root. This is catalog authority
  rather than a renderer path grant: the renderer cannot name a file, and
  nothing read from the file is returned except a 36-character hash.

### What the UI shows before keys arrive

- Clips whose keys are pending show no version badge; badges appear as batches
  land, and nothing reflows.
- Pending clips count as their own only version, so the *best version* filter
  includes them and *has a higher-resolution version* does not. Results are
  therefore provisional, and the Versions section of the filter panel states
  that: **Finding versions… 1,204 clips left**, replaced by nothing once the
  collection is fully evaluated.

### Acceptance

- Opening a folder performs no key work until the collection is shown and the
  scan has finished.
- Stored keys arrive with records from every record builder.
- A new request, folder change, profile change, window close and shutdown each
  cancel or drain the job, and a stale job never publishes into a newer
  profile.
- A changed file, a symbolic link or a path outside its root is never keyed.

## 5. Grouping, badges and the details panel

Status: **Unimplemented**

**Groups are library-wide.** A draft in one folder and its re-render in
another are versions of each other whichever folder is open. The renderer
builds a local index from the collection immediately and augments it with a
bounded library summary — version count and highest pixel count per key, for
at most 4,096 keys per request — computed in SQLite over present instances.
A version is a content, not an instance: two copies of one file are one
version.

**Ordering.** Within a group: pixel count, then duration, then modification
time, each descending. Unknown dimensions or duration sort as zero. No
producer is special-cased.

- **Badge.** A card whose group has two or more versions shows a compact
  "N versions" pill, marked when a higher-resolution version exists. The card
  receives primitives only, so the memoized card re-renders only when its own
  group changes.
- **Details panel.** For a single selected clip with a key, a *Versions*
  section lists the siblings — resolution, duration, modified date and
  location — in version order, marking *This clip* and the best version. It
  loads lazily when shown, at most 32 versions, and suppresses stale responses
  on rapid navigation. A sibling in the current collection selects and
  reveals it; one outside the collection (another folder, or hidden by a
  filter) shows its location and says why it cannot be revealed.
- The section appears in the floating inspector, the docked details workspace
  and the fullscreen details dock, through the shared metadata content
  components.

### Acceptance

- Badge counts and sibling lists include versions outside the open folder.
- Instances of one content count as one version.
- A sibling in the collection is selectable from the panel; one outside is
  explained, not silently inert.

## 6. Filters

Status: **Unimplemented**

A new `versionFilter` joins the filter state: `any` (default), `superseded`
(**Has a higher-resolution version**) and `best` (**Best version**).

- *Has a higher-resolution version*: some version in the library has strictly
  more pixels.
- *Best version* is its exact inverse, so the two partition every collection.
  Ties at the top all count as best — a same-resolution sweep has no
  higher-resolution version, so none of it has been re-rendered. Clips without
  a key are their own only version and count as best.
- **The worklist.** *Best version* plus a maximum resolution (`maxMegapixels`
  in `src/app/filters/filtersUtils.js`) lists the drafts that have not been
  re-rendered. Selecting them and transferring as links hands them to an
  external re-render tool; when its results are indexed, the drafts drop out
  of the list.
- The filter counts toward the active-filter badge, has a summary chip, and is
  saved with smart views. Saved views previously dropped the resolution bounds
  and the include-tags match mode; they now keep them, because a worklist that
  loses its resolution bound on save is a different list.

### Acceptance

- The two values partition any collection; `any` leaves it unchanged.
- The worklist combination returns exactly the unsuperseded clips under the
  bound.
- Saving and reapplying a view restores the version filter, resolution bounds
  and match mode; views saved before this change apply unchanged.

## 7. Transfer as links

Status: **Unimplemented**

The transfer panel gains **Link** beside Copy and Move. It uses the same
prepared plan: destination, layout, collision detection, root containment and
bounds are unchanged. Only the per-file operation differs.

- **Operation.** `fs.symlink(source, destination, "file")` with the source's
  canonical absolute path as the target. It fails with `EEXIST` on an existing
  entry, so collisions keep their existing skip semantics, and it never follows
  or replaces anything at the destination.
- **Verification.** After creation the destination must be a symbolic link
  whose target reads back as exactly the source path, and the source must
  still match the identity recorded at planning. Otherwise the link is removed
  — only if it is still the link just created — and the clip is reported as
  changed. Sources are never modified.
- **Reporting.** Results say *linked*, not *copied*; no byte count is shown,
  because none is written.
- **Windows.** Creating symbolic links needs Developer Mode or elevation.
  The option is shown on every platform; on Windows it carries that caveat, and
  an `EPERM` from `symlink` is reported as a named failure —
  **Windows only allows symbolic links with Developer Mode enabled or when
  running as administrator** — rather than the generic permission message.
  Because the first link fails the same way as every other, the transfer stops
  at the first such failure instead of repeating it for every clip.
- **macOS and Linux** need no privilege.

### Symbolic links inside a library root

**A library scan does not index symbolic links**, to files or to directories.
A link is fingerprint-identical to its target, so indexing it would show the
same content twice with shared tags, rating and review state — confusing to
review and dangerous to Move or trash. This was already the behavior of the
directory scan and the polling scanner, which both classify entries with
`Dirent.isFile()`/`isDirectory()` and therefore skip links; it is now also true
of the chokidar watcher, which could previously surface a link added while a
folder was open until the next rescan hid it again.

The consequence is stated in the panel: links placed inside a library root do
not appear in it. The transfer planner already refuses a destination inside
any source root; a destination inside a *different* indexed root is allowed
and simply does not show the links.

### Acceptance

- Link creates links, reports them as linked, and never alters or removes a
  source.
- An existing destination entry is a skipped collision, not an overwrite.
- A post-creation mismatch removes only the link it created.
- `EPERM` on Windows is reported with the named remedy and stops the batch.
- No scan path — directory scan, polling scan or watcher — indexes a symbolic
  link.

## Prior art: the `requeue` tag

The user's standalone `comfy-requeue` tool writes a `requeue` tag into the
finals it produces, carrying `source_stamp`, `source_seed`, `source_path` and
the draft's `source_prompt`/`source_workflow`. It is an exact, producer-written
link from a final to its draft.

Video Swarm **does not read it.** The generic key already groups those pairs
— the tool reruns the same prompt at the same seed — and depending on one
tool's private tag would make grouping work for one user's pipeline and not for
anyone else's. It is recorded here as evidence that the pairs exist, and as a
possible future cross-check, nothing more.

## Deferred

- **Collapsing a group into one card** in the grid. The *Best version* filter
  gives the collapsed view; a true stack with expand-in-place needs layout
  support the masonry grid does not have.
- **Side-by-side comparison** of a group's versions.
- **Revealing a sibling outside the collection** in its own folder from the
  details panel.
- **Keys from sidecars and non-ComfyUI producers.** The key reads the embedded
  API prompt only. Any producer that embeds an equivalent graph keys for free;
  others stay ungrouped.
- **Automatic library-wide indexing.** Only the explicit action reads outside
  the open collection.

## Implementation order

1. Key function and fixtures.
2. In-process tag reader, schema, record delivery and background indexer.
3. Library summaries, badges, details section and filters.
4. Link transfer and the watcher symlink guard.

## Implementation notes and decisions

### 2026-09-26 — Design

- Reuse the tag *recognition* of the embedded probe, not its process; reuse
  none of the resolver.
- Persist on `media_content` rather than a new table: the key is a property of
  content exactly like duration, and every record builder already joins it.
- Catalog authority for background reads, because a renderer path grant for
  every contributing root would either widen the renderer's authority or make
  library-wide versions impossible.

### 2026-09-26 — Slice 1: key function

- `main/generation-key.js` implements Section 1. Integer literals are read
  through `JSON.parse`'s source-text reviver, so seeds are exact without a
  second tokenizer. Only text payloads are accepted.
- Real payloads showed that tolerance for Python's `NaN` is not optional:
  every H3 and V2V fixture carries `is_changed: [NaN]`, and without the retry
  none of them keyed.
- 26 focused tests in `main/__tests__/generationKey.test.js` over nine reduced
  real fixtures and synthetic edge cases pass; the full suite (1,191 tests),
  zero-warning lint and the Vite build pass.

## References

- Tag recognition and payload bounds:
  [`embedded-generation-metadata.md`](embedded-generation-metadata.md).
- Content identity, bounded native work, record builders:
  [`large-library-performance.md`](large-library-performance.md).
- Library-wide collections and cross-root transfer:
  [`library-tag-views.md`](library-tag-views.md).
- The external re-render tool and the split of responsibilities:
  [`comfy-requeue.md`](comfy-requeue.md).
- Transfer planning, bounds and collision policy:
  [`review-workflow.md`](review-workflow.md).
