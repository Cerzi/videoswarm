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
- With it off, the feed endpoints answer 403 `LOCAL_API_FEEDS_OFF`, and `describe`
  says `feeds: false`, so a caller can tell the user where to turn it on.
- A saved view can be left out: each view gets **Share with apps** (on by
  default once the switch is on) in its menu. A view not shared is neither
  listed nor answered.

## 2. Endpoints (protocol 1, additions)

Status: **Proposed**

### `POST /api/v1/views`

`{}` → `{ "views": [{ "id": 12, "name": "Dancing 3★+", "updatedAt": …,
"revision": "…" }], "profile": "p-…", "revision": 1234 }`: every shared
view of the open profile. A view's `revision` changes when its definition
or name changes.

### `POST /api/v1/views/clips`

```json
{ "view": 12, "profile": "p-…", "unless": "f3a9…", "after": null, "limit": 5000 }
```

→

```json
{
  "view": { "id": 12, "name": "Dancing 3★+", "revision": "…" },
  "etag": "f3a9…",
  "unchanged": false,
  "clips": [
    {
      "path": "/abs/clip.mp4",
      "contentId": "v2-…",
      "available": true,
      "rating": 4,
      "review": "pick",
      "tags": [{ "name": "bellydance", "path": ["dance", "bellydance"] }],
      "generationKey": "gk3-…",
      "promptKey": "pk2-…",
      "width": 1280, "height": 720, "durationMs": 5000
    }
  ],
  "total": 8231,
  "next": "c-…",
  "ignored": [],
  "profile": "p-…",
  "revision": 1234
}
```

- **The whole set, in pages.** No cap on the set: every matching clip is
  returned, each content once (the copy seen most recently), in the
  view's sort order, `limit` per page (default and most 5,000). `next` is
  a cursor for the following page, null on the last. `total` is the size of
  the whole set. All pages of one answer belong to one snapshot named by
  `etag`; if the set changes between pages, the next page answers 409
  `LOCAL_API_FEED_CHANGED` and the caller starts again from the first
  page. A caller never sees part of a set as the whole of it.
- **Unchanged.** A caller that sends its last `etag` as `unless` (on the
  first page) gets `{ "unchanged": true }` and no clips when nothing moved
  in or out and no returned field changed.
- **Profile.** `profile` is on every response. A caller that sends the
  `profile` it followed the view under gets 409
  `LOCAL_API_PROFILE_CHANGED` if Video Swarm has since switched profile,
  so a view id is never read under another profile; it then drops its
  `etag` and decides again.
- `path` is absolute and native to this computer, as the catalog holds it,
  so a caller can play the file in place without copying it.
- `available` is false for a clip whose library folder cannot be opened
  now (an unplugged drive, an unreachable share). Such clips stay in the
  set, so a drive coming and going does not churn a project; a caller
  skips them until they are available again.
- `tags` have the same shape as `/clips`: each tag's name and its place in
  the tag tree (`path`), parents first.
- `view` repeats the view's id, name and revision, so a caller can label
  what it follows without a second call.
- `ignored` lists **parts of the view's definition** that cannot be applied
  outside the window (Section 3), such as `"companionFilters"` or
  `"mightBe"`; it never holds clips. The answer is the view as if those
  parts were off, and the caller can say "this view also filters on X,
  which apps can't see".

### Errors

| Situation | Answer |
|-----------|--------|
| Video Swarm closed, or the API switched off | Nothing listens on the port (connection refused). `local-api.json` says `"enabled": false` when it is switched off. |
| Wrong or missing token | 401 `LOCAL_API_UNAUTHORIZED` |
| *Let apps follow saved views* off | 403 `LOCAL_API_FEEDS_OFF` |
| The view exists but is not shared | 403 `LOCAL_API_VIEW_NOT_SHARED` |
| No such view in this profile (deleted) | 404 `LOCAL_API_VIEW_NOT_FOUND` |
| Profile switched since `profile` | 409 `LOCAL_API_PROFILE_CHANGED` |
| Set changed between pages | 409 `LOCAL_API_FEED_CHANGED` |

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
- If Video Swarm is closed, the API or the feed switch is off, or the
  view is not shared, the project keeps its last set and says why. If the
  view is gone (404), it keeps its last set and asks for another view.
- A clip that leaves the view while in use is not cut mid-play; it is
  simply not chosen again (a live set re-plans without it).
- A changed `contentId` at a known path means the file's content changed:
  the caller analyses it again.
- Tests use a fake server; never Video Swarm's database.

## Acceptance

- With the switch off, `views` and `views/clips` answer 403
  `LOCAL_API_FEEDS_OFF`; on, a shared view lists and an unshared one does
  not; each error case in Section 2 answers its own code.
- A set larger than one page comes back whole across pages, and a change
  between pages answers `LOCAL_API_FEED_CHANGED`.
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
