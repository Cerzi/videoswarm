# Windows All Motion Performance Recovery

Status: Active living specification
Last updated: 2026-07-22
Baseline comparison: Video Swarm v0.5.2 versus v0.6.0-rc.4

## Purpose

Video Swarm 0.6 is substantially faster than 0.5.2 on Linux, but manual
side-by-side testing on the same high-end Windows system shows that 0.5.2 is
materially faster than 0.6 when both run in **All Motion** mode. All Motion at
reasonable zoom levels on a capable system is the product baseline; Balanced
mode is not an acceptable explanation or workaround for this regression.

This specification owns the investigation and recovery of Windows All Motion
performance while protecting the Linux improvements shipped in 0.6.

## Status convention

- **Planned**: scoped but implementation has not started.
- **In progress**: implementation or measurement is underway.
- **Implemented**: code and focused regression coverage have landed.
- **Measured**: the relevant Windows and Linux acceptance evidence has been
  recorded. Implemented work is not considered fully closed until measured on
  the platforms it can affect.
- **Rejected**: evidence showed that the hypothesis was not causal or that its
  trade-off was unacceptable.

## Non-negotiable constraints

1. Linux 0.6 remains the protected performance baseline. No Windows recovery
   may restore the unbounded Linux DOM, media, decoder, watcher, or scan behavior
   of 0.5.2.
2. Cross-platform changes must remove redundant work or otherwise be monotonic.
   Changes that increase mounted cards, loader concurrency, resident media, or
   decoder pressure must be explicitly gated to `win32`.
3. The opaque `videoswarm-media://` boundary, renderer sandbox, profile
   generation ownership, canonical-path containment, and exact media lease
   ownership remain mandatory.
4. All Motion means every visible, loaded card is eligible for playback. It may
   consume substantial resources, but Balanced-mode caps must not leak into it.
5. Generated proxies remain optional and disabled by default. They are not the
   baseline solution for native Windows playback.
6. Improvements must be measured on release-like production builds. Development
   React and logging overhead is not release evidence.

## Confirmed facts

- The current Windows Electron 43 runtime initializes the NVIDIA RTX 5090
  through ANGLE/D3D11 with GPU compositing, rasterization, WebGL, and Chromium's
  video-decode feature enabled.
- This confirms hardware-accelerated rendering capability, but does not prove
  hardware decoding for every codec/profile or every concurrent stream.
- The Linux-only EGL/ANGLE/OpenGL switches are inside a
  `process.platform === "linux"` branch and do not alter Windows startup.
- All Motion bypasses the Balanced/Adaptive structural decoder cap.
- v0.6 virtualizes the masonry surface and physically disposes media when a card
  leaves the mounted window. v0.5 kept the full rendered card set mounted and
  could retain a larger warm media set.
- v0.6 uses strict synchronous loader leases. v0.5 allowed a small visible-card
  overflow above its nominal concurrent-loader cap.
- Each original-media protocol range request currently performs one SQLite
  instance resolution, two `realpath` calls, two `stat` calls, and a JavaScript
  stream handoff before Chromium consumes the response.
- v0.5 already ran a requestAnimationFrame hitch detector, a Long Tasks
  observer, and periodic memory sampling. The richer v0.6 telemetry is
  incremental overhead, not an entirely new monitoring loop.
- Visible cards used `preload="auto"` in v0.5 as well as v0.6. Offscreen virtual
  cards normally fail the physical viewport check before assigning a source;
  preload policy is not currently a leading hypothesis.

## Performance scenarios and acceptance gates

### Windows recovery scenarios

Use the same local, playable fixture and the same window size/zoom in v0.5.2 and
the candidate v0.6 build. Record at least one common generated-video resolution
and one high-resolution case when available.

1. **Steady All Motion**: hold one viewport stationary after every visible card
   has loaded.
2. **Forward scroll**: repeatedly advance by one viewport at a controlled pace.
3. **Reverse scroll**: return to the preceding two viewports to expose warm-card
   retention and reload churn.
4. **Zoom transition**: switch between two reasonable dense zoom levels, then
   allow layout to settle.
5. **Cold open and indexed revisit**: measure these separately so scan latency
   cannot be confused with playback latency.

Primary measurements:

- Time from card visibility to `loadeddata`.
- Time from `loadeddata`/decoder eligibility to `playing`.
- Visible cards versus playing cards in All Motion.
- Dropped-frame ratio and long-frame p95 while steady and scrolling.
- Media protocol request count and validation time.
- Card mounts/unmounts and media-source assignments per viewport traversal.
- Loader queue depth, wait duration, cancellations, and in-flight loads that
  become invisible.
- Renderer/main/GPU-process working set and Windows GPU Video Decode usage.

Initial release gate: on the agreed Windows fixture, candidate v0.6 should be
within 15% of v0.5.2 for median visibility-to-first-frame latency, should not
leave visible All Motion cards persistently decoder-starved after settlement,
and should not introduce repeated reloads when reversing one viewport unless a
configured resource bound is actually reached. Exact fixture paths and measured
values remain machine-local; summarized medians and hardware details belong in
this document.

### Linux non-regression gate

Every cross-platform change must pass the existing Linux soak and folder-revisit
budgets. Any platform-scoped renderer/scheduler policy must have focused tests
showing that Linux retains its current values and code path.

For real-hardware acceptance:

- Run the existing Linux soak harness in All Motion.
- Run the existing 1,000- and 6,000-clip folder-revisit scenarios when scan,
  layout, caching, or lifecycle code changes.
- Reject increased Linux mounted-card/media maxima, unbounded queues/caches,
  worse inactive-root cleanup, or a material regression in the recorded Linux
  first-grid/refresh budgets.
- Retain current Linux software-decode-safe defaults. Windows-only warm-window
  or loader-burst policy must be unreachable on Linux.

## Prioritized work

### P0. Reproducible Windows All Motion record

Status: **In progress**

Create a production-build measurement record for the five scenarios above.
Where automation cannot observe Windows GPU-engine use reliably, combine app
telemetry with a documented Task Manager or GPUView observation. Preserve
aggregate timings, never user media or absolute library paths.

Acceptance criteria:

- v0.5.2 and v0.6 run the same fixture, mode, zoom, and window dimensions.
- Cold open, indexed revisit, steady playback, and scroll behavior are reported
  separately.
- The record identifies whether the dominant regression is media-request time,
  loader wait, media remount/reload churn, decoder start, or frame pacing.

### P1. Remove redundant media-request filesystem validation

Status: **In progress**

The media service already resolves a canonical path before authorization. Its
main-process authorization callback then canonicalizes and stats the same path
again, after which the media service stats it again. Add a trusted internal
canonical-path authority operation so one request performs exactly one
`realpath` and one `stat` while retaining root containment, file-kind checks,
profile/scope revocation checks, and request-generation checks.

The authorization result may return the validated `stat` object to the media
service. Do not add a cross-request authorization cache in this slice.

Linux impact: monotonic reduction in filesystem work; no limit, scheduling,
layout, decoder, or scan policy changes.

Acceptance criteria:

- Original media requests perform one canonicalization and one file stat.
- Symlink/reparse-point escapes remain rejected.
- Revocation during the asynchronous stat rejects the request.
- Proxy authorization behavior remains unchanged.
- Range, abort, profile-transition, and disposal tests remain green.

### P2. Instrument the playback critical path

Status: **Planned**

Add bounded counters/timings for card mount, source assignment, protocol
validation, loader wait, `loadeddata`, decoder grant, and `playing`. Expose
aggregates through the existing diagnostics surface or a performance-harness
channel; do not log per-file paths or emit unbounded event histories.

Linux impact: counters must be disabled or low-overhead outside an explicit
profiling run. No production polling loop may be added.

Acceptance criteria:

- One profiling run can attribute visibility-to-playing latency to its major
  stages.
- Counters have explicit cardinality and lifetime bounds.
- Disabled instrumentation has no recurring timer and no per-frame allocation.

### P3. Windows warm virtual surface

Status: **Planned**

If the P2 record confirms remount/reload churn, retain a larger Windows mounted
window while leaving Linux's current one-viewport overscan unchanged. Prefer a
bounded, directional/adaptive overscan or a minimum mounted-card target over a
detached global media pool.

Candidate order:

1. Two-viewports directional overscan on `win32`.
2. A bounded Windows minimum mounted-card target aligned with the resident-media
   budget.
3. Disable virtualization below a moderate Windows collection threshold only if
   simpler overscan does not recover performance.

Linux impact: exact existing overscan and mounted-card bounds must be asserted in
unit tests and remain unchanged in the Linux harness.

Acceptance criteria:

- Reverse-scroll source reassignments and first-frame latency improve on
  Windows.
- Windows mounted cards/media remain bounded.
- Linux virtual window calculations are byte-for-byte behaviorally unchanged
  for equivalent inputs.

### P4. Windows visible-loader reserve and stale-load cancellation

Status: **Planned**

If loader wait is material, preserve the atomic lease model but add a bounded
Windows-only visible burst/reserve. Cancel an in-flight load only after it has
remained invisible for a short grace period; immediate cancellation can make
reverse scrolling worse.

Linux impact: existing strict loader cap and admission path remain unchanged.

Acceptance criteria:

- Newly visible Windows cards cannot remain behind obsolete invisible loads for
  an unbounded interval.
- Burst size and grace timers are explicit, small, and covered by lease-race
  tests.
- Linux scheduler limits and admission decisions are unchanged.

### P5. Protocol descriptor cache and stream-path experiments

Status: **Planned**

Only after P1/P2 measurement, evaluate a bounded generation-owned descriptor
cache for instance path, size, mtime, and MIME type. Invalidation must cover
profile changes, root revocation, watcher removal/change, and service epoch
changes. Separately measure whether alternative Electron-native file streaming
reduces copies without weakening the opaque renderer boundary.

Linux impact: no cache or streaming implementation lands without Linux soak and
profile-transition evidence. Prefer cross-platform reductions in work over
Windows-only protocol forks.

### P6. Scan/enrichment tuning

Status: **Planned**

Pursue only if cold-open measurements identify the scan rather than playback as
the perceived regression. Existing streaming, priority IDs, batched indexing,
cached preview, and two-worker enrichment remain the starting point. Potential
work is a minimal authorized/playable instance patch before optional timing and
audio enrichment, or storage-aware Windows concurrency.

Linux impact: current Linux batching/concurrency remains unchanged unless both
platform harnesses demonstrate an improvement.

### P7. Electron-version isolation

Status: **Planned**

If application-level changes do not explain the remaining gap, compare released
v0.5.2 and v0.6 builds plus a controlled Electron-version experiment. A
permanent downgrade is not an acceptable first-line fix because it loses runtime
and security updates and requires native ABI/packaging revalidation.

## Rejected or deprioritized hypotheses

### Balanced decoder cap

Status: **Rejected as the reported cause**

The confirmed comparison uses All Motion in both versions. Balanced may still
need separate product tuning, but it does not explain this regression.

### `preload="auto"`

Status: **Deprioritized**

Visible v0.5 cards already used automatic preload, and current offscreen cards
normally do not assign a source. Reconsider only if P2 observes offscreen source
assignment.

### Telemetry publication

Status: **Deprioritized**

The incremental v0.6 quality/memory sampling may be optimized later, but v0.5
already owned the main rAF and Long Tasks observers. Pursue only if a CPU profile
shows periodic telemetry-driven work on the critical path.

### Restoring the v0.5 render-limit model

Status: **Rejected**

The old default was already Max and restoring full unbounded mounting would
discard the Linux large-library gains. Windows recovery must remain bounded.

## Implementation log

| Date | Priority | Status | Evidence / result |
| --- | --- | --- | --- |
| 2026-07-22 | P0 | In progress | Manual same-system executable comparison confirms v0.5.2 is materially faster than v0.6 in All Motion on Windows; v0.6 remains materially faster on Linux. Detailed stage timings pending. |
| 2026-07-22 | P1 | In progress | Redundant media-request canonicalization/stat path confirmed in source; implementation started. |

