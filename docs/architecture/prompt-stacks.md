# Prompt Stacks

Status: **Implemented** — all eight sections; deferred items below. Section 7
is unverified by a human in the packaged app (see *Validation*).
Last updated: 2026-10-17

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
- Similar-prompt stacks (Section 7) compare prompts in the main process. The
  renderer sends prompt keys with clip counts and receives prompt keys; words
  are held as numbered sets in memory only and never written or logged.
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
- **Input media** basenames, with where a cut starts, as for the generation
  key. Image-to-video runs from different start images, and video-to-video
  runs cut from different points of one source, stay in different stacks.
- **Not** seeds, numbers, model or LoRA names, node ids or topology. A seed
  sweep, a steps or CFG sweep and a checkpoint swap therefore share a stack.

The key is `pk3-` followed by the first 128 bits of SHA-256 over a tagged,
versioned canonical form, so it can never equal a generation key. (Version 3,
2026-10-18, reads a JSON string by the texts inside it, as generation key
version 4 does; see `generation-versions.md`.)

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

- **Toggle.** *View → Stacks → Stack runs of a prompt*, or `G`. Off by
  default; remembered as the `stackByPrompt` setting. How alike prompts must
  be is chosen beside it (Section 7).
- **Neighbours, not groups** (2026-10-17). A stack is a run of clips next to
  each other in the grid's current sort order: walking the folder scope in
  that order, a clip joins the run before it when its prompt is the previous
  clip's prompt, or alike to it (Section 7), within one folder group. A clip
  without a key ends a run. Runs of one prompt that something else sits
  between stay separate: collapsing a batch saves scrolling past it, while
  gathering clips from all over the sort would be grouping, which is a
  different thing. A new sort regroups at once; under random order there are
  few stacks.
- **Collapse after filtering.** Runs are found before filters, so filters never
  regroup them; a stack card stands for the run's *matching* clips, and when
  filters hide some the count reads `5/20`. Selecting a stack selects only its
  matching runs. (A selection made before a filter change keeps its hidden
  clips, as every selection already does.)
- **Collection-local.** Stacks are formed within the open collection, unlike
  version counts, which are library-wide. A stack is a way of viewing what is
  open; a tag search gives a library-wide collection to stack.
- **One card.** The card shows the stack's cover: its pick, else its highest
  rating, else its highest-resolution version, else its newest run. The card
  sits where the cover sorts, inside the run's place in the grid. Clips that are alone in their stack, and clips
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

## 7. Similar prompts

Status: **Implemented, unverified by a human** (2026-10-17)

Exact stacks were too narrow in practice. On the first real library measured
(2,539 keyed clips), 1,892 prompt groups held 1,566 lone clips: most runs of
one idea had been reworded between runs, usually in more than ten words. A
stack now holds prompts that share most of their words.

- **Choice.** *View → Stacks* offers *Same prompt only*, *Nearly the same
  prompt* (90% of words in common), *Similar prompts* (80%, the default) and
  *Loosely similar prompts* (70%). Choosing one turns stacking on. Remembered
  as the `stackSimilarity` setting (`1`, `0.9`, `0.8` or `0.7`).
- **Measure.** Jaccard similarity of the prompts' word sets: the long texts
  the prompt key reads (Section 1), lowercased and split on letters and digits.
  Short texts and seeds are ignored.
- **Same input media.** Prompts over different input media never join; the
  same words over another source clip, or another segment of it, are another
  shot. This is the start-decides rule of `generation-versions.md`.
- **Boilerplate.** A text in at least a quarter of the collection's prompt
  groups (and at least three), beside at least three different other texts,
  is left out of every comparison. That is how a shared negative prompt or
  style suffix looks; one prompt reused over several input clips is not.
- **Alike, then neighbours** (2026-10-17). Main answers which prompts are
  alike: for each of the collection's prompt keys, the keys at or above the
  threshold (64 at most, closest first). The renderer decides which clips
  stack, from neighbours in the grid's order (Section 3), so a new sort needs
  no new answer.
- **Neighbour against neighbour.** Each clip is judged against the one
  before it, so a batch whose prompt changed a little at a time stays one
  stack. (A first version judged every clip against the run's first, to stop
  a slowly refined prompt collapsing a whole session; with stacks limited to
  neighbours that guard cost more than it saved, and the user found it
  arbitrary.)
- **Asynchronous, exact meanwhile.** The renderer asks main 250 ms after the
  collection's prompt keys change. Until the answer arrives, and whenever main
  cannot answer (no readable clip, a WebM or MKV clip, a profile switch),
  clips stack by exact prompt. An open stack follows its clips when runs
  re-form.
- **Saying so.** A stack of differing prompts says "runs of similar prompts"
  on its pill, and its bar counts the prompts (`5 runs · 3 similar prompts`).

### Cost

Main reads one present MP4 or MOV per prompt key, once per session, and checks
that it still holds the prompt the key came from. Pairing uses prefix
filtering with positional pruning (PPJoin), which is exact for Jaccard (a test
checks it against comparing every pair) and compares only prompts that share
a rare word. The anchor clustering it replaced took about 70 ms on the library
above (1,897 groups, about 300 distinct words each), in slices of at most
25 ms. The all-pairs join was timed on synthetic prompts shaped like it
(1,907 prompts of 300 words in batches of reworded variants): 40 ms at 90%,
51 ms at 80% and 101 ms at 70% in total, in slices of at most 18 ms.

### Measured

With the earlier, collection-wide grouping (before neighbours-only), on that
library, at each level:

| Level | Cards (from 1,897) | Stacks | Lone clips | Largest stack |
|------:|-------------------:|-------:|-----------:|--------------:|
| 90%   | 1,228              | 531    | 697        | 45            |
| 80%   | 953                | 525    | 428        | 51            |
| 70%   | 749                | 488    | 261        | 73            |

Measured with a count-only script; no prompt text was printed or kept.
Neighbour runs give fewer stacks than this by design, depending on the sort.

### Acceptance

- Reworded runs of one idea share a stack at the default level; unrelated
  prompts do not, and different input media never do.
- A batch refined a little at a time, back to back, is one stack.
- Clips of one prompt far apart in the sort never stack.
- Prompt text never reaches the renderer, storage or logs.
- The grid never waits on the answer.

## 8. Stack cards: a header and a strip

Status: **Implemented, unverified by a human** (2026-10-17)

A single cover said a stack existed but not what was in it. A stack card now
has a **header**, which plays as before, and along its bottom a **strip** of
up to three stills of other clips in the stack, with a `+N` tile for the rest.

- **Header.** Once anything in the stack is picked or rated, the best of it,
  as Section 3's cover rule has it: this is a culling tool. Otherwise the
  most typical clip: the one whose first frame differs least from all the
  others.
- **Strip.** How much the stack varies: each still is the clip whose first
  frame differs most from the header and the stills already chosen, shown in
  run order. Before fingerprints arrive the strip is spread evenly across the
  run. (Prompt words were considered as a fallback and dropped: in a stack of
  one exact prompt every clip has the same words.)
- **Hover and click.** Hovering a still plays that clip over the header
  (2026-10-17, `src/components/VideoCard/StackPeek.jsx`): its still at once,
  then the clip, looping, through a proxy when proxies are on and with sound
  when hover audio is. Leaving the strip returns to the header's clip where
  it was. Clicking a still opens the stack at that clip, selected and in
  view; `+N` opens the stack.
  - The hovered clip plays in its own small `<video>`; the header's media
    element, the most delicate code in the grid, is never re-pointed (that
    would report the hovered clip's size as the cover's and reflow the grid).
  - It takes the media scheduler's auxiliary lane, the one bounded extra
    decoder (shared with last-frame capture, and closed while the window is
    put away); with the lane taken the still shows instead.
  - While it plays, the header holds its own clip paused but keeps its
    decoder (marked `mediaOperation = "stack-peek"`, so the pause is not
    reported as a hand-off and the stall watchdog leaves it alone), and
    resumes when the peek ends. The grid decodes no more video than before.
- **No extra decoding in the grid.** Stills are images, so a screen of stack
  cards plays no more video than before. On cards narrower than 170 px the
  strip is hidden.

### First frames

- **Fingerprints** are asked for every clip in a stack, and only those: one
  ffmpeg grab of the first frame shrunk to 9×8 greys, reduced to a 64-bit
  difference hash, at low priority, two at a time. They are stored per
  content in the profile database (`frame_fingerprints`), so each clip is
  grabbed once. Two fingerprints are compared by the bits that differ.
- **Stills** are 240 px JPEGs of the first frame, asked for only for the
  strips of cards on screen, and kept in memory (600 at most in main, 800 in
  the renderer).
- The renderer names catalog rows; main checks each file resolves inside its
  root before ffmpeg opens it. Without ffmpeg there are no fingerprints or
  stills, and stack cards look as before.

### Acceptance

- An undecided stack is headed by its most typical clip, a decided one by its
  best.
- The strip shows clips unlike the header and each other.
- Clicking a still opens the stack at that clip.
- Clips outside stacks are never grabbed; a grab happens once per content.

## Deferred

- **Visual similarity**, for clips without embedded metadata. Local model only;
  an opt-in *find similar clips* action is a better fit than stacking.
- **Fullscreen navigation by stack** (left/right between stacks, up/down
  within one).
- **A "stacks without a pick" filter**, the culling counterpart of the drafts
  worklist in `generation-versions.md`.
- **Sorting stacks by size**, so the most repeated prompts come first.
- **Library-wide stack counts** beside collection-local ones.

## Implementation order

1. ~~Prompt key and fixtures.~~ Done.
2. ~~Storage, migration, indexing and record delivery.~~ Done.
3. ~~Local evaluation report.~~ Done.
4. ~~Collapsed grid, stack cards and the toggle.~~ Done.
5. ~~Stack view and stack navigation.~~ Done.
6. ~~Selection, auto-advance by stack and *Reject unreviewed*.~~ Done.
7. ~~Similar-prompt stacks.~~ Done.

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

### 2026-10-17 — Similar prompts

- Main compares prompts, not the renderer: the renderer never holds prompt
  text, and main already reads embedded metadata with path containment.
  Similarity is not stored: it depends on the collection (anchors, the
  boilerplate rule), and the prompts it needs are cached in memory after the
  first read.
- Words, not characters or embeddings: reworded runs keep most of their words,
  and a word set needs no model, no tuning per library and no network.
- Anchors rather than connected components, so that a run of small edits
  cannot merge a session through its intermediate prompts.
- The first version compared word sets as JavaScript `Set`s and took over a
  second on 1,900 groups in the main process. Numbering words once per session
  and pruning by prefix brought it to about 70 ms, sliced.
- `scripts/prompt-stack-report.cjs` keeps its own estimate (Section 6), with a
  frequency-only boilerplate rule. It predicted 929 cards at 80% for the
  library above; the app gives 953, the difference being prompts over
  different input media.

### 2026-10-17 — Neighbours only

- The user drew the line: stacking collapses a batch you would otherwise
  scroll past, so it follows the grid's order; collecting runs of a prompt
  from across the sort is grouping. Stacks became runs of neighbours, and main
  now answers which prompts are alike rather than assigning anchors.
- Runs are found before filters, in the folder scope sorted exactly as the
  grid sorts it (the random order is shared with the layout), so filtering
  and the `5/20` total behave as before.
