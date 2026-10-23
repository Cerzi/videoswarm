# View Feeds

Status: **Proposed** (2026-10-23).

## Summary

Curation happens in Video Swarm: ratings, tags, review decisions, prompt
search and workflow filters, saved as named views. A *view feed* lets
another app on this computer follow a saved view: it lists the views, and
asks for the clips one matches now. A music video project can then be
*assigned a view* ("Dancing 3★+") and always use what that view shows,
including clips rated, tagged or rejected after the project was made. A
live mode that should only use 4★ and 5★ clips follows a view "4★+, not
rejected".

It extends the local read API (`local-read-api.md`): same server, token,
loopback rules and file. It differs in one deliberate way: the read API
answers only about paths the caller sends and never lists the library; a
view feed returns the paths of the clips a view matches. That is listing,
so it has its own switch.

Decided with the user on 2026-10-23:

- **Video Swarm chooses.** The caller names a saved view; it does not send
  filters of its own. Curation stays where it is designed for, and the
  caller needs no copy of Video Swarm's filter logic.
- **One project, one view.** A project follows a view by its id, so
  renaming the view in Video Swarm keeps the link.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.
- **Proposed** means designed here and not yet built.

## 1. The switch

Status: **Proposed**

- Preferences › Local API gains **Let apps follow saved views**, off by
  default and only available while the API is on. Its note says what it
  allows: "Apps you give the token to can list your saved views and the
  files each one matches."
- With it off, the feed endpoints answer 403 `FEEDS_OFF`, and `describe`
  says `feeds: false`, so a caller can tell the user where to turn it on.
- A saved view can be left out: each view gets **Share with apps** (on by
  default once the switch is on) in its menu. A view not shared is neither
  listed nor answered.

## 2. Endpoints (protocol 1, additions)

Status: **Proposed**

### `POST /api/v1/views`

`{}` → `{ "views": [{ "id": 12, "name": "Dancing 3★+", "updatedAt": …,
"revision": "…" }], "profile", "revision" }`: every shared view. `revision`
(per view) changes when the view's definition changes.

### `POST /api/v1/views/clips`

```json
{ "view": 12, "unless": "f3a9…" }
```

→

```json
{
  "view": 12,
  "etag": "f3a9…",
  "unchanged": false,
  "clips": [
    {
      "path": "/abs/clip.mp4",
      "contentId": "v2-…",
      "rating": 4,
      "review": "pick",
      "tags": [{ "name": "bellydance", "path": ["dance", "bellydance"] }],
      "generationKey": "gk3-…",
      "promptKey": "pk2-…",
      "width": 1280, "height": 720, "durationMs": 5000
    }
  ],
  "truncated": false,
  "ignored": [],
  "profile": "p-…",
  "revision": 1234
}
```

- The whole matching set, each content once (the copy seen most
  recently), in the view's sort order. `etag` is a hash of the answer; a
  caller that sends it back as `unless` gets `{ "unchanged": true }` and
  no clips when nothing moved in or out or changed.
- At most 50,000 clips (`truncated` says more matched).
- `ignored` names parts of the view that cannot be applied outside the
  window (Section 3), so the caller can say "this view also filters on X,
  which apps can't see".
- Unknown or unshared view: 404 `VIEW_NOT_FOUND`. A profile switch shows in
  `profile`, as everywhere in the API.

Polling: a follower asks `views/clips` with its `etag` every 30 s, or when
`/changes` reports a change or `/views` a new view revision.

## 3. Applying a view in main

Status: **Proposed**

Today most filters run in the window. A feed needs the same answer the
grid would give, from the main process, without a window:

- **One filter module, two places.** The pure predicates in
  `src/app/filters/filtersUtils.js` (rating, review state, tags with
  All/Any and Exclude, tag hierarchy, size, frame rate, steps, version
  filter) move to a shared CommonJS-compatible module used by both the
  renderer and `main/`, so the two cannot drift. Tests run each predicate
  through both.
- **Prompt search and workflow filters** already run in main
  (`prompts:search`, `workflow:match`); the feed calls them directly.
  Prompt text still never leaves main: matches come back as clips.
- **Scope.** A feed always applies the view to the whole library (every
  indexed root that can be opened), whatever folder the view was saved
  in: a project wants every matching clip, not one folder's.
- **Not applied, listed in `ignored`:** companion filters and companion
  tags (they depend on companion apps answering the window), *Might be*
  (asks the tag suggester per clip; could follow later), and sort keys
  that only exist in the window (random order falls back to newest).
- **Cost.** Bounded like a library tag view: one SQL pass for the indexed
  facts, then the predicates; prompt and workflow parts are cached by query
  and invalidated by the change log, so an unchanged poll costs a hash.

## 4. Privacy

Status: **Proposed**

- Listing is new: with the switch on, a token holder learns the paths of
  every clip a shared view matches. The token already reads every rating
  and tag of a path it knows, and any program of the same user can read
  Video Swarm's files; the switch, *Share with apps* per view and the
  *last read by* line keep the owner in control.
- No prompt text, negative prompt, model or LoRA name is returned; prompt
  and generation keys are hashes, as in the read API.
- View names are the owner's words and are returned (they are how a
  project shows which view it follows).
- Nothing about callers is stored beyond what the read API keeps.

## 5. The caller's side (for companion projects)

Status: **Proposed**

Not built here; written down so both sides agree.

- A project stores the view's `id` (and its name for display).
- On open, and every 30 s while open, it asks `views/clips` with its last
  `etag`; added clips join the project's library (and are analysed in the
  background), removed ones leave it.
- If Video Swarm is closed, the switch is off or the view is gone, the
  project keeps its last set and says why.
- Tests use a fake server; never Video Swarm's database.

## Acceptance

- With the switch off, `views` and `views/clips` answer 403; on, a shared
  view lists and an unshared one does not.
- A view "rating ≥ 4" answers exactly the clips the grid shows for it in a
  library search; rating a clip 5 adds it to the next answer, lowering it to
  3 removes it, and an unchanged poll answers `unchanged`.
- A view with a prompt query answers the same clips as the grid, and no
  prompt text appears in the response or logs.
- A view using a companion filter answers with it listed in `ignored`.
- The shared filter module gives identical results in renderer and main
  tests.

## Implementation order

1. Move the filter predicates into a shared module; renderer unchanged in
   behavior; tests run in both environments.
2. Main-side view evaluation over the library catalog, with prompt and
   workflow parts; unit tests against a temp database.
3. The switch, *Share with apps*, and the two endpoints, with `etag`.
4. Preferences and view-menu UI; a smoke spec with made-up clips and a
   fake caller.
5. Then the caller: a project assigned to a view.
