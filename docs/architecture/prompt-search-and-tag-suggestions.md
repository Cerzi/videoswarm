# Prompt Search and Tag Suggestions

Status: **Sections 1 and 2 implemented, unverified by a human** (2026-10-17)

## Summary

Libraries of tens of thousands of clips need better ways in than folders and
hand-applied tags. Video Swarm already reads every clip's embedded ComfyUI
prompt (for prompt stacks and versions), so two cheap features need no AI:

1. **Prompt search**: find clips by the words in their prompts, in the open
   collection or across the whole library.
2. **Tag suggestions**: suggest tags the user already uses, learned from the
   clips they have tagged, for clips they have not.

Later phases (Section 3) add a Video Swarm node for ComfyUI and visual search,
both building on these.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Principles

- **Prompt text stays in the main process**, in memory, as numbered word sets
  (the same store as similar-prompt stacks). The renderer sends a query and
  prompt keys and receives prompt keys. Nothing derived from prompt text is
  written to disk.
- **The user's vocabulary only.** Suggestions never invent tags; they offer
  tags the user already uses, and nothing is applied without the user.
- **No network, no models.** Both features are plain word matching and
  counting on data already read.

## 1. Prompt search

Status: **Implemented, unverified by a human** (2026-10-17)

- **Where.** *Filters › Prompt*: a text field. It narrows the open collection
  like any filter, and with *Entire library* it narrows the library search
  itself, alone or with tags and a rating.
- **Matching.** Words are matched case-insensitively against the starts of
  the prompt's words: `danc` finds *dance* and *dancing*. A word in quotes
  matches only itself: `"pan"` finds *pan* but not *panda*. Several words in
  quotes are a phrase: `"golden hour"` finds those whole words next to each
  other in that order, within one positive text. Every term must appear; a
  term starting with `-` (`-night`, `-"golden hour"`) must not. A quote still
  being typed already counts.
- **How.** Each prompt is kept twice in memory: as a set of word numbers,
  which answers word terms and rules most prompts out, and as each positive
  text's word numbers in order, which a phrase is then looked for in. The
  ordered copy costs about 4 bytes a word (roughly 12 MB at the 20,000-prompt
  cache cap).
- **Negative prompts are ignored.** A text counts as negative when its node
  feeds a sampler's `negative` input and not its `positive` one, so searching
  `blurry` does not find every clip with a stock negative prompt. A text that
  reaches both (a negative made by zeroing the positive) counts as positive.
- **What is read.** One present MP4 or MOV per prompt key, verified against
  the key, as for similar prompts. The first search over a collection reads
  its prompts once per session; later searches are word lookups. WebM and MKV
  clips, whose prompts need ffprobe, are not searched.
- **Saved views** keep the query; a view searching the library re-runs it.
- **While prompt keys are still being read** after a folder opens, clips
  without one cannot match, so a search typed straight away fills in as
  keys arrive. The previous answer stays on screen until the next arrives.
- **Verification.** Unit tests cover parsing, word-start matching, exclusion,
  negative detection (including a negative made by zeroing the positive),
  the library constraint and the IPC surface;
  `tests/electron/prompt-search.smoke.spec.cjs` searches made-up prompts in
  the real app.

### Acceptance

- A word in a clip's positive prompt finds it; a word only in its negative
  prompt does not.
- `-word` excludes; several words narrow.
- A library search by prompt words alone returns matching clips from every
  root.
- No prompt text reaches the renderer, storage or logs.

## 2. Tag suggestions

Status: **Implemented, unverified by a human** (2026-10-17); rules deferred

Suggests tags the user already uses for clips that do not carry them, from
what the prompts of clips they did tag have in common
(`main/tag-suggestions.js`).

- **What a clip is described by.** The words of its positive prompts (as
  search reads them) and the weight files its graph loads: checkpoints,
  diffusion models, LoRAs, VAEs and text encoders, by file name. A prompt key
  is read from one of its clips, so a prompt run on several models counts
  with the models of one of them.
- **Examples.** A prompt, not a clip, is one example, so a batch of twenty
  clips from one prompt cannot outvote everything else. A prompt is an
  example of a tag when one of its clips carries the tag or a tag under it,
  and an example against it when one of its clips carries other tags and
  none of these, or turned the suggestion down. Clips with no tags say
  nothing, since the user may not have got to them, and a clip tagged only
  "dance" says nothing about "bellydance". Only present clips with a current
  prompt key count.
- **Learning.** Naive Bayes over the example prompts' features, for each tag
  on at least ten prompts with at least ten tagged prompts against it. A
  feature carries weight only when it is on at least two of those prompts
  and a one-sided Fisher exact test says chance would lean it that far at
  most once in a thousand times. Libraries hold tens of thousands of words;
  most that sit on a few tagged prompts do so by chance, and naive Bayes
  would trust each of them.
- **Checking.** Each tag is learned five times, each time without a fifth
  of the prompts (by prompt key), and scored on the fifth held back. The
  score a suggestion needs is the lowest at which held-back suggestions were
  still right at least 8 times in 10 (with at least three right), halfway to
  the next lower held-back score. A tag that never gets there is never
  suggested: tags about quality, such as "keeper", cannot be told from a
  prompt, and Filters lists them as such.
- **Suggesting.** For each clip, the tags whose score passes that it does
  not already count under and has not turned down, strongest first (by how
  far past the bar), at most three; of a tag and one under it, only the one
  under it.
- **When.** Learning runs on demand (Details, Filters, a library search)
  and again whenever the tags, turned-down suggestions or prompt numbering
  change; reading prompts the first time is the slow part, and counting
  afterwards takes milliseconds per tag (about 15 ms for a tag over 3,000
  prompts, yielding between tags). Nothing learned is stored.
- **Interface.**
  - Details shows *Suggested from the prompt*: outlined chips for the
    selected clips the tag fits (with a count when several are selected).
    A click applies the tag to those clips, a cross turns it down for them.
    The tooltip says how often the tag's suggestions were right on clips
    the user tagged.
  - *Filters › Might be* picks a tag and shows the clips it is suggested
    for, not tagged with it or anything under it and not turned down, in
    the open collection or, with *Entire library*, across the library.
    Right-click offers *Tag as "dance"* and *Not "dance"* for the selection;
    either way the clips leave the filter at once. Saved views and
    back/forward keep the tag.
- **Storage.** `tag_suggestion_dismissals` (content, tag, time) records
  what was turned down; it follows a content re-keyed from a v1 identity and
  goes with its tag. Scores and models are memory only.
- **Privacy.** Prompts and weight-file names stay in the main process as
  numbered features. The renderer sends catalog rows, fingerprints and tag
  names, and receives tag names, rows and precision.
- **Verification.** `main/__tests__/tagSuggestions.test.js` covers examples,
  the hierarchy, learning, the significance test, held-back checking,
  false suggestions on unseen prompts, LoRA features and the service;
  `tagSuggestionsDatabase.test.js` covers storage and the library search;
  renderer tests cover the chips, the filter and the menu; and
  `tests/electron/tag-suggestions.smoke.spec.cjs` tags made-up clips in the
  real app, takes a suggestion in Details, finds the other clip with
  *Might be* and turns it down.

### Acceptance

- With ten or more tagged prompts per tag, an untagged clip whose prompt
  fits is offered the tag; one whose prompt does not, is not.
- A tag that cannot be told from prompts is never suggested.
- A turned-down suggestion is not offered again for that clip.
- No prompt text or weight-file name reaches the renderer, storage or logs.

### Deferred

- **Rules**: "prompt contains X", "uses LoRA Y" or "is in folder Z" means
  tag T, as suggestions or applied on indexing.
- Keyboard keys for *Tag as* and *Not* while *Might be* is on, and sorting
  that filter most likely first.
- Undoing a turned-down suggestion other than by applying the tag.

## 3. Later phases

- **A Video Swarm node for ComfyUI.** A small annotate node whose inputs are
  read from the embedded prompt graph, or written into the file's metadata at
  render time when they come from another node: tags (with autocomplete from
  a tag vocabulary file Video Swarm exports), a batch id and run index (exact
  stacks), lineage (this render is the upscale of that clip), sweep axes
  (show a sweep as a grid by parameter) and notes.
- **Visual search** through a companion app (`companion-app.md`): image–text
  embeddings of a few frames per clip, for describing a clip in words, *more
  like this*, visual tag suggestions trained on the user's tags, and
  clustering into virtual groups. A separate, searchable layer: never tags.
- **Captions on request** from a vision–language model for a selection or a
  folder, through the same companion.

## Deferred

- Fuzzy matching in prompt search.
- Searching WebM and MKV prompts in-process.
