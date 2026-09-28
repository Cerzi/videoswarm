# UX Redesign: Presenting Features Without Bloat

Status: **Accepted** (decisions 2026-09-28); slices below are marked
individually
Last updated: 2026-09-28

## Summary

The UX audit (outstanding work 5b; the audit page is private to the user at
https://claude.ai/artifact/MgNRWMjGDcVKyzJeBStmsu) found that the app's
features are sound but their presentation has accumulated: five stacked bars
before the first clip, diagnostics shown to everyone, the same action in up
to six places under different names, and a header that no longer fitted a
laptop screen. The plain bugs it found are fixed. This document records the
user's decisions on the layout and the order the redesign lands in.

The organising idea: the daily loop — open a folder, browse and play,
select, review and rate, tag and filter, fullscreen, transfer — stays one
step away; everything else is one step further, in a predictable place (the
View menu, the ⋯ menu, Preferences).

## Status convention

- **Implemented** means the behavior and its focused verification are present.
- **Verified** means the repository-wide gates also passed on that change.
- **Unimplemented** means at least one acceptance criterion is still open.
- **Proposed** means the design is written and not yet accepted.

## Decisions

| | Question | Decision |
|---|---|---|
| D1 | Details opening itself on every selection | **Docked in the sidebar by default**; floating stays an option |
| D2 | The diagnostics line | **Keep a short version** (clip count, sort); the rest behind View |
| D3 | Playback mode and Proxy | **In the View menu** |
| D4 | Donate | **Help and About, plus a small link in ⋯** |
| D5 | Review mode | **Keep the master switch, labelled “Review”** |
| D6 | Narrow windows | **Fold the right-hand group into ⋯** |
| D7 | Where new features (Queue, Sequences) live | **Sidebar** — with the user's caveat that four or five tabs will feel tight; an activity rail is proposed below |
| D8 | A Preferences dialog | **Yes**: profiles, data location, playback defaults, ComfyUI connection |
| D9 | The naming glossary | **Adopted** as suggested |
| D10 | Order of work | **Everything together in the redesign** (the plain bugs were already fixed) |

## Glossary (D9)

| Concept | Term | Retired |
|---|---|---|
| Move / copy / link elsewhere | **Transfer…** | Move, Copy or Link to… · Copy Accepted |
| Delete to the system bin | **Move to Trash** (Recycle Bin on Windows) | Recycle Bin everywhere · Bin |
| Review states | **Accept · Reviewed · Reject · Unreviewed** | Mark as accepted · Mark as Accept · Rejects · pick (in UI) |
| Saved filter set | **Smart view** | Reusable filters · Saved view |
| Clip information panel | **Details** | Selection details · Clip details · Open selection details |
| Big player | **Fullscreen** | Fullscreen player · Fullscreen review · the Loupe |
| Include subfolders | **Include subfolders** | Subfolders · Scan subfolders · Index subfolders |
| Where results come from | **Folder / Library** | Pinned roots · library root · Current collection (as labels) |
| Show file on disk | **Show in File Manager / Finder / Explorer** | Open in folder |
| Product | **Video Swarm** | VideoSwarm |

## Target layout

- **One top bar**: sidebar toggle · **Open** (folder picker, recent, pinned)
  · location (‹ › breadcrumb, count, scope, **Include subfolders**) · …
  · **Filters** · sort · zoom · **Review** · **View ▾** · **⋯**. The folder
  bar below the header goes away.
- **View ▾**: show file names, hover audio, group by folders, folder groups
  strip, playback mode, proxy, and **playback details** (the full status
  line).
- **⋯**: keyboard shortcuts, Preferences…, About, Support Video Swarm.
- **Narrow windows (D6)**: when the bar cannot fit, the lowest-priority
  controls move into ⋯ instead of wrapping or falling off the edge.
- **Status line (D2)**: clip count, sort and grouping only, unless View ›
  Playback details is on.
- **Preferences (D8)**: profiles, data location, playback defaults and the
  ComfyUI connection — also the home for the queue engine's settings when
  it moves to its own process (see `comfy-queue-integration.md`).
- **Details (D1)**: docked in the workspace sidebar by default.

### D7: an activity rail instead of more tabs

The user accepted the sidebar as the home for new features, noting that four
or five tabs (Library, Details, Queue, Sequences, …) will feel tight across a
270 px sidebar. Proposed: an **activity rail** — a thin vertical strip of
icons on the sidebar's outer edge, one per feature, each with a hover label
and an optional badge ("3 rendering"). Clicking one shows that panel at the
sidebar's full width; clicking the active one collapses the sidebar, so the
rail also replaces the ☰ toggle. It scales to six or eight features without
squeezing any of them. **Awaiting the user's answer**; it is the last slice.

## Slices

1. **Glossary (D9).** Status: **Implemented**, **Verified** (2026-09-28).
   Every retired term in the table is gone from the UI: Transfer…, the
   four review states, Smart view, Details, Fullscreen, Include subfolders,
   Pinned folders, Video Swarm. Internal identifiers (the `VideoSwarmData`
   folder, `copyAccepted` IPC) are unchanged.
2. **View and ⋯ menus, Review label, short status line (D2–D5).** Status:
   **Implemented**, **Verified** (2026-09-28). `TopBar` replaces
   `HeaderBar`; its menus use the shared `menu/MenuButton` (menu,
   `menuitemcheckbox` and `menuitemradio` roles, arrow keys, Esc).
   Playback details is a saved setting (`playbackDetailsVisible`, off by
   default); off, the status line reads "24 clips · Sorted by Name ↑".
   Preferences… appears in ⋯ once slice 4 passes `onOpenPreferences`.
3. **One top bar with overflow into ⋯ (D6).** Status: **Implemented**,
   **Verified** (2026-09-28). Landed with slice 2, because both rewrite
   the same bar. `CollectionNavigationBar` is gone; the bar never wraps.
   It measures its children and folds, in order, zoom, sort, scope,
   Include subfolders, then the ‹ › buttons into ⋯, and unfolds when the
   window widens again. In the real app: nothing folds at 1440 or 1280,
   zoom folds at 1024, and sort at 900. Nothing is ever offscreen.
   The browser-only folder picker (`<input webkitdirectory>`, shown only
   outside Electron) is dropped, because the app is desktop-only.
4. **Preferences (D8).** Status: **Unimplemented**
5. **Details docked by default (D1), then the activity rail (D7).** Status:
   **Unimplemented**

Each slice lands as its own commit(s) with focused tests, the repository
gates, and a check in the real app at 1024, 1280 and 1440 px.

## Implementation notes and decisions

### 2026-09-28 — Decisions

- Recorded from the user's answers to the audit (D1 c, D2 b, D3 a, D4 b,
  D5 a, D6 a, D7 a with the caveat above, D8 a, D9 a, D10 b).

## References

- The audit: outstanding work 5b in [`../outstanding-work.md`](../outstanding-work.md).
- Re-render queue surfaces: [`comfy-queue-integration.md`](comfy-queue-integration.md).
- Clip sequences: [`clip-sequences.md`](clip-sequences.md) (on `claude/clip-sequences`).
