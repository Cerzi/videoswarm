# Variant Grouping

Status: **Unimplemented — accepted specification**
Last updated: 2026-08-10

## Summary

Re-rendering a generated clip at different settings produces a new file with new
bytes. Content identity correctly treats it as new content, yet it depicts the
same shot. Grouping those together is a distinct axis from deduplication, and
this specifies it.

A **variant key** is derived from what a clip *depicts*. Clips sharing a key are
the same shot rendered differently, and the grid can group them for comparison.

Nothing here is built. The design was agreed with the `comfy-requeue` session,
which validated the approach on ~90 real files and will not build a browsing UI
of its own; VideoSwarm owns this.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Why this is not deduplication

Fingerprint v2 is content-addressed: byte-identical files already collapse into
one content row sharing tags, rating and review state, and review already
auto-advances past duplicate content. **"Duplicate" therefore already means
something narrower, and this feature must not reuse the word.** The term is
**variant**.

The two axes are orthogonal, which is exactly why this earns its place. Two
renders of one shot have different bytes, so content identity correctly refuses
to merge them — and they are still the same shot.

## 1. What the key is built from

Status: **Unimplemented**

The key is built from the **normalized generation fields the parser already
produces**, not from raw graph inputs matched by name.

That distinction is the whole design. The originating tool matched
`slot_filenames` and `duration_seconds`, which are facts about one workflow
rather than about ComfyUI. `main/comfy-generation-parser.js` already returns
`prompt`, `negativePrompt`, `seed`, `sourceImages` and `sourceInputs`, with the
per-workflow adapters having done that extraction already, and reports an
unrecognised producer as partial rather than guessing. Duration comes from
`media_content.duration_ms`, read from the container itself, needing no graph
parsing at all.

Included — what the shot depicts:

- Seed
- Positive and negative prompt text
- Reference/source inputs
- Duration

Excluded — axes you vary while rendering the same shot:

- Resolution, steps, sampler, scheduler, CFG
- Whether a cache or upscaler node ran
- **Model and LoRA filenames.** Swapping a checkpoint gives a different render
  of the same shot, not a different shot. This one is easy to include by
  accident precisely because it arrives alongside the content fields and reads
  like content.

### Acceptance

- Two renders of one shot at different resolutions share a key.
- Two renders differing only by checkpoint share a key.
- Distinct shots do not share a key.

## 2. Failing safe

Status: **Unimplemented**

The two error directions are not symmetric, so the design is deliberately
lopsided.

Over-grouping merges two different shots and is **invisible** — nobody notices
until they compare the wrong pair and draw a wrong conclusion. Under-grouping
merely fails to group, which is visible and harmless.

Therefore **an unrecognised field defaults to included**. Keeping distinct
things apart is the safe direction to be wrong in. Exclusions are deliberate,
enumerated decisions, never a default.

A clip the parser reports as partial gets no key at all rather than a key
derived from whatever happened to parse.

### Acceptance

- An unrecognised content field prevents grouping rather than forcing it.
- A partial parse yields no variant key.

## 3. Do not hash the graph

Status: **Unimplemented**

Hashing the API-format prompt is the obvious implementation and it does not
work. Bypassing a node **deletes** it from the prompt, so a source and its
cache-free re-render have literally different node sets and would never group —
which is precisely the pair the feature exists to group.

Identity is content fields only. This is recorded because it is a trap that
already cost the originating tool time.

## 4. Storage

Status: **Unimplemented**

Grouping should be a query rather than a per-render computation, so the key is
computed when generation metadata is extracted and stored alongside it.
`instance_generation_metadata` already exists to carry it. This is an additive
schema change in the usual style.

## Validation fixture

The originating tool validated on ~90 real files: each source grouped with its
own re-render despite a deleted node and a 0.4 → 1.3 MP change, 40 distinct
shots stayed in 40 distinct groups, and it surfaced a genuine same-shot pair the
user did not know about.

That pair is worth keeping as a real-world fixture — same seed, same 11
references, same text, same 12 s duration, rendered ten minutes apart, and
crucially **different bytes**, so it is the exact case content identity will not
catch:

    /data/AI/ComfyUI/data/work/output/requeue/2026-08-09/queued/
      212459
      223205

Any committed fixture must be reduced to preserve graph topology without
carrying user prompts, paths, model names or hashes, as the existing embedded
metadata fixtures already are.

## Deferred

- **A comparison workspace** for playing grouped variants side by side. Already
  tracked separately as an existing roadmap item.
- **Non-ComfyUI producers.** The mechanism depends on embedded generation
  metadata.

## References

- Normalized field extraction:
  [`embedded-generation-metadata.md`](embedded-generation-metadata.md).
- Content identity and why this is a separate axis:
  [`large-library-performance.md`](large-library-performance.md).
- Why re-queueing itself stays external: [`comfy-requeue.md`](comfy-requeue.md).
