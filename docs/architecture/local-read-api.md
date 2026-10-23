# Local Read API

Status: **Phases 1 and 2 implemented, unverified by a human** (2026-10-17):
`describe`, `clips`, `tags` and `changes`. Prompt search is deferred: the
owner chose to let the first caller read embedded prompts itself.

## Summary

Other apps on the same computer want what Video Swarm knows about clips: an
editor that cuts videos from a library of clips would like the user's tags,
ratings and review decisions, and would like to search the clips' prompts.
Today the only way in is reading Video Swarm's SQLite database, whose schema
is internal and changes, and whose profiles are separate files.

The *local read API* is an opt-in HTTP server in Video Swarm's main process,
on loopback only, guarded by a token, that answers questions about clips and
changes nothing. It is the reverse of the companion protocol
(`companion-app.md`): there Video Swarm asks another app about clips; here
another app asks Video Swarm.

- **Lookup**: for paths or content ids, a clip's tags (with where each sits
  in the tag tree), rating, review state and generation keys.
- **Tag tree**: every tag and its parent.
- **Changes**: which clips' tags, rating or review state changed since a
  revision, removals included, so a caller can poll cheaply.

Following a saved view (the clips one matches, paths included) is designed
separately behind its own switch: `view-feeds.md` (Proposed).

Nothing is written through it. An app that wants to show something *in*
Video Swarm (a "used in a video" chip) does so as a companion.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.
- **Proposed** means designed here and not yet built.

## Principles

- **Off by default, the owner's choice.** Preferences › Local API switches
  it on, sets the port (default **47821**, any from 1024 to 65535), shows the
  token (hidden until asked, with *Copy* and *Make a new token*), says where
  the file is and which app read last and when. Switching it off closes the
  port; a port another program holds is reported there.
- **Loopback only.** The server binds `127.0.0.1` (and `::1` if available),
  never `0.0.0.0`. Every request's `Host` must be `127.0.0.1`, `localhost` or
  `[::1]` with the server's port, which defeats DNS rebinding.
- **No browsers.** A request carrying an `Origin` header is refused, no CORS
  header is ever sent, and every request needs `Content-Type:
  application/json` and an `Authorization` header, so a web page cannot get
  a request through even as a "simple" one.
- **A token, compared in constant time.** 256 random bits, made when the API
  is first switched on and kept until *Make a new token*.
- **One file, at a stable place.** `local-api.json` in Video Swarm's data
  folder, beside `profiles/`, the same for every profile: on Linux
  `~/.config/video-swarm/local-api.json`, on Windows
  `%APPDATA%\video-swarm\local-api.json`, on macOS
  `~/Library/Application Support/video-swarm/local-api.json`. It moves only
  if the user moves the data folder (Preferences › Data location). It holds
  `{ "version": 1, "enabled", "port", "token" }`, is written atomically and
  is readable by the user only (mode 0600). A caller reads the port and token
  from it. The threat the token guards against is other users and web pages:
  any program of the same user can already read Video Swarm's files.
- **Read-only.** No endpoint changes tags, ratings, review states, files or
  settings.
- **Prompt text never leaves the main process**, as everywhere else
  (`prompt-search-and-tag-suggestions.md`). No prompt text, negative prompt,
  model or LoRA name is ever in a response; only the prompt and generation
  keys, which are hashes.
- **Answers only about what was asked.** Lookups answer for the paths or ids
  sent; nothing lists the library, and no response carries a path the
  caller did not send.
- **The active profile.** Answers come from the profile open in Video
  Swarm. Every response names it by an opaque id (a hash, not its name), so
  a caller can tell a switch and start again.
- **Bounded.** Request bodies of at most 1 MiB (refused with 413); at most
  5,000 paths and ids per lookup; four requests at once (503 beyond); a
  30 s time limit per request.

## Endpoints (protocol 1)

All are `POST` with a JSON body, under `/api/v1/`. Errors are
`{ "error": { "code": "...", "message": "..." } }` with a 4xx or 5xx status.
Every successful response carries `profile` (opaque id) and `revision` (see
*Changes*).

### `POST /api/v1/describe`

`{}` → `{ "protocol": 1, "app": "Video Swarm", "version": "0.6.0", "profile":
"p-…", "revision": 1234, "limits": { … } }`.

### `POST /api/v1/clips`

```json
{ "paths": ["/abs/clip.mp4"], "contentIds": ["v2-1f4a-…"] }
```

At most 5,000 together. Answers by the key asked:

```json
{
  "clips": {
    "/abs/clip.mp4": {
      "contentId": "v2-1f4a-…",
      "tags": [{ "name": "bellydance", "path": ["dance", "bellydance"] }],
      "rating": 4,
      "review": "pick",
      "hasPrompt": true,
      "promptKey": "pk2-…",
      "generationKey": "gk3-…"
    },
    "v2-1f4a-…": { "…": "…" }
  },
  "profile": "p-…",
  "revision": 1234
}
```

- A path counts only when it is a present file in an indexed folder; any
  other path answers `null`, whether or not it exists on disk, so the API
  cannot be used to probe the file system.
- `contentId` is Video Swarm's v2 content identity: `v2-<size in hex>-<sha256
  of the first 64 KiB, the last 64 KiB (the first again when the file is 64
  KiB or less) and the size as decimal text>`. A caller can compute it, so it
  matches clips across moves and copies without sending paths.
- `rating` is 1 to 5, or `null`; `review` is `unreviewed`, `reviewed`,
  `pick` (accepted) or `reject`. Review states travel as they are; what a
  caller makes of them (a favourite, "never use") is its own business.
- `hasPrompt` is `true` or `false` once the clip's embedded metadata has been
  read, and `null` before.
- Content ids are `v2-…`; an entry not rescanned since the v1 upgrade may
  still be `v1-…` until it is.
- A file in two indexed roots (a folder indexed inside another) is one
  path and answers once.
- `promptKey` and `generationKey` are present when known. Clips with one
  `generationKey` are versions of one generation (re-renders, upscales);
  clips with one `promptKey` share a prompt (`generation-versions.md`,
  `prompt-stacks.md`). They are hashes; they do not carry prompt text.

### `POST /api/v1/tags`

`{}` → `{ "tags": [{ "name": "bellydance", "parent": "dance" }], … }`, every
tag in the profile, at most 8 deep.

### `POST /api/v1/changes`

```json
{ "since": 1200 }
```

→ `{ "revision": 1234, "changed": ["v2-…"], "tagTreeChanged": false,
"reset": false, "more": false }`: the contents whose tags, rating or review
state changed after revision 1200, removals included, at most 10,000 log
entries at a time; with `more`, call again from the `revision` returned. `tagTreeChanged` says tags were renamed,
moved or removed, so every clip's tag paths may differ. `reset` says the log
no longer reaches back that far, or the profile changed: fetch everything
again. Polling every 30 s while the caller is open is expected.

## Storage

- **A change log**, per profile: `metadata_changes(revision INTEGER PRIMARY
  KEY AUTOINCREMENT, fingerprint TEXT, kind 'clip' | 'tags', changed_at)`,
  appended in the same transaction as every write: assigning and removing
  tags, ratings, review states, restoring a review snapshot, re-keying a
  content (both sides), and the tag tree (a new tag, a move, a pruned tag).
  Pruned to the latest 100,000 rows or 90 days. Revisions come from
  `sqlite_sequence`, so they never repeat, even after pruning.
- **An index** on `file_instances(absolute_path)` for lookups by path.
- **The setting** is the file above, application-wide, not per profile.
- Nothing about callers is stored beyond the last reader's `User-Agent` and
  time, in memory, for Preferences.

## What it reveals, honestly

- Tags, ratings and review decisions are the user's private data. The API
  exists to share them with apps the owner chooses; the switch, the token
  and the *last read by* line are how the owner stays in control.
- Prompt and generation keys are hashes of whole prompts; recovering a
  prompt from one needs the prompt already.

## Implementation

- `main/local-api/server.js`: a `node:http` server on `127.0.0.1`, started
  and stopped with the setting; the Origin, Host, method, token, type and
  size checks run in that order before any handler, and an unexpected
  failure answers 500 without its message.
- `main/local-api/handlers.js`: the endpoints, over the active profile's
  store through the same profile-context checks as IPC, so a profile switch
  mid-request answers 503 rather than mixing profiles.
- `main/local-api/config.js`, `service.js`: the file and the running server.
- `main/database.js`: `getLocalApiClips`, `getMetadataRevision`,
  `listMetadataChangesSince` and the change-log writes.
- Preferences › Local API.
- Tests: `main/__tests__/localApiServer.test.js` (every refusal against a
  real server on an ephemeral port, handlers, the 0600 file, the service);
  `localApiDatabase.test.js` (lookups, a gone file, the log across write
  paths, reset); `tests/electron/local-api.smoke.spec.cjs` reads through the
  API from the test process while the real app runs, the way another app
  would. No test is ever pointed at a real caller.

## Decisions (2026-10-17, the owner)

1. A fixed default port, changeable in Preferences, plus the file.
2. The file is acceptable; callers read the port and token from it.
3. Review states only.
4. No prompt search for now (deferred below).

## Deferred

- `POST /api/v1/prompt-search`: words in, content ids out, among ids the
  caller names, never text. Whether a clip's prompt contains a word is
  itself information, so it would come with a rate limit.

## Acceptance

- With the API off, nothing listens.
- A request without the token, with an `Origin` header or with a foreign
  `Host` is refused before any handler runs.
- No response contains prompt text, a model or LoRA name, or a path the
  caller did not send.
- A profile switch is visible to the caller and never mixes two profiles in
  one answer.
- `changes` reports a tag removed from a clip.
