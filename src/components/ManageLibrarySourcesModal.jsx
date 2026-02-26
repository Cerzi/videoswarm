import React from "react";

const formatDate = (value) => {
  if (!value) return "Never";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
};

export default function ManageLibrarySourcesModal({
  open,
  sources,
  onClose,
  onSetSourceIncluded,
  onReindexSource,
  onRemoveSource,
}) {
  if (!open) return null;

  return (
    <div className="library-sources-modal__backdrop" onClick={onClose}>
      <div className="library-sources-modal" onClick={(event) => event.stopPropagation()}>
        <h3>Manage Sources</h3>
        <div className="library-sources-modal__list">
          {sources.map((source) => (
            <div className="library-sources-modal__row" key={source.id}>
              <div>
                <strong>{source.path}</strong>
                <div className="library-sources-modal__meta">
                  Last opened: {formatDate(source.lastOpenedAt)}
                </div>
              </div>
              <div className="library-sources-modal__actions">
                <label>
                  <input
                    type="checkbox"
                    checked={source.isIncluded !== false}
                    onChange={(event) =>
                      onSetSourceIncluded(source.id, event.target.checked)
                    }
                  />
                  Included
                </label>
                <button type="button" onClick={() => onReindexSource(source.id)}>
                  Reindex
                </button>
                <button type="button" onClick={() => onRemoveSource(source.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
