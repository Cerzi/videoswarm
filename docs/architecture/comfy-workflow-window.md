# ComfyUI Workflow Window

Status: **Implemented, unverified by a human** (2026-10-17)

## Summary

To see how a clip was made, the user used to drag it onto ComfyUI in a
browser, look, and close the tab again. Video Swarm now opens the clip's
embedded workflow in a window of its own showing the user's local ComfyUI,
loaded exactly as a dropped file would be. The window is ComfyUI's real
editor, so everything it can do with a workflow works: inspect nodes, edit,
queue, save.

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Deferred** means deliberately out of scope until stated evidence exists.

## Why ComfyUI's own page

A read-only viewer of our own (rendering the graph with LiteGraph and node
definitions from `/object_info`) was estimated at two to three days and would
always lag ComfyUI: custom node widgets, groups, subgraphs and the frontend's
changes would each need following. ComfyUI's page already draws every graph
the user's install can load. The cost is that ComfyUI must be running, which
it is whenever the user is generating.

## Behaviour

- **Where.** *Open workflow in ComfyUI* in a clip's context menu (MP4 and MOV
  clips whose prompt was read, or not read yet), and **Workflow** in the
  Generation panel when the payload is embedded in the file.
- **Which ComfyUI.** The address in *Preferences › ComfyUI*, default
  `http://127.0.0.1:8188`. Only loopback addresses are accepted, as for the
  re-render queue; re-rendering need not be switched on.
- **One window.** The first open creates it; later opens load into it and
  bring it forward. `Ctrl+W` closes it, and it closes with the main window.
- **Which graph.** The editor workflow when the clip carries one, loaded with
  `app.loadGraphData` and named after the clip. A clip with only an API prompt
  is loaded with `app.loadApiJson` where the frontend has it.
- **Readiness.** Main checks ComfyUI answers (`/queue` and two node
  definitions, nothing queued) before opening, then waits up to 30 s for the
  page's app object before loading. Failures say what to do: start ComfyUI,
  set its address, or that the clip carries no workflow.

## Isolation

The window shows another program's web page, including whatever its custom
nodes run, so it gets nothing of Video Swarm's:

- No preload, a sandboxed renderer, context isolation, no Node integration,
  no `<webview>`.
- Its own in-memory session (`videoswarm-comfyui`): no cookies or storage
  shared with Video Swarm or kept between runs.
- **Requests only to that ComfyUI**: its origin and its WebSocket on the same
  host and port (plus `data:` and `blob:`). Everything else is cancelled, so
  Video Swarm still makes no request beyond this machine. ComfyUI features
  that reach the internet (templates, release notes, the manager's registry)
  do not work in this window.
- Navigation away from ComfyUI's origin and new windows are refused.
- Permissions are refused except writing to the clipboard.

The renderer names the clip by catalog row; main checks the row is present,
that its path is one the renderer was shown, reads the embedded payload
in-process, and passes the graph to the page as a JSON string literal for the
page to parse.

## Acceptance

- A clip with an embedded workflow opens in the window, laid out as in
  ComfyUI, without touching the user's browser tabs.
- A second clip loads into the same window.
- With ComfyUI stopped, the user is told to start it or set its address.
- The window cannot reach the internet or navigate away from ComfyUI.

## Deferred

- WebM and MKV clips, whose payload needs ffprobe.
- Opening a sidecar JSON's workflow.
- A read-only mode. ComfyUI's page can queue the loaded workflow; that is the
  user's own ComfyUI acting on the user's request.
