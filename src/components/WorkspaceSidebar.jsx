import React, { useId, useRef } from "react";
import { LibrarySidebarContent } from "./LibrarySidebar";
import { DetailsIcon, GenerationIcon, LibraryIcon, SequenceIcon } from "./UiIcons";
import "./WorkspaceSidebar.css";

// The sidebar is an activity rail (UX redesign D7): a strip of icons, one per
// feature, beside one panel at the sidebar's full width. Clicking an icon
// shows its panel; clicking the open one collapses the sidebar to the rail.
// A feature joins by adding an entry to `panels`, so a queue or sequences
// panel never squeezes the others.
//   panels: [{ id, label, icon, badge: { text, label }, content }]

const normalizeSelectionCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
};

function EmptyDetails({ selectedCount }) {
  return (
    <div className="workspace-sidebar__empty-details" role="status">
      <span className="workspace-sidebar__empty-icon" aria-hidden="true">
        ◇
      </span>
      <strong>
        {selectedCount > 0 ? "Details unavailable" : "No clip selected"}
      </strong>
      <span>
        {selectedCount > 0
          ? "Details will appear when the selected clips are ready."
          : "Select a clip to inspect its metadata, tags, and review state."}
      </span>
    </div>
  );
}

function EmptyGeneration({ selectedCount }) {
  return (
    <div className="workspace-sidebar__empty-details" role="status">
      <span className="workspace-sidebar__empty-icon" aria-hidden="true">
        ◇
      </span>
      <strong>{selectedCount > 1 ? "Several clips selected" : "No clip selected"}</strong>
      <span>Select one clip to see how it was generated.</span>
    </div>
  );
}

// The panels every collection has. Details and Generation are present only
// while Details is docked; floating Details lives over the grid instead,
// with Generation as its last section. Sequences is present whenever the
// caller supplies it, in both Details modes: sequences belong to the
// profile, not to the selection.
export function buildWorkspacePanels({
  libraryProps = {},
  disabled = false,
  detailsDocked = false,
  detailsContent = null,
  generationContent = null,
  selectionCount = 0,
  sequencesContent = null,
  sequenceEntryCount = 0,
}) {
  const safeLibraryProps = libraryProps && typeof libraryProps === "object"
    ? libraryProps
    : {};
  const selectedCount = normalizeSelectionCount(selectionCount);
  const panels = [
    {
      id: "library",
      label: "Library",
      icon: <LibraryIcon />,
      content: (
        <LibrarySidebarContent
          {...safeLibraryProps}
          disabled={disabled || Boolean(safeLibraryProps.disabled)}
        />
      ),
    },
  ];
  if (detailsDocked) {
    panels.push({
      id: "details",
      label: "Details",
      icon: <DetailsIcon />,
      badge: selectedCount > 0
        ? {
          text: selectedCount.toLocaleString(),
          label: `${selectedCount.toLocaleString()} selected`,
        }
        : null,
      content: detailsContent ?? <EmptyDetails selectedCount={selectedCount} />,
    });
    panels.push({
      id: "generation",
      label: "Generation",
      icon: <GenerationIcon />,
      content: generationContent ?? <EmptyGeneration selectedCount={selectedCount} />,
    });
  }
  if (sequencesContent) {
    const entryCount = normalizeSelectionCount(sequenceEntryCount);
    panels.push({
      id: "sequences",
      label: "Sequences",
      icon: <SequenceIcon />,
      badge: entryCount > 0
        ? {
          text: entryCount.toLocaleString(),
          label: `${entryCount.toLocaleString()} ${entryCount === 1 ? "clip" : "clips"} in the sequence`,
        }
        : null,
      content: sequencesContent,
    });
  }
  return panels;
}

export default function WorkspaceSidebar({
  panels = [],
  activePanel = "library",
  open = true,
  onSelectPanel,
  onCollapse,
  disabled = false,
}) {
  const id = `workspace-sidebar-${useId().replace(/:/g, "")}`;
  const tabRefs = useRef({});
  const available = panels.filter(Boolean);
  const active = available.some((panel) => panel.id === activePanel)
    ? activePanel
    : available[0]?.id;
  const shownPanel = open ? available.find((panel) => panel.id === active) : null;

  const activate = (panelId) => {
    if (disabled) return;
    if (open && panelId === active) onCollapse?.();
    else onSelectPanel?.(panelId);
  };

  // Manual activation: arrows move focus along the rail, Enter or Space
  // opens, so moving through it never opens or collapses anything.
  const handleRailKeyDown = (event) => {
    if (disabled || !available.length) return;
    const ids = available.map((panel) => panel.id);
    const focusedIndex = ids.findIndex(
      (panelId) => tabRefs.current[panelId] === document.activeElement
    );
    const current = focusedIndex >= 0 ? focusedIndex : ids.indexOf(active);
    let next;
    if (event.key === "ArrowDown") next = (current + 1) % ids.length;
    else if (event.key === "ArrowUp") next = (current - 1 + ids.length) % ids.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else return;
    event.preventDefault();
    tabRefs.current[ids[next]]?.focus();
  };

  return (
    <aside
      className={`workspace-sidebar ${open ? "is-open" : "is-collapsed"}`}
      aria-label="Sidebar"
    >
      <div
        className="workspace-sidebar__rail"
        role="tablist"
        aria-label="Sidebar panels"
        aria-orientation="vertical"
        onKeyDown={handleRailKeyDown}
      >
        {available.map((panel) => {
          const selected = Boolean(shownPanel && shownPanel.id === panel.id);
          return (
            <button
              key={panel.id}
              ref={(node) => { tabRefs.current[panel.id] = node; }}
              type="button"
              id={`${id}-tab-${panel.id}`}
              className="workspace-sidebar__rail-button"
              role="tab"
              aria-controls={open ? `${id}-panel-${panel.id}` : undefined}
              aria-selected={selected}
              tabIndex={panel.id === active ? 0 : -1}
              title={selected ? `Hide ${panel.label}` : panel.label}
              disabled={disabled}
              onClick={() => activate(panel.id)}
            >
              <span className="workspace-sidebar__rail-icon" aria-hidden="true">
                {panel.icon}
              </span>
              <span className="workspace-sidebar__rail-label">{panel.label}</span>
              {panel.badge ? (
                <span
                  className="workspace-sidebar__rail-badge"
                  aria-label={panel.badge.label}
                >
                  {panel.badge.text}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Every panel stays mounted while the sidebar is open, so switching
          keeps the library's scroll position and a half-typed tag. */}
      {open ? (
        <div className="workspace-sidebar__body">
          {available.map((panel) => (
            <div
              key={panel.id}
              id={`${id}-panel-${panel.id}`}
              className={`workspace-sidebar__panel workspace-sidebar__panel--${panel.id}`}
              role="tabpanel"
              aria-labelledby={`${id}-tab-${panel.id}`}
              tabIndex={panel.id === active ? 0 : -1}
              hidden={panel.id !== active}
            >
              {panel.content}
            </div>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
