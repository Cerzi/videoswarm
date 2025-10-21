# Scroll Rail Feature Status — Full DOM Mode

## Visibility expectations
- The ScrollRail is now driven by the real masonry DOM. By default the rail is enabled and renders whenever the collection contains items and the wall has a measurable height.
- The `fullDomMasonry` feature flag (derived from `VS_DEWINDOW` / `VITE_VS_DEWINDOW` or the absence of the `VS_KEEP_WINDOWING` override) controls whether the app uses the simplified full-DOM layout. Disabling the flag restores the legacy windowed stack.
- `App.jsx` reads scroll metrics from `useMasonryLayout` and only requires a positive `totalHeight` before mounting the rail overlay.

## Current behaviour (post Phase D)
1. All videos render as lightweight card shells. Playback resources are still throttled by the existing intersection observer and resource manager.
2. ScrollRail operations (`onScrub`/`onCommit`) map directly to DOM offsets, producing deterministic jumps without background materialisation.
3. The rail overlay is fixed to the viewport and remains visible while the wall scrolls.

## Guardrails
- Development builds log a `[ScrollRail] guard` snapshot summarising item count, total height, and whether index→offset hooks are available.
- The masonry hook exposes `scrollMetrics` (`indexToOffset`, `offsetToIndex`, `totalHeight`) and `visibleRange` so downstream components can build additional diagnostics if needed.

## Recommendation
- Run `VS_DEWINDOW=1 VITE_VS_DEWINDOW=1 npm run electron:dev` to explicitly exercise the full DOM path.
- If you encounter performance regressions on extremely large libraries, set `VS_KEEP_WINDOWING=1` while collecting traces so we can compare against the legacy virtualised implementation.
