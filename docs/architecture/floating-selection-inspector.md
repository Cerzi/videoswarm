# Floating Selection Inspector

Status: **Implemented** (2026-07-14)

## Summary

Replace the bottom metadata drawer with a non-modal floating selection
inspector. The inspector opens beside the primary selected video, chooses the
side opposite the fitted right-click menu when both are present, can be moved
freely within the gallery, updates as the selection changes, and closes when
the selection is cleared or the user presses its close button.

This is a renderer-local utility surface, not another Electron
`BrowserWindow`. A second native window would add a renderer process, focus and
IPC synchronization, shutdown ownership, and a meaningful memory cost without
improving this in-app workflow. The floating inspector provides window-like
behavior while retaining the existing explicit Electron boundary.

## Problem

The current bottom drawer has several costs for a high-throughput video review
workflow:

- Opening it changes gallery bottom padding and triggers layout/scroll
  stabilization even though the metadata controls do not need layout space.
- It separates the selected clip from its details, forcing repeated eye travel
  between the grid and the bottom edge.
- Passive auto-open focuses the tag input, which can steal P/R/X/U review
  shortcuts from the grid.
- Closing the drawer sets a global dismissal state that can suppress it for
  later, unrelated selections.
- Clearing the selection can leave an empty drawer open.
- The resize affordance consumes space but still leaves the drawer constrained
  to one edge of the application.

The useful metadata behavior should remain: single-clip file and generation
information, multi-select aggregate state, ratings, review state, shared and
partial tags, tag suggestions, and the Focus action.

## Goals

1. Keep details spatially close to the selected clip without obscuring it.
2. Let the user move the inspector once and treat it as a stable tool palette
   while reviewing more clips.
3. Keep selection, displayed targets, and mutation targets identical.
4. Avoid masonry reflow, scroll jumps, extra media elements, and retained card
   DOM.
5. Remain usable with keyboard, pointer, touch, narrow windows, the library
   sidebar, and a simultaneous context menu.
6. Preserve all existing metadata, review, rating, tag, and generation-sidecar
   behavior.

## Non-goals

- The inspector does not preview or play a second copy of the selected video.
- It is not an operating-system window and does not leave the application.
- Its coordinates are not persisted between application sessions.
- It does not pin virtualized cards or media elements in memory.
- It does not continuously follow a card while the gallery scrolls.
- This change does not redesign the underlying metadata schema or mutation
  APIs.

## Interaction model

### Selection lifecycle

- A transition from no selection to one or more selected clips opens the
  inspector automatically without moving keyboard focus.
- The primary anchor is `selection.anchorId` when that ID remains selected and
  mounted. Otherwise it is the first mounted selected card in masonry order,
  then the first selected ID as a non-mounted fallback.
- While the inspector is open, selection changes update its content and action
  targets immediately.
- In automatic placement mode, a new primary selection re-anchors the
  inspector once. After a user drag, manual placement is stable across
  selection changes so the application does not fight the user.
- A zero selection closes the inspector, clears transient tag input and
  placement state, and resets dismissal for the next selection.
- The close button closes the inspector without clearing selection. Dismissal
  applies only to the exact current selection; a materially different
  selection opens again.
- The context-menu **Open details** command and the `I` shortcut explicitly
  reopen the current selection.
- Folder, root, profile, filter-pruning, and trash flows already remove invalid
  selected IDs. Reaching zero through any of those paths follows the same close
  lifecycle.

### Context-menu target consistency

Right-click does not change selection by itself. When **Open details** is
chosen on an unselected clip and the current selection contains zero or one
item, that context clip becomes the sole selection before the inspector opens.
If a multi-selection already exists, it remains the inspector target because
the context menu explicitly presents batch metadata actions.

The inspector must never render one set of clips while rating, review, or tag
actions mutate a different set.

### Focus behavior

- Passive selection and passive re-anchoring do not move focus.
- The explicit context-menu command may focus the tag input because the command
  represents an intent to manage details.
- The inspector is non-modal: there is no focus trap, and grid navigation and
  review shortcuts remain available whenever an input is not active.
- Escape closes the inspector when focus is inside it. Context menus and modal
  dialogs retain higher-priority Escape handling.
- Closing does not clear selection. Focus remains on the connected trigger when
  possible, otherwise the gallery remains the active work surface.

## Placement model

### Coordinate space and bounds

The inspector is an absolute overlay inside `.content-region`. Coordinates are
stored relative to the content region, while valid bounds come from
`.content-region__gallery`. This keeps the surface below the navbar and out of
the library sidebar without introducing a body portal or global window state.

The app resolves card geometry on demand from
`.video-item[data-video-id]`. It stores IDs and numeric rectangles only; it
does not retain DOM nodes across virtualization changes.

### Candidate selection

A pure placement helper receives:

- selected-card rectangle, when mounted;
- measured inspector width and height;
- gallery bounds;
- the actual post-clamp context-menu rectangle, when present;
- safe margin and anchor gap, normally 12 px.

It evaluates left and right candidates aligned with the card top, followed by
below and above fallbacks. Candidates are scored for:

1. overflow outside gallery bounds;
2. overlap with the fitted context menu;
3. overlap with the selected card;
4. distance from the selected card.

When a context menu is visible, its horizontal centre determines its side of
the card and the inspector prefers the opposite side. The helper uses the
menu's measured, fitted rectangle rather than the raw pointer because menus at
viewport edges may open in the opposite direction. If both surfaces cannot fit
on separate sides, the least-overlapping fully visible fallback wins.

Ordinary selection prefers the side with more usable room, with left as the
tie-breaker because the normal context-menu direction is down/right. Every
result is clamped so the complete inspector and close button stay reachable.

If the anchor card is virtualized or filtered out, the inspector keeps its last
safe position. On first open without a mounted anchor it uses a stable
top-right gallery fallback and retains the Focus action.

### Scroll and resize

The inspector does not chase its card during gallery scrolling. Continuous
measurement would produce jitter and add layout reads to a performance-critical
path. Focus can scroll the primary selection into view.

Window resize, sidebar width changes, and inspector content-size changes
re-clamp the current coordinates. They do not discard a deliberate manual
position unless it is no longer valid.

## Dragging

- Non-interactive title-bar space is the pointer drag handle. Buttons, links,
  and inputs never begin a drag.
- Only the primary pointer starts a session. Pointer capture is used, move work
  is coalesced to one animation frame, and move/up/cancel listeners plus any
  pending frame are removed on completion, close, or unmount.
- The entire inspector is clamped within current gallery bounds throughout the
  drag. The cursor changes between grab and grabbing, and text selection is
  suppressed only for the active session.
- A focused title bar supports Arrow keys in 16 px steps and Shift+Arrow in
  48 px steps. Home resets automatic placement beside the current selection.
- Manual position lasts for the current open session. Close/reopen restores
  context-aware automatic placement rather than persisting stale screen
  coordinates.

## Responsive behavior

The standard inspector uses a dense width of approximately
`clamp(340px, 32vw, 430px)` and a maximum height bounded by the gallery. Its
title bar remains fixed and its body scrolls independently.

When the gallery is narrower than 680 px or cannot contain the minimum panel
width beside content, the surface becomes a bounded bottom sheet:

- width is the gallery width minus 16 px;
- height is capped near 68% of the gallery;
- drag is disabled because it would not create useful alternative placement;
- close, Focus, metadata actions, and internal scrolling remain available;
- masonry padding and geometry still do not change.

Returning to a wider gallery restores automatic anchored placement.

## Visual design

- Use an opaque, high-contrast surface with a subtle border and moderate
  shadow. Do not use `backdrop-filter`; blur over many live videos is costly on
  Linux and software-decoding systems.
- Header order: grip and Details title, concise selection subtitle, Focus, and
  a clear 32 px or larger close button.
- Truncate long filenames with a title tooltip. Announce only the changed
  filename or selection count in a polite live region rather than re-announcing
  the entire inspector.
- Stack rating, review, tags, suggestions, and generation information for the
  narrower width. Keep existing status colors and visible keyboard hints.
- Use a short opacity/scale entrance and disable it under
  `prefers-reduced-motion`.
- The context menu remains above the inspector; fullscreen and application
  dialogs remain above both.

## Accessibility

- Use a non-modal `<aside role="complementary" aria-label="Selection details">`.
- The close button is named **Close selection details**.
- The title bar exposes keyboard move instructions and visible focus styling.
- Pointer dragging is never the only way to move or recover the surface.
- All coordinates are clamped so keyboard and close controls cannot be stranded
  offscreen.
- Existing form labels, button pressed state, input typing exemptions, and
  review shortcut behavior remain intact.

## Performance and ownership constraints

- Opening and closing must not change viewport padding, masonry height,
  scrollTop, card count, or media scheduler ownership.
- Placement performs bounded layout reads only on open, automatic anchor
  change, explicit context-menu placement, and resize.
- Dragging must not re-render the metadata body for every raw pointer event.
- No observer or global listener may survive the open inspector or an active
  drag session.
- Generation metadata remains enabled only for one selected instance while the
  inspector is open.
- No selected card is pinned in the virtual window solely to anchor the
  inspector.

## Implementation plan

1. **Implemented** — Pure viewport-space placement and clamping helpers score
   left, right, below, and above candidates, avoid the fitted menu and anchor,
   provide a stable unmounted-card fallback, and select the narrow sheet.
2. **Implemented** — `ContextMenu` reports its measured, post-clamp root
   rectangle once per distinct placement and suppresses stale or duplicate
   reports during request transitions.
3. **Implemented** — App now owns a selection-scoped open/dismiss lifecycle:
   deselection closes, close preserves selection, a changed selection opens,
   and a single unselected context target is adopted before details open.
4. **Implemented** — `MetadataPanel` is now the non-modal floating inspector
   with bounded pointer/rAF dragging, Arrow/Shift/Home movement,
   ResizeObserver/window/sidebar reclamping, Escape/X close, and a non-draggable
   narrow sheet while retaining all metadata controls.
5. **Implemented** — Dock sizing, collapsed hints, metadata transition holds,
   and conditional viewport padding were removed. Opening details does not
   schedule masonry work or change gallery geometry.
6. **Implemented** — Modifier-free `I` reopens details for a non-empty
   selection and is rendered by the shared shortcut catalog/help dialog.
7. **Implemented** — Focused geometry, component, context-menu, hotkey, help,
   and App lifecycle regressions cover opposite placement, clamping, cleanup,
   scoped dismissal, focus-token consumption, context targeting, narrow mode,
   and invariant viewport padding/scroll state.

## Implementation notes

- The implementation remains one renderer-local overlay; it creates no second
  Electron window, renderer process, video element, or persistent coordinate
  store.
- App retains only selection IDs and plain placement rectangles. Card elements
  are queried on demand from the bounded virtual window and are never retained.
- Passive selection does not increment the input focus token. Explicit context
  detail management consumes each token once, so a later `I` reopen does not
  unexpectedly focus the tag field.
- The context menu remains visually above the inspector. Its actual fitted
  rectangle, rather than the raw pointer location, drives opposite-side
  placement at viewport edges.

## Acceptance criteria

1. Selecting a visible clip opens a fully visible inspector beside it without
   changing masonry geometry, viewport padding, or scroll position.
2. A context-menu-origin open places the inspector opposite the actual fitted
   menu whenever space permits; constrained fallbacks stay visible and avoid
   unnecessary overlap.
3. New selections update content and action targets. Automatic placement
   follows the new primary selection once, while manual placement stays stable.
4. Deselect closes; close does not deselect; the same selection stays
   dismissed; a changed selection auto-opens; explicit Open details or `I`
   reopens it.
5. An unselected context target becomes the displayed and mutated target for a
   zero/single selection, while existing multi-select batches remain intact.
6. Pointer and keyboard dragging clamp correctly. Resize and content growth
   never strand the title bar or close button, and all transient resources are
   cleaned up.
7. Passive opening never steals focus. Escape, accessible naming, visible focus
   rings, typing exemptions, and live announcements have focused coverage.
8. Narrow galleries use the non-draggable sheet fallback and return to anchored
   placement when space is restored.
9. Existing single/multi metadata, rating, review, tag, suggestion, generation,
   and Focus behaviors continue to pass.
10. No additional video element, retained card DOM reference, persistent screen
    coordinate, unbounded listener, or second Electron window is introduced.
