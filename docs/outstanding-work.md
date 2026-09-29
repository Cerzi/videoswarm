# Outstanding Work

Last updated: 2026-09-29

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
H3 draft now shows *Embedded · Partial* with its model, VAE, sampler and
scheduler.

What this does **not** fix, and is still open: the positive prompt and seed
of MiniMax H3 graphs stay unresolved, because the prompt lives in a
`MiniMaxH3Ref2VAComposer` and the seed arrives through `RandomNoise`, neither
of which has an adapter; and the V2V hybrid graph reports `OUTPUT_NOT_FOUND`
because its custom save node is not a recognized output. Those are resolver
coverage gaps, not parsing failures.

Both are fixed since the Generation panel switched to the socket-type reader
([`architecture/generation-type-flow.md`](architecture/generation-type-flow.md),
2026-09-28): on 2,950 tagged clips it finds a prompt and a seed in 99% of
them and lost nothing the previous parser found. A MiniMax prompt is still
shown as its composer's fields (candidate fragments, Partial), because the
composer builds the final text at run time.

## 1c. Re-rendering inside Video Swarm: engine safety built, interface open

Status: **Accepted**; Phases 1 and 2 **Implemented** (2026-09-28); the
"never silently wrong" safety net **Implemented** (2026-09-29); the interface
(Phase 3), two-pass rendering (Phase 4) and the detached engine
**Unimplemented** — see
[`architecture/comfy-queue-integration.md`](architecture/comfy-queue-integration.md)

- **Phases 1 and 2.** The recipe learner, matcher and apply are pure modules
  (`main/comfy-recipe.js`) and reproduce real Omni and long-form finals from
  held-out drafts. The connection, checks, queue and runner run in the main
  process with their IPC. Decided by the user: a loopback-only, opt-in
  ComfyUI connection, a tray icon while a queue runs, single-pass only for
  version 1.
- **Safety net (Section 10).** `main/comfy-safety.js` walks downstream from
  every input a recipe changes and holds the clip when the change reaches an
  unknown node carrying literal data. That is how the V2V hybrid's SAM3
  clicks are caught. It also flags save nodes other than `SaveVideo`, nodes
  that write files, continuation runs and missing inputs. Each clip is sorted
  into *declared*, *known* or *review*. The runner never sends a held clip;
  `comfy:queue:confirm` records a person's confirmation of a hold that can be
  confirmed.
- **Waiting for the user:** five questions about how strict the net is
  (Section 7 below), and the go-ahead for the detached engine (Section 9 of
  the architecture doc).
- **Next:** the interface: Queue and Finished panels on the sidebar's
  activity rail, the recipe screen, "Queue with recipe…" and badges. Then
  Phase 4: out-of-memory retries, RAM and time estimates, two-pass rendering.
  Both may land in the detached engine rather than the main process.

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
  ComfyUI connection. Try switching and creating a profile.
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

## 6. Local branches and pushes

Status: **Tidied** (2026-09-29); the push is the user's to do

**Not pushed yet.** `main`, `claude/clip-sequences` and
`wip/clip-sequences` exist only on this machine; `main` is dozens of commits
ahead of `origin/main`. Pushing is the user's step:

    git -C /home/cerzi/Work/clip_browser_html push origin main claude/clip-sequences wip/clip-sequences

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

**Re-render safety net** (`comfy-queue-integration.md` Section 10):

1. **"Anything downstream unknown" is read narrowly:** unknown *and*
   carrying literal data. Read literally, every Omni and long-form clip
   would be held, because custom nodes sit downstream of every change.
2. **The changed node's own other inputs are trusted** to the example pairs,
   because every pair shows that node before and after. Keep this, or
   tighten it?
3. **Should a dependency hold be confirmable?** For V2V, confirming means
   rendering with the draft's clicks. The alternative is refusing until an
   adapter exists.
4. **Confirmation is a separate call** (`comfy:queue:confirm`), not a rule
   choice, because choices define what counts as the same render and apply
   to a whole batch.
5. **Known gaps:**
   - Scalars that are not named as geometry (a frame index, a time) are not
     caught.
   - Declared quality mode cannot be seen in API-only or subgraph workflows.
   - Only absolute paths are checked.
   - V2V still needs its own adapter to actually re-render.

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

10. **Changing the sort while scrolled down** still keeps the top card in
    view, wherever it moves to. Should a new sort always return to the top?
11. **The detached re-render engine** (Section 9) waits for the go-ahead.
12. **Releasing rc.6:** see Section 5.

## References

- Generation versions and link transfer:
  [`architecture/generation-versions.md`](architecture/generation-versions.md)
- Scope, matching and the tag-view record contract:
  [`architecture/library-tag-views.md`](architecture/library-tag-views.md)
- Why re-queueing stays external: [`architecture/comfy-requeue.md`](architecture/comfy-requeue.md)
- Transfer bounds and collision policy: [`architecture/review-workflow.md`](architecture/review-workflow.md)
