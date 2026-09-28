# Re-rendering in Video Swarm with Learned Recipes

Status: **Accepted** (decisions recorded 2026-09-28). Phase 1, the recipe
learner and matcher, is **Implemented** and **Verified**; Phases 2–4 are
**Unimplemented**.
Last updated: 2026-09-28

## Summary

[`comfy-requeue.md`](comfy-requeue.md) specified re-queueing inside Video Swarm
and then **rejected** it: re-rendering stayed in the standalone
`comfy-requeue` app, and the two tools split as "Video Swarm chooses, the app
runs". That app now works overnight on the user's machine, but only for the
two MiniMax H3 workflows it was written for. Every role in it — the composer,
the turbo LoRA, the `TURBO PATH` group, the switchboard — is code.

This document proposes bringing re-rendering into Video Swarm **without that
code**. The core idea is a **recipe learned from an example pair**, not a
workflow parser. A recipe is the difference between two versions of the same
generation: the draft, and the same generation in quality mode. Learned once
from one example, it re-renders every draft of that workflow. A new workflow
needs a new example, never new code.

It reverses a recorded decision, so three choices were left to the user.
They are now made; see [Decisions](#decisions).

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Verified** means the repository-wide gates also passed on that change.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Proposed** means the design is written and not yet accepted.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Goals

- Re-render any ComfyUI workflow at quality settings, learned from one
  example rather than written as code.
- Show exactly what a recipe will change, in plain rows, before anything runs.
- Keep the standalone app's hard-won safety: static checks before queueing,
  finals beside drafts, provenance, history, crash recovery, estimates.
- Survive an overnight run without the window being open.

## Non-goals

- **No inference of what "quality" means.** A recipe only ever replays a
  difference the user has shown by example.
- **No network beyond a loopback ComfyUI**, and none at all unless the user
  switches the connection on (Decision 1).
- **No GPU scheduling or model management.** ComfyUI owns its queue and memory.
- **No dependency on the standalone app.** Its history file, tag and settings
  are prior art and import sources, not runtime inputs.

## Evidence: the prototype

`prototypes/learn_recipe.py` (66 lines, stdlib) learns a recipe from a
finished re-render, which carries both graphs: its own `prompt` and the
draft's as `requeue.source_prompt`. It canonicalises both graphs (only nodes
reachable from the output; switches, reroutes and primitives followed to what
they carry; a node that vanished alongside an identical one that appeared is a
routing swap, not a change) and diffs them into remove-node, add-node and
set-input operations.

With no H3 knowledge, re-run in this repository on 2026-09-28 against real
finals, it recovered both of the app's hand-written recipes:

- **Omni** — turbo LoRA removed; `BasicScheduler.steps` 8 → 35; composer
  `output_megapixels` and `ref_image_megapixels` 0.5 → 1.5.
- **Long-form** — turbo LoRA removed; both `KSamplerAdvanced` stages' steps
  8 → 35 and switch point 6 → 27; `H3HybridWindows.total_steps` 8 → 35.

It saw through the loader swap and the Any Switch rerouting. The same runs
also show what a real learner has to handle, and the design below does:

1. **Finals mix the recipe with per-clip decisions.** The long-form final's
   diff includes an RTX scale the app chose to fit RAM for that clip, and the
   `_nopost_` final's diff removes RIFE and RTX entirely because that clip did
   not fit. A recipe learned from one final would teach those as rules.
2. **A removal shows up twice**: as the removed node, and as its consumer's
   input now coming "from" the node upstream. These are one operation.
3. **One pair cannot show a rule.** The switch point went 6 → 27 because the
   app scales it by the quality preset's 19/25, not by the draft's 6/8
   (6/8 × 35 = 26.25). From a single pair, "27" and "follows steps" are
   indistinguishable.
4. The prototype names its output class (`SaveVideo`). The real one must find
   outputs by socket type, as in
   [`generation-type-flow.md`](generation-type-flow.md).

## 1. Recipes

Status: **Implemented** (`main/comfy-recipe.js`)

A recipe is a small JSON document (`kind: "videoswarm.comfy-recipe"`,
`version: 1`); where it is stored is Phase 3's concern. It holds:

- **Workflow fingerprints** — for each example draft, the set of
  `(node id, class)` pairs of its API prompt. Node ids are stable within one
  workflow file across every render made from it.
- **Operations** (`ops`), each targeting a node id *and* its class:
  - `remove` — the node is dropped, and each consumer is rewired as the
    examples show: `through` one of the removed node's inputs (a bypass: the
    Omni turbo LoRA hands its `model` on to the Any Switch) or `drop` (a mute:
    each long-form Any Switch loses its turbo input and falls through). The
    rewiring is part of the removal, never reported again as a change of its
    own;
  - `add` — a node only the quality version has, with the example's node spec;
  - `set` — an input's new value. A new link is a `set` whose value is a link;
    there is no separate `rewire`.
- **UI operations** (`uiOps`) — `ui-mode` and `ui-widget` changes the API
  prompt does not show (the Omni switchboard's group toggles), so a result
  reopens in ComfyUI as it rendered.
- **Status per operation** — `constant`, or `varies` per clip with each
  example's before and after (`perPair`), and the evidence count.
- **Effects** — for each `set`, what it changes in the render with switches
  and primitives followed: `PrimitiveInt #38 value 25 → 35` shows as
  `KSamplerAdvanced.steps 8 → 35` on both stages and
  `H3HybridWindows.total_steps 8 → 35`. These are the review screen's rows.
- **Candidate rules** for inputs that may follow another (Section 2).
- **Identity exclusions** — never part of a recipe: seeds, prompt text, input
  media, output filenames and save prefixes, including a primitive that feeds
  one. A changed output name is listed under `ignored`; any other identity
  change refuses the pair as not a re-render of its draft.
- **Provenance** — the example labels (`learnedFrom`).

Adjustable settings are not stored in the recipe: `applyRecipe` takes the
user's `settings` (a new value for a constant `set`) and `choices` (keep,
apply, a value, or a candidate rule) per operation id.

### Acceptance

- Learning from the real Omni and long-form pairs yields exactly the
  operations listed under Evidence, and nothing from the identity exclusions.
  **Met** — see Implementation notes, 2026-09-28 Phase 1.

## 2. Learning a recipe

Status: **Implemented** for learning; the review screen is Phase 3
(**Unimplemented**)

A pair can come from three places:

1. **A versions stack** — "Make recipe from this pair" on two clips that the
   generation key already groups, choosing which is the draft.
2. **The same workflow exported in both modes** — two `.json` files; no render
   needed, and no per-clip decisions mixed in. This is the cleanest source.
3. **Existing finals** of the standalone app — both graphs in one file
   (`pairFromRequeueTags`).

Whatever the source, a recipe is learned from at least two pairs.

Learning canonicalises and diffs as the prototype does. Outputs are the
nodes that take IMAGE, VIDEO or AUDIO and name a file; pass-through (switches,
typed reroutes) and one-literal primitives are followed with the Generation
panel's own socket-type reader (`readComfyGraph` in
`comfy-generation-parser.js`), so both agree on what a switch carries. Only
nodes an output depends on count. A node that vanished alongside an identical
one that appeared (same class, same inputs once followed) is the same node
under a new id, and a new pass-through that carries what was already carried
is no change. It then corrects for points 1–3 above:

- **Two or more pairs are required.** An operation whose target value is the
  same in every pair it applies to is a constant; one whose value differs is
  **varies per clip**, and is kept at each draft's own value unless the user
  picks a value or a rule. One pair's value is never copied. A pair is
  refused when its label is a `_nopost` final, or its provenance says it is
  only the render pass of a two-pass run; pairs of different workflows (under
  80% of `(id, class)` shared) are refused.
- **Removals** absorb the rewiring they imply.
- **Candidate rules** are offered for an input, checked against every pair,
  and never applied unless chosen:
  - `ratio` — a fixed share of a related setting (27/35 of steps);
  - `preset-ratio` — the draft graph's own ratio between the two (19/25, the
    quality preset the long-form draft carries);
  - `draft-ratio` — the ratio the draft rendered with (6/8);
  - `lift-overrides` — the MiniMax composer's per-slot overrides cleared
    above the old global and up to the new one (the standalone app's
    `lift_overrides`), related to a numeric sibling on the same node.

  Settings are related when what they change in the render shares a node (the
  steps and switch point both reach the warmup sampler); a ratio rule is
  offered for the smaller setting, which follows the larger.

### The review screen

The diff is shown as plain rows, not as graph operations:

- "Turbo LoRA removed" (`LoraLoaderModelOnly`, 8-step LoRA)
- "Steps 8 → 35" — ☐ adjustable
- "Switch point 6 → 27 — follows Steps (19/25)"
- "Output 0.5 MP → 1.5 MP" — ☐ adjustable
- "Reference images 0.5 MP → 1.5 MP — follows Output"

Each row names its node's title or class. The user can drop a row, mark it
adjustable, or change a dependent's rule, and saves the recipe with a name.

### Acceptance

- The long-form switch point is flagged as a dependent of steps, and choosing
  "fixed ratio 19/25" reproduces 27 at 35 steps. **Met**: `preset-ratio`
  gives 27 at 35 steps and 38 at 50; `draft-ratio` (6/8) is offered and marked
  as not fitting.
- A per-clip RTX scale that differs between two example pairs is not adopted
  as a constant. **Met**: learned from a final that removed the RTX upscale
  and one that rescaled it, both are *varies per clip*.

## 3. Matching drafts to recipes

Status: **Implemented** (`matchRecipe`)

A draft matches a recipe when its API prompt is **close enough to an
example's fingerprint** (at least 80% of `(id, class)` pairs shared, Jaccard)
**and** contains **every target of every operation at the same node id and
class** (an `add` target must be absent, and what it links to present).
Otherwise the result names the reason in one line: "No LoraLoaderModelOnly at
node 667", "Node 667 is a UNETLoader, not the LoraLoaderModelOnly the recipe
changes", or "Not the recipe's workflow: 12% of its nodes match". Nothing is
queued without a matched recipe.

### Acceptance

- Every real Omni and long-form draft matches its recipe and not the other
  one. **Met** on the fixtures. That no V2V, LTX or VR180 render matches is
  checked when the library is scanned, in Phase 3.

## 4. Applying a recipe

Status: **Implemented** for the API prompt and UI workflow (`applyRecipe`);
saving and the provenance tag are Phase 2 (**Unimplemented**)

- Operations apply by node id with the class check, to a copy of the draft's
  API prompt. The draft is never modified. Removals rewire every consumer as
  recorded, or all consumers of the same output slot the same way; a consumer
  the examples never showed refuses the apply rather than guessing.
- **Added nodes** are rebuilt from the draft's own UI graph when the node
  exists there disabled — each UI node's `widgets_values_named` carries its
  settings under the exact API input names, dynamic combos included, which is
  how the standalone app rebuilds RIFE and RTX — keeping only the inputs the
  example's node had, and its links from the UI links. Otherwise the
  example's spec is used. A new input goes where the example has it, so a
  restored Any Switch input is first again.
- The **UI workflow** gets the example's node modes and UI-only widgets, and
  each widget whose API input changed follows it (found by its
  `widgets_values_named` position), so dropping a final on the ComfyUI canvas
  shows what rendered it. A missing UI target returns the API prompt with
  `workflowIssue` instead, as the standalone app did.
- Integers beyond 2^53 (seeds) survive: graphs are read and written with
  `main/comfy-graph-json.js`. Python's NaN is read as `null`.
- The final is saved **beside its draft under the draft's whole name**
  (`213533_00001_.mp4` → `213533_00001_final_1.5mp_35st_00001_.mp4`), with a
  provenance tag equivalent to the app's `requeue` tag: the draft's prompt and
  workflow, the recipe, and the settings used.

### Acceptance

- Applying the learned Omni and long-form recipes to their real drafts
  produces API prompts identical to the standalone app's conversions, apart
  from the provenance tag and the save prefix scheme. **Met**, apart from
  inputs the learner itself flags as varying per clip; see Implementation
  notes.

## 5. Checks before anything runs

Status: **Proposed**

Ported from the standalone app's `problems_in` and `plan`, against ComfyUI's
`/object_info`:

- every node class is installed, and every *required* input is present —
  including autogrow inputs, which arrive as `name.sub` keys
  (`images.image_0`);
- every combo value exists: models, LoRAs, and other combo inputs;
- every input file is still in ComfyUI's `input/`. This matters more than it
  looks: the MiniMax composer **silently drops** a missing reference slot and
  renumbers `<Picture N>`, so a missing file re-renders wrong rather than
  failing;
- a final does not already exist beside the draft;
- the draft is not already in the queue under another path.

A clip that fails a check shows the reason and is skipped; nothing is
submitted to find out.

## 6. Running

Status: **Proposed**

Ported from the standalone app's `Runner`, with its behaviour kept:

- **One clip on ComfyUI's queue at a time**, so the user's own generations slot
  in between, and reordering applies immediately.
- **Crash recovery** — a prompt lost with ComfyUI (no queue entry, no history
  after it returns) fails after three checks and the queue moves on; a failed
  clip retries only when the user asks. ComfyUI is never restarted by Video
  Swarm.
- **Adoption** — on restart, renders still on ComfyUI's queue are recognised by
  the draft prompt in their provenance tag.
- **Out-of-memory** — retried one size rung down, only for genuine OOM, with
  the classifier and test corpus described in `comfy-requeue.md` Section 6.
- **History** — every final recorded against its draft by embedded prompt, so
  moving either file loses nothing. A draft re-added after it was rendered is
  held with a link to its final, and "Render again" overrides.
- **Estimates** — `rate × steps × video seconds × MP^1.15`, the rate learned
  from this machine's own finished renders of the same recipe.

### Memory: single pass first

ComfyUI keeps every node's output until its prompt ends, and frames are
float32. After sampling, decode, colour stabilisation, RTX and RIFE outputs
all sit in RAM together beside ~38 GB of staged models; a 27 s long-form final
at 1.5 MP passed 125 GB and was killed.

The standalone app's answer is two passes — render without post-processing,
then post-process as its own prompt — but that only helps when memory is
actually released in between, and it mostly is not: `POST /free` runs only
between prompts, and even then about 52 GB stays resident. Only a freshly
restarted ComfyUI (~8 GB) had room for the second pass.

So version 1 is **single-pass only** (Decision 3), with a per-clip RAM
estimate that refuses a clip which will not fit rather than letting it swap or
die. Two-pass rendering, a RAM cap and the `_nopost_` fallback are Phase 4.
The standalone app now renders two passes by restarting ComfyUI's systemd
service between them; that works on the user's machine, but other users have
no such service, so it is not a version 1 foundation.

## 7. Where the engine lives

Status: **Unimplemented** — decided (Decisions 1 and 2)

The engine is main-process code behind an opt-in **ComfyUI connection**:

- off by default; when on, it accepts only **loopback** addresses
  (`127.0.0.1`, `::1`, `localhost`) and never the internet;
- all traffic in the main process behind bounded IPC; the renderer's CSP does
  not change, and the renderer never sends a URL, a graph or a path — only
  clip ids and recipe ids, as `comfy-requeue.md` Section 1 already specified;
- ComfyUI responses are untrusted input, parsed with the existing bounded
  readers.

An overnight queue must survive the window closing, which was the reason the
earlier design was rejected. While a queue is active, closing the window
**keeps Video Swarm running in the system tray** with a "Queue running — n
left" item; quitting from the tray asks first. With no active queue, closing
quits as today.

A **separate runner service** owning the queue, with Video Swarm as its front
end, was the alternative. It is not being built (Decision 2).

## 8. Interface

Status: **Proposed**

- **Queue** and **Finished** tabs in the workspace sidebar: order, estimates,
  per-clip check results, progress of the running clip, and Stop.
- **Recipe screen**: learned recipes, their review rows, and which drafts in
  the open collection each matches.
- **"Queue with recipe…"** on a selection: shows the matched recipe per clip,
  or why none matched, and the settings to use.
- **Clip badges**: queued, rendering, failed, and "has a final" — which the
  versions stack already shows independently of the queue.

## Decisions

Made by the user on 2026-09-28, replacing the three open questions this
proposal was written with.

1. **Yes to a ComfyUI connection in Video Swarm**: opt-in, off by default,
   loopback addresses only, never the internet. This amends the no-network
   stance recorded in [`comfy-requeue.md`](comfy-requeue.md).
2. **The engine runs inside Video Swarm's main process**, and the app stays in
   the tray while a queue is active. No separate runner service.
3. **Version 1 is single-pass only.** Two-pass rendering and RAM planning stay
   in Phase 4.

## Deferred

- Two-pass rendering, RAM cap and the `_nopost_` fallback (Phase 4).
- Recipes shared between profiles.
- Non-ComfyUI backends.
- Learning from a single pair without the user confirming dependents.

## Implementation order

1. **Recipe learner and matcher as pure modules.** **Implemented, Verified**
   (2026-09-28). Acceptance: learn Omni and long-form from real draft/final
   pairs, apply to held-out drafts, and compare with those finals' actual
   prompts.
2. **ComfyUI client, checks and runner**, ported with the app's tests against
   a fake ComfyUI: loopback-only opt-in connection, main-process engine, tray
   while a queue runs (Decisions 1 and 2).
3. **Interface**: Queue and Finished tabs, recipe screen, "Queue with recipe…",
   badges.
4. **Two-pass rendering, RAM cap and estimates** (after version 1, Decision 3).

## Implementation notes and decisions

### 2026-09-28 — Proposal

- Brief from the comfy-requeue session. Prototype preserved as
  `prototypes/learn_recipe.py`; its results and the four faults under
  Evidence come from re-running it here on real finals.
- The standalone app (`~/Work/comfy-requeue`, README, `requeue.py`, tests) is
  the reference implementation for Sections 5 and 6.

### 2026-09-28 — Decisions

- The user decided the three open questions (see Decisions): a loopback-only,
  opt-in ComfyUI connection; the engine in the main process with a tray while
  a queue runs; single-pass version 1. `comfy-requeue.md` records the amended
  network stance.

### 2026-09-28 — Phase 1: recipe learner and matcher

- `main/comfy-recipe.js`: `learnRecipe`, `matchRecipe`, `applyRecipe`,
  `pairFromRequeueTags` (a pair from a standalone final's `prompt`, `workflow`
  and `requeue` tags) and `liftOverrides`. Pure: no network, files or UI.
  Results are `{ recipe }` / `{ prompt, workflow, ... }` or `{ error: { code,
  message } }`; malformed input never throws.
- `main/comfy-graph-json.js`: graphs read and written with exact 64-bit
  integers (a re-render submits the draft's seed again).
- `comfy-generation-parser.js` exports `readComfyGraph` and `isSavingNode`,
  its socket typing and pass-through, so the learner reads graphs the way the
  Generation panel does. The panel's behaviour is unchanged.
- Fixtures: ten real finals (`main/__tests__/fixtures/recipes/`), reduced (UI
  layout and preview lists dropped, each final's UI workflow stored as a
  patch of its draft's) and sanitized (prompt text, media, model names,
  output prefixes and hashes replaced consistently across draft and final).
  They are not read from the output folder at test time.
- **Acceptance, Omni** (`comfyRecipeAcceptance.test.js`): learned from three
  pairs (two 0.5 MP drafts and a Hotel Fun draft with 1.0 MP references):
  remove the turbo LoRA (bypass into the Any Switch), `BasicScheduler.steps`
  → 35, composer `output_megapixels` and `ref_image_megapixels` → 1.5, and
  the switchboard's UI toggles; `slot_overrides` *varies per clip*. Applied to
  four held-out drafts (the three graph variants of the workflow and the other
  Hotel Fun draft), each API prompt equals its final's except
  `801.slot_overrides` on the three drafts that had an override to clear;
  choosing the offered `lift-overrides` rule makes all four prompts and
  their UI workflows (modes, widgets, links) identical to the finals. Run
  outside the repository against all 13 real Omni finals, the other ten also
  came out identical.
- **Acceptance, long-form**: learned from a single-pass final and the two-pass
  post-processed one: the TURBO PATH mute (LoRA and two primitives removed,
  each Any Switch dropping its turbo input), quality steps 35 and switch point
  27, composer 1.5 MP. The RTX upscale is *varies per clip* (removed by one
  final, rescaled to 1.172 by the other). Applied to the held-out final's
  draft, the prompt differs only in that RTX node and RIFE's input from it;
  choosing to remove it makes prompt and UI workflow identical.
- **Adding nodes** is checked on real graphs by running the long-form recipe
  in reverse: the TURBO PATH nodes and RTX upscale, muted or bypassed in the
  finals' UI graphs, are rebuilt from `widgets_values_named` and the UI links,
  and the result equals the original draft exactly.
- Things the learner cannot know, left to the user:
  - A value is constant when every example ends at it. Examples must show the
    variation: the long-form composer's `slot_overrides` is learned as a
    constant from those two pairs (one changed, one already clear), and the
    RTX removal would be a constant had both examples removed it. The
    review screen should show the evidence count beside each constant.
  - Which rule a *varies* input follows, and whether a constant that has
    candidate rules (the switch point) should follow a changed setting.
  - `lift-overrides` is the one rule that knows a node's value format (the
    MiniMax composer's override list); it is only offered when it reproduces
    every example.
  - UI-only mirrors of a setting (the Omni switchboard's steps primitive) keep
    the example's value when the user changes the setting; the API prompt is
    what renders.
  - UI operations cover top-level nodes; nodes inside subgraphs are applied in
    the API prompt only.

## References

- The earlier, rejected design and its reasons:
  [`comfy-requeue.md`](comfy-requeue.md).
- Reading graphs by socket type:
  [`generation-type-flow.md`](generation-type-flow.md).
- What a version is, and what must not change between versions:
  [`generation-versions.md`](generation-versions.md).
- Bounded native work, confirmations, transfer:
  [`review-workflow.md`](review-workflow.md).
- Prototype: [`prototypes/learn_recipe.py`](prototypes/learn_recipe.py).
