import React from "react";
import { ZOOM_MAX_INDEX } from "../zoom/config.js";
import { clampZoomIndex } from "../zoom/utils.js";
import { SortKey } from "../sorting/sorting.js";

export default function HeaderBar({
  version,
  isLoadingFolder,
  handleFolderSelect,
  handleWebFileSelection,
  recursiveMode,
  toggleRecursive,
  showFilenames,
  toggleFilenames,
  maxConcurrentPlaying,
  handleVideoLimitChange,
  zoomLevel,
  handleZoomChangeSafe,
  getMinimumZoomLevel,
  sortKey,
  sortSelection,
  groupByFolders,
  onSortChange,
  onGroupByFoldersToggle,
  onReshuffle,
}) {
  const isElectron = !!window.electronAPI?.isElectron;

  const minZoomIndex = getMinimumZoomLevel();

  const groupStyle = {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  };
  const dividerStyle = {
    ...groupStyle,
    marginLeft: "1rem",
    paddingLeft: "1rem",
    borderLeft: "1px solid #ccc",
  };

  return (
    <div className="header">
      <h1>
        🐝 Video Swarm{" "}
        <span style={{ fontSize: "0.6rem", color: "#666" }}>v{version}</span>
      </h1>

      <div className="controls" style={{ display: "flex", alignItems: "center" }}>
        <div style={groupStyle}>
          {isElectron ? (
            <button
              onClick={handleFolderSelect}
              className="file-input-label"
              disabled={isLoadingFolder}
              title="Select folder"
            >
              📁
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
                ⚠️
              </label>
            </div>
          )}

          <button
            onClick={toggleRecursive}
            className={`toggle-button ${recursiveMode ? "active" : ""}`}
            disabled={isLoadingFolder}
            title="Scan subfolders"
          >
            📂
          </button>

          <button
            onClick={toggleFilenames}
            className={`toggle-button ${showFilenames ? "active" : ""}`}
            disabled={isLoadingFolder}
            title="Show/hide filenames"
          >
            📝
          </button>
        </div>

        <div style={dividerStyle}>
          <div
            className="video-limit-control"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            title="Max playing limit"
          >
            <span>🎹</span>
            <input
              type="range"
              min="10"
              max="500"
              value={maxConcurrentPlaying}
              step="10"
              style={{ width: 100 }}
              onChange={(e) =>
                handleVideoLimitChange(parseInt(e.target.value, 10))
              }
              disabled={isLoadingFolder}
            />
            <span style={{ fontSize: "0.8rem" }}>{maxConcurrentPlaying}</span>
          </div>

          <div
            className="zoom-control"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            title="Zoom"
          >
            <span>🔍</span>
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
                accentColor:
                  zoomLevel >= minZoomIndex ? "#51cf66" : "#ffa726",
              }}
            />
            {zoomLevel < minZoomIndex && (
              <span style={{ color: "#ffa726", fontSize: "0.7rem" }}>⚠️</span>
            )}
          </div>
        </div>

        <div style={dividerStyle}>
          <select
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
            🗂️
          </button>

          {sortKey === SortKey.RANDOM && (
            <button
              onClick={onReshuffle}
              disabled={isLoadingFolder}
              className="toggle-button"
              title="Reshuffle"
            >
              🔀
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
