import React, { useMemo, useState, useEffect, useRef } from "react";
import "./MetadataPanel.css";

const STAR_VALUES = [1, 2, 3, 4, 5];

const RatingStars = ({ value, isMixed, onSelect, onClear, disabled }) => {
  return (
    <div className="metadata-panel__rating-row">
      <div
        className={`metadata-panel__stars ${isMixed ? "metadata-panel__stars--mixed" : ""}`}
      >
        {STAR_VALUES.map((star) => {
          const filled = value != null && value >= star;
          return (
            <button
              key={star}
              type="button"
              className={`metadata-panel__star ${filled ? "is-filled" : ""}`}
              onClick={() => !disabled && onSelect?.(star)}
              disabled={disabled}
              aria-label={`Rate ${star} star${star === 1 ? "" : "s"}`}
            >
              ★
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="metadata-panel__clear-rating"
        onClick={() => !disabled && onClear?.()}
        disabled={disabled}
      >
        Clear
      </button>
    </div>
  );
};

const MetadataPanel = ({
  isOpen,
  onToggle,
  selectionCount,
  selectedVideos = [],
  availableTags = [],
  onAddTag,
  onRemoveTag,
  onApplyTagToSelection,
  onSetRating,
  onClearRating,
  focusToken,
}) => {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen && focusToken) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusToken, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setInputValue("");
    }
  }, [isOpen]);

  const tagCounts = useMemo(() => {
    const counts = new Map();
    selectedVideos.forEach((video) => {
      (video?.tags || []).forEach((tag) => {
        const key = (tag ?? "").toString().trim();
        if (!key) return;
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    });
    return counts;
  }, [selectedVideos]);

  const sharedTags = useMemo(() => {
    if (!selectionCount) return [];
    const tags = [];
    tagCounts.forEach((count, tag) => {
      if (count === selectionCount) tags.push(tag);
    });
    return tags.sort((a, b) => a.localeCompare(b));
  }, [tagCounts, selectionCount]);

  const partialTags = useMemo(() => {
    if (!selectionCount) return [];
    const tags = [];
    tagCounts.forEach((count, tag) => {
      if (count > 0 && count < selectionCount) {
        tags.push({ tag, count });
      }
    });
    return tags.sort((a, b) => a.tag.localeCompare(b.tag));
  }, [tagCounts, selectionCount]);

  const ratingInfo = useMemo(() => {
    if (!selectedVideos.length) {
      return { value: null, mixed: false, hasAny: false };
    }
    const values = selectedVideos.map((video) =>
      typeof video?.rating === "number"
        ? Math.max(0, Math.min(5, Math.round(video.rating)))
        : null
    );
    const unique = new Set(values.map((value) => (value === null ? "none" : value)));
    if (unique.size === 1) {
      const raw = values[0];
      return {
        value: raw === null ? null : raw,
        mixed: false,
        hasAny: raw !== null,
      };
    }
    const hasAny = values.some((value) => value !== null);
    return { value: null, mixed: true, hasAny };
  }, [selectedVideos]);

  const sharedTagSet = useMemo(() => new Set(sharedTags), [sharedTags]);

  const suggestionTags = useMemo(() => {
    if (!isOpen || !Array.isArray(availableTags)) return [];
    const query = inputValue.trim().toLowerCase();
    const candidates = availableTags.filter((entry) => {
      if (!entry?.name) return false;
      if (sharedTagSet.has(entry.name)) return false;
      if (!query) return true;
      return entry.name.toLowerCase().includes(query);
    });
    return candidates.slice(0, 6);
  }, [availableTags, inputValue, sharedTagSet, isOpen]);

  const handleTagSubmit = () => {
    const tokens = inputValue
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);
    if (!tokens.length) return;
    onAddTag?.(tokens);
    setInputValue("");
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === "Tab" || event.key === ",") {
      event.preventDefault();
      handleTagSubmit();
    }
  };

  const toggleDisabled = selectionCount === 0;

  const panelClass = [
    "metadata-panel",
    isOpen ? "metadata-panel--open" : "metadata-panel--collapsed",
    selectionCount === 0 ? "metadata-panel--empty" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <aside className={panelClass} aria-hidden={!isOpen && selectionCount === 0}>
      <div className="metadata-panel__header">
        <button
          type="button"
          className={`metadata-panel__toggle${
            toggleDisabled ? " metadata-panel__toggle--disabled" : ""
          }`}
          onClick={() => !toggleDisabled && onToggle?.()}
          aria-expanded={isOpen}
          aria-label={
            toggleDisabled
              ? "Select a video to enable metadata panel"
              : isOpen
              ? "Collapse metadata panel"
              : "Expand metadata panel"
          }
          disabled={toggleDisabled}
        >
          {isOpen ? "❯" : "❮"}
        </button>
        <div className="metadata-panel__titles">
          <span className="metadata-panel__title">Details</span>
          <span className="metadata-panel__subtitle">
            {selectionCount ? `${selectionCount} selected` : "No selection"}
          </span>
        </div>
      </div>

      <div className="metadata-panel__content">
        {selectionCount === 0 ? (
          <div className="metadata-panel__empty-state">
            <p>Select one or more videos to tag and rate them.</p>
          </div>
        ) : (
          <>
            <section className="metadata-panel__section">
              <div className="metadata-panel__section-header">
                <span>Rating</span>
                {ratingInfo.mixed ? (
                  <span className="metadata-panel__badge">Mixed</span>
                ) : ratingInfo.hasAny ? (
                  <span className="metadata-panel__badge metadata-panel__badge--accent">
                    {`${ratingInfo.value} / 5`}
                  </span>
                ) : (
                  <span className="metadata-panel__badge">Not rated</span>
                )}
              </div>
              <RatingStars
                value={ratingInfo.value}
                isMixed={ratingInfo.mixed}
                onSelect={(val) => onSetRating?.(val)}
                onClear={onClearRating}
                disabled={!selectionCount}
              />
            </section>

            <section className="metadata-panel__section">
              <div className="metadata-panel__section-header">
                <span>Tags</span>
                <span className="metadata-panel__badge">
                  {sharedTags.length ? `${sharedTags.length} applied` : "None"}
                </span>
              </div>
              <div className="metadata-panel__chips">
                {sharedTags.length === 0 ? (
                  <span className="metadata-panel__hint">No shared tags yet.</span>
                ) : (
                  sharedTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className="metadata-panel__chip"
                      onClick={() => onRemoveTag?.(tag)}
                    >
                      <span>#{tag}</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  ))
                )}
              </div>

              {partialTags.length > 0 && (
                <div className="metadata-panel__partial-group">
                  <div className="metadata-panel__section-subtitle">
                    Appears on some selected clips
                  </div>
                  <div className="metadata-panel__chips">
                    {partialTags.map(({ tag, count }) => (
                      <button
                        key={tag}
                        type="button"
                        className="metadata-panel__chip metadata-panel__chip--ghost"
                        onClick={() => onApplyTagToSelection?.(tag)}
                        title={`Apply to all (${count}/${selectionCount})`}
                      >
                        <span>#{tag}</span>
                        <span className="metadata-panel__chip-count">
                          {count}/{selectionCount}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="metadata-panel__input-row">
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Add tag and press Enter"
                  disabled={!selectionCount}
                />
                <button
                  type="button"
                  onClick={handleTagSubmit}
                  disabled={!selectionCount || !inputValue.trim()}
                >
                  Add
                </button>
              </div>

              {suggestionTags.length > 0 && (
                <div className="metadata-panel__suggestions" aria-live="polite">
                  <div className="metadata-panel__section-subtitle metadata-panel__suggestions-title">
                    Available tags
                  </div>
                  <div className="metadata-panel__suggestion-list">
                    {suggestionTags.map((suggestion) => (
                      <button
                        key={suggestion.name}
                        type="button"
                        className="metadata-panel__suggestion"
                        onClick={() => onApplyTagToSelection?.(suggestion.name)}
                      >
                        <span>#{suggestion.name}</span>
                        {typeof suggestion.usageCount === "number" && (
                          <span className="metadata-panel__suggestion-count">
                            {suggestion.usageCount}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
};

export default MetadataPanel;
