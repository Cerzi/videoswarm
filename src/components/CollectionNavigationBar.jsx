import React from "react";
import { FolderScope } from "../library/folderModel";
import "./LibraryNavigation.css";

const siblingLabel = (value, fallback) =>
  value?.name || value?.label || value?.path || value?.relativePath || fallback;

function CollectionNavigationBar({
  breadcrumb = [],
  onBreadcrumbSelect,
  scope = FolderScope.ALL_DESCENDANTS,
  onScopeChange,
  previousSibling = null,
  nextSibling = null,
  onPreviousFolder,
  onNextFolder,
  recursive = false,
  onRecursiveChange,
  sidebarOpen = true,
  onSidebarToggle,
  showFolderHeaders = false,
  onFolderHeadersToggle,
  folderHeadersAvailable = true,
  matchingCount = 0,
  totalCount = 0,
  disabled = false,
}) {
  const safeMatchingCount = Math.max(0, Number(matchingCount) || 0);
  const safeTotalCount = Math.max(0, Number(totalCount) || 0);
  const formattedMatchingCount = safeMatchingCount.toLocaleString();
  const formattedTotalCount = safeTotalCount.toLocaleString();

  return (
    <div className="collection-navigation" aria-label="Collection navigation">
      <div className="collection-navigation__primary">
        <button
          type="button"
          className={`collection-navigation__icon-button ${
            sidebarOpen ? "is-active" : ""
          }`}
          onClick={() => onSidebarToggle?.(!sidebarOpen)}
          aria-label={sidebarOpen ? "Hide folder sidebar" : "Show folder sidebar"}
          aria-pressed={sidebarOpen}
          disabled={disabled}
          title={sidebarOpen ? "Hide folder sidebar" : "Show folder sidebar"}
        >
          ☰
        </button>

        <div className="collection-navigation__siblings" aria-label="Sibling folders">
          <button
            type="button"
            className="collection-navigation__icon-button"
            onClick={() => onPreviousFolder?.(previousSibling)}
            aria-label={`Previous matching folder: ${siblingLabel(
              previousSibling,
              "none"
            )}`}
            title={
              previousSibling
                ? `Previous matching folder: ${siblingLabel(previousSibling, "")}`
                : "No previous matching folder"
            }
            disabled={disabled || !previousSibling}
          >
            ‹
          </button>
          <button
            type="button"
            className="collection-navigation__icon-button"
            onClick={() => onNextFolder?.(nextSibling)}
            aria-label={`Next matching folder: ${siblingLabel(
              nextSibling,
              "none"
            )}`}
            title={
              nextSibling
                ? `Next matching folder: ${siblingLabel(nextSibling, "")}`
                : "No next matching folder"
            }
            disabled={disabled || !nextSibling}
          >
            ›
          </button>
        </div>

        <nav
          className="collection-navigation__breadcrumb"
          aria-label="Current folder path"
        >
          {breadcrumb.map((crumb, index) => {
            const isCurrent =
              crumb?.current === true || index === breadcrumb.length - 1;
            return (
              <React.Fragment key={crumb?.key ?? crumb?.relativePath ?? index}>
                {index > 0 ? (
                  <span
                    className="collection-navigation__separator"
                    aria-hidden="true"
                  >
                    /
                  </span>
                ) : null}
                <button
                  type="button"
                  className={`collection-navigation__crumb ${
                    isCurrent ? "is-current" : ""
                  }`}
                  onClick={() => onBreadcrumbSelect?.(crumb?.relativePath || "")}
                  aria-current={isCurrent ? "location" : undefined}
                  title={crumb?.fullPath || crumb?.label || ""}
                  disabled={disabled}
                >
                  {crumb?.label || "Root"}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
      </div>

      <div className="collection-navigation__controls">
        <span
          className="collection-navigation__count"
          aria-label={`${formattedMatchingCount} matching videos out of ${formattedTotalCount}`}
        >
          {formattedMatchingCount} / {formattedTotalCount}
        </span>

        <label className="collection-navigation__scope">
          <span>Scope</span>
          <select
            value={scope}
            onChange={(event) => onScopeChange?.(event.target.value)}
            disabled={disabled}
            aria-label="Folder scope"
          >
            <option value={FolderScope.ALL_DESCENDANTS}>All descendants</option>
            <option value={FolderScope.CURRENT_FOLDER}>Current folder</option>
            <option value={FolderScope.CURRENT_SUBTREE}>Current subtree</option>
          </select>
        </label>

        <label
          className="collection-navigation__check"
          title="Index and watch videos inside subfolders"
        >
          <input
            type="checkbox"
            checked={recursive}
            onChange={(event) => onRecursiveChange?.(event.target.checked)}
            disabled={disabled}
          />
          <span>Index subfolders</span>
        </label>

        {!sidebarOpen && folderHeadersAvailable ? (
          <button
            type="button"
            className={`collection-navigation__headers-toggle ${
              showFolderHeaders ? "is-active" : ""
            }`}
            onClick={() => onFolderHeadersToggle?.(!showFolderHeaders)}
            aria-label="Show folder headers"
            aria-pressed={showFolderHeaders}
            disabled={disabled}
            title="Show folder section headers in the flattened grid"
          >
            Headers
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default React.memo(CollectionNavigationBar);
