# Prototypes

Reference material, not shipped code. Nothing in the app imports, packages or
runs these files. They are kept because they are the evidence behind two
design documents and were written outside this repository, in a scratch
directory that does not survive a reboot.

Both are stdlib Python and read a ComfyUI MP4's container tags with `ffprobe`.

- `typeflow.py` reads a render's checkpoint, LoRAs, prompt, seed and steps by
  following socket **types** from the embedded UI `workflow`, with no list of
  known node classes. See
  [`../generation-type-flow.md`](../generation-type-flow.md).
- `learn_recipe.py` learns a re-render recipe as the difference between a
  draft's API prompt and its quality version's, read from a finished re-render
  that carries both (`prompt` and `requeue.source_prompt`). See
  [`../comfy-queue-integration.md`](../comfy-queue-integration.md).

Usage, for either: `python3 <script>.py <clip.mp4> [...]`.

Both came from the standalone `comfy-requeue` app (`~/Work/comfy-requeue`),
which remains the working implementation of re-rendering until the design in
`comfy-queue-integration.md` is decided.
