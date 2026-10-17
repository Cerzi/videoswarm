# Companion App

Status: **Partly implemented** (2026-10-17). Connection, client, IPC and
Preferences are in place; card chips, filters and sending are not yet.

## Summary

A *companion app* is another program on the same computer that does work on
clips: re-rendering, upscaling, captioning, publishing. Video Swarm is where
the user reviews. The companion decides; Video Swarm shows.

- Each card can show a short chip from the companion ("Waiting #3", "Done").
- Filters can hide clips already sent, so the review worklist holds only
  clips still waiting for a decision.
- Clips can be sent to one of the companion's actions, from a selection, the
  context menu or *Process review results*. A dry run shows what would happen
  first.

Video Swarm knows nothing about any particular companion. Every word the user
sees about a companion's work comes from the companion.

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
    { "id": "polish", "label": "Polish", "send": "Send to polish", "hint": "Makes a better copy" }
  ]
}
```

- `protocol` must be `1`.
- `actions`: at most 8. `id` matches `^[a-z][a-z0-9_-]{0,31}$`; `label` (32
  characters at most) names the action in filters and dialogs; `send` (48)
  is the menu item, `Send to <label>` when absent; `hint` (200) is optional.
- *Test connection* in Preferences uses this call and sends nothing else.

### `POST /api/lookup`

Request: `{"paths": ["/abs/path.mp4", ...]}`, at most 2000 paths. Response:

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
{ "action": "polish", "paths": ["/abs/path.mp4"], "dry_run": true, "again": false }
```

At most 500 paths. `dry_run` changes nothing and answers what would happen.
`again` asks to send clips that were sent before. Response:

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

## Behaviour in Video Swarm

### Implemented

- **Preferences › Companion app**: connect, address, *Test connection*
  (names the companion and its actions; sends nothing), Save. The setting is
  per profile and changes only through its own validated IPC.
- IPC: `companion:connection:get|set|test`, `companion:describe`,
  `companion:lookup` (rows, at most 2000), `companion:send` (rows, at most
  500, every path authorized). Main caches the description for a minute.
- Tests run against `main/__tests__/helpers/fakeCompanion.cjs`, with made-up
  clips. No test talks to a real companion.

### Unimplemented

- **Chips.** Lookups cover the whole open collection, so filters can judge
  every clip, in chunks of up to 2000, on folder open, on focus and after a
  send; then only clips whose phase is `under-way` are asked again, every few
  seconds. Cards receive the chip's label and tone as primitives.
- **Filters**, per action: any, not sent, under way, done, stopped, n/a; and
  *Hide clips already sent* across all actions. Savable in saved views. While
  the companion is not answering, the last answer of the session stands and
  the status line says so.
- **Sending.** *Send to …* items from the description, for a selection and
  the context menu: a dry run gives a dialog (how many will be sent, the
  estimate, skips and refusals grouped by reason), then the send, in chunks,
  with progress.
- **Process review results** offers sending Accepted clips to an action,
  above copying or moving them.

## Acceptance

- With the companion off, nothing is sent and nothing is shown.
- A clip sent for an action, whatever happened to it since, can be hidden
  from review with one filter.
- No companion-specific word appears in Video Swarm's code or interface text;
  labels come from `describe` and `lookup`.
- Every path a send names is one the renderer was shown.
