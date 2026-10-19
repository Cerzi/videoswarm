# Outstanding Work

Last updated: 2026-10-16

Written at a machine change, so it is a handover rather than a roadmap: what is
genuinely unfinished, what is finished but unverified by a human, and where the
existing docs currently overstate themselves. Roadmap-level ideas live in the
architecture docs; this file only tracks what someone picking the repo up next
would otherwise have to rediscover.

## Status convention

Matches `docs/architecture/`:

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## 1. Variant grouping — superseded and built as generation versions

Status: **Implemented** — see
[`architecture/generation-versions.md`](architecture/generation-versions.md)

The earlier `variant-grouping.md` spec built its key from the Generation
panel's graph resolver, which is exactly the part that is unreliable. It was
replaced by a graph-free key (seeds with one link hop, four-word texts, input
media) and built end to end, together with link transfer.

**Branch caveat.** `claude/variant-grouping` is based on a pre-rebase tip and
its only content is the superseded doc. This file previously said that doc was
also on `main`; it never was. Delete the branch rather than merging it.

## 1a. The Generation panel cannot parse ComfyUI's NaN

Status: **Implemented** (2026-09-27)

ComfyUI writes Python's non-standard `NaN` into the API prompt
(`is_changed: [NaN]` on several nodes), and strict `JSON.parse` rejected the
whole payload, so the panel reported "no supported fields could be resolved".
`main/comfy-generation-parser.js` now retries with the shared
`main/json-non-finite.js` helper, and the parser cache version is 4. A real
A1 draft now shows *Embedded · Partial* with its model, VAE, sampler and
scheduler.

What this does **not** fix, and is still open: the positive prompt and seed
of Acme graphs stay unresolved, because the prompt lives in a
`AcmeRef2VAComposer` and the seed arrives through `RandomNoise`, neither
of which has an adapter; and the V2V hybrid graph reports `OUTPUT_NOT_FOUND`
because its custom save node is not a recognized output. Those are resolver
coverage gaps, not parsing failures.

Both are fixed since the Generation panel switched to the socket-type reader
([`architecture/generation-type-flow.md`](architecture/generation-type-flow.md),
2026-09-28): on 2,950 tagged clips it finds a prompt and a seed in 99% of
them and lost nothing the previous parser found. A Acme prompt is still
shown as its composer's fields (candidate fragments, Partial), because the
composer builds the final text at run time.

## 1c. Re-rendering inside Video Swarm: removed

Status: **Removed** (2026-10-19), by the user's decision.

- **What it was.** An in-house re-render queue: a recipe learner from
  draft/final pairs, a loopback ComfyUI connection with pre-queue checks, a
  queue and runner in the profile database, a tray while a queue ran, and a
  "never silently wrong" safety net. Its interface was never built.
- **Why removed.** Re-rendering is done by companion apps
  ([`architecture/companion-app.md`](architecture/companion-app.md)), which
  already re-render and upscale from Video Swarm in one click. Two engines
  doing the same work would drift.
- **What stays.** The ComfyUI address in Preferences and its read-only
  Test, for *Open workflow in ComfyUI*
  ([`architecture/comfy-workflow-window.md`](architecture/comfy-workflow-window.md)).
- **Existing data.** Profiles that had the queue keep its tables, unused;
  nothing reads or writes them. Old settings' re-render switch and output
  folder are dropped the next time settings are saved.
- The code is in git history; its last version is at `5b91e33`.

## 1b. An empty non-recursive folder reports a failed scan

Status: **Implemented** (2026-09-27)

Opening a folder whose clips are all in subfolders, with *Subfolders* off,
logged "The folder record stream did not complete" after a five-second wait
instead of showing an empty folder. It predated generation versions.

Main numbers streamed record batches from 1 and returns the last number sent
as `recordSequence`, so a scan that sent nothing returns 0. The renderer
started each scan's `lastRecordSequence` at -1 and therefore waited for a
batch 0 that never exists. It now starts at 0. A hook regression test covers
the empty streamed scan, and the original case was rerun in the real app
(isolated profile, headless) without the error.

## 2. Smart views cannot be library-scoped

Status: **Implemented** (2026-09-28)

A saved view now carries `searchScope`: views saved during a library search
search the whole library wherever they are applied, including from the home
screen; every existing view defaults to folder scope and is unchanged. See
`library-tag-views.md`, Smart-view scope.

## 3. Continue Review does not explain itself in a library view

Status: **Implemented** (2026-09-28)

A library view now shows the review toolbar, whose resume area says there is
no resume point because resume points belong to a folder; Process results is
disabled with a reason. Previously the toolbar was hidden entirely there.
`library-tag-views.md` Section 3 describes it.

## 4. Unverified by a human: the rc.6 checklist

`0.6.0-rc.6` (the version on `main`, built locally, not yet tagged) carries
the UX redesign and the features finished since rc.5. All of it passes
`npm run verify`: lint, unit tests, the Electron-ABI suites, the build and
the Electron smoke specs. **None of it has been used by a person.** Every
feature in rc.5 had a defect that the automated suite passed, so treat rc.6
as a soak before `v0.6.0`.

Things to try, and what to judge:

- **The top bar.**
  - Open a folder from **Open**, then use ‹ › and the breadcrumb.
  - Narrow the window: zoom, sort, scope and Include subfolders should fold
    into **⋯** and come back when it widens.
  - Is anything you use daily now a click too far?
- **View and ⋯.** Is the split between display settings (View) and app
  things (⋯) where you would look?
- **The status line.** Is it enough to show just the clip count and sort?
  View › Playback details brings back the decoder figures.
- **Preferences** (Ctrl+,): playback, profiles, data location and the
  ComfyUI address. Try switching and creating a profile.
- **The sidebar's activity rail: Library, Details, Generation, Sequences.**
  - Clicking the open icon collapses the sidebar.
  - Details comes forward when you select a clip. Generation stays in
    front while you step through clips reading prompts.
  - Is four icons comfortable?
- **Details.** Review, rating and tags come first, then versions and file
  facts. Try **Copy** on the prompts, and highlighting a prompt then
  pressing Ctrl+C.
- **Ctrl chords.** In fullscreen, Ctrl+C, Ctrl+A, Ctrl+S and Ctrl+D no
  longer act as C, A, S and D.
- **The review bar.** It stays one row and folds into its own ⋯. At your
  usual window size, is anything you rely on folded away?
- **Opening folders.** New folders open at the top, including with
  subfolders, Name ↓ or Random.
- **Clip sequences.**
  - Add clips with **B**, the context menu or **+ Sequence**.
  - Reorder by drag or Alt+↑/↓, then Play.
  - Try the three exports under **Files**: numbered copy, one video, and
    renaming the originals. Rename on copies of real clips first.

Still unconfirmed from rc.5:

- **Transfer affordances.** Copy is the filled primary, Move is outlined
  amber until hover, and the layout toggle fills the option actually
  selected. The colouring was reported as inverted twice, so this deserves
  a look rather than an assumption.
- **The clear-filter control.** An × inside the filters button, shown on
  hover and focus only; it may be too hidden at rest.
- **Requiring a tag before a library search.** Reasonable on a 24k-clip
  profile, possibly annoying on a small one.
- **Library smart views.** Marked ◇ *Library*; check the marker is clear and
  the badge fits a narrow sidebar.
- **Generation versions and Link.** Whether the badge earns its place on
  every card, and whether *Best version* is the right name.

## 5. Smaller known gaps

Fixed on 2026-09-29: the Playwright transfer-affordance specs have now run
here, including the Link checks, and `npm run verify` runs the whole gate
(lint, unit tests, Electron-ABI suites, build and Electron smoke specs) in
one command. CI already ran the smoke specs on every push to `main`.

- **jsdom cannot verify CSS.** It does not implement specificity: asked
  about the inverted layout toggle, it reported the unselected pill as
  correctly unstyled while a real browser painted it solid green. The review
  bar's 16 px buttons (fixed on 2026-09-29) were the same class of bug. Any
  assertion about what a control actually looks like belongs in the
  Playwright suite.
- **`v0.6.0` is not cut yet, deliberately.** Promote to stable only after
  rc.6 has been used in earnest; see Section 4.
- **Releasing rc.6** is the user's step: update the rc.5 links in
  `README.md`, `.github/ISSUE_TEMPLATE/config.yml` and
  `.github/ISSUE_TEMPLATE/bug_report.yml`, push the `v0.6.0-rc.6` tag, then
  inspect and publish the draft release the workflow creates.

## 5a. Clip sequences

Status: **Implemented** (2026-09-29), merged into `main` — see
[`architecture/clip-sequences.md`](architecture/clip-sequences.md)

Sequences are a panel on the activity rail. Clips are added with **B**, the
context menu or **+ Sequence** in Details, and reordered by drag or
Alt+↑/↓. Three exports sit under **Files**:

- **Numbered copy.** Copies with `010_` prefixes plus an ffmpeg
  `concat.txt`.
- **One video.** Stream copy when every clip matches, otherwise a re-encode
  that lists each mismatch first. It can be cancelled and never leaves a
  partial file.
- **Rename originals.** Two-phase and all-or-nothing, never overwrites, and
  renames everything back if a step fails.

Export and rename refuse while a clip is missing, naming the positions.

Two bugs were found and fixed on the way:

- New and Rename used `window.prompt`, which Electron does not implement,
  so both did nothing in the real app.
- A multi-clip add went in click order instead of sort order.

Left open:

- **Thumbnails in the panel.** Decoding a frame per entry would compete
  with the grid's decoder budget.
- **Single-clip rename.** The module supports it, but there is no UI.
- **Copy frame during sequence playback** uses a canvas capture, as tag
  views already do.
- **One unavoidable race in rename.** Node's `rename` replaces an existing
  file, so a file created between the last check and the rename itself
  could still be replaced.

`wip/clip-sequences` (`02106f2`) is kept unchanged as the original.

## 5b. Feature bloat: the UX redesign

Status: **Implemented** (2026-09-29) — see
[`architecture/ux-redesign.md`](architecture/ux-redesign.md) and the audit
page, https://claude.ai/artifact/MgNRWMjGDcVKyzJeBStmsu (private to the user)

All ten decisions and every slice have landed:

- the glossary;
- one top bar that folds into ⋯;
- the View and ⋯ menus;
- the short status line;
- Preferences;
- Details docked by default and following the selection;
- the activity rail;
- Generation as its own panel.

Two bugs found on the way are fixed too: folders opened scrolled far down,
and the review bar wrapped to two rows with 16 px buttons. How it feels in
use is Section 4's job.

## 5c. The app feels heavy: interaction performance pass

Status: **Implemented, unverified by a human** (2026-10-16)

A code review found the weight was mostly renderer main-thread work at
the moments of interaction, not decoding. The commits from `2e5fde4` to
`6b0c36f` address it:

- Scrolling no longer waits on the renderer: Ctrl+wheel zoom comes from
  Electron's `zoom-changed` instead of a non-passive window listener.
- The app re-renders a few times per screen of scrolling, not every
  frame, and not at all for hover, idle telemetry or memory polls; a
  click re-renders only the cards whose selection changed; hidden
  sidebar panels skip renders whose props did not change.
- A slow frame no longer evicts loaded clips.
- Unloaded cards are quiet tiles that show the clip's first frame once
  captured; startup opens dark; no backdrop blur over live video.
- Cards no longer clip their playing video through a rounded mask
  (the video rounds its own corners), slots are 2D-translated, file
  names overlay the video instead of cropping it, and selection is a
  ring that leaves the video's size alone.
- Folder opens write one row per unchanged file instead of 10-15
  statements; the media protocol does one read per range request with
  512 KiB chunks.
- The watcher tracks only video files and its events reach the grid
  in one update per 80 ms; generation-key progress publishes once a
  second. Measured on real A1 clips, key work is about 1 ms per file,
  so it stays on the main process.
- Proxies skip sources the 1280x720 box would barely shrink, and encode
  with two threads below normal priority.

Nothing was profiled or launched, because the GPU was busy with
generation. Check by hand:

- **Ctrl+wheel zooms the grid** on Linux. This is the riskiest change:
  the `zoom-changed` path is unit-tested only.
- Cards look right: rounded corners on playing video, the selection
  ring, file names over the video with tags and audio badge above them,
  still frames and the switch from still to motion.
- Startup goes straight to the dark app; Static + Hover still starts on
  hover; new clips written into an open folder appear.
- With Preferences › Pause while other windows cover it on: the grid
  freezes about 2-3 s after another window fully covers it, keeps
  playing while it is visible on another monitor or partly uncovered,
  and resumes on focus or uncovering.
- `npm run test:electron-smoke` passes.

Also on `main` since (2026-10-16): prompt stacks merged from
`claude/prompt-stacks`; generation key version 3 and prompt key version 2,
so cuts from different starts of one video are no longer versions; tag
matches under the tag input, including in fullscreen. Check by hand:

- **G** toggles stacks; a stack card's pill or a double-click opens it.
- After opening a library, version badges and stacks come back once the
  one-time background re-key finishes.
- Typing a tag in fullscreen lists matches; arrows and Enter add one.
- Tag hierarchy (`architecture/tag-hierarchy.md`): typing
  `dance/bellydance` nests a tag; Filters › Tags › Parent moves one;
  filtering or a library view of `dance` includes `bellydance` clips.
- In a library view, a card's **Go to folder** opens its folder with the
  clip selected and in view, and the filters cleared.
- Similar-prompt stacks (`architecture/prompt-stacks.md`, Section 7): with
  stacks on, reworded runs of one idea join one stack a moment after the
  folder opens; *View › Stacks* switches between *Same prompt only* and the
  similar levels; a mixed stack's pill says "similar prompts".
- Filters › rating 4+ with no tag, then *Entire library*: every 4- and
  5-star clip from every root.
- File details show the resolution with its megapixels, e.g.
  `1920×1080 (2.1MP)`.
- Review passes (`architecture/review-passes.md`): with filters applied (or
  two or more clips selected), *Review these N* (or Shift+R) shows just
  those clips, frozen, with "0 of N decided"; deciding clips counts up and
  they stay put even under an *Unreviewed* filter; *Exit pass* returns to
  the grid and the pass waits under Library › Review passes; resuming lands
  on the last clip; at the end a search pass offers *Run the search again*.
  Shift+1 accepts and sends to the first companion quick action.
- Big cards look sharp at the largest zoom levels: a card shown more than
  about 15% larger than its 720p proxy plays the original (a playing proxy
  swaps over as you zoom in, briefly showing its still frame), and its still
  frame is captured as wide as the card, up to 1280 px.
- Companion one-click sends: once requeue marks an action `quick`, hovering
  a card it has not sent shows that action's button, and one click sends it
  with a toast; *Send to …* on a selection sends at once when nothing would
  be skipped, and opens the dialog when something would.
- Ctrl+A (⌘A) after filtering selects every clip the grid shows, including
  ones far off screen and every run of a collapsed stack; the status line
  says "N selected" with *Clear*, the count turns amber from 1,000, and past
  20,000 (trash) or 50,000 (move, copy) it says what cannot be done at once;
  tags, ratings and review decisions on any number go in batches; Esc
  clears; Ctrl+A in
  a text field still selects its text. Then move the selection.
- Workflow filters (`architecture/workflow-filters.md`): after opening a
  folder (and the background read finishing), Filters › Workflow › Leaves
  out a LoRA word hides every clip made with it; Uses keeps only those;
  Steps ≥ 20 hides few-step runs; Frame rate ≥ 30 keeps interpolated clips;
  Versions › Has a lower-resolution version lists re-renders and upscales;
  a smart view saved with them restores them.
- Versions side by side (`architecture/generation-versions.md`, Section 8):
  clicking a card's "N versions" pill (or *Side by side* in the details
  panel) shows every version in one row filling the window, best first,
  including versions in folders that are not open, all playing; *Play
  together from the start* restarts them at once; picking, rejecting,
  rating or tagging any of them sticks; `Esc` returns to the grid with the
  clip selected.
- Background work note (`architecture/background-activity.md`): opening a
  large folder with stacks on shows "Reading clips' workflows · N left" at
  the right of the status line after a moment, and nothing when idle; the
  panel lists each kind with a bar; Pause stops new proxy encodes and prompt
  reading (CPU drops once a running encode finishes) while playback and
  stack stills carry on; the line then says "Background work paused" until
  Resume, and a restart forgets the pause.
- Hover audio (View › Play audio on hover, proxy playback on): every clip
  that has sound plays it on hover, including clips already playing a proxy;
  the first start after the update rebuilds proxies in the background.
- View › Layout › Justified rows: every row but the last fills the width
  with no gap and no crop, rows read in sort order; Shift-click range
  selection follows the rows; zoom changes the row height, and a zoom level
  shows about as many clips as masonry columns do (portrait clips as wide as
  a column); scrolling a large folder stays smooth; the choice survives a
  restart.
- Filters › Prompt: words narrow the grid to clips whose prompts contain
  them (word starts, `-word` excludes); a word only in the negative prompt
  finds nothing; with *Entire library*, prompt words alone search every
  root (`architecture/prompt-search-and-tag-suggestions.md`).
- Stack cards: an undecided stack is headed by its most typical clip, with
  three stills of the most different clips and `+N` along the bottom;
  hovering a still shows it over the header, clicking opens the stack there.
  First frames are grabbed only for clips in stacks.
- Stacks only collapse neighbours: a batch run back to back collapses, the
  same prompt elsewhere in the sort stays separate, and re-sorting regroups.
- Mouse back and forward (and Alt+←/→): open a stack, go back to the grid,
  forward into the stack again; move between folders and roots and back;
  in fullscreen, back closes the player.
- With ComfyUI running, a clip's *Open workflow in ComfyUI* (context menu)
  or **Workflow** (Generation panel) opens it in a ComfyUI window; a second
  clip loads into the same window; with ComfyUI stopped, the error says to
  start it (`architecture/comfy-workflow-window.md`).
- Tag suggestions (`architecture/prompt-search-and-tag-suggestions.md`,
  Section 2): Details shows *Suggested from the prompt* for an untagged clip
  whose prompt fits a tag used on ten or more different prompts; the chip
  applies, the cross turns it down for good. Quality tags such as "keeper"
  are listed under Filters › Might be as not told by the prompt. *Might be*
  with a tag shows clips it is suggested for; right-click *Tag as* or *Not*
  empties it as you go; with *Entire library* it searches every root. The
  first learning reads every tagged clip's prompt, so it may take a while
  on a big library: say if it feels too slow, and whether the suggestions
  are any good.
- A smart view saved during a rating-only, prompt-only or *Might be*
  library search searches the library again when applied (it used to come
  back as a folder view).
- Filters is one wide panel (2026-10-17): *This folder / Entire library* in
  its header, tags down the left, every other filter as a labelled row on
  the right with its explanation in the label's tooltip; below 900 px wide
  it is one column. Nothing should need scrolling to on a normal window.
- With no folder open, Filters lists the tags, and *Entire library* with no
  filter shows the whole library (up to 50,000 clips, newest kept past that).
- Prompt search: `"pan"` in quotes finds *pan* and not *panda*;
  `"golden hour"` finds the phrase, in order.
- *Entire library* with no filter on the owner's library (folders indexed
  inside other indexed folders) loads instead of blanking the window; each
  file appears once.
- Preferences › Local API (`architecture/local-read-api.md`): switching it
  on writes `local-api.json` beside `profiles/`; *Last read by* names the app
  reading it.
- Several companion apps per profile (`architecture/companion-app.md`): add
  two in Preferences › Companion app; each card shows a chip from each, the
  context menu names the app beside its actions, Filters has a row per app,
  and a profile that had one companion keeps it as the first.

Decided 2026-10-17: **proxies are on by default**, to try. For portrait
WAN/A1 clips they cut decoded pixels by about 1.8-3x. They are CRF 30
re-encodes, so they only feed the grid: fullscreen always plays the
original. Settings saved before the change (which held `false` because it
was the default) are turned on once (`main/proxy-playback-settings.js`); a
later choice sticks. Check by hand:

- After installing, *View › Playback proxies (720p)* is ticked; clips
  above 720p start on originals and switch to proxies as they are made,
  the next time their cards load.
- Switching proxies off survives a restart.
- If grid previews look too soft to judge at a glance, say so: the
  default can go back with one line.

## 5d. A fully portable build

App side implemented 2026-10-17 (`architecture/portable-mode.md`): detection,
every folder moved into `VideoSwarmData/` beside the copy, the lock per data
folder, the data folder fixed. Packaging (the portable artifacts and their
launchers) waits for the owner's choice, set out in that document.

## 6. Local branches and pushes

Status: **Tidied** (2026-09-29); the push is the user's to do

**Not pushed yet.** `main`, `claude/clip-sequences` and
`wip/clip-sequences` exist only on this machine; `main` is dozens of commits
ahead of `origin/main`. Decided 2026-10-19: it stays local until a build has
proved stable. Pushing is the user's step:

    git push origin main claude/clip-sequences wip/clip-sequences

Local Claude branches that were fully merged into `main` were deleted
(2026-09-29), along with the finished agent worktrees. Every commit they
held is on `main`. `claude/library-tag-views` stays, because it tracks a
GitHub branch.

Two branches are kept on purpose:

- **`claude/variant-grouping`** holds only the superseded variant-grouping
  doc (Section 1). Delete it, or archive it as `archive/variant-grouping`
  like the older branches, rather than merging it.
- **`agent/remove-appimage-release`** has one commit whose change reached
  `main` through pull request #82.

Unmerged work from before March 2026 is archived on GitHub under
`archive/<name>`: the timeline scroll rail, the "All Known" library browsing
and the native Linux decoder. The backup refs (`backup/main-before-squash`,
`backup/pre-filter-20250810`, `backup-pre-prune`) should stay.

## 7. Decisions waiting for the user

From the overnight work on 2026-09-29.

**Re-render safety net (1-5):** withdrawn 2026-10-19 with the in-house
re-render (Section 1c).

**Clip sequences:**

6. **B** adds to the sequence. E, Final Cut's "append", clashes with
   fullscreen's next-clip key.
7. **Numbered copy is all-or-nothing:** any name already taken blocks it,
   where other transfers skip. Make it skip instead?
8. **A clip used twice** is copied twice by the numbered copy, but renaming
   the originals refuses.
9. **Re-encode defaults:**
   - the most common frame size and rate;
   - clips of other sizes letterboxed;
   - silence added where a clip lacks sound;
   - the output named after the sequence.

**Other:**

10. **Changing the sort while scrolled down:** decided 2026-10-19 and done:
    a sort, reshuffle or folder grouping the user picks returns to the top;
    reorders they did not ask for (a rating moving a clip) keep the place.
11. **The detached re-render engine:** withdrawn 2026-10-19 with the
    in-house re-render (Section 1c).
12. **Releasing rc.6:** decided 2026-10-19: not yet. `main` stays local,
    unpushed and untagged, until a build has proved stable in use
    (Sections 4 and 5).

## References

- Generation versions and link transfer:
  [`architecture/generation-versions.md`](architecture/generation-versions.md)
- Scope, matching and the tag-view record contract:
  [`architecture/library-tag-views.md`](architecture/library-tag-views.md)
- Re-rendering from Video Swarm, through companion apps: [`architecture/companion-app.md`](architecture/companion-app.md)
- Transfer bounds and collision policy: [`architecture/review-workflow.md`](architecture/review-workflow.md)
