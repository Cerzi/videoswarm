import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import MenuButton from "./menu/MenuButton";
import { FolderScope } from "../library/folderModel";
import { SortKey } from "../sorting/sorting.js";
import { ZOOM_LEVEL_STEP, ZOOM_MAX_INDEX } from "../zoom/config.js";
import { clampZoomIndex, getTileWidthForZoomLevel } from "../zoom/utils.js";
import { PLAYBACK_MODES, normalizePlaybackMode } from "../playback/playbackPolicy";
import { MODE_DESCRIPTIONS } from "../playback/playbackModeDescriptions";
import { supportContent } from "../config/supportContent";
import "./TopBar.css";

// The one bar above the grid (UX redesign D2–D6): open and location on the
// left; filters, sort, zoom, Review, View and ⋯ on the right. Settings that
// change rarely live in the View menu, app-level things in ⋯. When the window
// is too narrow the lowest-priority controls fold into ⋯ rather than wrapping
// or falling off the edge.

// Folded first to last.
export const FOLD_ORDER = Object.freeze(["zoom", "sort", "scope", "subfolders", "siblings"]);

export const SORT_OPTIONS = Object.freeze([
  { value: "name-asc", label: "Name ↑" },
  { value: "name-desc", label: "Name ↓" },
  { value: "created-asc", label: "Created ↑", hint: "Falls back to Modified time if creation time is unavailable." },
  { value: "created-desc", label: "Created ↓", hint: "Falls back to Modified time if creation time is unavailable." },
  { value: "resolution-asc", label: "Resolution ↑", hint: "Clips whose dimensions have not been read yet sort first." },
  { value: "resolution-desc", label: "Resolution ↓", hint: "Clips whose dimensions have not been read yet sort last." },
  { value: "random", label: "Random" },
]);

const SCOPE_OPTIONS = Object.freeze([
  { value: FolderScope.ALL_DESCENDANTS, label: "All descendants" },
  { value: FolderScope.CURRENT_FOLDER, label: "Current folder" },
  { value: FolderScope.CURRENT_SUBTREE, label: "Current subtree" },
]);

const PLAYBACK_OPTIONS = Object.freeze([
  { value: PLAYBACK_MODES.BALANCED, label: "Balanced" },
  { value: PLAYBACK_MODES.ADAPTIVE_MOTION, label: "Adaptive Motion (safety capped)" },
  { value: PLAYBACK_MODES.ALL_MOTION, label: "All Motion (uncapped)" },
  { value: PLAYBACK_MODES.STATIC_HOVER, label: "Static + Hover" },
]);

const siblingLabel = (value) =>
  value?.name || value?.label || value?.path || value?.relativePath || "";

const Icon = (props) => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" fill="none" aria-hidden="true" {...props} />
);
const FolderIcon = () => <Icon><path d="M3 5h6l2 2h10v12H3z" /></Icon>;
const FilterIcon = () => (
  <Icon><path d="M4 5h16" /><path d="M7 11h10" /><path d="M10 17h4" /></Icon>
);
const ZoomIcon = () => (
  <Icon><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></Icon>
);
const ShuffleIcon = () => (
  <Icon><polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
    <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
    <line x1="4" y1="4" x2="9" y2="9" /></Icon>
);

export default function TopBar({
  isLoadingFolder = false,
  onOpenFolder,
  recentFolders = [],
  pinnedFolders = [],
  onOpenLocation,
  // location
  hasOpenFolder = false,
  breadcrumb = [],
  onBreadcrumbSelect,
  previousSibling = null,
  nextSibling = null,
  onPreviousFolder,
  onNextFolder,
  matchingCount = 0,
  totalCount = 0,
  scope = FolderScope.ALL_DESCENDANTS,
  onScopeChange,
  recursive = false,
  onRecursiveChange,
  isRefreshingFolder = false,
  // sidebar
  showSidebarToggle = false,
  sidebarOpen = false,
  onSidebarToggle,
  // filters
  onFiltersToggle,
  filtersActiveCount = 0,
  onFiltersClear,
  filtersAreOpen = false,
  filtersButtonRef,
  // sort and zoom
  sortKey,
  sortSelection,
  onSortChange,
  onReshuffle,
  zoomLevel,
  onZoomChange,
  minimumZoomLevel = 0,
  // review
  reviewModeEnabled = true,
  onReviewModeToggle,
  // view menu
  showFilenames = true,
  onFilenamesToggle,
  hoverAudioEnabled = false,
  onHoverAudioToggle,
  groupByFolders = true,
  onGroupByFoldersToggle,
  showFolderHeaders = false,
  onFolderHeadersToggle,
  playbackMode,
  onPlaybackModeChange,
  playbackDecision = null,
  playbackCapabilityStatus = "",
  proxyPlaybackEnabled = false,
  onProxyPlaybackToggle,
  proxyPlaybackAvailable = true,
  workSuspended = false,
  playbackDetailsVisible = false,
  onPlaybackDetailsToggle,
  // ⋯ menu
  onHotkeyHelp,
  onOpenPreferences,
  onOpenAbout,
  onOpenSupport,
  initialFolded = [],
}) {
  const barRef = useRef(null);
  const [folded, setFolded] = useState(initialFolded);
  const busy = isLoadingFolder;

  const foldable = {
    zoom: true,
    sort: true,
    scope: hasOpenFolder,
    subfolders: true,
    siblings: hasOpenFolder,
  };
  const isFolded = (key) => folded.includes(key);

  // Fold one more control while the bar's contents are wider than the bar.
  // Measured from the children, not the bar's scroll width, so an open menu
  // hanging below the bar never counts.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !bar.clientWidth) return;
    const style = window.getComputedStyle(bar);
    const gap = parseFloat(style.columnGap || style.gap) || 0;
    const children = [...bar.children];
    const needed =
      children.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) +
      gap * Math.max(0, children.length - 1) +
      (parseFloat(style.paddingLeft) || 0) +
      (parseFloat(style.paddingRight) || 0);
    if (needed <= bar.clientWidth + 1) return;
    const next = FOLD_ORDER.find((key) => foldable[key] && !folded.includes(key));
    if (next) setFolded((previous) => [...previous, next]);
  });

  // A wider window unfolds everything and lets the pass above fold again.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return undefined;
    let lastWidth = bar.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = bar.clientWidth;
      if (width > lastWidth + 1) setFolded([]);
      lastWidth = width;
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const zoomSlider = (
    <input
      type="range"
      className="topbar__zoom-slider"
      min={minimumZoomLevel}
      max={ZOOM_MAX_INDEX}
      value={zoomLevel}
      step={ZOOM_LEVEL_STEP}
      aria-label="Grid zoom"
      aria-valuetext={`${getTileWidthForZoomLevel(zoomLevel)}px cards`}
      title={
        zoomLevel < minimumZoomLevel
          ? "Below the smallest card size this many clips can play smoothly at"
          : "Card size"
      }
      onChange={(event) => onZoomChange?.(clampZoomIndex(Number.parseFloat(event.target.value)))}
      disabled={busy}
      data-below-minimum={zoomLevel < minimumZoomLevel ? "true" : undefined}
    />
  );

  const normalizedPlayback = normalizePlaybackMode(playbackMode);
  const target = Math.max(0, Number(playbackDecision?.target) || 0);
  const safetyCap = Math.max(target, Number(playbackDecision?.safetyCap) || 0);
  const decoderSummary = workSuspended
    ? "Media paused"
    : playbackDecision
      ? `${target} of ${safetyCap} decoder${safetyCap === 1 ? "" : "s"} in use`
      : "";

  const viewItems = [
    { type: "checkbox", id: "filenames", label: "Show file names", checked: showFilenames, onChange: () => onFilenamesToggle?.(), disabled: busy },
    { type: "checkbox", id: "hover-audio", label: "Play audio on hover", checked: hoverAudioEnabled, onChange: () => onHoverAudioToggle?.(), disabled: busy },
    { type: "checkbox", id: "group", label: "Group by folders", checked: groupByFolders, onChange: () => onGroupByFoldersToggle?.(), disabled: busy },
    {
      type: "checkbox",
      id: "folder-groups",
      label: "Folder groups strip",
      hint: "Buttons for jumping between folder groups, shown while the sidebar is hidden",
      checked: showFolderHeaders,
      onChange: (value) => onFolderHeadersToggle?.(value),
      disabled: busy || !groupByFolders,
    },
    { type: "separator", id: "sep-playback" },
    { type: "heading", id: "playback-heading", label: "Playback" },
    ...PLAYBACK_OPTIONS.map((option) => ({
      type: "radio",
      id: `playback-${option.value}`,
      label: option.label,
      hint: MODE_DESCRIPTIONS[option.value],
      checked: normalizedPlayback === option.value,
      onSelect: () => onPlaybackModeChange?.(option.value),
      disabled: busy,
    })),
    {
      type: "checkbox",
      id: "proxy",
      label: "Playback proxies (720p)",
      hint: "Generate bounded 720p playback proxies in the background; originals are never changed",
      checked: proxyPlaybackEnabled,
      onChange: () => onProxyPlaybackToggle?.(),
      disabled: busy || !proxyPlaybackAvailable,
    },
    {
      type: "checkbox",
      id: "playback-details",
      label: "Playback details in the status line",
      hint: "Decoders, frames dropped and memory, for tuning playback",
      checked: playbackDetailsVisible,
      onChange: () => onPlaybackDetailsToggle?.(),
    },
    decoderSummary || playbackCapabilityStatus
      ? { type: "note", id: "playback-note", text: [decoderSummary, playbackCapabilityStatus].filter(Boolean).join(" · ") }
      : null,
  ];

  const foldedItems = [];
  if (isFolded("siblings") && foldable.siblings) {
    foldedItems.push(
      { type: "item", id: "previous-folder", label: previousSibling ? `Previous folder: ${siblingLabel(previousSibling)}` : "Previous folder", shortcut: "[", disabled: busy || !previousSibling, onSelect: () => onPreviousFolder?.(previousSibling) },
      { type: "item", id: "next-folder", label: nextSibling ? `Next folder: ${siblingLabel(nextSibling)}` : "Next folder", shortcut: "]", disabled: busy || !nextSibling, onSelect: () => onNextFolder?.(nextSibling) }
    );
  }
  if (isFolded("subfolders")) {
    foldedItems.push({ type: "checkbox", id: "folded-subfolders", label: "Include subfolders", checked: recursive, onChange: (value) => onRecursiveChange?.(value), disabled: busy });
  }
  if (isFolded("scope") && foldable.scope) {
    foldedItems.push(
      { type: "heading", id: "folded-scope-heading", label: "Scope" },
      ...SCOPE_OPTIONS.map((option) => ({ type: "radio", id: `folded-scope-${option.value}`, label: option.label, checked: scope === option.value, onSelect: () => onScopeChange?.(option.value), disabled: busy }))
    );
  }
  if (isFolded("sort")) {
    foldedItems.push(
      { type: "heading", id: "folded-sort-heading", label: "Sort" },
      ...SORT_OPTIONS.map((option) => ({ type: "radio", id: `folded-sort-${option.value}`, label: option.label, hint: option.hint, checked: sortSelection === option.value, onSelect: () => onSortChange?.(option.value), disabled: busy }))
    );
  }
  if (isFolded("zoom")) {
    foldedItems.push({ type: "heading", id: "folded-zoom-heading", label: "Card size" }, { type: "custom", id: "folded-zoom", render: () => zoomSlider });
  }

  const moreItems = [
    ...foldedItems,
    foldedItems.length ? { type: "separator", id: "sep-folded" } : null,
    { type: "item", id: "shortcuts", label: "Keyboard shortcuts", shortcut: "?", onSelect: () => onHotkeyHelp?.() },
    onOpenPreferences ? { type: "item", id: "preferences", label: "Preferences…", shortcut: "Ctrl+,", onSelect: () => onOpenPreferences() } : null,
    { type: "separator", id: "sep-app" },
    { type: "item", id: "about", label: "About Video Swarm", onSelect: () => onOpenAbout?.() },
    { type: "item", id: "support", label: supportContent.donationLinkLabel || "Support Video Swarm", onSelect: () => onOpenSupport?.() },
  ];

  const openItems = [
    { type: "item", id: "open-folder", label: "Open folder…", shortcut: "Ctrl+O", onSelect: () => onOpenFolder?.(), disabled: busy },
    ...(recentFolders.length
      ? [{ type: "heading", id: "recent-heading", label: "Recent" },
        ...recentFolders.slice(0, 8).map((folder) => ({ type: "item", id: `recent-${folder.path}`, label: folder.name || folder.path, hint: folder.path, onSelect: () => onOpenLocation?.(folder.path), disabled: busy }))]
      : []),
    ...(pinnedFolders.length
      ? [{ type: "heading", id: "pinned-heading", label: "Pinned folders" },
        ...pinnedFolders.slice(0, 12).map((folder) => ({ type: "item", id: `pinned-${folder.rootPath}`, label: folder.name || folder.rootPath, hint: folder.rootPath, onSelect: () => onOpenLocation?.(folder.rootPath), disabled: busy }))]
      : []),
  ];

  const safeMatching = Math.max(0, Number(matchingCount) || 0).toLocaleString();
  const safeTotal = Math.max(0, Number(totalCount) || 0).toLocaleString();

  return (
    <div className="header topbar" ref={barRef}>
      {showSidebarToggle ? (
        <button
          type="button"
          className={`toggle-button topbar__icon ${sidebarOpen ? "is-active" : ""}`}
          onClick={() => onSidebarToggle?.(!sidebarOpen)}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          disabled={busy}
        >
          ☰
        </button>
      ) : null}

      <MenuButton
        label="Open"
        icon={<FolderIcon />}
        items={openItems}
        ariaLabel="Open"
        title="Open a folder"
        align="start"
        buttonClassName="toggle-button topbar__open"
        disabled={busy && !recentFolders.length}
      />

      {hasOpenFolder ? (
        <nav className="topbar__location" aria-label="Location">
          {!isFolded("siblings") ? (
            <span className="topbar__siblings">
              <button type="button" className="toggle-button topbar__icon" onClick={() => onPreviousFolder?.(previousSibling)}
                aria-label={`Previous folder: ${siblingLabel(previousSibling) || "none"}`}
                title={previousSibling ? `Previous folder: ${siblingLabel(previousSibling)} ([)` : "No previous folder"}
                disabled={busy || !previousSibling}>‹</button>
              <button type="button" className="toggle-button topbar__icon" onClick={() => onNextFolder?.(nextSibling)}
                aria-label={`Next folder: ${siblingLabel(nextSibling) || "none"}`}
                title={nextSibling ? `Next folder: ${siblingLabel(nextSibling)} (])` : "No next folder"}
                disabled={busy || !nextSibling}>›</button>
            </span>
          ) : null}
          <span className="topbar__breadcrumb" aria-label="Current folder path" role="group">
            {breadcrumb.map((crumb, index) => {
              const isCurrent = crumb?.current === true || index === breadcrumb.length - 1;
              return (
                <React.Fragment key={crumb?.key ?? crumb?.relativePath ?? index}>
                  {index > 0 ? <span className="topbar__separator" aria-hidden="true">/</span> : null}
                  <button type="button" className={`topbar__crumb ${isCurrent ? "is-current" : ""}`}
                    onClick={() => onBreadcrumbSelect?.(crumb?.relativePath || "")}
                    aria-current={isCurrent ? "location" : undefined}
                    title={crumb?.fullPath || crumb?.label || ""} disabled={busy}>
                    {crumb?.label || "Root"}
                  </button>
                </React.Fragment>
              );
            })}
          </span>
          <span className="topbar__count" aria-label={`${safeMatching} matching clips out of ${safeTotal}`}>
            {safeMatching} / {safeTotal}
          </span>
        </nav>
      ) : null}

      {hasOpenFolder && !isFolded("scope") ? (
        <select className="select-control topbar__scope" value={scope} aria-label="Folder scope" title="Which folders in the location to show"
          onChange={(event) => onScopeChange?.(event.target.value)} disabled={busy}>
          {SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : null}

      {!isFolded("subfolders") ? (
        <label className="subfolders-option topbar__subfolders" title="Include clips in subfolders, and watch them for changes">
          <input type="checkbox" checked={recursive} onChange={(event) => onRecursiveChange?.(event.target.checked)} disabled={busy} />
          <span>Include subfolders</span>
        </label>
      ) : null}

      {isRefreshingFolder ? (
        <span className="folder-refresh-status" role="status">
          <span className="folder-refresh-status__spinner" aria-hidden="true" />
          Refreshing
        </span>
      ) : null}

      <span className="topbar__spacer" />

      <div className="topbar__filters">
        <button ref={filtersButtonRef} onClick={onFiltersToggle} disabled={busy} type="button"
          className={`toggle-button ${filtersActiveCount > 0 || filtersAreOpen ? "active" : ""}`}
          title={filtersActiveCount > 0 ? `Filters active (${filtersActiveCount})` : "Open filters"}>
          <FilterIcon />
          <span className="filters-button-label">Filters</span>
          {filtersActiveCount > 0 && <span className="filters-button-badge" aria-hidden="true">{filtersActiveCount}</span>}
        </button>
        {filtersActiveCount > 0 && (
          <button type="button" className="filters-button-clear" onClick={onFiltersClear} disabled={busy}
            aria-label={`Clear ${filtersActiveCount} active filter${filtersActiveCount === 1 ? "" : "s"}`} title="Clear all filters">
            <span className="filters-button-clear__count" aria-hidden="true">{filtersActiveCount}</span>
            <span className="filters-button-clear__icon" aria-hidden="true">×</span>
          </button>
        )}
      </div>

      {!isFolded("sort") ? (
        <select className="select-control topbar__sort" value={sortSelection} aria-label="Sort order" title="Sort order"
          onChange={(event) => onSortChange?.(event.target.value)} disabled={busy}>
          {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value} title={option.hint}>{option.label}</option>)}
        </select>
      ) : null}
      {sortKey === SortKey.RANDOM ? (
        <button type="button" className="toggle-button topbar__icon" onClick={onReshuffle} disabled={busy} title="Reshuffle" aria-label="Reshuffle">
          <ShuffleIcon />
        </button>
      ) : null}

      {!isFolded("zoom") ? (
        <label className="topbar__zoom" title="Card size">
          <ZoomIcon />
          {zoomSlider}
        </label>
      ) : null}

      <button type="button" className={`toggle-button topbar__review ${reviewModeEnabled ? "active" : ""}`}
        onClick={() => onReviewModeToggle?.()} aria-pressed={reviewModeEnabled} disabled={busy}
        title={reviewModeEnabled ? "Turn off review: hide the review bar and review badges" : "Turn on review: accept, reject and track progress"}>
        Review
      </button>

      <MenuButton label="View" items={viewItems} ariaLabel="View" title="View options" />
      <MenuButton
        label=""
        icon={<span aria-hidden="true" className="topbar__more-icon">⋯</span>}
        items={moreItems}
        ariaLabel="More"
        title={foldedItems.length ? "More: controls that did not fit, and app options" : "More"}
        buttonClassName="toggle-button topbar__more"
        showCaret={false}
      />
    </div>
  );
}
