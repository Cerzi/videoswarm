# Prompt Stacks

Status: **Implemented** — all six sections; deferred items below. Not yet
run against a real library or in the packaged app (see *Validation*).
Last updated: 2026-10-16

## Summary

Generative workflows rarely produce one clip per idea. A prompt is run with
twenty seeds, swept across sampler settings, retried on another model. In a
large library those runs sit side by side in the grid, and a reviewer scrolls
past twenty near-identical clips to reach the next idea.

A **prompt stack** collapses every run of one prompt into a single card. The
card plays one representative clip and says how many it stands for; opening it
shows the runs in the normal grid. Stacking is a view: it changes what the grid
shows, never what is stored or where files are.

This builds directly on [`generation-versions.md`](generation-versions.md).
A *version group* is one generation (one seed) rendered more than once; a
*prompt stack* is every generation of one prompt. Each version group sits
inside one stack.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Goals

- Group runs of one prompt reliably and cheaply, without tracing the graph and
  without looking at pixels.
- Fail toward *not stacking*: a clip that cannot be keyed is shown on its own.
- Never hide a clip silently: a stack always says how many clips it stands
  for, and anything done to a collapsed stack says how many clips it touched.
- Keep culling fast: judge a whole prompt from one card, or open it, keep the
  best run and reject the rest.

## Non-goals

- **No visual similarity.** Perceptual hashes only match near-identical clips,
  and different seeds of one prompt usually differ in composition; image
  embeddings group unrelated prompts with similar scenes, need a per-library
  threshold, and would add a large model and a native runtime. See *Deferred*.
- **No prompt text in storage.** Inherited from
  [`embedded-generation-metadata.md`](embedded-generation-metadata.md): only
  the derived key reaches SQLite, React state or logs.
- **No network access**, no ComfyUI installation, no mutation of source media.
- **Not deduplication**, and not a claim that the runs are interchangeable.

## Privacy

Video Swarm makes no outbound network requests (the opt-in ComfyUI connection
accepts loopback addresses only), and nothing in this feature changes that.

- The prompt key is a 128-bit hash. The texts it is computed from exist only
  inside the key function, exactly as for the generation key.
- A stack's displayed prompt, if shown, is read on demand from the clip's own
  embedded metadata, as the Generation panel already does.
- The evaluation tool in Section 6 writes its detailed report only to a local
  file the user names, and prints counts only.
- Any future visual mode must run on this machine; a cloud embedding service
  is out of scope.

## 1. The prompt key

Status: **Implemented** (2026-10-16)

`computeGenerationKeys(payload)` in `main/generation-key.js` returns the
generation key and the prompt key from one parse. The prompt key reads:

- **Texts** of four or more words, as for the generation key.
- **Short texts** of two or three words, as for the generation key since its
  version 2. Without them, `a cat` and `a dog` sharing a long negative prompt
  would land in one stack. Single words stay out: they cannot be told apart
  from settings such as sampler or scheduler names.
- **Input media** basenames, as for the generation key. Image-to-video runs
  from different start images stay in different stacks.
- **Not** seeds, numbers, model or LoRA names, node ids or topology. A seed
  sweep, a steps or CFG sweep and a checkpoint swap therefore share a stack.

The key is `pk1-` followed by the first 128 bits of SHA-256 over a tagged,
versioned canonical form, so it can never equal a generation key.

**It exists exactly when the generation key does**: it needs the same seed and
the same four-word text, so seedless processing workflows stay unstacked. The
two keys are written together; the store refuses one without the other.

**Nesting.** The prompt key is hashed from the generation key's parts minus
its seeds, so two clips with the same generation key always share a stack:
each version group sits inside exactly one stack.

### Known ways it can be wrong

Each of these can only be seen on a real library, which is what Section 6 is
for.

- **Prompts chosen at run time.** A wildcard template, a prompt list indexed by
  a counter, or an LLM prompt generator keeps the same template text in the
  graph while the actual prompt changes. All of its outputs share one stack.
- **Single-word prompts** are invisible to the key, as above.
- **Prompts without spaces** (for example Chinese or Japanese) are one word, so
  they never key; this is inherited from the generation key.

### Acceptance

- Runs differing only in seed, sampler settings or model share a prompt key and
  keep distinct generation keys.
- Different four-word texts, different short texts and different input media
  give different prompt keys.
- The three real version-set fixtures each sit in one stack, the three stacks
  are distinct, and the seedless fixture has no key.
- The prompt key is absent exactly when the generation key is.

## 2. Storage and indexing

Status: **Implemented** (2026-10-16)

- `media_content` gains `prompt_key` and `prompt_key_version`, with a partial
  index on the key. A NULL version means not evaluated; a current version with
  a NULL key means evaluated and not keyable.
- **Migration.** When the columns are added, content already evaluated as
  having no generation key is marked as having no prompt key. The two are
  absent under the same conditions, so files without embedded metadata are not
  re-read just to learn nothing.
- **Re-evaluation.** Content with a generation key and no current prompt key
  becomes a background candidate again. Its generation key is still delivered
  meanwhile, so version badges stay put; the record reports
  `generationKeyChecked` only once both keys are current.
- The background indexer computes both keys from one read and publishes them
  together; the renderer applies `promptKey` with the same updates that carry
  `generationKey`.

### Acceptance

- Records from every builder (indexing, cached snapshot, tag search) carry the
  prompt key.
- A database that predates the columns, or that has only generation keys,
  migrates; unkeyed content is settled without being re-read.
- Malformed keys, and one key without the other, are refused.

## 3. Stacks in the grid

Status: **Implemented** (2026-10-16)

- **Toggle.** *View → Stack runs of one prompt*, or `G`. Off by default;
  remembered as the `stackByPrompt` setting.
- **Collapse after filtering.** Stacks are formed from the clips that pass the
  current filters and folder scope. A stack card stands for its *matching*
  clips; when filters hide some runs of the prompt, the count reads `5/20`.
  Selecting a stack selects only its matching runs. (A selection made before
  a filter change keeps its hidden clips, as every selection already does.)
- **Collection-local.** Stacks are formed within the open collection, unlike
  version counts, which are library-wide. A stack is a way of viewing what is
  open; a tag search gives a library-wide collection to stack.
- **One card.** The card shows the stack's cover: its pick, else its highest
  rating, else its highest-resolution version, else its newest run. The card
  sits where the cover sorts. Clips that are alone in their stack, and clips
  without a key, look exactly as they do today.
- **Visual.** A count pill with a stack icon at the top right (below the
  rating when there is one), which opens the stack, and an inset double
  outline. Offset "deck" edges were tried on paper and dropped: the masonry
  gap is 4 px and the card clips its overflow, so they would touch the
  neighbouring cards. No animation.
- **Status line.** While stacks are collapsed it counts the clips the cards
  stand for and the stacks among them (`18 clips · 3 stacks`), not cards.

## 4. Opening a stack

Status: **Implemented** (2026-10-16)

The generation-versions document deferred collapsing because expanding a card
in place needs layout support the masonry grid lacks. A stack therefore opens
as its own view rather than in place:

- Opening a stack (its count pill, a double click, or `Enter` on a selected
  stack) shows only its runs in the normal grid, with a bar above it: stack
  position, run and seed counts, runs hidden by filters, *Reject unreviewed*,
  *Previous* and *Next* stack, and *All stacks*. The cover is selected alone.
- *All stacks* or `Esc` returns to the collapsed grid with the stack's card
  selected and scrolled into view.
- Previous and next stack follow the collapsed grid's order at the moment the
  stack was opened, skipping stacks that have since dissolved, and use `[` and
  `]` in place of the previous/next-folder keys while a stack is open.
- A stack whose runs are all filtered out or removed closes by itself; another
  folder, scope or collection closes it too. Inside a stack, a double click
  plays the clip as usual, and versions of one seed show their usual badge.

## 5. Selection and review

Status: **Implemented** (2026-10-16)

- **A collapsed stack selects as all of its clips.** Selecting its card selects
  every matching run; anything done to it (review state, rating, tags,
  transfer, trash) applies to all of them, and the selection count says so.
  `useSelectionState` takes optional *selection units*: a click, Ctrl-click or
  Shift-range treats a stack as one item (clicking the only selected stack
  clears it, as for one clip), and after the stacks change the selection is
  widened so no stack is ever left partly selected.
  One rule is easier to trust than per-action exceptions, and it is what
  culling needs: rejecting a bad prompt rejects all its runs. Destructive
  actions already confirm with the clip count.
- **Auto-advance moves by stack.** A review decision on one selected stack
  advances to the next card, as it does for one clip.
- **Inside a stack**, selection is per clip as everywhere else.
- **Reject unreviewed** (`Shift+D` or `Shift+X`, or the bar's button) rejects
  every unreviewed run in the open stack in one step that `Z` undoes, leaving
  picks, ratings and earlier rejects alone. Pick the best run, then reject the
  rest.

## 6. Checking stacks on your own library

Status: **Implemented** (2026-10-16)

`scripts/prompt-stack-report.cjs` groups a folder by the prompt key exactly as
the app does, without the app and without the catalog:

```
node scripts/prompt-stack-report.cjs <folder> --out <report.html> [--limit N] [--iso-only]
```

- **The terminal output is counts only**: clips found and keyed, stacks by
  size, stacks with several seeds, grid cards before and after stacking, and
  the similar-prompt estimate below. It never prints prompt text, file names,
  paths or keys (a key of a short prompt can be guessed by hashing candidate
  prompts). A test fails if it ever does. This output is safe to share.
- **The report file** lists every stack, largest first, with its texts, input
  media, runs grouped by seed, and lazily loaded previews. It holds prompts and
  paths, so it is for its owner's eyes: it is written only to a path outside
  the repository, with owner-only permissions where the platform supports
  them, and its content security policy allows local media and nothing else.
- **Similar-prompt estimate.** Prompt groups with the same input media whose
  words overlap by 80% or more, ignoring any text shared by many groups
  (typically the negative prompt), are listed side by side with the differing
  words highlighted. The count of cards a similar-prompt mode would leave uses
  anchors, not chains: a group joins only a larger group it is itself close
  to, so a prompt refined one word at a time cannot collapse a whole session.
- MP4 and MOV tags are read in-process; WebM and MKV need ffprobe on `PATH`,
  or are skipped with `--iso-only`.

### Validation

Unrun on a real library as of this writing. Run on synthetic clips only:
three seeds and a re-render of one prompt formed one stack of four, a prompt
differing by one word was reported as a close pair, and the shared negative
prompt was ignored. In Chromium the report's policy let local VP9 previews
play and refused an injected image and fetch.

The interface was exercised on 2026-10-16 by the built renderer in Chromium
with a stand-in for the preload bridge serving eighteen synthetic records:
collapse (18 clips to 8 cards), the pill, `Enter`, double click, `[`/`]`,
`Shift+D`, `Esc`, Ctrl-click and Shift-range across a stack, a review key on a
collapsed stack (one call naming all six runs), and the setting saved both
ways. The packaged Electron app was not run: in that container
`better-sqlite3` could not be rebuilt for Electron 43, whose headers host was
not reachable. `src/App.test.jsx` covers the same flow against the real
`App`.

## Deferred

- **Similar-prompt stacking.** Waits on the Section 6 estimate from a real
  library. If built: same input media required, boilerplate texts excluded by
  frequency, anchor-based joining, and the card says the prompts differ.
- **Visual similarity**, for clips without embedded metadata. Local model only;
  an opt-in *find similar clips* action is a better fit than stacking.
- **Fullscreen navigation by stack** (left/right between stacks, up/down
  within one).
- **A "stacks without a pick" filter**, the culling counterpart of the drafts
  worklist in `generation-versions.md`.
- **Sorting stacks by size**, so the most repeated prompts come first.
- **Scrubbing a stack card** across its runs, which needs still frames for
  clips that are not loaded.
- **Library-wide stack counts** beside collection-local ones.

## Implementation order

1. ~~Prompt key and fixtures.~~ Done.
2. ~~Storage, migration, indexing and record delivery.~~ Done.
3. ~~Local evaluation report.~~ Done.
4. ~~Collapsed grid, stack cards and the toggle.~~ Done.
5. ~~Stack view and stack navigation.~~ Done.
6. ~~Selection, auto-advance by stack and *Reject unreviewed*.~~ Done.

## Implementation notes and decisions

### 2026-10-16 — Key, storage and report

- The prompt key shares `deriveGenerationKeyParts` with the generation key so
  the two cannot drift; only the hash differs. Short texts are collected in the
  same pass under their own bound (512); exceeding it returns no keys at all,
  rather than a key over a truncated graph.
- The generation key was first left unchanged, with its same-seed short-prompt
  weakness recorded here. Later the same day it moved to version 2, which
  reads short texts too (`generation-versions.md`, implementation notes), so
  the two keys now differ only by seeds.
- The report tool reuses the app's in-process tag reader and key function
  rather than a separate prototype, so what it measures is what the app does.

### 2026-10-16 — Interface

- Collapsing happens before the masonry layout, as a list transform: the grid
  is given each stack's cover in place of its runs, and an open stack is given
  only its runs. The layout, virtualization and playback scheduling are
  untouched, which is why a stack opens as a view rather than in place.
- Selection units live in `useSelectionState` rather than in each consumer,
  because review keys, file actions, tags, transfer and the context menu all
  read the selection directly; a whole-stack selection is simply the set of
  its runs.
- Auto-advance treats one selected stack like one clip and moves to the next
  card; the review workflow learns the units through a ref, as the selection
  hook does.
- Cards receive primitives and one stable callback, so stacks recomputing on
  every metadata update re-render only the cards whose counts change.
