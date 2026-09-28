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

Status: **Unimplemented**

This is item 4 of the implementation order in `library-tag-views.md` and the one
piece of that feature that was never built. The document's opening section
promises it, so the doc currently reads as though it exists.

`saved_views` stores an opaque `definition_json` and `useSavedViews` passes a
`definition` straight through with no scope axis. A saved view is therefore
still only a recipe evaluated against whichever root is open, so a saved
`#keeper` view cannot mean "every keeper in the profile".

Default to folder scope when adding it, so every existing saved view keeps
meaning exactly what it meant before.

## 3. Continue Review does not explain itself in a library view

Status: **Unimplemented**

`library-tag-views.md` Section 3 is marked Implemented and claims the control
"states why rather than silently doing nothing". It does not. There is no
wiring between `tagCollection` and the review-resume affordance.

Review checkpoints are keyed by `root_id`, so a rootless collection genuinely
has no checkpoint to resume — the behavior is correct, only the explanation is
missing. **Correct the Section 3 bullet or implement it; do not leave both.**

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
- **Generation versions and Link** (after rc.5). Driven headless in the real
  app on copies of real clips, not yet used by a person: whether the badge
  earns its place on every card, whether *Best version* is the right name for
  "no higher-resolution version exists", and whether **Transfer** is findable
  as the new name of the Move/Copy button.

## 5. Smaller known gaps

- **`dateModifiedFormatted` is dead payload.** Generated per record in
  `main.js` and read by nothing. Its sibling `dateCreatedFormatted` caused a
  real bug by being parsed back into a `Date`; this one is merely wasted bytes
  on every scanned record.
- **The Playwright CSS spec now covers Link but has not run with it.** The
  transfer-affordance spec needs Playwright's own Chromium, which was not
  installed on the machine that added the Link button; the same checks were
  run inside Electron instead.
- **The Playwright suite is not in the standard gate.** `npm test`,
  `test:electron-abi`, lint, `node --check` and `vite build` are what runs
  routinely. `test:electron-smoke` — which now includes the transfer-affordance
  CSS checks — has to be run deliberately, so a cascade regression would not be
  caught by the usual gate.
- **Lint and test globs reach into `.claude/worktrees/`.** Worktrees live
  inside the repository, so running `npx eslint .` from the root lints every
  worktree's built `dist-react` bundle and fails with thousands of errors in
  minified vendor code. Run the gate from inside a worktree, or scope the paths
  (`npx eslint src main main.js preload.js scripts tests`). Nothing is actually
  wrong when this happens.
- **jsdom cannot verify CSS.** It does not implement specificity. Asked about
  the inverted layout toggle it reported the unselected pill as correctly
  unstyled while a real browser painted it solid green. Any assertion about what
  a control actually looks like belongs in the Playwright suite.
- **`v0.6.0` is not cut yet, deliberately.** rc.5 carries 21 commits of
  user-facing work that was never in any earlier release candidate, including
  the content-identity change. Promote to stable only after rc.5 has been used
  in earnest — see Section 4 for why.

## 5a. Clip sequences are parked on a branch

The unfinished clip-sequences work (`docs/architecture/clip-sequences.md`,
`SequencePanel`, `main/sequence-view.js`, `useSequences`, `selectionOrder`;
last active 2026-09-01) was moved unchanged out of the main checkout onto
`wip/clip-sequences` (`02106f2`) so `main` could fast-forward. It touches
`main.js`, `main/database.js`, `preload.js`, `src/App.jsx` and
`src/library/folderViewState.js`, all of which have moved since, so **rebase
it onto `main` before continuing it.**

## 5b. Feature bloat: a UX pass once re-rendering lands

Status: **Unimplemented** — requested by the user on 2026-09-28, to start
once the re-render work (1c) is finished

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

## 6. Local branches that were not pushed

Roughly thirty local branches under `codex/*`, `feature/*` and various
experiments (`v2`, `masonic`, `temp`, `python_webserver_refactor`,
`linux-native-decoder`) date from 2025 and early 2026. Their remote branches
were deleted — the ordinary post-merge cleanup — and their tips are not
reachable from `origin/main`, which is what a squash-merge looks like from the
branch side.

They were left alone deliberately: pushing them would recreate refs the
repository already cleaned up. **This has not been verified commit by commit.**
If any of that work matters, check it before the old machine is gone, because
these branches exist nowhere else.

The backup refs (`backup/main-before-squash`, `backup/pre-filter-20250810`,
`backup-pre-prune`) are pre-rewrite snapshots and should stay local.

## References

- Generation versions and link transfer:
  [`architecture/generation-versions.md`](architecture/generation-versions.md)
- Scope, matching and the tag-view record contract:
  [`architecture/library-tag-views.md`](architecture/library-tag-views.md)
- Why re-queueing stays external: [`architecture/comfy-requeue.md`](architecture/comfy-requeue.md)
- Transfer bounds and collision policy: [`architecture/review-workflow.md`](architecture/review-workflow.md)
