# Companion App

Status: **Implemented, unverified by a human** (2026-10-17). Exercised
against a fake companion only.

## Summary

A *companion app* is another program on the same computer that does work on
clips: re-rendering, upscaling, captioning, publishing. Video Swarm is where
the user reviews. The companion decides; Video Swarm shows.

- A profile can connect up to four companions at once (2026-10-17), each
  with its own chips, filters and actions.
- Each card can show a short chip from each companion ("Waiting #3", "Done").
- Filters can hide clips already sent, so the review worklist holds only
  clips still waiting for a decision.
- Clips can be sent to one of the companion's actions, from a selection, the
  context menu or *Process review results*. A dry run shows what would happen
  first.

Video Swarm knows nothing about any particular companion. Every word the user
sees about a companion's work comes from the companion.

The reverse direction, another app reading what Video Swarm knows about
clips, is the proposed local read API (`local-read-api.md`).

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Principles

- **Opt-in, loopback only.** Off by default. The address must be
  `localhost`, `127.0.0.1` or `[::1]`, and a host name must still resolve to
  this computer when used. Video Swarm makes no request beyond this machine.
- **The companion decides, Video Swarm shows.** Nothing a companion answers is
  written to Video Swarm's database. Answers are kept in memory for the
  session.
- **Hand-off by reference.** Sending names files by path; the companion
  decides what to do with them, for example linking them into its own folders.
  Video Swarm never writes into a companion's folders and never moves files
  for it.
- **Untrusted answers.** All traffic is in the main process. Answers are
  size- and time-bounded, reduced to the fields below, and their text is
  shown, never interpreted.
- **Catalog rows, not paths, from the renderer.** The renderer names clips by
  catalog row. Main turns rows into paths, and checks every path in a send is
  one the renderer was shown.

## Protocol v1

All requests are `POST` with `Content-Type: application/json` and a JSON body,
to the configured origin. A companion should refuse other content types and
non-local `Host` headers. Errors are a non-2xx status with
`{"error": "<message for the user>"}`; the message is shown as is, so it
should be short and contain no private paths.

### `POST /api/describe`

Request: `{}`. Response:

```json
{
  "protocol": 1,
  "name": "Example helper",
  "actions": [
    {
      "id": "polish",
      "label": "Polish",
      "send": "Send to polish",
      "hint": "Makes a better copy",
      "quick": true
    }
  ]
}
```

- `protocol` must be `1`.
- `actions`: at most 8. `id` matches `^[a-z][a-z0-9_-]{0,31}$`; `label` (32
  characters at most) names the action in filters and dialogs; `send` (48)
  is the menu item, `Send to <label>` when absent; `hint` (200) is optional.
- `quick` (optional, added 2026-10-19): `true` offers the action as a
  one-click button, labelled with `label`, on the card under the pointer
  and in the fullscreen viewer, whenever the clip's lookup says that action
  is `not-sent`. Anything but
  `true` means no button. Keep labels short for it.
- `withdraw` (optional, added 2026-10-20): `true` when the action's sends
  can be taken back with `/api/withdraw`, which Video Swarm offers as
  *Undo*.
- `targets` (optional, added 2026-10-20): the action sends into a place the
  user picks, such as a project: `{"label": "Project", "new": "New
  project…"}` (32 and 48 characters; without `new`, none can be made).
  `pick` (48) is then the picker's menu item, e.g. `Add to project…`, and
  the one-click item for the companion's current target reads `<send>
  <target label>`, so `send` should read like `Add to`. The targets
  themselves come from `/api/targets`, never from this cached answer.
- *Test connection* in Preferences uses this call and sends nothing else.

### `POST /api/targets` (added 2026-10-20)

Request: `{"action": "add"}`. Response: `{"targets": [{"id", "label",
"detail", "current"}]}`, in display order (recent first), at most 200;
`label` 48 characters, `detail` one line of 120, shown as is; the first
`current: true` is the companion's current target. Asked afresh whenever a
menu or the picker opens, so it should answer in well under 300 ms.

`id` is opaque and may be a folder path: Video Swarm keeps it in its main
process, hands the window a short handle in its place, and never shows or
logs it.

### `POST /api/withdraw` (added 2026-10-20)

Request: `{"action", "paths", "target"?, "client": "videoswarm"}`, at most
500 paths. Only what this client sent can be taken back. Response:
`{"results": {path: {"result": "withdrawn" | "skipped" | "refused", "why"}},
"target"?}`. Video Swarm's *Undo* withdraws exactly the paths a send
answered `sent`, with the same target.

### `POST /api/lookup`

Request: `{"paths": ["/abs/path.mp4", ...]}`, at most 500 paths. Response:

```json
{
  "clips": {
    "/abs/path.mp4": {
      "kind": "render",
      "chip": { "label": "Waiting #3", "tone": "progress" },
      "actions": {
        "polish": { "phase": "under-way", "why": "Third in line", "position": 3 }
      }
    }
  }
}
```

- Results are keyed by the exact path strings sent. Video Swarm may reach a
  file through a symbolically linked folder, so a companion must not re-key
  by resolved path.
- `chip` is `{label, tone}` or null. `label` is shown verbatim (48
  characters at most); `tone` is `progress`, `warning`, `done`, `info` or
  `muted`, and any other tone shows as `info`.
- `actions` holds one *stage* per described action. `phase` is one of:

| Phase       | Meaning                                              |
|-------------|------------------------------------------------------|
| `not-sent`  | Never sent for this action.                          |
| `under-way` | Sent, and may still change on its own.               |
| `done`      | Sent and finished.                                   |
| `stopped`   | Sent, and ended without a result (failed, refused, taken back). |
| `n/a`       | This action does not apply to this clip.             |

  A clip counts as **sent** for an action when its phase is `under-way`,
  `done` or `stopped`. `why` (300 characters at most) is shown in tooltips.
  The companion's own states stay its own: Video Swarm reads only `phase`.
- `kind` is optional and informational (`^[a-z][a-z0-9_/-]{0,31}$`).
- Paths not asked for, stages for undescribed actions and stages without a
  known phase are ignored.

### `POST /api/send`

Request:

```json
{
  "action": "polish",
  "paths": ["/abs/path.mp4"],
  "ratings": { "/abs/path.mp4": 4 },
  "dry_run": true,
  "again": false,
  "client": "videoswarm"
}
```

At most 500 paths. `dry_run` changes nothing and answers what would happen.
`client` (added 2026-10-20) is always `videoswarm`, so a companion can tell
what this app sent. For an action with targets, `target` (added 2026-10-20)
is an id from `/api/targets` or `{"new": "<name>"}` (one line, 80
characters); a companion answers every path `refused` ("Choose a project")
when none is named. The answer then includes `"target": {"id", "label"}`:
for `new`, the target a real send made, whose id Video Swarm uses for the
remaining chunks and for *Undo*. A dry run with `new` makes nothing and
answers as if the target were empty.
`again` asks to send clips that were sent before. `ratings` (optional, added
2026-10-18) maps each rated clip's path, exactly as in `paths`, to its stars,
a whole number from 0 to 5; unrated clips are left out, and so is the field
when none is rated. It goes with every chunk, dry runs included, so a
companion can order what it is sent best first; one that ignores it loses
nothing. A companion may refuse a malformed map with 400. Response:

```json
{
  "results": {
    "/abs/path.mp4": { "result": "sent", "why": "", "estimate": 540 }
  },
  "dry_run": true
}
```

- `result` is `sent`, `skipped` (nothing to do, for example already sent) or
  `refused` (cannot be done). Any other value, or a missing path, shows as
  unrecognised.
- `why` explains a skip or refusal; `estimate` is optional, in seconds.
- Sending may take seconds per batch; Video Swarm sends in chunks and shows
  progress. A later chunk should see an earlier chunk's clips as sent.

### Recognising a clip after it moves

Requests name clips by path, which a move, rename or copy changes. A
companion that wants to keep knowing a clip may compute Video Swarm's own
content fingerprint itself (`main/fingerprint.js`, version 2): SHA-256 over
the first 64 KiB, then the last 64 KiB (the first again when the file is no
larger), then the size in decimal, written `v2-<size in hex>-<digest in hex>`.
It depends on the bytes only, never on the name, folder or file times.

This makes the algorithm part of the protocol.
`main/__tests__/fingerprintContract.test.js` pins its output and writes it
out; changing what goes into it means a new fingerprint version, and
companion authors must be told before it ships.

## Behaviour in Video Swarm

### Implemented

- **Several companions.** A profile keeps a list of up to four, each
  `{ id, enabled, url }`. The id (`c1`…`c4`) is given when one is added and
  kept when its address changes, so filters and saved views that name it
  stay valid. A profile saved with the single connection that came before
  has it as `c1`, and saved filters naming a bare action id are read as
  `c1`'s.
- **Preferences › Companion app**: a list, each with *Connect to this app*,
  address, *Test connection* (names the companion and its actions; sends
  nothing) and *Remove*; *Add a companion app*, then Save. The list is per
  profile and changes only through its own validated IPC, which refuses an
  address listed twice or a fifth app.
- IPC: `companion:connections:get|set`, `companion:connection:test`, and
  `companion:describe`, `companion:lookup` (rows, at most 500) and
  `companion:send` (rows, at most 500, every path authorized), each naming
  the companion by id. Main keeps a client per companion and caches each
  description for a minute.
- Tests run against `main/__tests__/helpers/fakeCompanion.cjs`, with made-up
  clips. No test talks to a real companion.
- **Chips** (`src/app/companion/useCompanion.js`). Each companion has its
  own session. Every clip in the open collection is looked up once, in
  chunks of 500, so filters can judge the whole collection; new clips are
  looked up as they arrive, and so are clips shown from outside it (a
  review pass's or the versions view's guests, 2026-10-20). After that only clips under way are asked again,
  every 4 s while the window is visible, and everything on focus at most
  every 30 s. While a companion is not answering, its last answers stand,
  the status line says so, and Video Swarm tries again every 30 s. A card
  shows one chip per companion with something to say, stacked below the
  review and version pills, each with its label, tone and a tooltip of each
  action's phase and reason (under the companion's name when several are
  connected); the chips stay the same array while they read the same, so a
  card re-renders only when its own chips change.
- **Filters** (Filters › each companion's name): *Hide clips already sent*,
  one switch per companion across its actions (2026-10-20: it was one switch
  for all of them, so adding a clip to one app's project would empty another
  app's worklist; a view saved with the old switch on means the first app),
  and per action any, not sent,
  sent, under way, done, not done or stopped. *Not done* (added 2026-10-18)
  is anything short of done where the action applies: not sent, under way or
  stopped, never "does not apply"; the worklist of what is left to finish.
  Filters are keyed `c1/polish`. A phase filter shows only clips the
  companion has answered for (changed 2026-10-19: unanswered clips used to
  pass, filling a *Done* list with unknowns). A missing clip is never asked
  about, so it never matches; a present clip still waiting is counted in the
  status line, "214 clips not checked yet by <name>". *Hide clips already
  sent* keeps unanswered clips. Saved views keep the filters; a view without
  them is stored exactly as before.

- **Sending** (`src/components/CompanionSendPanel.jsx`). *Send to …* items,
  named by each companion (and followed by its name when several are
  connected), in a clip's context menu act on the whole selection.
  - **One click** (2026-10-19, `sendWithoutReview` in
    `src/app/companion/companionSend.js`): the dry run runs first; when it
    says every clip would be sent, they are, with a toast saying how many
    and the estimate. One clip that would be skipped or refused gets a toast
    with the app's reason instead. Several with any skip or refusal open the
    dialog, so nothing is left out silently.
  - **The dialog** opens on the dry run: how many will be sent, the
    estimate, and skips and refusals grouped by reason. *Send again clips
    sent before* re-runs it with `again`. *Send* sends only what the dry run
    said would be sent, in chunks of 100, with progress and *Stop*; the
    clips are looked up again straight after.
- **One-click card buttons** (2026-10-19). An action described with
  `quick: true` shows as a small button, labelled by the app, on the card
  under the pointer, when the app's lookup says that clip has not been sent
  for it. Clicking sends that clip in one click as above, without selecting
  it; once it is sent the lookup no longer says `not-sent` and the button
  goes. Only a card with buttons tracks the pointer, so hovering across
  the grid re-renders nothing else.
- **In fullscreen** (2026-10-19). The review rail shows each app's chip for
  the clip on screen and the same one-click buttons. A button sends only;
  the first two quick actions across the apps carry their keys, `⇧1` and
  `⇧2`, which accept the clip as well (`review-passes.md`, Quick review
  keys).
- **Process review results** offers each companion's actions for the
  Accepted clips in scope, above moving rejects and copying Accepted clips, with the same
  dry run. The dialog cannot close while a send runs.
- `tests/electron/companion.smoke.spec.cjs` runs the whole path in the real
  app against two fakes at once: connecting both, a chip from each, a
  selection with a skipped clip opening the dialog (the other app is sent
  nothing), a card's one-click button sending without one, refusing a row
  the renderer was never shown, and hiding sent clips.

## Deferred

- A change feed (`/api/changes` with a revision counter), so work done
  outside Video Swarm shows without waiting for focus.
- Keyboard shortcuts for sending.

## Acceptance

- With the companion off, nothing is sent and nothing is shown.
- A clip sent for an action, whatever happened to it since, can be hidden
  from review with one filter.
- No companion-specific word appears in Video Swarm's code or interface text;
  labels come from `describe` and `lookup`.
- Every path a send names is one the renderer was shown.
