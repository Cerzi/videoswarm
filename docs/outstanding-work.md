# Outstanding Work

Last updated: 2026-08-12

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

## 1. Variant grouping is specified and unbuilt

Status: **Unimplemented**

`docs/architecture/variant-grouping.md` is an accepted specification with
nothing behind it. It groups re-renders of the same shot, which content identity
correctly refuses to merge because their bytes differ.

The design was agreed with the `comfy-requeue` session and validated there on
~90 real files. Read the doc's Section 3 before starting: hashing the API-format
prompt is the obvious implementation and it does not work, because bypassing a
node deletes it from the prompt.

**Branch caveat.** `claude/variant-grouping` is based on a pre-rebase tip, so it
points at commits no longer in `main`'s history. Its only content is the design
doc, which is also on `main`. Rebase it or delete it and start fresh; do not
merge it as-is.

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

## 5. Smaller known gaps

- **`dateModifiedFormatted` is dead payload.** Generated per record in
  `main.js` and read by nothing. Its sibling `dateCreatedFormatted` caused a
  real bug by being parsed back into a `Date`; this one is merely wasted bytes
  on every scanned record.
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

- Accepted but unbuilt spec: [`architecture/variant-grouping.md`](architecture/variant-grouping.md)
- Scope, matching and the tag-view record contract:
  [`architecture/library-tag-views.md`](architecture/library-tag-views.md)
- Why re-queueing stays external: [`architecture/comfy-requeue.md`](architecture/comfy-requeue.md)
- Transfer bounds and collision policy: [`architecture/review-workflow.md`](architecture/review-workflow.md)
