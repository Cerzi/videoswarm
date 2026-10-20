# Review Passes

Status: **Implemented, unverified by a human** (2026-10-19).

## Summary

Review works on what you are looking at. *Review these N* in the review bar
(or `Shift+R`) freezes the clips the grid shows, or the selection when two
or more clips are selected, into a **review pass**: a fixed list in the
order shown, reviewed with the usual keys, counted on its own, and kept so
it can be resumed after leaving it or restarting.

Decided with the user on 2026-10-19:

- **Starting:** a new control in the review bar, beside the existing review
  mode switch, which is unchanged.
- **Memory:** one active pass, plus up to ten listed in the sidebar to
  resume. The per-folder Continue Review checkpoint is unchanged.
- **Keys:** `Shift+1` / `Shift+2` accept the selection and send it to the
  first or second companion quick action
  ([`companion-app.md`](companion-app.md)), so judging and dispatching is one
  motion.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## The pass

- **Frozen.** The list is the clips shown when it started, a collapsed stack
  standing for all of its runs, each content once, in on-screen order. It
  does not change while it is reviewed: a clip that stops matching the
  filter it came from (accepted under *Unreviewed*, sent under a
  companion's *Not done*) stays where it is, so acting on a clip never pulls
  it away.
- **Shown like an open stack**, over the grid it came from, with a bar:
  the pass's name and "12 of 40 decided", *Exit pass*, and at the end, for
  a pass started from a search, *Run the search again*, which applies that
  search's filters, sort and scope (a smart view's definition), now showing
  what has started matching since.
- **Progress counts the pass.** The review bar's counts, auto-advance,
  targets and undo are the pass's; entering or leaving a pass starts a new
  undo history.
- **Clips from folders that are not open** (a library search) are guests,
  as in the versions view (`generation-versions.md`, Section 8): selectable,
  reviewed, rated, tagged and acted on, their roots granted. Companion apps
  are asked about them too, so they show chips and one-click buttons.
- **Done** once every clip has a decision: Accepted, Reviewed or Rejected (a
  rating counts as reviewed, as everywhere). A done pass is marked finished
  and leaves the sidebar list.
- Another folder, scope or collection closes the pass; it stays listed.

## Storage

`review_passes` and `review_pass_clips` in the profile database
(`main/database.js`): the name, where it came from (`results` with its view
definition and location, or `selection`), the clips by content fingerprint
and catalog row in order, and the cursor (the position of the clip last
selected, saved 0.8 s after the selection moves).

- At most 50,000 clips per pass, as many as a library view holds; each
  content once.
- Ten passes kept; finished ones go first, then the oldest.
- Opening a pass returns each position's clip as a playable record: the
  instance it was made from while present, otherwise the copy seen most
  recently. Clips gone from the library, or in roots that cannot be opened,
  are left out.
- IPC: `review-passes:create`, `:list`, `:open`, `:cursor`, `:finish`,
  `:delete`; preload `window.electronAPI.reviewPasses`.

## Quick review keys

`Shift+1` / `Shift+2`, by physical key: the selected clips are sent to the
first or second action marked `quick` across the connected companion apps,
in their order (a one-click send: dry run, then send, a dialog only for
skips and refusals), and accepted. With *Advance after marking* on, the next
clip is selected. With no such action, a toast says so and nothing changes.

In fullscreen (2026-10-19) the same keys act on the clip on screen: it is
sent, then accepted as the rail's *Accept* does, advancing when *Advance
after marking* is on. A single clip's skip or refusal is a toast, so no
dialog opens behind the viewer. Fullscreen's shortcut guide lists them;
`Shift+R` stays a grid key.

## Verification

- `main/__tests__/reviewPassesDatabase.test.js` (Electron ABI): order and
  one instance per content, decided counts, cursor, gone and unavailable
  clips, finishing, the ten-pass limit, the 50,000 cap.
- `src/hooks/selection/useHotkeys.test.js`: `Shift+R`, `Shift+1/2` by
  physical key, nothing without a selection.
- `src/components/ReviewPassBar.test.jsx`, `main/__tests__/preloadNativeIpc.test.js`.
- `src/App.test.jsx`: `Shift+1` accepts and sends to the first quick action,
  in the grid and in fullscreen (by physical key, whatever it prints).
- `src/components/fullscreen/FullscreenReviewPanels.test.jsx`: the rail's
  chips and one-click buttons, their keys, one send per click.
- `tests/electron/review-pass.smoke.spec.cjs`: the real app freezes a
  selection, counts a decision, leaves it, resumes it from the sidebar,
  finishes it, and starts a pass over everything shown with `Shift+R`.

## Deferred

- Renaming a pass; passes named from a smart view's name.
- Resuming the last pass automatically at startup.
- Re-running a folder pass's search in another folder than the open one.
