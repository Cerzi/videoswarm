# Outstanding Work

Last updated: 2026-09-28

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

## 1c. Re-rendering inside Video Swarm: Phases 1–2 done, 3–4 open

Status: **Accepted**; Phases 1 and 2 **Implemented** (2026-09-28), Phases 3
and 4 **Unimplemented** — see
[`architecture/comfy-queue-integration.md`](architecture/comfy-queue-integration.md)

Recipes learned from two or more draft/final pairs replace the standalone
app's per-workflow code. The user decided the three open questions: a
loopback-only, opt-in ComfyUI connection; the engine in Video Swarm's main
process with a tray icon while a queue runs; single-pass only for version 1.
Phase 1, the learner, matcher and apply as pure modules
(`main/comfy-recipe.js`), reproduces real Omni and long-form finals from
held-out drafts. Phase 2 adds the connection, checks, queue and runner in the
main process with its IPC, but no interface yet. Next is Phase 3, the
interface (see 5b first), then Phase 4: out-of-memory retries, RAM and time
estimates, two-pass rendering.

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

## 4. Unverified by a human

Everything below ships in `0.6.0-rc.5` and is built and tested, but nobody has
confirmed it feels right. **This is the reason rc.5 exists rather than a stable
`v0.6.0`:** every one of these was exercised by a human for the first time in
the days before the release, and every one of them had a defect that a
1,165-test suite had passed. Treat rc.5 as the first genuine soak of this
feature set.

- **Transfer affordances.** Copy is the filled primary, Move is outlined amber
  until hover, and the layout toggle fills the option actually selected. The
  colouring was reported as inverted twice, so this deserves a look rather than
  an assumption.
- **The clear-filter control.** An × inside the filters button, shown on hover
  and focus only. Discoverability is untested; it may be too hidden at rest.
- **Requiring a tag before a library search.** The scope control is disabled
  until an include tag is selected. Reasonable on a 24k-clip profile, possibly
  annoying on a small one.
- **Library smart views** (after rc.5). A view saved during a library
  search is marked ◇ *Library* in the sidebar and can be applied from the
  home screen. Check the marker is clear and the badge fits narrow sidebars.
- **The review toolbar in a library view** (after rc.5). It used to be hidden
  there; it now shows, with a line explaining there is no resume point. Check
  it reads as helpful rather than as clutter.
- **Generation versions and Link** (after rc.5). Driven headless in the real
  app on copies of real clips, not yet used by a person: whether the badge
  earns its place on every card, whether *Best version* is the right name for
  "no higher-resolution version exists", and whether **Transfer** is findable
  as the new name of the Move/Copy button.

## 5. Smaller known gaps

Fixed on 2026-09-28: the dead `dateModifiedFormatted` field is no longer
built for every scanned record, and lint and Vitest now ignore `.claude/**`,
so running the gate from the repository root no longer walks into agent
worktrees' built bundles.

- **The Playwright CSS spec now covers Link but has not run with it.** The
  transfer-affordance spec needs Playwright's own Chromium, which was not
  installed on the machine that added the Link button; the same checks were
  run inside Electron instead.
- **The Playwright suite is not in the standard gate.** `npm test`,
  `test:electron-abi`, lint, `node --check` and `vite build` are what runs
  routinely. `test:electron-smoke` — which now includes the transfer-affordance
  CSS checks — has to be run deliberately, so a cascade regression would not be
  caught by the usual gate.
- **jsdom cannot verify CSS.** It does not implement specificity. Asked about
  the inverted layout toggle it reported the unselected pill as correctly
  unstyled while a real browser painted it solid green. Any assertion about what
  a control actually looks like belongs in the Playwright suite.
- **`v0.6.0` is not cut yet, deliberately.** rc.5 carries 21 commits of
  user-facing work that was never in any earlier release candidate, including
  the content-identity change. Promote to stable only after rc.5 has been used
  in earnest — see Section 4 for why.

## 5a. Clip sequences are rebased, not finished

Status: **Rebased** (2026-09-28); the feature is **Partially implemented**

The unfinished clip-sequences work (`docs/architecture/clip-sequences.md`,
`SequencePanel`, `main/sequence-view.js`, `useSequences`, `selectionOrder`;
last active 2026-09-01) now sits on **`claude/clip-sequences`**, replayed
onto current `main`. Only the Electron-ABI suite list conflicted. On that
branch the full suite, lint, the build, the Electron-ABI suites (including
the 15 sequence-store and 6 sequence-view tests) and the Electron smoke
specs pass. `wip/clip-sequences` (`02106f2`) is kept unchanged as the
original; it exists on this machine only.

Still to build, per its own doc: writing the order onto disk (Section 5),
exporting (Section 6) and the rest of missing-entry handling (Section 7).
Where the Sequence panel lives is a question for the UX pass (5b), so it
waits for that. Not merged into `main`.

## 5b. Feature bloat: a UX pass, audited

Status: **Decided** (2026-09-28); the redesign is in progress — see
[`architecture/ux-redesign.md`](architecture/ux-redesign.md) and the audit
page, https://claude.ai/artifact/MgNRWMjGDcVKyzJeBStmsu (private to the user)

The audit also found plain bugs, **fixed on 2026-09-28**: the header, review
bar, fullscreen review rail and docked Details header now wrap instead of
clipping (at 1280 px Filters and Keyboard shortcuts had fallen off the
header; the wrapping is the interim form until D6 is decided); a resolution
sort is named and remembered; the Properties stub is gone; file actions use
each platform's words (Show in File Manager / Finder / Explorer, Move to
Trash / Recycle Bin); the transfer picker title fits any selection; the
resolution filter has summary chips; toasts stack instead of overlapping,
and the memory warning moved clear of them and no longer blocks clicks.
The decisions (D1–D10) cover where Details, diagnostics, playback settings,
Donate, review mode, narrow windows, new features and a Preferences dialog
should live, and a naming glossary.

The app has grown a feature at a time (review mode, saved and smart views,
generation versions, the Generation panel, transfers, and now re-rendering),
and each added its own entry points. Do one deliberate UX pass over the
whole app rather than another feature:

- Map how every feature is presented today: menus, toolbar, sidebar tabs,
  context menus, popovers, hotkeys (`src/hotkeys/shortcutCatalog.js`).
- Decide which features are core daily work and keep those one step away;
  move niche ones behind a clear secondary place instead of the main surface.
- Rework the flow between them for the common paths (open a folder, review,
  filter, transfer, re-render), not screen by screen.
- Review the fundamental UI itself (layout, density, typography,
  consistency between panels) for improvements, keeping it a dense working
  tool.

Phase 3 of re-rendering (its Queue and Finished tabs, recipe screen and
badges) should be designed with this pass in mind rather than adding another
top-level surface first.

## 6. Local branches: audited

Status: **Audited** (2026-09-28); the actions below are the user's to take

This section used to say roughly thirty old branches existed only on this
machine. **They do not**: every one of the 28 older unmerged branches is on
GitHub under `archive/<name>`, at exactly the same commit (checked against
the remote-tracking refs from the last fetch, 2026-08-31). Of the 67 local
branches, 36 are fully merged into `main` and 31 are not; of those 31, only
one exists nowhere else.

What is genuinely only on this machine:

- **`main` itself** — 21 commits ahead of `origin/main` at the last fetch:
  generation versions, link transfer, the socket-type Generation reader,
  re-render phases 1 and 2, and the fixes since. **Push `main` before the
  machine change.**
- **`wip/clip-sequences`** and its rebased copy **`claude/clip-sequences`**
  (see 5a).
- Local-only Claude branches (`claude/sad-mclean-f38fe4`,
  `claude/comfy-typeflow-design`, `claude/type-flow-switchover`,
  `claude/recipe-learner`, `claude/comfy-runner`,
  `claude/outstanding-small-fixes`) — all fully merged into `main`, so they
  are safe to delete once `main` is pushed.

Work that never reached `main` but is archived: a custom **timeline scroll
rail** (three iterations, Oct 2025), the March 2026 **“All Known” library
browsing** (superseded by the library index and tag views), and a
**native Linux decoder** its own last commit calls unworkable. The backup
refs (`backup/main-before-squash`, `backup/pre-filter-20250810`,
`backup-pre-prune`) should stay. The full per-branch table is in the audit
page.

## References

- Generation versions and link transfer:
  [`architecture/generation-versions.md`](architecture/generation-versions.md)
- Scope, matching and the tag-view record contract:
  [`architecture/library-tag-views.md`](architecture/library-tag-views.md)
- Why re-queueing stays external: [`architecture/comfy-requeue.md`](architecture/comfy-requeue.md)
- Transfer bounds and collision policy: [`architecture/review-workflow.md`](architecture/review-workflow.md)
