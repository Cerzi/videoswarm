# ComfyUI Re-queue (Promotion)

Status: **Unimplemented — experimental design only**
Last updated: 2026-08-09

## Summary

Every MP4 ComfyUI writes carries its own API-format prompt in the container:
the whole graph, every widget, the seed. A finished video is therefore
sufficient to re-run itself, with no workflow file and no ComfyUI session. Video
Swarm already reads that payload for the Generation panel, and it is already the
application where these outputs are browsed, so re-running a clip at higher
settings is a natural verb on an object the catalog already models.

This document specifies that feature. Nothing here is built yet.

The prior art is a working standalone CLI (`~/Work/comfy-requeue/requeue.py`)
which has promoted real batches; its hard-won behaviours are cited throughout
and should be treated as evidence rather than as a design to copy verbatim. The
CLI has to guess things an application can simply know, and this design departs
from it wherever that is true.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## What a re-queue is, and what it is not

A promoted clip is **a new generation at the same seed**, not an upscale.
Changing the latent resolution changes composition, so the result can differ in
framing, detail placement, and sometimes subject.

In a CLI this is a `--help` footnote. In Video Swarm the two clips will sit
adjacent in a grid, at similar aspect ratios, with related filenames — a layout
that actively invites the reading "before and after of the same video". The UI
must therefore state the distinction at the point of promotion and must not
label the result with any word implying preservation ("upscale", "enhance",
"higher quality version"). "Re-run at higher settings" is accurate; "promote"
is acceptable shorthand once the distinction has been made.

This is a correctness requirement about user expectation, not copy polish.

## 1. Trust and process boundary

Status: **Unimplemented**

Video Swarm currently has **no outbound network capability at all**: there is no
`http`, `https`, `fetch`, or `WebSocket` use anywhere in the main process, and
the renderer's CSP is `connect-src 'self' videoswarm-media:`, so the renderer
cannot reach a ComfyUI server even if asked to. This feature introduces the
first deliberate opening in that boundary and must not widen it further.

- All ComfyUI traffic lives in the main process behind bounded IPC. The
  renderer sends instance ids and preset ids; it never sends a URL, a graph, or
  a filesystem path, and it never receives a raw graph back.
- The server address is a profile-local setting, defaulting to
  `http://127.0.0.1:8188`. Non-loopback addresses require explicit opt-in and
  are recorded in the settings file like any other bounded value.
- The renderer CSP does not change. `connect-src` stays as it is.
- Responses are parsed with the existing bounded readers. A ComfyUI server is
  not a trusted peer: its `/history` payload is untrusted input and gets the
  same treatment as container metadata already does.

### Acceptance

- No renderer code performs network I/O.
- A non-loopback server address cannot be set without an explicit user action.
- A hostile or malformed `/history` response cannot exhaust memory or crash the
  main process.

## 2. Submission is an expensive outward action

Status: **Unimplemented**

Measured from the CLI's real runs: 20 clips promoted from 0.4/0.8 MP to 1.5 MP
at 25 steps took **6.1 hours** and peaked at **32017 MiB of 32607 MiB** VRAM on
a 5090. A batch submission is not a UI preference change; it commits hours of
someone's GPU.

It is therefore treated like the destructive file operations already in the app:

- An explicit confirmation naming the exact clip count, the target settings and
  the destination, shown before anything is submitted.
- A hard cap on batch size, bounded in the same style as the 2,000-file reject
  limit and the 20,000-media transfer limit.
- No implicit or automatic promotion. Nothing is ever submitted as a side effect
  of browsing, scanning, or selecting.
- The confirmation states that the GPU will be occupied and for roughly how
  long, using the measured per-clip duration when history is available.

### Acceptance

- No code path submits work without a preceding explicit confirmation.
- Batch size is bounded and the bound is reported rather than silently applied.

## 3. Presets keyed by workflow signature

Status: **Unimplemented**

The CLI's brittleness is real and is not fixable by inference. `--set
CLASS.field` assumes a class exists and is unique; resolution lives in
`ResolutionSelector.megapixels` in one workflow and in
`EmptyLatentImage.width/height`, a primitive, or a hardcoded value in others.
Bypass needs a same-typed passthrough. Prefix rewriting assumes SaveVideo-shaped
nodes.

The design does not guess. It introspects and remembers.

- On promotion of a clip whose workflow has not been seen before, enumerate the
  settable widgets the graph actually exposes and ask the user once which knobs
  to change.
- Store that mapping against a **workflow signature** — a stable hash over the
  sorted set of node classes and their counts, not over widget values, so the
  same workflow at different settings signs identically.
- Reuse the preset automatically for every later clip with the same signature.
- Presets are profile-local, listed, editable and deletable, like saved views.

This converts an invisible guess-per-run into a visible one-time setup per
workflow. The brittleness becomes an editable mapping the user owns.

### Acceptance

- Promoting a clip with an unknown signature prompts for a preset and never
  guesses.
- Promoting a clip with a known signature requires no further configuration.
- A preset that no longer matches its graph is reported, not silently applied.

## 4. Graph mutation

Status: **Unimplemented**

Mutations are applied to a parsed copy of the embedded graph. The CLI's observed
semantics are adopted because they match ComfyUI's own:

- **Bypass** removes the node and rewires each output's consumers to whatever
  fed the same-typed input. If an output slot has no same-typed input to pass
  through, the whole node is refused rather than half-rewired. This is not
  hypothetical: a scheduler node taking `PDD_HEADS` and emitting `SIGMAS` has no
  passthrough and cannot be bypassed at all.
- **Bypassing a class that is absent from the graph is a no-op, not an error.**
  Graphs drift between generations, and treating absence as failure split one
  real batch in half for no reason.
- **LoRA filenames are not preflighted as input files.** They resolve through
  model search paths rather than `input/`. Preflighting them rejected six valid
  videos in the CLI before the cause was found.
- **Filename prefixes arrive already resolved** (`H3/2026-08-09/000617`, not
  `%date%` tokens). A destination change therefore swaps the directory and
  preserves the stem, rather than setting the prefix outright.

### Acceptance

- A refused bypass fails the clip with a stated reason and submits nothing.
- An absent bypass class does not affect the batch.
- Mutation never writes to the source file.

## 5. Linking source to result

Status: **Unimplemented**

This is the capability the standalone CLI structurally cannot provide, and the
main reason for building this inside Video Swarm.

The CLI infers the output filename from the mutated prefix. An application
supervising the queue does not have to infer anything: submission returns a
`prompt_id`, and `GET /history/{prompt_id}` reports the **actual** output
filenames. The link is recorded from observed truth at completion:

    (source fingerprint, source instance, prompt_id, output paths, preset,
     submitted_at, completed_at, outcome)

Both directions then resolve exactly, with no filename guessing.

**Fingerprint v2 is what makes this durable.** Content identity no longer
embeds creation time, so a link keyed to content survives the source or the
result being copied or moved — under v1 a copy produced a different identity and
would have broken the relation. Retaining instance rows with a `missing_reason`
rather than deleting them means a link also survives the source being trashed or
moved out of the library. The link is keyed by fingerprint for durable identity
and additionally records the instance for provenance ("where it was when you
promoted it").

A promoted result is genuinely new content with its own fingerprint. The link is
a relation between two content rows; it is not, and must not be modelled as,
two instances of one content.

### Acceptance

- Both directions resolve without inspecting filenames.
- A link survives copying, moving, or trashing either endpoint.
- A result that is never indexed still records its reported output paths.

## 6. Supervision and OOM retry

Status: **Unimplemented**

The CLI's supervisor state machine generalises and should be ported closely.
Only the resolution-lowering step is workflow-specific, and that comes from the
preset.

- **Queue everything first, supervise after.** The batch is submitted in full
  before the watcher starts, so losing the supervisor costs the retries, not the
  run. A one-at-a-time supervisor would make a dropped connection cost the whole
  batch.
- **Only genuine OOM is retried**, matched on `out of memory`,
  `outofmemoryerror`, `allocation on device`, `not enough memory`. A missing
  model, a bad widget and an interrupted run all fail identically at every
  resolution; retrying those smaller burns exactly the hours this feature exists
  to protect. The CLI's matcher was tested against real `/history` shapes
  including an interrupt and an unrelated `AttributeError`, and that test corpus
  should come across too.
- The supervisor is profile-owned and cancellable, and drains on profile change,
  window close and shutdown, following the existing embedded-metadata probe and
  transfer coordinators rather than inventing a new lifecycle.

### Acceptance

- A non-OOM failure is never retried at a lower resolution.
- Losing the supervisor leaves submitted work running and recorded.
- Profile change or shutdown drains supervision without orphaning state.

## Deferred

- **Live progress.** The CLI has a websocket progress client. Polling
  `/history` is sufficient for a first cut and avoids a second connection
  lifecycle; websocket progress is deferred until polling proves inadequate.
- **Promotion presets shared between profiles.** Profile-local only for now.
- **Any inference of which widget means "resolution".** Explicitly rejected;
  see Section 3.
- **Non-ComfyUI backends.** The embedded-payload mechanism is ComfyUI-specific.

## Implementation order

1. Schema and link model, with the workflow-signature preset store.
2. Main-side ComfyUI client: bounded submit and `/history` read, loopback
   default, no renderer exposure.
3. Graph mutation with the Section 4 semantics and a fixture corpus taken from
   real payloads.
4. Preset introspection and the first-run configuration flow.
5. Batch submission with confirmation and bounds.
6. Supervision and OOM retry, porting the CLI's classifier and its test corpus.
7. Link surfacing in the UI, both directions.

## Open questions

- Where does promotion belong in the UI? Selection is the obvious scope, and the
  transfer work established both a context-menu action and a selection-inspector
  button as the pattern for selection-scoped operations.
- Should a promoted result be auto-added to the library if it lands outside any
  indexed root, or reported as unindexed until the user adds it?
- Does the destination follow the recent-destinations list the transfer flow
  already persists, or does ComfyUI's own output directory remain authoritative?

## References

- Prior art: `~/Work/comfy-requeue/requeue.py`, `progress.py` (stdlib only).
- Existing payload parsing: [`embedded-generation-metadata.md`](embedded-generation-metadata.md).
- Content identity and retention:
  [`large-library-performance.md`](large-library-performance.md).
- Bounded native work and confirmation patterns:
  [`review-workflow.md`](review-workflow.md).
