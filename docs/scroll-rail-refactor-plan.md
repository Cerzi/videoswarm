# VideoSwarm Scroll Rail Audit & Refactor Plan

## 0. Executive Summary
- Existing rail math is bound to DOM order and the mounted subset, causing scrubbing to clamp at the currently rendered window.
- Introduce a layout projection model (LPM) that offers global index-to-offset mappings backed by measurements and estimations.
- Progressive rendering must become range-addressable with the ability to temporarily exceed budgets during scrubs and long-distance jumps.
- Masonry hooks should publish both logical and DOM order while sharing a central measurement store.
- Deliver the ScrollRail UI as a thin layer over a new projection and range coordination system.

**Outcome:** Deterministic rail scrubbing across the full collection, stable contextual labels, predictable jump/seek behaviour, and preserved wall performance.

## 1. Current Pain Points
1. Helpers such as `orderForRange` and `visualOrderedIds` only operate on the mounted subset, so the rail cannot address unseen items.
2. Progressive budgets cannot target high indices, causing hints for distant items to be clamped before rendering.
3. Height reservation hacks mirror truncated knowledge, so scroll height never reflects the full logical collection.

**Conclusion:** A global projection model is required; incremental patches cannot recover the missing data.

## 2. Target Architecture
### 2.1 LayoutProjectionModel (LPM)
- Maintains a render-independent mapping between logical indices, columns, and offsets.
- Inputs: logical order, grid geometry (column count/width, gaps), measurement store, estimators for unseen items.
- APIs: `indexToOffset`, `offsetToIndex`, `ensureProjected`, `updateMeasurement`, `getTotalHeight`.
- Behaviour: place items using logical order, maintain per-column tails, use estimators until actual measurements arrive, rebuild on parameter changes.

### 2.2 MeasurementStore
- Versioned map of id to height with staleness policies.
- Provides column statistics (avg, p50, p90) to feed estimators.

### 2.3 RangeCoordinator
- Bridges the LPM with the masonry renderer and progressive loader.
- APIs for viewport-to-range mapping, materialisation requests, rail scrubbing, and jump-to-index behaviour.
- Integrates with a budget governor that temporarily raises limits and decays them after idle.

### 2.4 MasonryRenderer
- Renders the DOM window derived from logical indices.
- Emits measurements back into the store.

### 2.5 ScrollRail
- Consumes total count, projection APIs, and contextual label provider.
- Emits scrubs and commits (jump requests) to the coordinator.

## 3. Refactor Plan
### Phase A – Extract the Model
1. Introduce `MeasurementStore` and a `useReportMeasuredHeight` hook that routes card measurements.
2. Add `logicalOrder` and `id→logicalIndex` mappings to the collection layer.
3. Implement the LPM as a pure module with a `useLPM` wrapper and optional visualiser.
4. Run the LPM in parallel for telemetry while keeping existing rendering.

### Phase B – Swap Rendering to LPM (Feature Flag)
5. Build a simple `RangeCoordinator` that maps viewport bounds to logical index ranges.
6. Replace DOM-order helpers with LPM-powered range selection.
7. Add parity metrics and watchdogs to ensure stability.

### Phase C – Scroll Rail on LPM
8. Implement an index-driven `ScrollRail` that uses the projection APIs and contextual labels.
9. Add keyboard and accessibility affordances.

### Phase D – Progressive Coordination & Polish
10. Implement range materialisation requests with elevated priorities during scrubs.
11. Introduce a decay policy for elevated budgets.
12. Tune estimators to use robust statistics (trimmed mean, median).

## 4. Proposed Interfaces (TypeScript)
```ts
interface MeasurementStore {
  version: number;
  get(id: string): number | undefined;
  upsert(id: string, height: number): void;
  statsForColumn(col: number): { avg: number; p50: number; p90: number };
}

interface LPMParams {
  logicalOrder: string[];
  columnCount: number;
  columnWidth: number;
  gapX: number;
  gapY: number;
  measure: MeasurementStore;
}

interface LayoutProjectionModel {
  indexToOffset(i: number): { y: number; column: number };
  offsetToIndex(y: number): number;
  getTotalHeight(): number;
  ensureProjected(i0: number, i1: number): void;
  updateMeasurement(id: string, h: number): void;
}

interface RangeCoordinator {
  viewportToDesiredRange(viewTop: number, viewH: number, overscan: number): [number, number];
  onScrub(targetIndex: number): void;
  jumpToIndex(i: number, align?: 'start' | 'center' | 'end'): void;
  requestMaterialize(i0: number, i1: number, priority: 'rail' | 'nav' | 'idle'): void;
}

interface VideoCollection {
  logicalOrder: string[];
  idToIndex: Map<string, number>;
  ensureVisibleRange(i0: number, i1: number, opts?: { priority: 'rail' | 'nav' }): void;
}

interface ScrollRailProps {
  total: number;
  indexToOffset: (i: number) => { y: number };
  offsetToIndex: (y: number) => number;
  totalHeight: number;
  labelForIndex: (i: number) => string;
  onScrub: (i: number) => void;
  onCommit: (i: number) => void;
}
```

## 5. Algorithms & Data
- Column assignment uses a greedy min-tail heuristic with gap adjustments.
- Estimators seed with global medians, clamp to robust ranges, and rebuild on geometry changes.
- `offsetToIndex` uses block-based binary search over column tails.
- Budget governor temporarily inflates visible ranges during scrubs and decays budgets when idle.

## 6. Integration Points
- `hooks/useChunkedMasonry`: replace DOM-order helpers with logical range inputs from the coordinator.
- `hooks/video-collection`: own logical sort, expose `ensureVisibleRange` with high-priority paths.
- `hooks/ui-perf/useIntersectionObserverRegistry`: continue gating playback by visibility.
- `components/VideoCard/*`: report measurements via the store.
- `components/ScrollRail`: shift to index-driven math.
- `FullScreenModal` navigation: reuse `idToIndex` for left/right navigation under logical ordering.

## 7. Observability & Guardrails
- Perf counters: total height, measurement counts, estimation error quantiles, rail boost state, budget levels.
- Watchdogs: react to high estimation error and post-jump misalignment.
- Optional telemetry for anonymised size distributions and scrub distances.

## 8. Testing Strategy
- Unit: LPM inverses and estimator stability.
- Integration: priority range materialisation responsiveness.
- UI: keyboard accessibility, ARIA feedback, jump accuracy after sort or metadata changes.

## 9. Migration & Rollout
1. Phase A under a feature flag for shadow mode.
2. Compare DOM versus LPM selection logs in canary builds.
3. Switch rendering under flag, monitor watchdogs, then enable by default.
4. Ship ScrollRail UI, gather feedback, and tune budgets/labels.

## 10. Risks & Mitigations
- Estimator drift: robust stats and idle re-measurements.
- Memory growth: sparse projection storage (block summaries) and on-demand calculations.
- Sort changes during edits: versioned logical order and incremental rebuilds anchored by ID.

## 11. Implementation Checklist
- [ ] MeasurementStore module and measurement hook.
- [ ] Logical order and index mapping in the collection hook.
- [ ] Layout projection model with tests and dev overlay.
- [ ] Range coordinator and budget governor.
- [ ] Update chunked masonry to consume logical ranges.
- [ ] Fast-path `ensureVisibleRange` for high-priority requests.
- [ ] ScrollRail component with contextual labels.
- [ ] Watchdogs and counters.
- [ ] E2E scenarios with large synthetic datasets.

## 12. Developer Notes
- Keep index math in logical space; DOM is a projection.
- Recompute from the LPM on resize/zoom rather than storing pixels.
- ScrollRail should remain stateless, emitting target indices only.
- Prioritise determinism; small post-jump corrections are acceptable as measurements refine.

## 13. Conclusion
A global, sort-aware projection plus range coordination enables rail scrubbing across any collection size while preserving performance. Build the model first, then layer ScrollRail behaviour on top, avoiding DOM-order coupling.
