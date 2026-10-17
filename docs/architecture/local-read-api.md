# Local Read API

Status: **Proposed** (2026-10-17). Nothing is built.

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
- **Prompt search**: words in, content ids out, among ids the caller names.
- **Changes**: which clips' tags, rating or review state changed since a
  revision, removals included, so a caller can poll cheaply.

Nothing is written through it. An app that wants to show something *in*
Video Swarm (a "used in a video" chip) does so as a companion.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.
- **Proposed** means designed here and not yet built.

## Principles

- **Off by default, the owner's choice.** Preferences › Local API switches
  it on, shows the address and token, and says which app read last and when.
  Switching it off closes the port.
- **Loopback only.** The server binds `127.0.0.1` (and `::1` if available),
  never `0.0.0.0`. Every request's `Host` must be `127.0.0.1`, `localhost` or
  `[::1]` with the server's port, which defeats DNS rebinding.
- **No browsers.** A request carrying an `Origin` header is refused, no CORS
  header is ever sent, and every request needs `Content-Type:
  application/json` and an `Authorization` header, so a web page cannot get
  a request through even as a "simple" one.
- **A token, compared in constant time.** 256 random bits, made when the API
  is first switched on, shown in Preferences with *Copy* and *Make a new
  token*. Video Swarm also writes `{ port, token }` to a file in its data
  folder readable by the user only (mode 0600), so an app run by the same
  user can find it. The threat this guards against is other users and web
  pages: any program of the same user can already read Video Swarm's files.
- **Read-only.** No endpoint changes tags, ratings, review states, files or
  settings.
- **Prompt text never leaves the main process**, as everywhere else
  (`prompt-search-and-tag-suggestions.md`). Prompt search answers with
  content ids. No prompt text, negative prompt, model or LoRA name is ever
  in a response.
- **Answers only about what was asked.** Lookups answer for the paths or ids
  sent; nothing lists the library, and no response carries a path the
  caller did not send.
- **The active profile.** Answers come from the profile open in Video
  Swarm. Every response names it by an opaque id (a hash, not its name), so
  a caller can tell a switch and start again.
- **Bounded.** Request bodies of at most 1 MiB; at most 5,000 items per
  lookup and 20,000 ids per prompt search; one prompt search at a time; at
  most 60 prompt searches a minute; a 30 s time limit per request. Work
  yields to the event loop like every other catalog read.

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
  `pick` (accepted) or `reject`.
- `promptKey` and `generationKey` are present when known. Clips with one
  `generationKey` are versions of one generation (re-renders, upscales);
  clips with one `promptKey` share a prompt (`generation-versions.md`,
  `prompt-stacks.md`). They are hashes; they do not carry prompt text.

### `POST /api/v1/tags`

`{}` → `{ "tags": [{ "name": "bellydance", "parent": "dance" }], … }`, every
tag in the profile, at most 8 deep.

### `POST /api/v1/prompt-search`

```json
{ "query": "\"golden hour\" -night", "contentIds": ["v2-…"] }
```

`query` uses Filters › Prompt's syntax (word starts, `"exact"` words and
`"phrases"`, `-` to rule out; negative prompts ignored). Answers
`{ "matches": ["v2-…"], "unread": 3 }`: the content ids among those sent
whose positive prompts match, and how many could not be read. Ids not in the
library are ignored. The first search over many clips reads their prompts
and may take a while; later ones are lookups.

### `POST /api/v1/changes`

```json
{ "since": 1200 }
```

→ `{ "revision": 1234, "changed": ["v2-…"], "tagTreeChanged": false,
"reset": false }`: the contents whose tags, rating or review state changed
after revision 1200, removals included, at most 10,000 at a time (call again
from the new revision for more). `tagTreeChanged` says tags were renamed,
moved or removed, so every clip's tag paths may differ. `reset` says the log
no longer reaches back that far, or the profile changed: fetch everything
again. Polling every 30 s while the caller is open is expected.

## Storage

- **A change log**, per profile: `metadata_changes(revision INTEGER PRIMARY
  KEY AUTOINCREMENT, fingerprint TEXT NOT NULL, changed_at INTEGER NOT
  NULL)`, appended in the same transaction as every tag, rating and review
  write (assigning and removing tags, ratings, review states, restoring a
  review snapshot, and re-keying a content), and a tag-tree revision bumped
  by renames, moves and pruned tags. Pruned to the latest 100,000 rows or 90
  days. This is new bookkeeping in hot write paths, so it lands with tests
  per write path and a check that bulk tagging stays fast.
- **Settings**, application-wide rather than per profile: `localApi: {
  enabled, port }`. The token lives only in the 0600 file, never in
  settings.
- Nothing about callers is stored beyond the last reader's `User-Agent` and
  time, in memory, for Preferences.

## What it reveals, honestly

- Tags, ratings and review decisions are the user's private data. The API
  exists to share them with apps the owner chooses; the switch, the token
  and the *last read by* line are how the owner stays in control.
- Prompt search returns no text, but whether a clip's prompt contains a
  word is itself information: a caller asking about one word at a time could
  learn which of the clips it names contain it. The rate limit slows that;
  it cannot prevent it. The owner should switch the API on only for apps
  they trust with that.
- Prompt and generation keys are hashes of whole prompts; recovering a
  prompt from one needs the prompt already.

## Implementation sketch

- `main/local-api/server.js`: a `node:http` server, started and stopped with
  the setting; the header, token and size checks before any handler runs.
- `main/local-api/handlers.js`: pure handlers over the metadata store and
  the prompt service, using the same profile-context checks as IPC
  (`captureMetadataContext`, `assertMetadataContextActive`), so a profile
  switch mid-request answers `PROFILE_CHANGED` rather than mixing profiles.
- `main/database.js`: `getClipsByPaths`, `getClipsByContentIds`,
  `listTagTree`, the change log and `listChangesSince`.
- Preferences › Local API: the switch, the address, the token with *Copy*
  and *Make a new token*, and *Last read by … at …*.
- Tests: handler tests on a temp database; HTTP tests against the server on
  an ephemeral port (refused without a token, with an `Origin`, with a
  foreign `Host`, with a body too large; answers by key; never a path not
  sent); change-log tests for every write path; a smoke spec reading through
  the API from the test process while the real app runs. No test is ever
  pointed at a real caller.

## Phasing

1. `describe`, `clips` and `tags`, with the security checks and Preferences.
2. The change log and `changes`.
3. `prompt-search`.

Each phase is useful alone; a caller can poll `clips` for the clips it has
until phase 2 lands.

## Questions for the owner

1. A fixed default port (so a caller can be configured once) or one chosen
   at random and found through the 0600 file?
2. Is the token file acceptable, or should the token only ever be copied
   from Preferences?
3. Should *pick* and *reject* travel as review states only, or also as a
   simpler `favourite` / `never` the caller does not need to interpret?
4. Is 60 prompt searches a minute right for the caller's planner, which may
   run many searches while it plans an edit?

## Acceptance

- With the API off, nothing listens.
- A request without the token, with an `Origin` header or with a foreign
  `Host` is refused before any handler runs.
- No response contains prompt text, a model or LoRA name, or a path the
  caller did not send.
- A profile switch is visible to the caller and never mixes two profiles in
  one answer.
- `changes` reports a tag removed from a clip.
