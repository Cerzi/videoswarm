# Generation Metadata by Socket Type

Status: **Implemented and Verified — the socket-type reader is the Generation
panel's reader** (2026-09-28). Render-size ordering of generation versions
(Section 6) remains Unimplemented.
Last updated: 2026-09-28

## Summary

The Generation panel reads a ComfyUI render's checkpoint, LoRAs, prompt, seed
and sampling settings by tracing the embedded API graph from the output node
back to the sampler. `main/comfy-generation-parser.js` does that with
**allow-lists of node classes**: five sampler classes (`SAMPLER_TYPES`),
per-class maps of which input carries conditioning or a model
(`UNARY_CONDITIONING_INPUT`, `MODEL_PASSTHROUGH_INPUT`), three decode classes,
and so on. A node that is not on a list stops the trace.

That is why the panel is unreliable. No list keeps up with custom nodes, and a
single wrapper, switch or composer anywhere on the path loses everything behind
it. On the user's library, MiniMax H3 graphs yield no prompt or seed (the prompt
lives in a composer, the seed arrives through `RandomNoise`), and the V2V hybrid
yields nothing at all (its custom save node is not a recognised output).

This document replaces the allow-lists with **socket types**. ComfyUI's
embedded UI `workflow` records the type of every input and output socket, and
every link carries its type too. Types are shared by every custom node:
`MODEL`, `CLIP`, `VAE`, `CONDITIONING`, `LATENT`, `IMAGE`, `GUIDER`, `SIGMAS`,
`NOISE`, `INT`, `FLOAT`, `STRING`, and `*` for switches that pass anything
through. Roles are defined by what a node consumes and produces, not by its
name.

This is a living design record in the style of
[`embedded-generation-metadata.md`](embedded-generation-metadata.md), whose
goals, non-goals, bounds and evidence levels it keeps. A section is marked
**Implemented** only after its focused acceptance tests pass, and **Verified**
only after the repository gates also pass.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Verified** means the repository-wide gates also passed on that change.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Goals

- Read checkpoint, LoRAs, prompt, seed, steps, CFG, sampler and scheduler from
  graphs built from custom nodes that no one has written an adapter for.
- Keep the panel's evidence levels: a value is **direct** (one literal on a
  proven path), **graph-derived** (resolved through links, switches or
  primitives), or **unresolved** (reported, never guessed).
- Make reliability **measurable**: a coverage harness over a real corpus
  reports how often each field is found, before and after any change.
- Give generation versions a better ordering signal than output pixels.

## Non-goals

Inherited unchanged from `embedded-generation-metadata.md`: no execution of
workflow code, no raw graphs in SQLite or renderer state, lazy and bounded
work, no network access and no ComfyUI installation required. Also:

- **No class allow-lists** in the new reader. Conventional *input names*
  (`model`, `positive`, `seed`) are used, because ComfyUI itself standardises
  them; class names are not.
- **No reconstruction of composed prompts.** A composer that builds its prompt
  from several text fields yields those fields as fragments, as today. The
  reader never concatenates them with guessed punctuation.
- Generation versions keep their own graph-free key
  ([`generation-versions.md`](generation-versions.md)). Nothing here feeds
  grouping.

## Evidence: the prototype

`prototypes/typeflow.py` (74 lines, stdlib) is the proof of concept. With no
node lists at all, on 2026-09-28 it read, from real renders in the user's
library:

| Render | Checkpoint | LoRAs | Prompt | Seed | Steps |
|---|---|---|---|---|---|
| H3 hybrid (`HybridNative_Ref2VA`) | yes | 3, incl. the turbo LoRA | yes | 123 | 8 |
| H3 long-form | yes | 2, incl. turbo | yes | 123 and the noise seed | 8 |
| V2V hybrid | yes | 1 | yes | 123 | 8 |
| LTX outpaint | — | — | — | — | — |
| VR180 | — | — | — | — | — |
| AnimateDiff masking (seedless) | — | — | — | — | — |

The shipped parser, on the same H3 and V2V renders, returns no prompt and no
seed, and nothing at all for the V2V hybrid.

The misses are exactly the two cases below that the prototype does not handle:
**subgraphs** (LTX outpaint) and **no UI workflow** (VR180 saves through VHS,
which embeds only `prompt`). The AnimateDiff graph genuinely has no sampler.

The prototype also shows two faults the design must fix:

- Its sampler test ("produces a LATENT and takes a MODEL, directly or through a
  direct input") also admits `MMH3ReferenceMultiPrompt` and `H3HybridWindows`.
  Their real sockets show why: `H3HybridWindows` takes `MODEL`, a custom
  `MMH3_COND_SET` and a `LATENT` and outputs six types; the multi-prompt node
  takes no `MODEL` at all. Section 3 tightens the test.
- On the long-form graph it reports two seeds, `123` and the real noise seed,
  because it collects every `seed`-named input upstream of any sampler.
  Section 5 ties numeric settings to a stage.

## 1. Socket types

Status: **Implemented and Verified** (2026-09-28) in `main/comfy-generation-parser.js`

A **type map** assigns every API input `(nodeId, inputName)` and every output
slot `(nodeId, slot)` a socket type, with the evidence it came from:

1. **Declared** — the embedded UI `workflow`: `nodes[].inputs[].type`,
   `nodes[].outputs[].type`, and the typed `links` array
   (`[id, originNode, originSlot, targetNode, targetSlot, type]`).
2. **Subgraph-declared** — `workflow.definitions.subgraphs[]`. An API id such as
   `5407:5600` is inner node `5600` of the subgraph instantiated by outer node
   `5407`, whose UI `type` is the subgraph's `id`. Nested subgraphs extend the
   id (`a:b:c`). ComfyUI flattens subgraphs when it builds the API prompt, so
   every API link already names a concrete producer; only the inner nodes'
   own socket types are needed, never the subgraph's boundary links (object
   links whose `origin_id` of `-10` is the input side and `-20` the output).
3. **Inferred** — when there is no UI workflow, or a node is missing from it,
   types come from ComfyUI's conventional input names: `model`→`MODEL`,
   `clip`→`CLIP`, `vae`→`VAE`, `positive`/`negative`/`conditioning`→
   `CONDITIONING`, `latent_image`/`latent`/`samples`→`LATENT`,
   `guider`→`GUIDER`, `sigmas`→`SIGMAS`, `noise`→`NOISE`, `sampler`→`SAMPLER`,
   `image`/`images`→`IMAGE`, `video`→`VIDEO`; the standard scalars
   `seed`, `noise_seed`, `steps`, `start_at_step`, `end_at_step`→`INT`,
   `cfg`, `denoise`→`FLOAT`; and switch inputs named `any_NN`→`*`. An output
   slot's type is the type of the input that consumes it, so one named
   consumer types the producer.
4. **Catalogued** — with the optional ComfyUI connection of
   [`comfy-queue-integration.md`](comfy-queue-integration.md) switched on,
   `/object_info` gives every installed class's socket types. This is
   **Deferred** until that connection exists; the reader must work without it.

A link's type is its producer's output type, else its consumer's input type,
with two refinements the real corpus forced: a **concrete type beats `*`**
(a switch's output is declared `*`, but the save consuming it declares
`VIDEO`; preferring `*` lost the output on 56 H3 renders), and declared
evidence beats inferred. The UI graph's **output slot names** are kept too;
Section 3 uses them to keep positive and negative apart.

### Acceptance

- API ids of subgraph inner nodes resolve to their declared types. Nested
  subgraphs are handled by the same recursion but no real fixture has one yet.
- With no UI workflow, a VHS-saved graph is fully typed from input names.
- Every type records whether it was declared, subgraph-declared or inferred.

## 2. Pass-through

Status: **Implemented and Verified** (2026-09-28) in `main/comfy-generation-parser.js`

Some nodes carry a value without changing its meaning. They are followed,
never reported:

- A node whose output is typed `*`, or whose inputs are all `*`-typed or of a
  single type equal to its output (rgthree `Any Switch`, reroutes that survive
  into the API graph): the carried value is the **first connected input in
  input-name order** (`any_01` before `any_02`), which is the switch's own rule.
- A **conditional switch** — inputs named `on_true` and `on_false` plus one
  selector (KJNodes `LazySwitchKJ`, core `ComfySwitchNode`): the selector is
  resolved to a boolean and the chosen branch is carried. An unresolvable
  selector leaves the value unresolved, never guessed. Older H3 renders route
  their model and steps through one, and missed both without this rule.
- A node with no linked inputs and exactly one scalar literal, booleans
  included (`PrimitiveInt`, `PrimitiveBoolean`, `Seed (rgthree)`,
  `INTConstant`): the value is that literal.

Muted (mode 2) and bypassed (mode 4) nodes do not appear in the API graph, so
the API graph is already the executed graph. The UI graph is consulted only
for types.

### Acceptance

- A value routed through nested switches and a primitive resolves to its
  literal, as graph-derived.
- A switch with no connected input resolves to nothing, not to a neighbour.

## 3. Roles

Status: **Implemented and Verified** (2026-09-28) in `main/comfy-generation-parser.js`

All roles are found by walking **upstream from the output**, so nodes on
unconnected branches (a still-image branch, a disabled preview) never
contribute.

- **Output** — a node consuming `IMAGE` or `VIDEO` that holds a
  filename-like string input (`filename_prefix`, `filename`, `path`). Prefer
  the one whose prefix matches the file's own name; otherwise the only
  candidate; otherwise report **ambiguous** and stop, as today.
- **Sampler stage** — a node that **outputs `LATENT`**, **consumes a
  `LATENT`**, and consumes either `MODEL` and `CONDITIONING`, or a `GUIDER`, or
  `NOISE` and `SIGMAS`. This admits `KSampler`, `KSamplerAdvanced`,
  `SamplerCustomAdvanced` and any custom sampler with standard sockets, and
  rejects the prototype's two false positives by their own socket types.
  Stages are ordered by distance to the output; the nearest is **final**, and
  a tie is partial, as today.
- **Guider** — the source of a stage's `GUIDER` input. Its `MODEL` and
  `CONDITIONING` inputs stand in for the stage's own.
- **Model chain** — from a stage's (or its guider's) `MODEL` input, follow
  `MODEL`-typed links upstream through pass-through. A node with no `MODEL`
  input is the **root**; its string inputs ending in a model extension
  (`.safetensors`, `.gguf`, `.ckpt`, `.pt`, `.pth`, `.bin`) name the
  checkpoint. A node *on* the chain is a patch. It is a **LoRA** when it holds a
  model-extension string under an input whose name contains `lora`, or dict
  inputs shaped `{on, lora, strength}` (rgthree Power Lora); `strength*` inputs
  give strengths, and a zero or `on: false` entry is not "used", as today.
- **Prompt** — from a stage's (or guider's) `positive`/`negative`/
  `conditioning` input, walk upstream along `CONDITIONING`, `STRING` and `*`
  links, and through any node that outputs one of those. Collect string
  literals of at least four words that are not file names or JSON held in a
  string (a composer's file list; tested by parsing, because prose may begin
  with `[Shot 1]`). The walk follows every link except those typed as models,
  media, sampling machinery or plain numbers, because text reaches samplers
  through custom types (`MMH3_COND_SET`) as well as `CONDITIONING` and
  `STRING`. Which input the walk started from decides **positive** or
  **negative**. Two rules keep them apart: a node that passes a pair through
  (an output slot named like one of its inputs, as LTX's conditioning nodes
  name `positive` and `negative`) is followed only along the matching input;
  and text reached from both walks — a negative made by zeroing the positive —
  is positive only. One string is a
  direct prompt; several are fragments labelled with their node and input name
  (`summary`, `detailed_description`), and the result is partial.
- **VAE, text encoder** — roots of `VAE` and `CLIP` chains, found the same way
  as the model root. This replaces `DECODE_TYPES`.
- **Sources** — `IMAGE`/`VIDEO`/`AUDIO`-producing roots on the path whose
  string input names a media file, as today.

### Acceptance

- The false positives the prototype admitted are rejected by socket types.
- A MiniMax H3 composer's text fields are returned as positive fragments.
- A LoRA reached only through an Any Switch is reported; one on an
  unconnected branch is not.

## 4. No UI workflow

Status: **Implemented and Verified** (2026-09-28) in `main/comfy-generation-parser.js`

VHS `VideoCombine` embeds only `prompt`. Everything above still runs on
inferred types (Section 1, rule 3). The result records `origin.typeEvidence:
"inferred"` but is **not** downgraded: this design first said inferred types
should lower evidence one level, but on the real corpus and the shipped
parser's own fixtures the conventional names proved as reliable as declared
types, and a downgrade would have marked every VHS-saved render Graph-derived
for no difference in reliability. On the VR180 graph this reaches: output `VHS_VideoCombine` by
`filename_prefix`; stage `SamplerCustomAdvanced` by `noise`/`guider`/
`sigmas`/`latent_image`; guider `BasicGuider`; model root `UNETLoader` through
two patch nodes by `model`; seed `5044` through a noise wrapper by `noise`;
steps `30` from `BasicScheduler` by `sigmas`.

### Acceptance

- The VR180 render yields checkpoint, seed and steps, recorded as inferred.
- Qualified names (`audio_vae`, `t5_clip`) type as VAE and CLIP, so an audio
  VAE is never reported as a text encoder.

## 5. Settings per stage

Status: **Implemented and Verified** (2026-09-28) in `main/comfy-generation-parser.js`

Numeric and choice settings are read **per sampler stage**, from the stage
node and the nodes that feed its non-model, non-conditioning, non-latent
inputs (`NOISE`, `SIGMAS`, `SAMPLER`, `GUIDER`), each resolved through
Section 2:

- seed — inputs named `seed` or `noise_seed`;
- steps, CFG, denoise, start/end step — by their conventional names;
- sampler and scheduler — `sampler_name`, `scheduler`.

Seeds keep their exact source text, as the current parser and the generation
key do. The panel's **seed** is the final stage's; other stages keep theirs in
`samplerStages`. A `seed`-named input elsewhere upstream (an image-noise node,
a disabled per-step roll) is not the generation seed and is not reported as
one, which removes the long-form's second seed.

### Acceptance

- The long-form hybrid reports one seed per stage and one panel seed.
- Steps and switch points of a two-stage `KSamplerAdvanced` graph are reported
  per stage.

## 6. Generation size, and version ordering

Status: **Unimplemented**

The generation-versions ordering uses **output pixels**, and on 2026-09-28 one
real pair was ordered wrongly: a draft RTX-upscaled to 1088×1920 out-pixelled
its `_nopost_` final at 928×1664, so the draft read as the best version
([`generation-versions.md`](generation-versions.md), "Known limitation").

The final stage's `LATENT` input traces to what sized the generation. Resolved
through Section 2, the reader reports a **render size**:

- `width`/`height` inputs on the node that produced the first stage's latent
  (`EmptyLatentImage`, `EmptyHunyuanLatentVideo`, `MiniMaxH3ReferenceToVideo`);
- or, when those are linked to a size calculator, a `*megapixels*` input on
  that calculator (the MiniMax composer's `output_megapixels`).

Versions would then order by **render megapixels, then total steps**, falling
back to output pixels, duration and modification time when the graph does not
say. This needs render size and steps stored per content, the same way the
generation key is: an additive column pair on `media_content`, computed by the
existing background indexer from the payload it already reads. That wiring is
**Unimplemented** and belongs to the implementation phase, not this design.

### Acceptance

- The RTX-upscaled draft and its `_nopost_` final order correctly.
- A graph that does not state its size keeps the current ordering.

## 7. Coverage harness

Status: **Implemented and Verified** (2026-09-28) as `scripts/generation-coverage.cjs`

Reliability is a number, not an impression. `scripts/generation-coverage.cjs`
walks a folder, reads each clip's embedded tags in-process (ffprobe for
non-ISO containers), runs **both** the shipped parser and the type-flow
reader, and reports per top-level folder the share of clips with a
checkpoint, a prompt (direct or fragments), a seed and steps, plus a sample of
spot-check lines. It prints counts and field presence, never prompt text.

It is a development tool, not part of `npm test`: it reads the user's own
library. The corpus is the user's `data/work/output` (H3, H3-Long, video,
vr180, outpaint, requeue).

### Acceptance

- One command prints a before/after table for a corpus folder.
- The switch-over decision in Section 8 cites its numbers.

## 8. Switching the panel over

Status: **Implemented and Verified** (2026-09-28)

The socket-type reader **is** `parseComfyGenerationPayload` in
`main/comfy-generation-parser.js`, behind the same interface and result shape,
so the generation-metadata service is unchanged apart from its parser cache
version (now **5**, so every cached result is re-read). The class allow-lists
(`SAMPLER_TYPES`, `UNARY_CONDITIONING_INPUT`, `MODEL_PASSTHROUGH_INPUT`,
`DECODE_TYPES`, the output and Wan adapters) are deleted, not kept as a
parallel path. Payload location, JSON bounds, `NaN` handling and exact 64-bit
seeds moved to `main/comfy-payload.js`. Sidecar reading, the generic sidecar
fallback and source precedence are untouched.

### Evidence for prompt text

Confidence comes from the node that holds the text, not from its distance to
the sampler:

- **exact** (Direct) — the node outputs conditioning: it is the encoder, and
  used the text as written. Behind a combine it is still exact, composed with
  another (`composition: "combined"`).
- **derived** (Graph-derived) — a node holding one value and nothing else,
  whose value reaches an encoder through switches only (`"routed"`).
- **candidate** (Partial) — any other node, which may change the text before
  it is used: a composer, an assembler, an enhancer (`"upstream"`). Shown as a
  fragment, never as *the* prompt, with a `PROMPT_CANDIDATE` diagnostic.

On an encoder, short text counts (a two-word negative prompt); on a
candidate, only prose of four words or more, so settings stored as strings
are not mistaken for prompts.

### What changed on purpose

- A node holding a single string, whatever its class, is read as a value
  holder like `PrimitiveStringMultiline`: its text becomes a Graph-derived
  prompt. The shipped parser withheld such text when it did not know the
  class; types cannot tell the two apart, and the evidence badge says how the
  text was reached.
- Text from nodes that may transform it is now shown, as labelled candidate
  fragments, instead of being hidden with a diagnostic.
- `samplers` lists sampler names only. The shipped parser added schedulers, so
  the panel showed the scheduler twice, and a graph with no `sampler_name`
  (WanVideoWrapper) showed its scheduler as the sampler. It also used to report
  the class name `WanVideoSampler` as the sampler; that is gone.

### A latent storage bug

The service has always been able to produce the `derived` quality, and the
panel renders a Graph-derived badge for it, but the cache table's `CHECK`
constraint and allow-list accepted only exact, partial and unknown, so any
graph-derived result failed to save ("Unsupported generation quality:
derived"). The shipped parser rarely produced one; the new reader does. The
constraint now allows it. A profile whose table has the old check gets the
table rebuilt with its rows copied across (SQLite cannot relax a `CHECK` in
place), keeping the embedded-metadata guarantee that migration loses no
cached rows; a table so old it has no quality column needs nothing, because
the column is added later with the current check.

## Open questions

- Whether `/object_info` typing (Section 1, rule 4) is worth having once the
  ComfyUI connection exists, or whether inferred types are enough.
- ~~Whether the old allow-list parser is kept as a fallback.~~ Deleted at
  switch-over: the harness found no clip where it found a field the new
  reader did not.

## Deferred

- `/object_info` typing, pending the ComfyUI connection.
- Visual-workflow-only payloads (a `workflow` with no `prompt`): still
  deferred, as in `embedded-generation-metadata.md`.
- Evaluating custom string composition: never, per the non-goals.

## Implementation order

1. A pure type-flow reader behind the parser interface, with reduced real
   fixtures for H3 Omni, long-form, V2V, LTX outpaint (subgraphs) and VR180
   (no workflow).
2. The coverage harness, run on the user's corpus, with results recorded here.
3. ~~Switch-over, when the harness supports it.~~ Done.
4. Render size per content, and generation-version ordering by it.

## Implementation notes and decisions

### 2026-09-28 — Design

- Brief from the comfy-requeue session; prototype preserved as
  `prototypes/typeflow.py`. The prototype's results and faults above were
  re-run in this repository on real renders before writing this.
- Input *names* are allowed as evidence and class *names* are not, because
  ComfyUI standardises the former across custom nodes and not the latter.

### 2026-09-28 — Reader, harness and first corpus run

- `main/comfy-type-flow.js` (merged into `comfy-generation-parser.js` at
  switch-over) implements Sections 1–5 behind the shipped
  parser's interface and result shape (`parseComfyTypeFlow(payload,
  { fileName, origin })`), reusing its payload location, bounds and NaN
  handling. It is **not wired in**. `container-tags.js` gained an
  `includeWorkflow` option so the harness can read the UI graph in-process;
  the generation-key indexer still skips it.
- `scripts/generation-coverage.cjs` over the user's `data/work/output`
  (3,332 clips, 2,935 with a `prompt` tag), shipped → type-flow:

  | Folder | Tagged | Output | Checkpoint | Prompt | Seed | Steps |
  |---|---|---|---|---|---|---|
  | H3 | 2,366 | 100 → 100% | 33 → 100% | 0 → 100% | 1 → 100% | 40 → 100% |
  | H3-Long | 97 | 98 → 98% | 0 → 98% | 0 → 98% | 98 → 98% | 0 → 98% |
  | requeue | 336 | 100 → 100% | 99 → 100% | 0 → 100% | 1 → 100% | 99 → 100% |
  | video | 67 | 73 → 100% | 9 → 90% | 0 → 90% | 54 → 90% | 7 → 90% |
  | vr180 | 48 | 100 → 100% | 100 → 100% | 0 → 100% | 0 → 100% | 100 → 100% |
  | outpaint | 5 | 100 → 100% | 80 → 100% | 0 → 40% | 80 → 100% | 0 → 20% |
  | **All** | **2,935** | **99 → 100%** | **40 → 99%** | **0 → 99%** | **6 → 99%** | **46 → 99%** |

  No clip lost a field the shipped parser found. The remaining gaps are
  mostly genuine: the top-level AnimateDiff/masking renders have no sampler;
  LTX samples from explicit sigmas, so has no step count; and those outpaint
  renders' positive prompt is empty.
- Values, not just presence: all 17 real `_final_1.5mp_35st_` finals report
  35 steps, their 15 drafts report 8, and every draft's reported seed is one
  the generation key collected. The full corpus run takes about six seconds.
- Five rules above came from the corpus, not the prototype: `any_NN` and
  scalar input names, conditional switches, boolean primitives, concrete
  types over `*`, and slot-name pairing of positive and negative. The last
  one corrected an early result that read an LTX render's negative text as
  its prompt.
- Tests: `main/__tests__/comfyTypeFlow.test.js`, 13 cases over five reduced
  real fixtures (`fixtures/type-flow/`: Omni, long-form, V2V, LTX subgraphs,
  VR180 without a workflow) and synthetic single-rule graphs.

### 2026-09-28 — Switch-over

- The reader replaced the allow-list resolver as the Generation panel's
  parser, as described in Section 8. Porting the shipped parser's own tests
  found what the corpus could not, because the corpus has no WanVideoWrapper
  renders: wrapper suites use their own socket types, so types ending
  `VIDEOMODEL` and `TEXTEMBEDS` (and, without a workflow, the `text_embeds`
  input) play MODEL and CONDITIONING; LoRA stacks hang off the model chain
  through lora-named links (`lora`, `prev_lora`, with `lora_N` paired to
  `strength_N`); and a text encoder is also the model-file root the prompt
  path reaches (a T5 loader). The Wan fixture now reads the same models,
  LoRAs in the same order, text encoder, VAE, stages and prompts as before.
- Bounds are enforced with the shipped codes (`COMFY_GRAPH_NODE_LIMIT`,
  `COMFY_GRAPH_EDGE_LIMIT`, `COMFY_TRAVERSAL_DEPTH_LIMIT`,
  `COMFY_TRAVERSAL_LIMIT`, `COMFY_OUTPUT_LIMIT`, `COMFY_SAMPLER_LIMIT`), and
  output selection keeps the shipped matching (exact file name, then a
  prefix followed by `_` or `-`, then the only output).
- `scripts/generation-coverage.cjs` now goes through the panel's own path:
  tags from the service's ffprobe probe, then the service's
  `hasSupportedFields` and `buildPersistenceInput`, with `--baseline` taking
  the previous parser (extracted from git) for comparison. On 2,950 tagged
  clips, previous → current: output 99 → 100%, checkpoint 40 → 99%, prompt
  0 → 99%, seed 6 → 99%, steps 45 → 99%. **No clip lost a field.** Evidence:
  33 Direct, 53 Graph-derived, 2,861 Partial (almost all MiniMax composer
  prompts, shown as candidate fragments), 3 with nothing supported.
- The real app, headless on copies of an H3 Omni draft, a long-form, a V2V,
  an LTX outpaint and a VR180 clip, showed model, VAE, text encoder, seed,
  sampler, scheduler and steps for all five; the Omni's composer fields as
  labelled candidate fragments; and the outpaint's negative prompt with a
  Graph-derived badge. That run found the storage bug and the audio-VAE
  misattribution above.
- Verification: parser, type-flow and service suites; the new Electron-ABI
  suite `generationMetadataQuality.test.js`; `npm test -- --run`,
  `npm run test:electron-abi`, zero-warning lint and the Vite build.

## References

- Current parser, evidence levels and bounds:
  [`embedded-generation-metadata.md`](embedded-generation-metadata.md).
- Version ordering limitation:
  [`generation-versions.md`](generation-versions.md).
- The optional ComfyUI connection:
  [`comfy-queue-integration.md`](comfy-queue-integration.md).
- Prototype: [`prototypes/typeflow.py`](prototypes/typeflow.py).
