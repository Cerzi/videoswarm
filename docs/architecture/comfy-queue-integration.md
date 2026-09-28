# Re-rendering in Video Swarm with Learned Recipes

Status: **Proposed — awaiting three decisions by the user (see Open
decisions); nothing is built**
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

Everything here reverses a recorded decision, so it is a proposal. Three
choices are the user's and are written as open questions, not answered.

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
  switches the connection on (Open decision 1).
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

Status: **Proposed**

A recipe is a small, profile-local document:

- **Workflow fingerprint** — the set of `(node id, class)` pairs of the
  draft's executed graph. Node ids are stable within one workflow file across
  every render made from it.
- **Operations**, each targeting a node id *and* its class:
  - `remove` — bypass a node, rewiring each consumer to the same-typed input it
    passed through (the standalone app's bypass semantics: refuse the whole
    recipe if an output has no same-typed input);
  - `add` — a node present only in the quality version, with its inputs;
  - `set` — an input's new literal value;
  - `rewire` — an input's new source, only where it is not already implied by a
    `remove` (point 2 above).
- **Identity exclusions** — never part of a recipe: seeds, prompt text, input
  media, output filenames and save prefixes. The generation key's parts
  ([`generation-versions.md`](generation-versions.md)) are exactly what must
  stay the same, and the diff ignores them.
- **Adjustable settings** — operations the user marked as settings rather than
  constants ("Steps", "Output MP"), with their example values as defaults.
- **Dependents** — settings that follow another (a switch point following
  steps), with the rule that relates them (Section 2).
- **Provenance** — where it was learned from, and when.

### Acceptance

- Learning from the real Omni and long-form pairs yields exactly the
  operations listed under Evidence, and nothing from the identity exclusions.

## 2. Learning a recipe

Status: **Proposed**

A pair can come from three places:

1. **A versions stack** — "Make recipe from this pair" on two clips that the
   generation key already groups, choosing which is the draft.
2. **The same workflow exported in both modes** — two `.json` files; no render
   needed, and no per-clip decisions mixed in. This is the cleanest source.
3. **Existing finals** of the standalone app — both graphs in one file.

Learning canonicalises and diffs as the prototype does, finding outputs, pass-
through and switches by socket type. It then corrects for points 1–3 above:

- **Per-clip decisions** are separated by learning from **two or more pairs**
  when available: an operation present in every pair with the same target
  value is a constant; one whose value varies across pairs is a per-clip
  decision and is shown as such, not silently adopted. A `_nopost_` final is
  never used as an example.
- **Removals** absorb the rewiring they imply.
- **Dependents** are proposed only when they can be told apart: with one pair,
  a numeric change that shares a node or a stage with another (steps and a
  switch point on the same sampler) is flagged "may follow Steps", and the
  user picks the rule — *keep the example's value*, *scale with it*
  (6/8 × new steps), or *fixed ratio* (19/25 × new steps). With several pairs
  the ratio is fitted and shown.

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
  "fixed ratio 19/25" reproduces 27 at 35 steps.
- A per-clip RTX scale that differs between two example pairs is not adopted
  as a constant.

## 3. Matching drafts to recipes

Status: **Proposed**

A draft matches a recipe when its executed graph contains **every target of
every operation at the same node id and class**. Extra or missing nodes
elsewhere do not prevent a match; the workflow fingerprint only ranks
candidates when several recipes match.

Every clip shows which recipe matched, or why none did, in one line: "No
recipe: this workflow has no `LoraLoaderModelOnly` at node 667". Nothing is
queued without a matched recipe.

### Acceptance

- Every real Omni and long-form draft in the library matches its recipe, and
  no V2V, LTX or VR180 render does.

## 4. Applying a recipe

Status: **Proposed**

- Operations apply by node id with the class check, to a copy of the draft's
  API prompt. The source file is never written.
- **Added nodes** are rebuilt from the draft's own UI graph when the node
  exists there disabled — each UI node's `widgets_values_named` carries its
  settings under the exact API input names, dynamic combos included, which is
  how the standalone app rebuilds RIFE and RTX — and otherwise copied from the
  example.
- The final's embedded **UI workflow** gets the example's node modes, so
  dropping a final on the ComfyUI canvas shows what rendered it.
- The final is saved **beside its draft under the draft's whole name**
  (`213533_00001_.mp4` → `213533_00001_final_1.5mp_35st_00001_.mp4`), with a
  provenance tag equivalent to the app's `requeue` tag: the draft's prompt and
  workflow, the recipe, and the settings used.

### Acceptance

- Applying the learned Omni and long-form recipes to their real drafts
  produces API prompts identical to the standalone app's conversions, apart
  from the provenance tag and the save prefix scheme.

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

So this design proposes **single-pass only in version 1**, with a per-clip RAM
estimate that refuses a clip which will not fit rather than letting it swap or
die. Two-pass rendering, a RAM cap and the `_nopost_` fallback are Phase 4
(Open decision 3).

## 7. Where the engine lives

Status: **Proposed — Open decisions 1 and 2**

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

The alternative (Open decision 2) is a **small separate runner service** that
owns the queue and ComfyUI connection, with Video Swarm as its front end. It
survives Video Swarm quitting and restarts cleanly, at the cost of a second
process to install, start and keep compatible.

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

## Open decisions

These are the user's. The design does not assume an answer.

1. **Local ComfyUI connectivity in Video Swarm — yes or no?** Video Swarm has
   no network capability today, and `comfy-requeue.md` recorded that as a
   reason to keep re-rendering outside it. A loopback-only, off-by-default
   connection is the smallest opening, but it is still the first one.
2. **Engine inside Video Swarm with a tray icon, or a separate small runner
   service?** Inside is one install and one process; separate survives Video
   Swarm quitting and keeps the GUI's lifecycle simple.
3. **Version 1 single-pass only?** Single-pass is simpler and safe with a RAM
   refusal, but refuses long 1.5 MP long-form finals that the standalone app
   can already render in two passes on a freshly restarted ComfyUI.

## Deferred

- Two-pass rendering, RAM cap and the `_nopost_` fallback (Phase 4).
- Recipes shared between profiles.
- Non-ComfyUI backends.
- Learning from a single pair without the user confirming dependents.

## Implementation order

1. **Recipe learner and matcher as pure modules.** Acceptance: learn Omni and
   long-form from real draft/final pairs, and reproduce the standalone app's
   conversions exactly on its own test drafts
   (`~/Work/comfy-requeue/tests/*.json`). No network, no UI, and no open
   decision needed.
2. **ComfyUI client, checks and runner**, ported with the app's tests against
   a fake ComfyUI. Needs Open decisions 1 and 2.
3. **Interface**: Queue and Finished tabs, recipe screen, "Queue with recipe…",
   badges.
4. **Two-pass rendering, RAM cap and estimates.** Needs Open decision 3.

## Implementation notes and decisions

### 2026-09-28 — Proposal

- Brief from the comfy-requeue session. Prototype preserved as
  `prototypes/learn_recipe.py`; its results and the four faults under
  Evidence come from re-running it here on real finals.
- The standalone app (`~/Work/comfy-requeue`, README, `requeue.py`, tests) is
  the reference implementation for Sections 5 and 6.

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
