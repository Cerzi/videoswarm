# Rating Arena

Status: **Implemented** (designed and built 2026-10-23); Sections 8 and 9
are deferred.

## Summary

The arena asks for ratings a few clips at a time, side by side, so each
judgement has context. It draws clips from the whole library by default, so
clips nobody has looked at in months come back to the surface. A rating is
easier and steadier next to clips already rated than on its own: a 4★ from
last month and a 4★ today mean the same thing when both were given against
the same kind of company.

Decided with the user on 2026-10-23:

- **Pool:** the whole library by default, to resurface forgotten clips;
  *These clips* (what the grid shows) as the other choice.
- **Confidence:** a clip that keeps its rating in a round has held once.
  Holding is weak evidence, since the company may have been easy: it only
  steers which clips are picked, decays, and never locks or shows as a
  score.
- **Review decisions:** with review mode on, the usual keys work on the
  selected clip and the cards show their state; there are no buttons, so
  ratings stay the focus.
- **Later, a bonus mode:** duels between 5★ clips, picking the better of
  two, to rank the best clips (Section 8).

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## 1. Rounds

Status: **Implemented**

A round is two to four clips shown together with one question.

- **Place.** One unrated clip, *New*, beside one clip each from the low,
  middle and top of the scale (1★, 3★ and 5★; the nearest rating when one
  is empty). Rating the new clip ends the round. With fewer than two rated
  clips in the pool, a **first round** shows three unrated clips to rate
  instead.
- **Tier check.** Three or four clips with the same rating: change any
  that do not belong. *Next* ends the round; every clip left as it was has
  held.
- **Border.** Two clips from each of two neighbouring ratings, such as 4★
  and 5★: move any that sit on the wrong side. *Next* ends it as a tier
  check does. A hold here counts double, since the clip faced the rating
  next to its own.
- **Mixed** (the default) deals Place three times in five while the pool
  has unrated clips, and tier checks and borders otherwise. The bar can
  pin one kind, and a border to one pair (say 4/5).
- **No repeats.** A clip shown in the last 20 rounds of the session is not
  shown again, unless the pool is too small for anything else.

## 2. Choosing clips

Status: **Implemented**

- **Pool.** *Library*: every present clip in roots that can be opened,
  each content once (the copy seen most recently), except rejected ones,
  and of a generation's versions only the best (the order the Versions
  list uses: largest, then longest, then newest; decided with the user on
  2026-10-23), since the others are re-renders of the same clip.
  *These clips*: the clips the grid shows when the arena opens, at most
  50,000, as a review pass takes them. The pool is fixed when the arena
  opens; ratings and review states are read again for every round, so
  changes made anywhere count.
- **Similar prompts** (the default; *Any* is the other choice). A round's
  companions are picked to resemble its first clip: the same prompt key
  first, then the most alike prompts among a bounded sample of the tier
  (at most 200 prompts per round, read and compared in main), then any.
  Clips compared on the same subject are judged on how well they were
  made, not on what they show.
- **Who comes back.** Tier checks and borders favour clips held least and
  checked longest ago, never-checked first, so old ratings resurface.
  Place's reference clips favour clips that have held more, picked at
  random from the better half so the same few do not repeat.
- **Holding decays.** A clip's holds since its rating last changed count
  1 each (2 in a border), halving every 60 days. One clip in five is
  picked ignoring holds altogether, so nothing settles for good.
- **Ready at once.** Main prepares the next round while the current one is
  shown, and hands it out only if it still fits: its clips unrejected, *New*
  still unrated, the others at the ratings they were dealt with, and a
  first round only while there is still too little rated for Place.

## 3. The view

Status: **Implemented**

Built like the versions view (`generation-versions.md`, Section 8): its own
view over the grid, with the grid's cards, playback, selection, Details and
menus.

- **Layout:** one row, as large as fits the window, every clip at the same
  height. A masonry wall would give each clip the same width, so portrait
  clips would come out several times larger than landscape ones, and the
  larger clip tends to look better in a comparison.
- **Order and labels:** Place shows *New* first, then its reference clips
  from low to high; the others go by rating. Each card's pill names its
  part: *New*, *3★*, and *4★ → 5★* once changed in the round.
- **Selection:** a round opens with its first clip selected; ← and → move
  between its clips; a click selects as in the grid.
- **Guests:** clips from folders that are not open are guests, as in the
  versions view and review passes: rated, tagged, reviewed, and asked
  about by companion apps; their roots are granted.
- **The bar:** *Arena*, the round kind (*Mixed*, *Place*, *Tier check*,
  *Border*), the pool (*Library*, *These N clips*), matching (*Similar
  prompts*, *Any*), "Round 7 · 213 unrated left", the session's counts
  (placed, moved, held, tagged) and a streak of rounds finished without
  skipping, *Play together from the start*, and *Back*.
- **Leaving:** `Esc` or *Back* returns to the grid, and a toast sums up the
  session. Another folder, scope or collection closes the arena too. A
  round changed and left, or brought back by Undo, is recorded on leaving;
  an untouched one is not.
- **Entry:** the *Arena* button in the top bar, beside *Review*. Inside the
  arena the versions pill, stacks (`G`), folder keys (`[` `]`) and review
  passes (`Shift+R`, *Review these*) are off.

## 4. Keys

Status: **Implemented**

Listed in `src/hotkeys/shortcutCatalog.js` under the arena.

| Key | In the arena |
|-----|--------------|
| `1`–`5` | Rate the selected clip. In Place, rating *New* ends the round after a short beat, so the change is seen. |
| `0` | Clear the selected clip's rating. |
| `←` `→` | Select the previous or next clip of the round. |
| `Enter` | Next round. In Place this skips *New*, which stays unrated. |
| `Z` | Undo the last change, with review mode on or off; if it ended the previous round, that round comes back as it was dealt. |
| `Q` `W` `E` | Apply the first, second or third suggested tag to *New*. |
| `T` | Type a tag for the selected clip. |
| `A` `S` `X` `U` | Review mode only: Accept, Reviewed, Reject, Unreviewed. |
| `Esc` | Leave the arena. |

Elsewhere `Enter` opens a clip and `Backspace` trashes the selection;
neither does that in the arena (`Backspace` does nothing there).

## 5. Review decisions and tags

Status: **Implemented**

- **Decisions.** With review mode on, `A`, `S`, `X` and `U` set the
  selected clip's review state, and its card shows it as in the grid. In
  Place, rejecting *New* ends the round and the clip leaves the pool.
  *Advance after marking* does not apply: the arena moves on by rounds.
  With review mode off, these keys do nothing, as in the grid.
- **Tags.** For *New*, up to three suggested tags show under the bar, from
  the tag suggestions (`prompt-search-and-tag-suggestions.md`, Section 2),
  each with its key; a click applies it and its cross turns it down, as in
  Details. `T` opens a box to type any tag, with the library's tags
  offered as you type. Suggestions only come for tags already used on ten
  or more prompts, so a new library may show none.

## 6. Storage and privacy

Status: **Implemented**

- **`arena_checks`** in the profile database: one row per clip per round
  finished (content fingerprint, time, round kind, outcome — placed, held,
  raised, lowered, skipped — and the rating before and after). Holds and
  last-checked times are derived from it. At most 200,000 rows, oldest
  first to go; rows follow a re-keyed content and go with a content that
  leaves the library.
- **Nothing else is stored.** The pool, the session's counts and recent
  rounds are memory only; ratings, tags and review states are written
  through the usual paths, so Undo, Details and the local read API see
  them as any other change.
- **Privacy.** Prompts stay in main: the renderer receives playable
  records and round roles, never prompt text, and similarity is computed
  in main from the prompt reader's numbered words.

## 7. IPC

Status: **Implemented**

- `arena:start` `{ scope: "library" | "clips", instanceIds? }` builds the
  pool and returns `{ session, counts }` (unrated, and clips per rating).
- `arena:round` `{ session, kind, border?, match }` returns
  `{ round: { id, kind, clips: [{ instanceId, role, rating }] }, records,
  counts }`: each clip's part (*new*, *reference*, *check*) and the rating
  it was dealt with, by catalog row, and playable records in a tag view's
  shape; `round` is null with a `reason` when the pool has nothing for the
  kind. Roots are granted as a versions view grants them.
- `arena:finish` `{ session, round }` records the round's rows from the
  ratings and review states as they stand in the database, replacing rows
  written when the same round was finished before, and returns the
  outcome counts. The renderer waits for its own review writes first.
- `arena:end` `{ session }` lets the pool go.
- Preload: `window.electronAPI.arena`.

## 8. Later: a Versions round

Status: **Deferred**; proposed to the user on 2026-10-23.

The same view for one generation's versions, two to four side by side
(the largest first), asking whether the best really is the best: rate
each, and the best rated becomes *Best*. Today *Best* means the largest,
so this needs the user's word on whether a rating may overrule size, and
where a chosen best is kept.

## 9. Later: ranking duels

Status: **Deferred** until the arena has been used.

A bonus mode for the very best: two 5★ clips side by side, `←` or `→` for
the better one, `Enter` when too close to call. Each result updates a
hidden score per clip (Bradley–Terry, refitted after each duel), and pairs
are chosen where the scores are closest and least known, so a top-twenty
ranking settles in a few dozen duels. The ranking would show as a sort,
*Best first*, among 5★ clips.

## Acceptance

- From any folder, opening the arena shows a Place round of clips from
  across the library, playing in one row; rating *New* with `3` moves on
  to the next round, and the clip's rating shows in the grid and Details.
- A tier check finished with `Enter` records a hold for each unchanged
  clip; changing one with `1`–`5` records it as raised or lowered.
- `Z` after a round ended brings that round back with the rating undone.
- With review mode on, `X` on *New* rejects it and moves on; with it off,
  `X` does nothing.
- Suggested tags apply with `Q`, `W` and `E`.
- No prompt text reaches the renderer, storage or logs.

## Where it lives

- Main: `main/rating-arena.js` (dealing, sessions, outcomes),
  `main/database.js` (`arena_checks`, pool and records), the `arena:*`
  handlers in `main.js`, and `alikeScores` in `main/prompt-similarity.js`.
- Renderer: `src/app/arena/arenaView.js` (pure: labels, order, keys,
  counts), `src/app/arena/useRatingArena.js` (the session), the wiring in
  `src/App.jsx`, and `src/components/ArenaBar.jsx`.
- Tests: `main/__tests__/ratingArena*.test.js`, `src/app/arena/*.test.js`,
  the arena test in `src/App.test.jsx`, and
  `tests/electron/rating-arena.smoke.spec.cjs`.

## Implementation order

1. Storage, pool and round picking in main (`main/rating-arena.js`), with
   the prompt similarity ranking; unit tests.
2. IPC and preload.
3. The view: state, layout, labels, bar, keys, guests; renderer tests.
4. Review keys and tags in rounds.
5. A smoke spec in the real app with made-up clips.
