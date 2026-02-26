import React from "react";
import "./FiltersPopover.css";

const basename = (value) => {
  const text = (value ?? "").toString();
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? text;
};

export default function SourcesPopover({
  sources = [],
  filters,
  onSelectSource,
  onToggleIncludeSubfolders,
  onAddFolder,
  onOpenManageSources,
}) {
  const activePath = filters?.activePathPrefix ?? null;
  const isFolderMode = filters?.searchIn === "FOLDER" && !!activePath;

  return (
    <div className="filters-popover" role="dialog" aria-label="Known sources">
      <div className="filters-popover__header">
        <div>
          <h3>Known Locations</h3>
          <p>Pick a source to filter the grid.</p>
        </div>
      </div>

      <section className="filters-section">
        <div className="filters-tag-list" role="list">
          {sources.map((source) => {
            const selected = activePath === source.path && isFolderMode;
            return (
              <button
                key={source.id}
                type="button"
                className={`sources-row ${selected ? "sources-row--active" : ""}`}
                onClick={() => onSelectSource(source.path)}
                title={source.path}
              >
                <span>{basename(source.path)}</span>
                <span>{source.clipCount ?? 0} clips</span>
              </button>
            );
          })}
        </div>

        {isFolderMode && (
          <label className="filters-scope-option">
            <input
              type="checkbox"
              checked={Boolean(filters?.includeSubfolders)}
              onChange={(event) => onToggleIncludeSubfolders(event.target.checked)}
            />
            <span>Include subfolders</span>
          </label>
        )}

        <div className="filters-popover__header-actions">
          <button type="button" className="filters-link" onClick={onAddFolder}>
            Add Folder…
          </button>
          <button type="button" className="filters-link" onClick={onOpenManageSources}>
            Manage Sources…
          </button>
        </div>
      </section>
    </div>
  );
}
