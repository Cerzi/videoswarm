# De-Windowing Plan — Full DOM + Smart Playback (ScrollRail Simplification)

**Goal:** Remove render-window/virtualization, render the **entire masonry wall** (3k+ items) as lightweight DOM, **only attach video players near the viewport**, and simplify ScrollRail to operate on the real DOM (no projection/model materialisation).

**Why:** Earlier builds proved full DOM is acceptable for your datasets. The windowing stack adds complexity (rail, projection, budgets) and is the main source of anchoring bugs. We’ll keep performance by lazy-instantiating `<video>` players while letting the DOM exist for layout and anchors.

---

## 0) Success Criteria

- All items (3k+) exist as **DOM nodes** after initial layout (cards render as lightweight shells with poster/thumb + metadata).
- Near-viewport items (e.g., within 1.5–2.0× viewport) get live `<video>` elements; others keep image/thumb or an inert `<video preload="none">` without sources.
- ScrollRail jumps **directly** to DOM anchors (item offsets) and lands accurately on date or index without a second correction pass in the common case.
- Steady 60fps scroll on modern hardware; no long (>50 ms) main-thread stalls during scrubs/jumps.

---

## 1) Scope of Removal (Windowing/Progressive)

**Remove/neutralize:**
- `useProgressiveList` budgets and any range materialisation.
- `RangeCoordinator.requestMaterialize` and boost/decay logic.
- DOM window calculations in `useChunkedMasonry` (or replace with full map).
- Any LPM-dependent code used only to **predict** offsets or total height.

**Keep:**
- **Sorting/logicalOrder** source of truth in `useVideoCollection`.
- **IntersectionObserverRegistry** and playback throttling.
- **MeasurementStore** (optional) for debug & precise anchors, but no longer required for rendering order.

---

## 2) Architecture After De-Windowing

### 2.1 Rendering
- **Full render:** map `logicalOrder` → `<VideoCardShell id=.../>` for all items.
- **Card shell** renders: poster/thumb (static), title/meta, fixed container with known width; **no active `<video>`** by default.
- **Near-viewport activation:** IO callback swaps shell → live `<video>` (attach `src`, `autoplay`, etc.). On exit (beyond offscreen threshold), detach `src` or recycle to pool.

### 2.2 ScrollRail
- Reads **real offsets** from the container:
  - `totalHeight = scrollContainer.scrollHeight`.
  - `indexToOffset(i) = cardRefs[i].offsetTop` (or cached from `getBoundingClientRect` + container scrollTop).
  - `offsetToIndex(y)` by **binary search** (or block samples every 64 cards, then scan locally).
- Date-aware labels: `labelForIndex(i)` reads the actual card’s date from the data model.
- Commit: `scrollContainer.scrollTo({ top: indexToOffset(iAlign), behavior: 'instant'|'smooth' })`.

### 2.3 Observers & Reflow Safety
- Use a **single** `IntersectionObserver` (root: scroll container) feeding a **PlaybackManager** that mounts/unmounts `<video>`.
- Add a **ResizeObserver** on the grid to update offset caches when a card’s height changes (e.g., image loads). Batched per-frame.

---

## 3) Step-By-Step Refactor Plan (PR-sized chunks)

### PR-1: Feature flag & Read-only metrics
- Add `VS_DEWINDOW=1` (or reuse experimental flag) to select the new path.
- Log: total items, scrollHeight, average card height.

### PR-2: Full DOM path
- **`useMasonryLayout`**: replace windowed range with full map.
- Remove `ensureVisibleRange` calls.
- Ensure the grid container uses **containment** to reduce layout cost.

### PR-3: Card Shell + Activation
- **VideoCardShell** renders poster/thumb and metadata, only attaching `<video>` when activated.
- **PlaybackManager** drives activation/deactivation based on IO with generous root margins.

### PR-4: ScrollRail rewire (DOM-based)
- `totalHeight`: from scroll container.
- `indexToOffset`/`offsetToIndex`: use DOM offsets + block summaries.
- Commit flows rely on DOM anchors with optional date-to-index lookup.
- `ResizeObserver` updates cached offsets after layout changes.

### PR-5: Remove old windowing code paths
- Strip `useProgressiveList` and range budgets; delete `RangeCoordinator.requestMaterialize` and boost/decay.
- Keep only what’s needed for ScrollRail input and index/date helpers.

---

## 4) File-Level To-Dos (indicative)
- `src/hooks/useChunkedMasonry.ts` → retire chunk logic; return full `logicalOrder` with masonry positions.
- `src/hooks/video-collection.ts` → keep `logicalOrder`, `idToIndex`, sort changes.
- `src/hooks/ui-perf/useIntersectionObserverRegistry.ts` → ensure it supports **one global IO** used by PlaybackManager.
- `src/components/VideoCard/VideoCard.tsx` → split into `VideoCardShell` + activation hook; move auto-play logic to manager.
- `src/components/ScrollRail/*` → make it **DOM-offset based**; delete dependency on projection/materialisation.
- `src/config/featureFlags.js` → add `deWindow` flag; default **on** for dev testing.

---

## 5) Performance Guardrails (Full DOM)
- **DOM weight:** Keep shells light (avoid heavy per-card hooks/effects; memoize props; avoid frequent React re-renders).
- **CSS:** Prefer GPU-friendly properties; avoid triggering layout on scroll; use `will-change: transform` sparingly.
- **Images:** Use sized thumbnails; avoid layout shift.
- **Videos:** Attach sources only when active; cap concurrent decoders; consider pooling.
- **Observers:** Single IO instance; batch RO/IO callbacks with `requestAnimationFrame`.

---

## 6) ScrollRail UX Details (DOM mode)
- Track is fixed overlay; thumb normalized to [0,1].
- Keyboard: PgUp/PgDn = ± viewport; Home/End = 0/N-1.
- Hide native scrollbar in the wall (flagged) while keeping wheel/keys.

---

## 7) Risks & Mitigations
- **Memory:** 3k shells still cost memory → ensure shells have minimal overhead.
- **Layout jitter:** Image load may change card height → use placeholders and fixed aspect ratios; refresh offsets via RO.
- **Large reflows:** Debounce operations on container width/column changes.
- **Future features:** Keep legacy path behind flag as escape hatch for huge datasets.

---

## 8) Accept/QA Checklist
- [ ] 3k-item folder renders full DOM in < 2–3 seconds without freezing UI.
- [ ] Scrolling remains smooth; FPS stable.
- [ ] Only near-viewport items have live video; others are thumbs.
- [ ] ScrollRail jumps accurately to date/index (± one item), no secondary correction needed typically.
- [ ] No layout shift on rail drag/commit; no native scrollbar visible when flag is on.

---

## 9) Recommendation
- Ship the full-DOM architecture as default while keeping a flag to restore windowing if required for ultra-large datasets. Focus ongoing tuning on activation heuristics and ScrollRail UX rather than projection math.
