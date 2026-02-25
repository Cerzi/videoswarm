import React, { useEffect, useMemo, useRef, useState } from "react";

const formatDate = (value) => {
  if (!value) return "Never";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
};

export default function LibraryOverlayDrawer({
  isOpen,
  onToggle,
  videos,
  librarySources,
  filters,
  onFiltersChange,
  onRemoveSource,
  onReindexSource,
  onSetSourceIncluded,
}) {
  const [isManageOpen, setManageOpen] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeydown = (event) => {
      if (event.key === "Escape") {
        onToggle(false);
      }
    };

    const handlePointerDown = (event) => {
      if (!panelRef.current?.contains(event.target)) {
        onToggle(false);
      }
    };

    window.addEventListener("keydown", handleKeydown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isOpen, onToggle]);

  const tagCounts = useMemo(() => {
    const counts = new Map();
    videos.forEach((video) => {
      (video.tags ?? []).forEach((tag) => {
        const normalized = (tag ?? "").toString().trim();
        if (!normalized) return;
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      });
    });
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [videos]);

  const selectedSourceIds = filters.sourceIds ?? [];
  const selectedTagSet = new Set(filters.includeTags ?? []);

  return (
    <>
      <div className={`library-overlay ${isOpen ? "library-overlay--open" : ""}`}>
        <button
          type="button"
          className="library-overlay__handle"
          aria-label="Toggle library drawer"
          onClick={() => onToggle(!isOpen)}
        >
          {isOpen ? "⟨" : "⟩"}
        </button>

        <aside className="library-overlay__panel" ref={panelRef} aria-hidden={!isOpen}>
          <header className="library-overlay__header">
            <h3>Library</h3>
            <button type="button" className="toggle-button" onClick={() => setManageOpen(true)}>
              Manage Sources
            </button>
          </header>

          <section className="library-overlay__section">
            <h4>Scope</h4>
            <button
              type="button"
              className={`library-overlay__pill ${selectedSourceIds.length === 0 ? "active" : ""}`}
              onClick={() => onFiltersChange((prev) => ({ ...prev, sourceIds: [] }))}
            >
              All Clips ({videos.length})
            </button>
          </section>

          <section className="library-overlay__section">
            <h4>Tags</h4>
            <div className="library-overlay__list">
              {tagCounts.map(([tag, count]) => {
                const active = selectedTagSet.has(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    className={`library-overlay__pill ${active ? "active" : ""}`}
                    onClick={() =>
                      onFiltersChange((prev) => ({
                        ...prev,
                        includeTags: active
                          ? (prev.includeTags ?? []).filter((entry) => entry !== tag)
                          : [...(prev.includeTags ?? []), tag],
                      }))
                    }
                  >
                    {tag} ({count})
                  </button>
                );
              })}
            </div>
          </section>

          <section className="library-overlay__section">
            <h4>Sources</h4>
            <div className="library-overlay__list">
              {librarySources.map((source) => {
                const active = selectedSourceIds.includes(source.id);
                return (
                  <button
                    key={source.id}
                    type="button"
                    className={`library-overlay__pill ${active ? "active" : ""}`}
                    onClick={() =>
                      onFiltersChange((prev) => ({
                        ...prev,
                        sourceIds: active
                          ? (prev.sourceIds ?? []).filter((entry) => entry !== source.id)
                          : [...(prev.sourceIds ?? []), source.id],
                      }))
                    }
                  >
                    {source.path}
                  </button>
                );
              })}
            </div>
          </section>
        </aside>
      </div>

      {isManageOpen && (
        <div className="library-sources-modal__backdrop" onClick={() => setManageOpen(false)}>
          <div className="library-sources-modal" onClick={(event) => event.stopPropagation()}>
            <h3>Manage Sources</h3>
            <div className="library-sources-modal__list">
              {librarySources.map((source) => (
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
            <button type="button" onClick={() => setManageOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
