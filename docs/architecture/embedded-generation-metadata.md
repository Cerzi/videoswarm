# Embedded Generation Metadata

Status: **Embedded API-graph extraction implemented and verified for core
ComfyUI and the fixture-backed WanVideoWrapper slice; bounded follow-up work
remains explicit below**
Last updated: 2026-07-20

## Summary

Video Swarm's Generation panel will treat metadata embedded in a media file as
the primary record of how that clip was made. Exact adjacent JSON sidecars
remain a supported fallback. The first producer-specific resolver targets
ComfyUI and ComfyUI-VideoHelperSuite (VHS), while the stored result and user
interface remain producer-neutral.

ComfyUI commonly stores two related but different JSON documents:

- `prompt`: the API/execution graph submitted to the server. This graph has
  node class names, named inputs, and explicit connections and is the best
  source for reliable field extraction.
- `workflow`: the visual editor graph. It is valuable evidence and can restore
  the canvas, but `widgets_values` cannot be interpreted reliably for arbitrary
  custom nodes without their node definitions.

The extractor therefore does not concatenate every string it finds or label
the first `text` value as the prompt. It traces the execution graph from the
output toward the sampler, conditioning, model, and source branches. Direct
values are distinguished from graph-derived and unresolved values. Unknown
custom nodes degrade to a transparent partial result rather than a confident
but incorrect answer.

This is a living implementation and verification record. A slice is marked
**Implemented** only after its focused acceptance tests pass. A slice is
marked **Verified** only after the applicable repository-wide gates pass.

## Product goals

1. Show the positive prompt, negative prompt, seed, model, sampler, scheduler,
   LoRAs and strengths, steps, CFG, source media, and run identity when those
   values can be supported by embedded evidence.
2. Explain where the result came from and when it is partial.
3. Keep metadata work lazy, cancellable, bounded, profile-owned, and small
   enough for folders containing thousands of clips.
4. Preserve current sidecar behavior for generators and tools that do not
   embed metadata or whose metadata was stripped during transcoding.
5. Create a producer-neutral foundation for later generation-aware search and
   grouping without retaining raw workflows in SQLite or renderer memory.

## Non-goals

- Do not execute workflow nodes, custom Python, expressions, or embedded text.
- Do not claim that arbitrary custom string graphs can always be reconstructed.
- Do not scan every file on folder open in this phase.
- Do not retain raw `prompt`/`workflow` graphs in SQLite, React state, or a
  process-lifetime cache.
- Do not add an unbounded media cache or prefetch metadata for off-screen clips.
- Do not mutate, repair, or rewrite source media.
- Do not require a ComfyUI installation or contact a ComfyUI server.

## 1. Existing baseline

Status: **Implemented and verified**

The current on-demand pipeline accepts one authorized indexed instance ID and
checks exactly three adjacent paths in deterministic order:

1. `video.ext.json`
2. `stem.workflow.json`
3. `stem.json`

It reads through an opened, non-symlink file handle and enforces a 2 MiB input
limit, depth 32, 10,000 JSON nodes, 32 values per field, two active jobs,
64 queued jobs, and a five-second deadline. Requests are profile-generation
owned, renderer requests are debounced, superseded work is cancelled, and
profile changes, renderer destruction, and shutdown drain owned work. Only
compact extracted fields are stored per profile.

The baseline parser is intentionally generic, but its recursive key sweep can
mistake an unrelated `text` widget for a prompt and cannot prove that a model,
seed, or prompt belongs to the output clip. It also reports only sidecar
presence, even when the media itself contains the authoritative graph. Those
limitations are replaced by the following slices rather than hidden in UI
copy.

## 2. Source discovery and precedence

Status: **Implemented for bounded embedded API-graph discovery and exact
sidecar fallback** (2026-07-15). Visual-workflow extraction remains
**Unimplemented**.

### Order

For one requested indexed clip:

1. Validate current profile/root ownership and authorize the exact media path.
2. Check a compact cached result against media size, modification time, parser
   version, and source kind.
3. Probe bounded container tags for embedded generation payloads.
4. Check the existing three exact adjacent sidecars only when embedded
   evidence is absent, visual-workflow-only, or otherwise cannot resolve a
   supported field.
5. Select one coherent candidate in this implemented order: embedded API
   graph, sidecar API graph when embedded evidence is visual-only/unusable,
   then explicit generic sidecar fields. Embedded wins ties. Embedded and
   sidecar visual-graph interpretation remains a future resolver slice.
6. If no source is usable, clear stale cached metadata and return a
   structured empty result.

An embedded API graph wins because it travelled with the rendered output and
has enough structure to prove branch ownership. A sidecar API graph may beat
an embedded visual-only graph because named execution inputs are materially
stronger than uninterpretable widget positions, but the UI must identify the
fallback. Sources are never silently merged. This avoids presenting a stale
sidecar's model beside an embedded graph's prompt after files have been renamed
or copied. A future explicit comparison surface may show conflicts.

A structurally valid embedded API graph remains authoritative when its traced
result is partial. Video Swarm shows that incompleteness rather than silently
substituting a potentially stale sidecar. Sidecar fallback occurs only when
embedded evidence is absent or produces no supported field.

An embedded envelope that is valid but contains only a visual workflow does
not currently invent a partial result. Sidecar fallback is allowed because the
embedded payload produced no supported fields; the response records that
embedded metadata was detected but was not resolvable.

### Initial container probe

The first implementation uses `ffprobe` without a shell to read only format
and stream tags. The runner is limited to one active process, 16 queued jobs,
five seconds, 2 MiB stdout, 64 KiB stderr, and a short terminate/kill grace
period. It never asks ffprobe to decode frames. Owner cancellation and shutdown
use the shared bounded child-process runner.

Recognized tag names are case-insensitive and include direct `prompt` and
`workflow` tags plus JSON envelopes found in `comment`, `description`, or
equivalent container comment fields. Values may be objects, JSON strings, or a
bounded legacy double-encoded JSON string. Parsing stops after the configured
decode depth.

`ffprobe` absence or an unsupported/corrupt container is a capability result,
not a fatal Generation-panel error: exact sidecar fallback still runs. The UI
may explain that embedded probing is unavailable. A bundled cross-platform
probe or small audited native container reader is a later portability slice;
shipping an arbitrary executable or assuming system PATH is not part of this
initial implementation. A normal request memoizes a missing executable for the
process lifetime; explicit **Re-read** bypasses that memo so installing or
repairing `ffprobe` can recover without restarting the app.

### Source signature

The compact cache records:

- source kind: `embedded` or `sidecar`;
- an internal source path for sidecars only, plus a display-safe source label;
- media/sidecar size and modification time;
- embedded tag/container key when applicable;
- parser version and extraction format;
- update time.

Paths remain main-process data and are exposed to the renderer only when they
are already part of an authorized native action. The Generation panel receives
only a source label such as **Embedded · Comment** or **Adjacent sidecar**.

### Acceptance

- A usable embedded API payload is preferred without opening adjacent sidecars.
- Missing `ffprobe`, malformed output, timeouts, oversized output, non-zero
  exit, cancellation, profile changes, and shutdown all settle deterministically.
- Sidecars continue working when embedded probing is unavailable or empty.
- A media or sidecar signature change invalidates the cached result.
- No frame is decoded and no work begins for an unopened Details panel.

## 3. Bounded payload normalization

Status: **Implemented for direct/stringified ComfyUI API graphs and VHS
envelopes** (2026-07-15). Producer-neutral embedded objects and visual graphs
remain **Unimplemented**.

Container tags and sidecars feed one normalizer. It accepts these common shapes:

- a direct ComfyUI API graph;
- `{ "prompt": <API graph>, "workflow": <visual graph> }`;
- a VHS comment containing that object as JSON;
- legacy single- or double-stringified `prompt` and `workflow` members;
- an exact sidecar with explicit producer-neutral generation fields through
  the legacy bounded generic parser. Equivalent embedded generic objects are
  not yet interpreted.

Every decoded layer shares the existing byte, depth, and node budgets. Object
shape inspection occurs before graph traversal. The normalizer rejects
prototype-bearing/non-plain structures supplied by tests, ignores unknown
binary values, clamps all strings and arrays, and never returns the raw graph.

The normalized envelope records which graph representations were present,
which producer was recognized, and bounded diagnostics such as
`workflow-only`, `unknown-node-on-prompt-path`, or `multiple-output-candidates`.
Diagnostics are stable codes with short UI copy; they never contain full
prompt text, raw JSON, or native paths.

The first parser caps graphs at 4,096 nodes, 16,384 edges, 32,768 traversal
visits, 32 output candidates, 32 sampler stages, and 64 prompt fragments,
assets, and diagnostics per category. Prompt text is capped at 16 KiB per
fragment and 64 KiB total. A clamped prompt receives an explicit diagnostic and
the result becomes Partial. These sit inside the outer 2 MiB, depth-32, and
10,000-JSON-node envelope limits.

### Acceptance

- Direct, stringified, and legacy double-stringified VHS payloads normalize to
  the same bounded representation.
- Very wide/deep/large payloads fail before building an unbounded traversal
  stack or renderer object.
- Metadata text remains inert data and is never logged as an instruction.
- Raw graph nodes and links are eligible for garbage collection immediately
  after compact extraction.

## 4. ComfyUI graph resolver

Status: **Implemented for core ComfyUI API graphs and the fixture-backed
WanVideoWrapper API slice** (2026-07-15). Visual-graph resolution and arbitrary
custom-node interpretation remain **Deferred pending evidence**.

### Graph selection

The API/execution graph is authoritative when present. Nodes are keyed by ID,
contain `class_type`, and reference upstream outputs as `[nodeId, outputIndex]`.
The visual `workflow.nodes`/`workflow.links` graph is fallback evidence only.

Candidate output nodes are ranked by:

1. a filename/path field matching the active clip where one exists;
2. a recognized video/image output class such as VHS Video Combine;
3. a terminal node with no downstream consumers;
4. deterministic node order as a final tie-breaker.

If multiple plausible outputs remain, extraction is marked partial rather than
mixing their branches.

### Branch traversal

Traversal works backward from the selected output and is cycle-safe and
node-bounded. It identifies sampler-like nodes and follows named inputs:

- `positive` and `negative` into conditioning branches;
- `model` and `clip` into checkpoint, UNet, text-encoder, VAE, and LoRA chains;
- `sampler`, `sigmas`, and scheduler fields into sampler/scheduler nodes;
- `latent_image`, `image`, video, and control inputs into source-media nodes.

A positive/negative designation from a sampler connection is stronger than a
node title. Titles such as “Positive Prompt” are useful fallback evidence but
must not override contradictory graph wiring.

### Prompt reconstruction

Prompt extraction uses three levels:

- **Direct:** one scalar `text` input on a recognized text-encoding node on the
  proven positive or negative conditioning branch.
- **Derived:** deterministic output from an allowlisted adapter whose semantics
  Video Swarm implements and tests, such as a known string concatenate node.
- **Candidate:** bounded string fragments on the correct branch whose custom
  composition semantics are unknown.

Multiple fragments remain separate with node labels and provenance. They are
not joined with guessed punctuation. The primary `prompt` is populated only by
one direct value or one deterministic derived value. Candidate fragments are
shown as **Prompt fragments** and the result is marked partial.

The adapter layer is parser-versioned and allowlisted. Each adapter declares
class names, recognized inputs, deterministic ordering, output behavior, and
tests.
Unknown custom nodes pass through graph traversal only when their connected
inputs can be followed safely; they do not gain invented execution semantics.
The allowlist currently includes `PrimitiveStringMultiline.value`, which the
supplied execution graph uses directly. Unknown composition remains unresolved
and partial rather than being reconstructed heuristically. In particular, the
supplied visual workflow's disconnected, empty composition nodes are not enough
evidence to implement or attribute their runtime semantics.

### Models, LoRAs, and sampling fields

The first resolver recognizes core and common naming conventions for:

- checkpoint/UNet/model loader values (`ckpt_name`, `unet_name`,
  `model_name`);
- LoRA loaders (`lora_name`, `strength_model`, `strength_clip`), retaining
  every proven LoRA in branch order;
- seeds (`seed`, `noise_seed`) as exact strings, including integers beyond
  JavaScript's safe integer range;
- sampler and scheduler names;
- steps, CFG/guidance, denoise, and related scalar sampling fields;
- source image/video loader names and generation/run IDs.

The fixture-backed WanVideoWrapper adapter recognizes `WanVideoSampler`,
`WanVideoTextEncode`, its T5/model/VAE loaders, model/block-swap/LoRA
passthrough nodes, single and multi LoRA selectors, `INTConstant`, and
`Seed (rgthree)`. It records serial high/low sampler stages, resolves named
scalar producers without evaluating arbitrary schedules, and excludes
zero-strength LoRAs from the user-facing “used LoRAs” list. An unresolved CFG
schedule remains unset instead of being reduced to a guessed scalar.

LoRA display never infers strength from a filename. A missing strength is
shown as unknown. Duplicate LoRA names on distinct graph nodes remain distinct
unless the complete normalized tuple matches.

### Confidence and completeness

The compact result includes:

- `confidence`: `direct`, `derived`, or `partial`;
- `partial`: boolean;
- bounded `diagnostics` codes;
- per-fragment/per-LoRA provenance where useful;
- graph format and recognized producer.

Confidence describes extraction, not the truth or quality of the user's
prompt. Generic sidecar fields can still be displayed, but are labelled
**Declared** rather than graph-proven.

### Acceptance

- Positive and negative prompts are selected by branch ownership, not global
  key order.
- Unrelated notes and `text` widgets never become the primary prompt.
- A model/LoRA from an unconnected branch is not attributed to the clip.
- Direct CLIP text, large seeds, KSampler/SamplerCustom fields, checkpoint and
  UNet loaders, WanVideoSampler/TextEncode, active Wan LoRA chains, source
  media, duplicate nodes, cycles, unknown custom nodes, and multiple outputs
  have focused fixtures.
- No resolver path exceeds the shared depth/node/value/string budgets.

## 5. Compact persistence and IPC

Status: **Implemented and Electron-ABI verified** (2026-07-15)

The profile-local `instance_generation_metadata` table evolves additively. Its
legacy `sidecar_*` signature columns remain readable during migration, while
new generic source columns describe embedded or sidecar evidence. New compact
fields include negative prompt, prompt fragments, schedulers, LoRAs, bounded
sampling facts, producer/format, confidence, partial state, and diagnostics.

SQLite write normalization repeats all renderer-independent bounds. JSON
columns store only compact arrays/objects and have explicit byte budgets.
Structured source inputs retain their image/video kind. If extracted evidence
exceeds the smaller compact-cache budget, persistence adds a truncation
diagnostic and downgrades completeness to partial rather than silently keeping
an exact badge.
Changing profile ownership invalidates pending writes before publication.
Deleting an instance continues to cascade its cached generation row.

The existing preload operations remain sufficient:

- read generation metadata for one indexed instance and request token;
- cancel one owned request token.

No raw path, arbitrary path probe, graph JSON, database handle, or child
process control crosses preload. The IPC result differentiates `found`,
`cached`, source kind, partial result, fallback use, and embedded-probe
capability without exposing native stderr.

### Acceptance

- Existing profile databases migrate without losing sidecar cache rows.
- Embedded and sidecar signatures cache independently and invalidate correctly.
- Profile isolation and stale-completion suppression are covered under
  Electron's SQLite ABI.
- Returned and persisted JSON sizes remain bounded under adversarial input.

## 6. Generation-panel experience

Status: **Implemented and renderer-verified** (extended 2026-07-20)

The floating inspector, docked workspace editor, and fullscreen Details dock
share one metadata content component. Copy becomes source-neutral and
informative:

- Loading: **Reading embedded metadata…** followed by sidecar fallback when
  necessary.
- Empty: **No embedded generation metadata or adjacent sidecar was found.**
- Capability fallback: explain that embedded probing was unavailable while
  showing any sidecar result.
- Source badge: **Embedded**, **Adjacent sidecar**, and **Cached** where true.
- Completeness badge: **Direct**, **Graph-derived**, or **Partial**.

The primary positive prompt is visually dominant. Negative prompt, prompt
fragments, model/checkpoint, LoRAs with strengths, seed, sampler, scheduler,
steps, CFG/guidance, denoise, source media, and run identity use compact
sections rather than one undifferentiated fact list. Empty categories are
omitted.

Partial results include one concise explanation and an expandable bounded list
of unresolved conditions. The UI never implies that “workflow detected” means
every value can be reconstructed. Refresh invalidates/reprobes the active
instance only. Generation metadata remains lazy and sidecar/graph JSON is not
rendered into the DOM.

Future actions such as **Copy prompt**, **Copy generation summary**, or
**Restore workflow in ComfyUI** require their own safe design. They are not
quietly added to this read-only pass.

### Acceptance

- Embedded, sidecar, cached, empty, partial, unavailable-probe, loading, and
  error states are visually and semantically distinct.
- Long prompts and LoRA lists remain usable without expanding the dock beyond
  its existing bounded scroll surface.
- Floating and fullscreen panels render identical extracted facts.
- Lazy opening/closing and rapid clip navigation cancel stale work and never
  show metadata from the previous selection.

## 7. Performance, lifecycle, and security

Status: **Implemented for lazy work, finite queues, renderer/profile ownership,
and shutdown** (2026-07-15). Explicit minimize-suspension cancellation remains
**Unimplemented**.

- At most one container probe and two sidecar reads are active process-wide;
  the coordinator itself has a finite queue, deduplicates equivalent work, and
  applies a profile-instance generation guard so an older normal read cannot
  overwrite or clear a newer explicit re-read.
- The media file is never copied into memory. Probe stdout and every decoded
  JSON layer are byte-limited.
- Profile changes, renderer destruction, shutdown, and request cancellation
  terminate child work and prevent SQLite publication.
- Cache rows contain compact strings/arrays only; no media elements, blobs,
  buffers, graphs, React nodes, or child handles survive the request.
- Spawn uses an argument array, `shell: false`, ignored stdin, hidden Windows
  windows, and no environment-derived script.
- Native paths are authorized before probe/read and never interpolated into a
  shell command.
- Prompts and workflow text are untrusted inert content. They are not sent to a
  model, evaluated, used as HTML, or written to logs.

The renderer starts this work only while a visible Generation disclosure is
expanded and enabled, so collapsing it, switching the workspace back to
Library, or closing the Details surface cancels its request. A dedicated hook
from whole-window work suspension into this coordinator is still outstanding;
that gap does not create eager folder-open work, but it prevents this bullet
from being marked fully complete. Profile/shutdown coordination uses a bounded
two-second drain: an unabortable filesystem call may outlive that wait, but its
aborted ownership token prevents any later database publication.

## 8. Verification matrix

Status: **Core and WanVideoWrapper repository gates verified** (2026-07-15).
A packaged Electron smoke fixture and cross-platform reader verification remain
**Unimplemented**.

### Pure/native tests

- Container tag normalization and supported VHS envelope variants.
- Comfy API graph ownership, prompt/negative classification, model and LoRA
  tracing, custom-node degradation, cycles, multiple outputs, and all bounds.
- Child-process arguments, concurrency/queue/output/time limits, cancellation,
  missing executable, fallback, caching, and shutdown.
- SQLite migration, compact-field normalization, profile isolation, and
  instance cascade.
- Main-process ownership and preload contract regressions.

### Renderer tests

- Hook debounce, cancellation, refresh, stale response suppression, and source
  state.
- Shared Generation section source/completeness badges and all result states.
- Ordinary/fullscreen lazy loading only while Details and Generation are open.

### Repository gates

- Focused Vitest suites.
- Electron-ABI SQLite suites.
- Full `npm test -- --run`.
- `npm run lint`.
- `npm run vite:build`.
- Main/preload syntax checks and `git diff --check`.
- Electron smoke with one real embedded VHS fixture when a small redistributable
  fixture is available; otherwise a generated-at-test-time container probe
  fixture is required before marking cross-process integration Verified.

## Implementation order

1. **Implemented** — Add bounded payload normalizer and pure Comfy API graph
   resolver with representative core/VHS fixtures.
2. **Implemented** — Add the bounded embedded container probe and coordinator,
   retaining exact sidecar fallback and lifecycle ownership.
3. **Implemented** — Migrate compact SQLite storage and return provenance via
   existing IPC/preload operations.
4. **Implemented** — Redesign the shared Generation content around source,
   completeness, negative prompt, LoRAs, and partial diagnostics.
5. **Partially implemented** — Focused, native, full Vitest, lint, build,
   syntax, diff, and real-container command-line smoke gates pass. A generated
   fixture in the production Electron smoke harness remains outstanding.
6. **Deferred** — Decide and verify a packaged cross-platform embedded probe so
   Windows/Linux releases do not depend indefinitely on a system `ffprobe`.
7. **Deferred** — Add deterministic custom composition adapters only from
   connected execution graphs or authoritative node semantics. Disconnected
   visual-canvas nodes are not sufficient evidence.
8. **Deferred** — Feed compact normalized generation fields into the separate
   generation-aware search specification.

## Implementation notes and decisions

### 2026-07-15 — Initial design

- Existing sidecar limits and cancellation are the safety baseline, not code
  to discard.
- Embedded metadata is primary; sidecars are exact-path fallback.
- VHS commonly stores a JSON envelope containing an API `prompt` graph and a
  visual `workflow` in a container comment. Legacy versions may stringify the
  prompt more than once, so normalization is bounded and tolerant.
- The API graph is preferred because named connections can establish which
  conditioning/model branch produced an output. Visual widget positions alone
  cannot.
- Unknown custom string composition remains visible as fragments/partial rather
  than being guessed.
- Initial probing reuses the app's bounded native-process infrastructure and
  degrades gracefully when `ffprobe` is absent. A packaged portability answer
  stays explicitly Deferred until it is implemented and tested.

### 2026-07-15 — Initial implementation

- Added `main/embedded-metadata-probe.js`: one shell-free `ffprobe` lane with a
  16-job pending bound, five-second timeout, 2 MiB/64 KiB output limits,
  cancellation, shutdown, and deterministic missing-reader fallback.
- Added `main/comfy-generation-parser.js`: a pure bounded API-graph resolver
  for VHS/core output, sampler, conditioning, model, VAE, text encoder, LoRA,
  and source branches. Unsafe JSON integers remain exact strings; unrelated
  text and unknown string composition are never promoted to a prompt.
- Replaced the old sidecar-only coordinator with a profile/renderer-owned
  embedded-first service. It deduplicates work, keeps finite native queues,
  validates media/source signatures, never merges sources, and publishes only
  compact normalized fields.
- Migrated profile SQLite storage additively while keeping legacy sidecar
  columns readable. The IPC/preload contract remains instance-ID-only and now
  supports a bounded active-instance re-read.
- Redesigned the shared floating/docked/fullscreen Generation section with source,
  cache and completeness badges; positive/negative prompts; prompt fragments;
  LoRAs; richer sampling/assets; capability fallback; and bounded diagnostics.
- Verified 1,006 full-suite tests, 47 Electron-ABI SQLite tests, zero-warning
  ESLint, the Vite production build, main/preload/module syntax checks, and
  `git diff --check`. A generated MP4 carrying a VHS-style comment envelope
  also completed the real system-`ffprobe` path and yielded its prompt,
  negative prompt, exact seed, checkpoint, sampler, and steps.
- The pre-commit adversarial pass fixed plain-text generic-sidecar fallthrough,
  last-request-wins publication, bounded cancellation drains, force recovery
  after a missing reader, source-input kind persistence, multi-fragment
  completeness, prompt-fragment provenance display, and explicit compact-cache
  truncation diagnostics.

### 2026-07-15 — WanVideoWrapper fixture correction

- A supplied real Wan2.2 container dump proved that embedded metadata was
  present and correctly discovered: its `prompt` tag held a bounded API graph,
  while `workflow` held the separate visual canvas. The old parser selected
  the correct VHS output but stopped with `SAMPLER_NOT_FOUND` because
  `WanVideoSampler` was not registered. Prompt extraction is sampler-rooted,
  so this one adapter gap also hid the otherwise exact prompt.
- The executed path contains two serial `WanVideoSampler` stages pointing to
  one `WanVideoTextEncode`. Its `positive_prompt` points directly to a
  `PrimitiveStringMultiline.value`; its negative prompt is a direct scalar.
  This is exact execution-graph evidence and does not require analyzing widget
  positions or guessing which arbitrary string node is “the prompt.”
- Added bounded adapters for the observed Wan sampler, text encoder, scalar,
  model, block-swap, LoRA, T5, VAE, and decode nodes. Only non-zero LoRAs on
  reachable model branches are reported. The final sampler's model is the
  primary model; contributing-stage models remain listed.
- Added a deterministic prompt adapter for the observed
  `PrimitiveStringMultiline`, while retaining partial diagnostics for unknown
  runtime string producers. Disconnected composition nodes in the visual canvas
  are deliberately not interpreted. Visual-workflow inference remains deferred.
- Parser cache version 3 invalidates older cached `SAMPLER_NOT_FOUND` results.
  A reduced synthetic fixture preserves the real graph topology without
  committing user prompts, paths, model names, sampling values, node IDs,
  hashes, or the supplied dump.
- Focused parser and coordinator verification passes 31 tests. The repaired
  supplied payload resolves its prompts, sampler stages, generation assets,
  active reachable LoRAs, and source image with no parser diagnostics.
  Repository-wide verification passes 1,012 Vitest tests and 47
  Electron-ABI SQLite tests, plus zero-warning ESLint, the Vite production
  build, main/preload/module syntax checks, and `git diff --check`. The Vite
  build retains its pre-existing CJS API and chunk-size notices.

### Remaining implementation work

- Bundle or otherwise provision and verify an audited cross-platform metadata
  reader instead of relying indefinitely on a system `ffprobe`.
- Add a generated embedded-metadata fixture to the production Electron smoke
  harness, including cancellation during profile/root/window transitions.
- Wire whole-window work suspension directly into pending generation probes.
- Add visual-workflow interpretation and producer-neutral embedded fields only
  with bounded fixtures that prove their semantics.
- Add further versioned custom prompt/model/sampler adapters only after
  representative API graphs establish their execution semantics; unknown
  nodes stay explicitly partial.

## References

- [ComfyUI workflow documentation](https://docs.comfy.org/development/core-concepts/workflow)
- [ComfyUI-VideoHelperSuite Video Combine metadata option](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite#video-combine)
- [ComfyUI core node definitions](https://github.com/Comfy-Org/ComfyUI/blob/master/nodes.py)
