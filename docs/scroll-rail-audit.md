# Custom Scroll Rail Audit & Refactor Specification

## Executive Summary
- The current custom `ScrollRail` overlays the masonry viewport but derives its scroll model from `orderForRange`, which collapses to only the rendered subset once the layout completes. This truncates offsets, so the rail can only scrub within the currently mounted items, causing the thumb to disappear after a short drag and preventing access to the full library.
- Height estimates, index lookups, and scroll targets all share the same truncated data, so the rail continually re-clamps user input back into the visible window while the progressive renderer throttles new mounts. The result is a rail that feels broken even though the underlying masonry still supports deep scroll positions.
- To support a sort-agnostic timeline we need a dedicated layout data model that understands the full `orderedVideos` sequence, merges real measurements when available, exposes deterministic projections for unmeasured items, and coordinates with the progressive list so items are mounted before we jump to them.
- This document inventories the existing subsystems (`useVideoCollection`, `useMasonryLayout`, `useChunkedMasonry`, and `ScrollRail`), explains the failure modes, and proposes a refactor plan that separates global ordering from the virtualized viewport while keeping the existing performance optimisations.

## Current Architecture
### Data & Rendering Pipeline
1. **Progressive rendering (`useVideoCollection`)** – wraps `useProgressiveList`, resource management, and play orchestration. It exposes `videosToRender`, which is the only subset actually mounted in the grid. Growth is throttled by idle time, long-task detection, and optional `maxVisible` hints.【F:src/hooks/video-collection/useVideoCollection.js†L1-L133】【F:src/hooks/video-collection/useProgressiveList.js†L1-L200】
2. **Masonry layout orchestrator (`useMasonryLayout`)** – sorts and groups the filtered list, tracks viewport metrics, computes progressive visibility caps, and relays layout completions from the chunked masonry runtime. It currently returns both `orderedIds` (the full logical ordering) and `visualOrderedIds` (the order of DOM nodes reported by `useChunkedMasonry`). It then chooses `orderForRange = visualOrderedIds.length ? visualOrderedIds : orderedIds` for downstream consumers such as stable anchoring and the scroll rail.【F:src/app/hooks/useMasonryLayout.js†L200-L375】【F:src/app/hooks/useMasonryLayout.js†L366-L375】
3. **Chunked layout engine (`useChunkedMasonry`)** – measures the current DOM nodes, writes absolute positions, and reports `(id, x, y, height)` tuples for each mounted card. It also mirrors an estimated height from `grid.dataset.estimatedHeight` back into inline `style.height` to preserve the scrollable area.【F:src/hooks/useChunkedMasonry.js†L150-L268】
4. **Viewport container** – the scroll root is `.content-region__viewport`, with the native scrollbar hidden. The grid lives inside and is given explicit height estimates via the hook above.【F:src/App.css†L280-L318】【F:src/App.jsx†L1124-L1200】

### Scroll Rail Integration
- `ScrollRail` renders inside the same scroll root, listening to `scroll` events, computing progress against `maxScroll = effectiveHeight - viewport`, and commanding `scrollTo` with offsets produced by `getEstimatedOffsetForIndex`. Labels are derived from `orderedVideos` with sort-specific formatting.【F:src/components/ScrollRail.jsx†L27-L245】
- The hook methods that back the rail (`getEstimatedOffsetForIndex`, `getEstimatedIndexForOffset`, and `getScrollHeightEstimate`) all depend on `orderForRange` rather than the full `orderedIds` list.【F:src/app/hooks/useMasonryLayout.js†L424-L555】

## Failure Analysis
1. **`orderForRange` collapses to rendered subset** – As soon as the first layout completes, `visualOrderedIds` contains only the DOM nodes that exist (i.e., `videosToRender`). Because `orderForRange` prefers `visualOrderedIds`, every downstream calculation now thinks the collection length equals the rendered subset. Any index ≥ that subset is clamped away before the rail can request an offset.【F:src/app/hooks/useMasonryLayout.js†L366-L455】
2. **Scroll height estimate uses truncated length** – `getScrollHeightEstimate` multiplies `orderForRange.length` by an approximate row height. Once the subset wins, the estimated height collapses to the same short window, so `maxScroll` in the rail never exceeds a few rows. The thumb therefore snaps back to the top and appears to “disappear” because progress is effectively pinned near zero.【F:src/app/hooks/useMasonryLayout.js†L539-L555】【F:src/components/ScrollRail.jsx†L83-L155】
3. **Index lookup is similarly truncated** – `getEstimatedIndexForOffset` returns indices in the `[0, orderForRange.length)` interval. Even if we could scroll deeper (e.g., via keyboard), the rail immediately rewrites `activeIndex` to stay within the rendered subset, so the label and thumb never reflect the true scroll position for the full dataset.【F:src/app/hooks/useMasonryLayout.js†L464-L528】【F:src/components/ScrollRail.jsx†L83-L155】
4. **Progressive list never pre-mounts targets** – While scrubbing, `useProgressiveList` only increases its limit gradually (it honours `maxVisible` and `desiredVisible` hints but still needs time to materialize cards). Because the rail clamps indices prematurely, the component never requests mounts beyond the current window, so the progressive list never gets the signal to grow fast enough. This feedback loop makes the UI feel inert even if the rail were allowed to request distant offsets.【F:src/hooks/video-collection/useProgressiveList.js†L17-L200】【F:src/App.jsx†L200-L259】
5. **Height mirroring hides the bug** – `useChunkedMasonry` dutifully respects `grid.dataset.estimatedHeight`, but the dataset itself is derived from the truncated `orderForRange.length`. The grid therefore adopts the same short height estimate, masking any attempt to scroll further down.【F:src/app/hooks/useMasonryLayout.js†L557-L605】【F:src/hooks/useChunkedMasonry.js†L214-L221】

## Design Goals for the Refactor
- **Single source of truth for logical order**: preserve access to the full `orderedVideos` array regardless of how many items are mounted.
- **Bidirectional projections**: expose functions that map `index → offset` and `offset → index` using (a) real measurements where available, (b) column heuristics elsewhere, without shrinking the domain.
- **Progressive coordination**: allow the rail (and other jump-to-index features) to request a “render budget” big enough to mount target items before scrolling, then gracefully return to normal throttling afterwards.
- **Sort-agnostic metadata**: the rail UI should be able to show contextual hints (date, name initial, folder) by reading the same ordering metadata the sort pipeline already maintains.
- **Stability for existing consumers**: selection anchoring, intersection observers, and zoom transitions rely on `orderForRange` for actual DOM order. We need to keep that contract while introducing the new global layout state.

## Proposed Refactor Plan
### 1. Introduce a Layout Data Model
- Create a dedicated “layout model” module/hook that stores:
  - `logicalOrder`: the full `orderedIds` array from `useMasonryLayout`.
  - `measurementStore`: a map from id → `{index, y, height, column}` seeded as soon as a card is mounted (from `useChunkedMasonry` callbacks).
  - `estimateContext`: cached column count, column gap, and average tile height so we can extrapolate positions for unmeasured indices.
- Expose projection APIs:
  - `getOffsetForLogicalIndex(index)` returning `{estimatedY, confidence}` without clamping to rendered bounds.
  - `getLogicalIndexForOffset(offset)` that never returns indices outside `[0, logicalOrder.length)`.
- Keep a separate `getDomOrder()` for components that truly need the rendered subset (e.g., stable anchoring).

### 2. Update `useMasonryLayout`
- Keep `visualOrderedIds` for DOM order but stop substituting it into `orderForRange`. Instead, publish both `logicalOrder` and `domOrder`, and pass the former to the new layout model.
- Move the existing height estimation logic into the layout model so it always computes with `orderedVideos.length`. Only the DOM height mirroring should continue to look at measured values.
- Thread progressive metadata (column count, approx height) into the model so projections stay consistent with the current zoom and container size.【F:src/app/hooks/useMasonryLayout.js†L273-L555】

### 3. Extend `useChunkedMasonry`
- When `onLayoutComplete` fires, send enriched events (with logical indices) to the layout model. Because the layout engine only sees DOM nodes, we’ll need a lookup table from id → logical index supplied by `useMasonryLayout`.
- Ensure the grid height clamp uses the model’s full height estimate rather than the DOM order length so the scroll container always represents the whole dataset.【F:src/hooks/useChunkedMasonry.js†L214-L268】

### 4. Rebuild the Scroll Rail
- Consume the new projection APIs instead of `orderForRange` so the rail can map drag progress to any logical index.
- When the user drags, request a temporary `progressiveBudget` (e.g., `ensureVisibleRange(startIndex, endIndex)`) from a new helper that wraps `useProgressiveList`. This can momentarily disable pause-on-scroll and lift batch caps until the target range is mounted, then revert to defaults once idle.
- Keep sort-specific label formatters but drive them from a pluggable registry keyed by `sortKey`, making it easy to add folder or rating hints later.【F:src/components/ScrollRail.jsx†L27-L245】

### 5. Progressive List Coordination
- Enhance `useVideoCollection` with a method such as `requestImmediateVisibleCount(count)` that bumps the progressive list to at least that many items synchronously (subject to caps) and sets a decay timer to return to normal behaviour. This replaces the current `desiredVisibleDuringScrub` heuristic which cannot exceed the clamped subset.【F:src/hooks/video-collection/useVideoCollection.js†L18-L133】【F:src/App.jsx†L200-L259】

### 6. Testing & Instrumentation
- Add integration tests that mount the app with a large synthetic dataset, drive the rail to various progress ratios, and assert that the scroll container’s `scrollTop` and active labels match expected logical indices.
- Unit test the layout model’s projections to ensure it honours measured data while still covering the full logical range.
- Provide debugging utilities (e.g., toggle overlay showing estimated vs. measured positions) to verify the model during development.

## Expected Outcomes
- The rail will be able to scrub across the entire dataset regardless of how many cards are currently mounted, resolving the disappearing thumb and short-range scroll behaviour.
- Height estimates will stay stable because they are driven by logical length rather than DOM order, so the scroll container exposes the full range immediately after sort/filter changes.
- Progressive loading will react promptly to scrubbing, ensuring the target cards are mounted by the time the viewport arrives.
- The architecture cleanly separates logical ordering from rendered order, reducing the risk of future regressions in selection anchoring or virtualization.

## Next Steps
1. Implement the layout model and integrate it into `useMasonryLayout`.
2. Update `useChunkedMasonry` and the grid height mirroring to consume the new height estimate.
3. Rebuild `ScrollRail` on top of the new APIs and add coordination hooks for progressive loading.
4. Expand automated tests to cover the new behaviour.
5. Iterate on the rail UI (styling, accessibility, hover labels) once the underlying mechanics are proven reliable.
