# VideoSwarm Shift-Click Multi-Selection Specification

## 1. Overview
VideoSwarm displays videos in a masonry-style wall where card height varies per item. Because masonry layouts have no reliable row structure, multi-selection behaviors must follow the linear ordering of the underlying dataset. This document describes the user experience, data model, and interaction rules required to deliver shift-click range selection that matches expectations set by desktop operating systems and photo management applications.

## 2. Goals
- Deliver intuitive multi-selection semantics comparable to Google Photos, Apple Photos, Windows Explorer, and macOS Finder.
- Base every selection decision on the canonical linear order rather than on-screen positions.
- Keep selection state stable across viewport resizing, masonry reflows, filtering, and sorting.
- Provide hooks for visual feedback and accessibility features that communicate the current selection.

## 3. Definitions
### 3.1 Linear Order
A stable array containing every video item exactly once, sorted according to the active sort mode (e.g., newest first, alphabetical). Masonry layout calculations must read from but never alter this order.

### 3.2 Selection Anchor
The linear index of the last item that was selected by a non-toggle interaction (single click or shift-click). It defines the starting point for shift-click ranges.

### 3.3 Toggle Selection
Any selection change triggered via `Ctrl`/`Cmd` + click. Toggle actions add or remove a single item without affecting the anchor.

## 4. Supported User Interactions
### 4.1 Single Click
- Clears existing selection.
- Selects the clicked item exclusively.
- Sets the selection anchor to the clicked item's linear index.

### 4.2 Ctrl/Cmd + Click
- Toggles the clicked item's selected state.
- Leaves the current selection anchor unchanged.

### 4.3 Shift + Click
- Computes the contiguous linear range between the selection anchor and the clicked item.
- Replaces the current selection with that range (unless optional merge behavior is enabled).
- Updates the anchor to the clicked item's index.

### 4.4 Optional Shift-Hover Preview
- While the user hovers with the `Shift` modifier held, preview-highlight the range that would be selected if clicked.
- Preview must use the same linear-order algorithm as shift-click.

## 5. Prohibited Behaviors
- Do not interpret shift-click as a geometric bounding-box selection.
- Never rely on the masonry layout's spatial arrangement to infer selection ranges.
- Avoid behaviors that cause the same shift-click action to yield different results after a reflow.

## 6. Data Requirements
- Maintain a canonical, ordered array of video metadata that represents the user's chosen sort mode.
- Each rendered card must receive its immutable linear index.
- Persist selection state separately from layout-specific data structures.
- Ensure updates to the masonry layout do not mutate selection state or linear indices.

## 7. Shift-Click Algorithm (Conceptual)
1. Retrieve `anchorIndex` (if undefined, fall back to `clickedIndex`).
2. Determine `clickedIndex` from the card's stored linear index.
3. Compute `startIndex = Math.min(anchorIndex, clickedIndex)` and `endIndex = Math.max(anchorIndex, clickedIndex)`.
4. Select every item whose linear index is in `[startIndex, endIndex]`; deselect all others unless optional merge rules apply.
5. Update the selection anchor to `clickedIndex`.

## 8. Optional Extended Behavior
- When `Ctrl/Cmd + Shift + click` is detected, merge the computed range with the existing selection instead of replacing it.
- Define deterministic tie-breaking for conflicts when optional merge behaviors intersect with toggled items.

## 9. Visual Feedback Requirements
- Provide a clear selected-state indicator for all selected cards.
- Offer an optional lighter preview highlight for range previews.
- Consider displaying a toast or status indicator when large ranges are selected.
- Ensure selected and preview states are conveyed via ARIA attributes for screen readers.

## 10. Viewport and Layout Behavior
- Selection state must persist through masonry reflows, responsive breakpoint changes, and virtualized rendering updates.
- Changing sort order preserves the current selection set but resets the anchor to `undefined` so that the next shift-click establishes a new reference point.

## 11. Edge Cases
- If no anchor exists (e.g., first interaction), the clicked item becomes both selected and the anchor.
- If the anchor item is removed or filtered out, promote the earliest selected item's index to anchor; if none remain, the next single click sets a fresh anchor.
- Items outside the viewport must remain selectable via shift-click based on linear indices.

## 12. Testing Requirements
- Unit-test anchor updates, toggling logic, and range calculations across sort orders.
- Verify that linear ordering remains stable as items load, unload, or reflow.
- Compare interaction sequences against OS gallery applications to confirm matching expectations.
- Add regression tests ensuring selection persists through viewport resizes and data updates.

## 13. Summary
Shift-click multi-selection must always respect the dataset's linear order and never rely on geometry. Accurate anchor management and separation between layout and selection data ensure deterministic, OS-consistent behavior across all user interactions.
