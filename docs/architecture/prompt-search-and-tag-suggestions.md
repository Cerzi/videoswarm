# Prompt Search and Tag Suggestions

Status: **Section 1 implemented, unverified by a human; Section 2 proposed**
(2026-10-17)

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
  the prompt's words: `danc` finds *dance* and *dancing*. Every word must
  appear; a word starting with `-` must not. Word order and phrases are not
  matched (word sets keep no order).
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

Status: **Proposed**

- **Learning.** For each tag with enough examples (say 10), compare how often
  each prompt word, LoRA and model appears on clips with the tag against
  clips without it (a naive Bayes or logistic score over word sets). This
  needs no model and retrains in milliseconds when tags change.
- **Suggesting.** For an untagged clip, the tags whose score passes a
  threshold, strongest first, never more than three.
- **Interface.**
  - In Details, suggested tags show as outlined chips beside the clip's tags:
    a click applies one, a cross dismisses it, and a dismissal is remembered
    so it is not offered again.
  - A per-tag review queue: *clips that might be "dance"*, most likely first,
    reviewed with the keyboard like review mode. This is the efficient path
    for a large library.
- **Rules**, alongside learning: "prompt contains X", "uses LoRA Y" or "is in
  folder Z" means tag T, applied as suggestions or, if the user says so,
  automatically on indexing.
- **Storage.** Dismissals are stored per clip content and tag; scores are not
  stored.

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

- Phrase and fuzzy matching in prompt search.
- Searching WebM and MKV prompts in-process.
