import React from "react";
import RecentLocationsMenu from "./RecentLocationsMenu";
import SupportLink from "./SupportLink";
import { supportContent } from "../config/supportContent";
import { ZOOM_MAX_INDEX } from "../zoom/config.js";
import { clampZoomIndex } from "../zoom/utils.js";
import { SortKey } from "../sorting/sorting.js";

// --- Minimal inline SVG icons (fallback for environments without icon libs)
const Icon = (props) => (
  <svg
    viewBox="0 0 24 24"
    width="1em"
    height="1em"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    fill="none"
    {...props}
  />
);

const FolderIcon = (props) => (
  <Icon {...props}>
    <path d="M3 4h5l2 2h11v14H3z" />
  </Icon>
);

const TextIcon = (props) => (
  <Icon {...props}>
    <path d="M4 7V4h16v3" />
    <path d="M12 4v16" />
    <path d="M9 20h6" />
  </Icon>
);

const FilmIcon = (props) => (
  <Icon {...props}>
    <rect x="2" y="2" width="20" height="20" rx="2" />
    <line x1="7" y1="2" x2="7" y2="22" />
    <line x1="17" y1="2" x2="17" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
  </Icon>
);

const ZoomInIcon = (props) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
    <line x1="11" y1="8" x2="11" y2="14" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </Icon>
);

const GridIcon = (props) => (
  <Icon {...props}>
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
  </Icon>
);

const ShuffleIcon = (props) => (
  <Icon {...props}>
    <polyline points="16 3 21 3 21 8" />
    <line x1="4" y1="20" x2="21" y2="3" />
    <polyline points="21 16 21 21 16 21" />
    <line x1="4" y1="4" x2="9" y2="9" />
    <line x1="15" y1="15" x2="21" y2="21" />
  </Icon>
);

const SortIcon = (props) => (
  <Icon {...props}>
    <path d="M3 9l4-4 4 4" />
    <path d="M7 5v14" />
    <path d="M21 15l-4 4-4-4" />
    <path d="M17 5v14" />
  </Icon>
);

const FilterIcon = (props) => (
  <Icon {...props}>
    <path d="M4 4h16" />
    <path d="M6 9h12" />
    <path d="M10 14h4" />
    <path d="M12 14v6" />
  </Icon>
);

export default function HeaderBar({
  isLoadingFolder,
  handleFolderSelect,
  handleWebFileSelection,
  recursiveMode,
  toggleRecursive,
  showFilenames,
  toggleFilenames,
  renderLimitStep,
  renderLimitLabel = "Max",
  renderLimitMaxStep = 10,
  handleRenderLimitChange,
  zoomLevel,
  handleZoomChangeSafe,
  getMinimumZoomLevel,
  sortKey,
  sortSelection,
  groupByFolders,
  onSortChange,
  onGroupByFoldersToggle,
  onReshuffle,
  recentFolders = [],
  onRecentOpen,
  hasOpenFolder = false,
  onFiltersToggle,
  filtersActiveCount = 0,
  filtersAreOpen = false,
  filtersButtonRef,
}) {
  const isElectron = !!window.electronAPI?.isElectron;

  const minZoomIndex = getMinimumZoomLevel();

  const dividerStyle = {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginLeft: "1rem",
    paddingLeft: "1rem",
    borderLeft: "1px solid #ccc",
  };

  return (
    <div className="header">
      <div className="nav-left">
        {isElectron ? (
          <button
            onClick={handleFolderSelect}
            className="file-input-label"
            disabled={isLoadingFolder}
            title="Select folder"
          >
            <FolderIcon />
          </button>
        ) : (
          <div className="file-input-wrapper">
            <input
              type="file"
              className="file-input"
              webkitdirectory="true"
              multiple
              onChange={handleWebFileSelection}
              style={{ display: "none" }}
              id="fileInput"
              disabled={isLoadingFolder}
            />
            <label htmlFor="fileInput" className="file-input-label" title="Open folder">
              <FolderIcon />
            </label>
          </div>
        )}

        <label className="subfolders-option" title="Scan subfolders">
          <input
            type="checkbox"
            checked={recursiveMode}
            onChange={toggleRecursive}
            disabled={isLoadingFolder}
          />
          <span>Subfolders</span>
        </label>

        {hasOpenFolder && recentFolders.length > 0 && (
          <RecentLocationsMenu items={recentFolders} onOpen={onRecentOpen} />
        )}
      </div>

      <div className="controls" style={{ display: "flex", alignItems: "center" }}>
        <button
          onClick={toggleFilenames}
          className={`toggle-button ${showFilenames ? "active" : ""}`}
          disabled={isLoadingFolder}
          title="Show/hide filenames"
        >
          <TextIcon />
        </button>

        <div style={dividerStyle}>
          <div className="video-limit-control" title="Limit rendered VideoCards">
            <FilmIcon />
            <input
              type="range"
              min="0"
              max={renderLimitMaxStep}
              value={renderLimitStep}
              step="1"
              style={{ width: 100 }}
              onChange={(e) =>
                handleRenderLimitChange(parseInt(e.target.value, 10))
              }
              disabled={isLoadingFolder}
              aria-label="Rendered VideoCards limit"
              aria-valuetext={renderLimitLabel}
            />
            <span style={{ fontSize: "0.8rem" }}>{renderLimitLabel}</span>
          </div>

          <div className="zoom-control" title="Zoom">
            <ZoomInIcon />
            <input
              type="range"
              min={minZoomIndex}
              max={ZOOM_MAX_INDEX}
              value={zoomLevel}
              step="1"
              onChange={(e) =>
                handleZoomChangeSafe(
                  clampZoomIndex(parseInt(e.target.value, 10))
                )
              }
              disabled={isLoadingFolder}
              style={{
                accentColor: zoomLevel >= minZoomIndex ? "#51cf66" : "#ffa726",
              }}
            />
            {zoomLevel < minZoomIndex && (
              <span style={{ color: "#ffa726", fontSize: "0.7rem" }}>!</span>
            )}
          </div>
        </div>

        <div style={dividerStyle}>
          <SortIcon />
          <select
            className="select-control"
            value={sortSelection}
            onChange={(e) => onSortChange(e.target.value)}
            disabled={isLoadingFolder}
            title="Choose sort order"
          >
            <option value="name-asc">Name ↑</option>
            <option value="name-desc">Name ↓</option>
            <option
              value="created-asc"
              title="Falls back to Modified time if creation time is unavailable."
            >
              Created ↑
            </option>
            <option
              value="created-desc"
              title="Falls back to Modified time if creation time is unavailable."
            >
              Created ↓
            </option>
            <option value="random">Random</option>
          </select>

          <button
            onClick={onGroupByFoldersToggle}
            disabled={isLoadingFolder}
            className={`toggle-button ${groupByFolders ? "active" : ""}`}
            title="Group by folders"
          >
            <GridIcon />
          </button>

          {sortKey === SortKey.RANDOM && (
            <button
              onClick={onReshuffle}
              disabled={isLoadingFolder}
              className="toggle-button"
              title="Reshuffle"
            >
              <ShuffleIcon />
            </button>
          )}

          <div style={{ position: "relative" }}>
            <button
              ref={filtersButtonRef}
              onClick={onFiltersToggle}
              disabled={isLoadingFolder}
              className={`toggle-button ${
                filtersActiveCount > 0 || filtersAreOpen ? "active" : ""
              }`}
              title={
                filtersActiveCount > 0
                  ? `Filters active (${filtersActiveCount})`
                  : "Open filters"
              }
              type="button"
            >
              <FilterIcon />
              <span className="filters-button-label">Filters</span>
              {filtersActiveCount > 0 && (
                <span className="filters-button-badge">{filtersActiveCount}</span>
              )}
            </button>
          </div>

          <SupportLink
            className="donate-button"
            aria-label={`${supportContent.donationButtonLabel} – ${supportContent.donationTooltip}`}
            title={supportContent.donationTooltip}
          >
            <span aria-hidden="true" className="donate-button__icon">
              ❤️
            </span>
            <span className="donate-button__label">
              {supportContent.donationButtonLabel}
            </span>
          </SupportLink>
        </div>
      </div>
    </div>
  );
}
