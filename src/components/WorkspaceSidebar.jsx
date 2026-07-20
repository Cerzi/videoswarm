import React, { useId, useRef } from "react";
import { LibrarySidebarContent } from "./LibrarySidebar";
import "./WorkspaceSidebar.css";

const WORKSPACE_TABS = Object.freeze(["library", "details"]);

const normalizeActiveTab = (value) =>
  WORKSPACE_TABS.includes(value) ? value : "library";

const normalizeSelectionCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
};

export default function WorkspaceSidebar({
  activeTab = "library",
  onTabChange,
  libraryProps = {},
  detailsContent = null,
  selectionCount = 0,
  disabled = false,
}) {
  const selectedTab = normalizeActiveTab(activeTab);
  const selectedCount = normalizeSelectionCount(selectionCount);
  const id = `workspace-sidebar-${useId().replace(/:/g, "")}`;
  const tabRefs = useRef({});
  const safeLibraryProps = libraryProps && typeof libraryProps === "object"
    ? libraryProps
    : {};

  const selectTab = (tab) => {
    if (disabled || tab === selectedTab) return;
    onTabChange?.(tab);
  };

  const handleTabKeyDown = (event) => {
    if (disabled) return;
    const currentIndex = WORKSPACE_TABS.indexOf(selectedTab);
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % WORKSPACE_TABS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = WORKSPACE_TABS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = WORKSPACE_TABS[nextIndex];
    onTabChange?.(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const libraryTabId = `${id}-tab-library`;
  const detailsTabId = `${id}-tab-details`;
  const libraryPanelId = `${id}-panel-library`;
  const detailsPanelId = `${id}-panel-details`;

  return (
    <aside
      className="workspace-sidebar"
      aria-label="Library and clip details"
    >
      <div
        className="workspace-sidebar__tabs"
        role="tablist"
        aria-label="Workspace sidebar panels"
        onKeyDown={handleTabKeyDown}
      >
        <button
          ref={(node) => { tabRefs.current.library = node; }}
          type="button"
          id={libraryTabId}
          className="workspace-sidebar__tab"
          role="tab"
          aria-controls={libraryPanelId}
          aria-selected={selectedTab === "library"}
          tabIndex={selectedTab === "library" ? 0 : -1}
          disabled={disabled}
          onClick={() => selectTab("library")}
        >
          Library
        </button>
        <button
          ref={(node) => { tabRefs.current.details = node; }}
          type="button"
          id={detailsTabId}
          className="workspace-sidebar__tab"
          role="tab"
          aria-controls={detailsPanelId}
          aria-selected={selectedTab === "details"}
          tabIndex={selectedTab === "details" ? 0 : -1}
          disabled={disabled}
          onClick={() => selectTab("details")}
        >
          <span>Details</span>
          {selectedCount > 0 ? (
            <span
              className="workspace-sidebar__selection-count"
              aria-label={`${selectedCount.toLocaleString()} selected`}
            >
              {selectedCount.toLocaleString()}
            </span>
          ) : null}
        </button>
      </div>

      <div className="workspace-sidebar__body">
        <div
          id={libraryPanelId}
          className="workspace-sidebar__panel workspace-sidebar__panel--library"
          role="tabpanel"
          aria-labelledby={libraryTabId}
          tabIndex={selectedTab === "library" ? 0 : -1}
          hidden={selectedTab !== "library"}
        >
          <LibrarySidebarContent
            {...safeLibraryProps}
            disabled={disabled || Boolean(safeLibraryProps.disabled)}
          />
        </div>

        <div
          id={detailsPanelId}
          className="workspace-sidebar__panel workspace-sidebar__panel--details"
          role="tabpanel"
          aria-labelledby={detailsTabId}
          tabIndex={selectedTab === "details" ? 0 : -1}
          hidden={selectedTab !== "details"}
        >
          {detailsContent ?? (
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
          )}
        </div>
      </div>
    </aside>
  );
}
