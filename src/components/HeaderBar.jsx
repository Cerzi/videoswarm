import React from "react";
import { ZOOM_MAX_INDEX } from "../zoom/config.js";
import { clampZoomIndex } from "../zoom/utils.js";

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
}) {
  const isElectron = !!window.electronAPI?.isElectron;

  const minZoomIndex = getMinimumZoomLevel();

  return (
    <div className="header">
      <h1>
        🐝 Video Swarm{" "}
        <span style={{ fontSize: "0.6rem", color: "#666" }}>v{version}</span>
      </h1>

      <div id="folderControls">
        {isElectron ? (
          <button
            onClick={handleFolderSelect}
            className="file-input-label"
            disabled={isLoadingFolder}
          >
            📁 Select Folder
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
            <label htmlFor="fileInput" className="file-input-label">
              ⚠️ Open Folder (Limited)
            </label>
          </div>
        )}
      </div>

      <div className="controls">
        <button
          onClick={toggleRecursive}
          className={`toggle-button ${recursiveMode ? "active" : ""}`}
          disabled={isLoadingFolder}
        >
          {recursiveMode ? "📂 Recursive ON" : "📂 Recursive"}
        </button>

        <button
          onClick={toggleFilenames}
          className={`toggle-button ${showFilenames ? "active" : ""}`}
          disabled={isLoadingFolder}
        >
          {showFilenames ? "📝 Filenames ON" : "📝 Filenames"}
        </button>

        <div
          className="video-limit-control"
          style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
        >
          <span>🎹</span>
          <input
            type="range"
            min="10"
            max="500"
            value={maxConcurrentPlaying}
            step="10"
            style={{ width: 100 }}
            onChange={(e) => handleVideoLimitChange(parseInt(e.target.value, 10))}
            disabled={isLoadingFolder}
          />
          <span style={{ fontSize: "0.8rem" }}>{maxConcurrentPlaying}</span>
        </div>

        <div
          className="zoom-control"
          style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
        >
          <span>🔍</span>
          <input
            type="range"
            min={minZoomIndex}
            max={ZOOM_MAX_INDEX}
            value={zoomLevel}
            step="1"
            onChange={(e) =>
              handleZoomChangeSafe(clampZoomIndex(parseInt(e.target.value, 10)))
            }
            disabled={isLoadingFolder}
            style={{
              accentColor: zoomLevel >= minZoomIndex ? "#51cf66" : "#ffa726",
            }}
          />
          {zoomLevel < minZoomIndex && (
            <span style={{ color: "#ffa726", fontSize: "0.7rem" }}>⚠️</span>
          )}
        </div>
      </div>
    </div>
  );
}
