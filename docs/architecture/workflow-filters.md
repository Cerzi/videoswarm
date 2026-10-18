# Workflow Filters

Status: **Implemented, unverified by a human** (2026-10-18).

## Summary

Filters for how a clip was made, beside the existing resolution filter:

- **Frame rate**: at most 16, 24 or 30 fps; at least 24, 30 or 60.
- **Versions › Has a lower-resolution version**: re-renders and upscales of
  a smaller version, whatever made them.
- **Workflow › Steps**: the workflow's largest steps setting, at most 8 or
  12, at least 12, 20 or 30 (few-step distilled runs against full ones).
- **Workflow › Uses / Leaves out**: words matched inside the names of the
  nodes the embedded workflow runs and the weight files it loads (models,
  LoRAs, VAEs, upscalers).

Together these answer "which clips were re-rendered", "which were upscaled",
"hide few-step drafts" or "only clips made with this LoRA" without Video
Swarm knowing any tool that made them.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Not coupled to any tool

Nothing here names a producer, a node type or a model. The words are the
user's, typed into the filter, and saved with smart views like any filter.
State that only another tool knows (queued, sent, finished) belongs to that
tool and reaches the window through the companion app protocol
([`companion-app.md`](companion-app.md)): each connected app's actions are
already filter rows, so "requeued" or "upscaled" by a particular tool is a
filter on that tool's own action, and Video Swarm stays producer-neutral.

## Workflow facts

`deriveWorkflowFacts` (`main/generation-key.js`) reads the ComfyUI API graph
a clip embeds, in the same background read that computes the generation and
prompt keys (`main/generation-key-indexer.js`), so no file is read twice:

- **terms**: every node's `class_type` and the base name (no folder, no
  extension) of every weight file an input names, lower-cased, distinct;
  at most 512 of at most 128 characters.
- **steps**: the largest whole-number input named `steps`, `num_steps`,
  `sampling_steps` or `total_steps`, directly or through one primitive node
  (as seeds are read); null when there is none.
- Never a text input, so never a prompt.

They are stored per content in `media_content` (`workflow_steps`,
`workflow_terms` one term per line, `workflow_facts_version`), because a
draft and its full re-render share their keys but not their steps or LoRAs.
A content is read again whenever its facts are missing or of an older
version; a file without a key is read too, as an upscale-only workflow has
no seed and still has facts. After this change every indexed file is read
once more, in the background, as the collection holding it is opened.

## Matching

- `workflow:match` takes the collection's fingerprints, up to eight words
  to include and eight to leave out, and steps bounds, and answers with the
  matching fingerprints and how many have not been read yet. Terms never
  leave main.
- Every word to include must appear inside some term; no word to leave out
  may. Case does not matter.
- A clip whose workflow has not been read, or has none, never matches while
  a workflow filter is set; the filter says how many are still unread. A
  clip whose timing has not been read never matches a frame rate bound, as
  for resolution.
- The renderer (`useWorkflowSearch`) asks 300 ms after the last change, and
  again as background reading progresses; the previous answer stays until a
  new one arrives, as for prompt search.
- Frame rates compare to the nearest frame (23.976 counts as 24). Library
  views now carry each clip's frame rate and duration as folder views do.

## Verification

- `main/__tests__/generationKey.test.js`: facts from a graph, steps through
  a primitive, no text, no facts without a graph.
- `main/__tests__/generationVersionsDatabase.test.js` (Electron ABI):
  storing and validating facts, matching by words and steps, unread
  counts, every file read once more after the upgrade, the smallest
  version in summaries.
- `main/__tests__/generationKeyIndexer.test.js`: facts written with keys.
- `src/app/hooks/useFilterState.test.js`, `filtersUtils.test.js`,
  `generationVersions.test.js`, `FiltersPopover.test.jsx`,
  `reviewViewDefinition.test.js`, `preloadNativeIpc.test.js`.
- `tests/electron/workflow-filters.smoke.spec.cjs`: the real app reads
  made-up workflows and filters by words left out, words used and steps.

## Acceptance

- Leaving out a word hides every clip whose workflow uses it, and clips
  without a readable workflow; using one keeps only those that do.
- A steps bound separates few-step runs from full ones.
- *Has a lower-resolution version* finds re-renders and upscales across the
  library; saved views keep every new filter.
