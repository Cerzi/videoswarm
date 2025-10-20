# Scroll Rail Feature Status (Phases A–C)

## Visibility expectations
- The ScrollRail UI is guarded by the `experimentalLayoutProjection` feature flag. By default the flag resolves to `false` unless `VS_EXP_LPM` (or `VITE_VS_EXP_LPM`) is set to a truthy value in the environment. Without that flag, `useMasonryLayout` reports `layoutProjectionEnabled = false`, which prevents the rail from rendering even though the component code is present.
- When the flag is enabled, `shouldShowScrollRail` additionally checks that the layout projection model is hydrated and reports a positive `totalHeight` before rendering the component.

### Relevant code
- `feature.experimentalLayoutProjection` is computed from the environment variables in `src/config/featureFlags.js`.
- `useMasonryLayout` exposes `layoutProjectionEnabled` which simply mirrors that flag, and `App.jsx` requires it to be `true` for the rail to mount.

## Phase D prerequisites
1. **Range materialisation wiring** – Hook `onScrub`/`onCommit` callbacks into the collection loader via `requestMaterialize` so distant targets mount promptly during scrubs.
2. **Budget governor** – Allow temporary oversubscription of progressive rendering budgets when scrubbing or after jump requests, decaying back to steady-state limits once idle.
3. **Estimator robustness** – Tune measurement estimators (e.g., trimmed mean/median per column) to reduce thumb drift until unseen items are measured.
4. **Observability** – Add projection/budget watchdog metrics (estimation error, rail boost state) to detect divergence during prolonged sessions.

## Recommendation
- To preview the ScrollRail during development, launch the app with `VS_EXP_LPM=1` (or `VITE_VS_EXP_LPM=true` in Vite) so that the projection stack and rail UI activate.
- Keep Phase D tasks behind the same flag until range materialisation and budgeting changes are validated.
