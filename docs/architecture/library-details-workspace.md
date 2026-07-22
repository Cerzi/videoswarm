# Library and Details Workspace Sidebar

Status: **Implemented and verified** (2026-07-20)
Last updated: 2026-07-20

## Summary

Video Swarm's left rail becomes a two-tab workspace for **Library** navigation
and selection-owned **Details**. Users may keep clip metadata docked beside the
grid, switch back to the folder tree without losing selection, or undock the
same editor into the existing draggable inspector.

The dock is a presentation choice, not a second metadata owner. Floating,
docked, and fullscreen surfaces reuse the same bounded metadata primitives and
always mutate the exact current selection or fullscreen target.

This pass also makes long Generation metadata collapsible, gives pinned roots
an unmistakable active star, and replaces misleading review-session language
with resume-point language.

## Goals

1. Offer stable Library and Details work modes without forcing a floating
   palette over a dense video grid.
2. Preserve the floating inspector for users who prefer spatially anchored
   details.
3. Keep one renderer selection and one metadata mutation target; never copy a
   video collection into sidebar state.
4. Avoid hidden generation reads, extra media elements, decoded resources, or
   masonry work.
5. Make review controls clearly usable before a resume point exists.
6. Keep the rail dense, keyboard accessible, responsive, and usable with
   thousands of clips.

## Interaction model

### Docking

- The floating inspector exposes **Dock** in its header.
- Docking opens the workspace sidebar, selects **Details**, closes the floating
  shell, and persists the profile-local presentation choice.
- **Undock** restores the floating inspector beside the current selection and
  returns the sidebar to **Library**.
- The active Library/Details tab is session-local. Selecting a different clip
  updates Details but never steals the Library tab after the user chose it.
- `I` and the context-menu **Open details** action reveal the user's chosen
  presentation: they open the docked Details tab or the floating inspector.
- Closing the workspace sidebar hides docked details without changing the
  docking preference. `I` makes it reachable again.
- A zero selection closes the floating inspector. The dock remains available
  and shows a concise selection prompt rather than retaining stale clip data.

### Fullscreen

Fullscreen keeps its modal-owned Details dock. The application root is inert
while the native dialog is open, so reusing or forcing the background sidebar
would be inaccessible. Both surfaces reuse the same metadata sections and
collapse behavior, but fullscreen keeps its explicit single-clip ownership.

### Generation disclosure

- Generation has a real accessible disclosure control on every metadata
  surface.
- Header badges and **Re-read** stay available while the body is collapsed.
- Expansion state is retained per ordinary/fullscreen surface for the current
  renderer session and survives clip navigation; it is not persisted.
- A collapsed or hidden section does not start native metadata extraction.
- There is no animated height transition: large prompts and workflows can be
  removed from layout immediately.

### Review resume points

Review states, ratings, tags, and their shortcuts always work. They are not
enabled by a session button. The first successful positive review/rating action
automatically creates the lightweight checkpoint described in
`continue-review-sessions.md`.

User-facing wording calls that checkpoint a **resume point** or **saved review
position**:

- With no checkpoint, the toolbar says review is ready and offers **Find
  Unreviewed** as an optional way to save the current view and jump to a target.
- Pinned roots remain navigation rows and show passive total and unreviewed clip
  counts. Review and resume actions live only in the review toolbar above.
- A matching checkpoint is **Review position saved** and keeps **Find
  Unreviewed** available; a remote one is **Resume point saved elsewhere**.
- The one-item overflow menu is removed. **Clear resume point...** directly
  opens the existing confirmation and never removes ratings, review states, or
  tags.

## Component and state ownership

- `App` owns `metadataInspectorMode` (`floating` or `docked`), the session-only
  active sidebar tab, ordinary/fullscreen Generation disclosure state, and the
  existing exact selection.
- Profile settings persist only `metadataInspectorMode`. Sidebar visibility,
  active tab, floating coordinates, selected IDs, and disclosure state remain
  transient.
- `WorkspaceSidebar` owns no collection or metadata state. It renders the
  existing library content and the supplied selection editor in two accessible
  tabpanels.
- `MetadataInspectorContent` owns only bounded form state such as the tag input.
  It receives selected records and callbacks from `App` and is shared by the
  floating and docked shells.
- Fullscreen continues to use its modal-owned target/controller and never reads
  the background dock's selection.

## Persistence and validation

`metadataInspectorMode` is added to the existing bounded, atomic profile
settings JSON. Main-process normalization allowlists only `floating` and
`docked`, defaulting malformed or missing values to `floating`. The existing
settings IPC is sufficient; no database migration or new channel is added.

## Layout and accessibility

- The wide rail remains approximately 270–340 px and uses one complementary
  landmark with a named tablist and tabpanels.
- Tabs support pointer activation, Arrow Left/Right, Home, and End; inactive
  panels are removed from keyboard and accessibility navigation.
- At narrow widths the rail becomes a bounded opaque drawer over the gallery
  instead of reducing the video grid to an unusable strip. No backdrop blur is
  used on Linux.
- Docked Details has one outer scrollbar. The floating editor remains bounded
  to 15 ranked tag suggestions, while docked and fullscreen Details may show up
  to 100. Popular tags consume available rail space; nested scrolling is used
  only when the rail itself cannot contain the content.
- Focus remains on the invoking control unless an explicit details command
  requests the tag input. Selection changes do not move focus.

## Performance constraints

- Docking does not create media nodes, decoder leases, thumbnails, or another
  renderer process.
- Hidden Library/Details panels perform no generation extraction.
- The sidebar stores no video arrays, DOM nodes, decoded state, or unbounded
  tag/workflow data.
- Tab changes do not alter masonry order, virtual mounting, or scroll position.

## Verification checklist

1. **Implemented** — Shared floating/docked metadata editor with exact
   mutation targets and bounded tag suggestions.
2. **Implemented** — Accessible Library/Details tabs, empty Details state,
   Dock/Undock, `I`/context routing, and profile-local mode persistence.
3. **Implemented** — Lazy collapsible Generation content across ordinary and
   fullscreen surfaces.
4. **Implemented** — Yellow active pin stars and clarified resume-point copy.
5. **Implemented** — Focused component/App/settings tests, full Vitest,
   syntax checks, ESLint, Vite build, and `git diff --check`.

## Verification record

Verification completed on 2026-07-20:

- Focused sidebar, inspector-content, Generation, review-control, fullscreen,
  settings, and App ownership suites passed.
- Full Vitest passed: 1,058 tests, with 21 existing intentional skips.
- ESLint completed with zero warnings.
- The Vite production renderer build completed successfully. Its existing
  large-chunk advisory remains informational and is unrelated to this slice.
- `main.js`, `preload.js`, the new CommonJS settings helper, and the updated
  Continue Review Electron smoke passed syntax checks.
- `git diff --check` passed.

## Deferred work

- Resizable sidebar width and user-reorderable tabs.
- Multiple named review passes per root.
- Persisted Generation disclosure state.
- A fullscreen filmstrip or multi-clip comparison workspace.
- Customizable shortcuts.
