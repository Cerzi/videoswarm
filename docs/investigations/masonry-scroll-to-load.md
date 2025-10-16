# Masonry "Scroll to load" Regression Investigation

## Summary
Recent fixes introduced a layout epoch signal and tightened the play orchestrator, but the regression where certain visible tiles stay stuck on the _“Scroll to load”_ placeholder after every masonry rebuild remains. A review of the loading pipeline shows that the current implementation still relies on a single synchronous geometry check that can bail out while the masonry grid is in the middle of its multi-frame relayout. When that happens no subsequent trigger re-runs the load admission for that tile, so the placeholder never advances even though the card is visible and counted in the debug metrics.

## How loading is supposed to work
1. **IntersectionObserver** – `VideoCard` registers with the shared observer and updates `visibleVideos` in app state through `handleVisible` whenever a tile crosses the viewport.【F:src/components/VideoCard/VideoCard.jsx†L520-L545】【F:src/hooks/ui-perf/useIntersectionObserverRegistry.js†L71-L150】
2. **Manual visibility check** – Every time the observer reports a hit (or the layout epoch bumps) `ensureVisibleAndLoad` runs. It measures the card rectangle against the scroll root and only proceeds when the element is firmly inside the viewport, falling back to `visibilityRef` if the rect collapses to 0 × 0.【F:src/components/VideoCard/VideoCard.jsx†L452-L517】
3. **Resource admission** – Once geometry agrees the card is visible, the call is delegated to the resource manager which enforces memory and loader limits, but it always grants visible tiles (with a small overflow margin).【F:src/hooks/video-collection/useVideoResourceManager.js†L220-L262】
4. **Layout epoch** – Whenever the masonry layout completes we `refresh()` the observer and bump `layoutEpoch` so each card schedules a `requestAnimationFrame` check that re-invokes `ensureVisibleAndLoad`.【F:src/App.jsx†L575-L611】

## What happens during a masonry rebuild
* `useChunkedMasonry` performs relayout work over multiple animation frames, mutating tile styles a chunk at a time. Until a tile is processed its `getBoundingClientRect()` returns the stale position (often the zero-sized pre-layout placeholder).
* IntersectionObserver callbacks fire as soon as the root rect changes. `handleVisible` immediately calls `ensureVisibleAndLoad`, but at this moment the tile’s rect is frequently still degenerate (`height < 1` and `width < 1`). Because `visibilityRef` has not been updated yet (the parent `isVisible` prop still reflects the previous frame), the helper returns early and records no load attempt.【F:src/components/VideoCard/VideoCard.jsx†L474-L485】【F:src/components/VideoCard/VideoCard.jsx†L520-L569】
* When app state finishes updating `isVisible`, the “backup trigger” effect runs in the same frame, but it shares the same `ensureVisibleAndLoad` guard and therefore bails out for the same reason if the geometry is still degenerate.【F:src/components/VideoCard/VideoCard.jsx†L547-L569】
* After the chunked relayout finally assigns dimensions, the observer `refresh()` has already run once and the layout epoch tick has been consumed by the earlier `requestAnimationFrame`. There is no subsequent driver to run `ensureVisibleAndLoad` again for that tile, so it remains stuck showing the placeholder even though `visibleVideos` and the play orchestrator still count it as in-view.

## Why other subsystems are not the root cause
* **Resource manager limits** – Visible tiles bypass the loaded cap and can overflow the concurrent loader budget slightly, so the admission layer is not preventing the retry once geometry is ready.【F:src/hooks/video-collection/useVideoResourceManager.js†L227-L240】
* **Play orchestrator** – The latest patch already evicts tiles that lose their loaded media, preventing inflated playing counts. The stuck cards are not re-requesting their media, so the orchestrator never hears a `reportStarted` event and simply shows fewer active players.
* **Layout epoch refresh** – `bumpLayoutEpoch()` only runs once per rebuild (and again on viewport resize), but because the epoch effect only schedules a single `requestAnimationFrame` callback it does not persistently poll after a bailout.【F:src/App.jsx†L575-L611】【F:src/components/VideoCard/VideoCard.jsx†L500-L517】

## Hypothesis
The regression stems from relying on a single-frame geometry confirmation whenever visibility changes. During zoom, resize, or sidebar transitions the masonry grid spends multiple frames transitioning tiles, so cards that momentarily report zero-sized rects never retry loading once the layout stabilises. We previously papered over this with the “stuck-card auditor,” but the underlying race still exists. A durable fix likely needs either:

* a retry loop that keeps re-evaluating visible placeholders until they successfully request media, or
* a way for the layout engine to notify cards after their final position is written (e.g. per-tile callbacks or a post-layout measurement pass) instead of relying on the observer event that fires too early.

Either approach would ensure `ensureVisibleAndLoad` runs against settled geometry and unlocks the pending load, eliminating the persistent _“Scroll to load”_ tiles after every masonry rebuild.
