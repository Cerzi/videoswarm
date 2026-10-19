# Background Activity

Status: **Implemented, unverified by a human** (2026-10-18).

## Summary

Video Swarm does work in the background whose results people wait for
without seeing it: playback proxies being made, prompts read from clips for
stacks and prompt search, first frames read for stacks, tag suggestions
learned. While it runs, its effects can look like faults (a stack not yet
merged, no suggestions yet, the fans running). The status line under the
top bar says what is running, quietly, and offers a pause.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## What shows

`main/background-activity.js` keeps one entry per kind of work, in this
order:

| Kind | Shown as | Reported by | Paused |
|---|---|---|---|
| `prompts` | Reading clips' workflows | `generation-key-indexer.js`, per job: files read of the job's total | Yes, between files |
| `playback-proxies` | Building playback proxies | `proxy-manager.js`, per proxy queued and finished | Yes, queued proxies wait |
| `stack-frames` | Reading first frames for stacks | `stack-frames.js`, per fingerprint queued and finished | Yes, queued grabs wait |
| `tag-suggestions` | Learning tag suggestions | `tag-suggestions.js`, tags learned of the total | No |

- A kind counts from zero each time it starts after being idle: done and
  total cover the batch under way, so a queue that keeps growing shows how
  much of it is left.
- **Only kinds and counts** leave main: never a path, file name, tag name or
  prompt.
- Snapshots go to the window over `activity:changed` at most twice a second
  (the first change after a quiet spell at once), and `activity:get` reads
  one.
- Not shown: work with its own place in the window (folder scans, copying,
  trash), and small work done for a card
  on screen (poster frames, thumbnails, drag icons, a stack strip's stills,
  frame captures).

## The status line

`src/components/BackgroundActivityStatus.jsx`, at the right end of the
status line in both its short and detailed forms. It owns its updates
(`useBackgroundActivity`), so they never re-render the grid.

- **Idle:** nothing.
- **Running:** a small spinner and the first kind running with what is left
  ("Building playback proxies · 38 left"), and `+N` for other kinds. A kind
  shows once it has run for 1.5 seconds, so a blip never flickers in.
- **Paused:** a pause mark and "Background work paused", shown even with
  nothing waiting, so the way to resume is always there.
- **Panel:** clicking it lists each kind with its count and a thin bar, and
  holds the Pause / Resume button. Escape or a click elsewhere closes it.

## Pause

`activity:set-paused` holds pausable work until resumed or the app restarts
(it is not saved: a forgotten pause must not leave features waiting for
good).

- Queued proxies and stack fingerprints stay queued: the shared process
  runner (`child-process-runner.js`) starts nothing marked to hold while
  paused, and a process already running finishes. Cached proxies are still
  played.
- The prompt reader waits before its next file; cancelling it (a profile
  change, the window closing) wakes it at once.
- Work someone is waiting for on screen still runs: a stack strip's stills
  (`holdWhilePaused: false`), and tag learning, which a suggestion or *Might
  be* request is waiting for.
- Playback, folder scans and anything else the user does are unaffected.

## Verification

- `main/__tests__/backgroundActivity.test.js`: adding up, order, counts only,
  starting again from zero, publish rate, pause and resume.
- `main/__tests__/childProcessRunner.test.js`: queued work held while paused,
  running work finishing, cancelling held work, work that does not hold.
- `main/__tests__/generationKeyIndexer.test.js`: progress, waiting while
  paused, a paused job cancelled at once.
- `main/__tests__/tagSuggestions.test.js`: learning reported, not held.
- `main/__tests__/preloadNativeIpc.test.js`: the bridge sends plain values.
- `src/components/BackgroundActivityStatus.test.jsx`: idle, the summary, the
  panel, pausing and resuming, the show delay.
- `tests/electron/background-activity.smoke.spec.cjs`: a pause reaches main,
  shows in the real status line, and is resumed from the panel.

## Acceptance

- Background work that runs for more than a moment shows in one quiet line;
  idle shows nothing.
- Pause holds proxies, prompt reading and stack fingerprints without
  stopping playback or anything the user asks for, and Resume picks up where
  they left off.
