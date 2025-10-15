import React, { useMemo, useState, useEffect, useRef, forwardRef } from "react";
import "./MetadataPanel.css";

const STAR_VALUES = [1, 2, 3, 4, 5];
const MAX_SUGGESTION_TAGS = 15;

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

const MetadataPanel = forwardRef((
  {
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
  },
  ref
) => {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef(null);

  const derivedSelectionCount = useMemo(() => {
    const numeric = Number(selectionCount);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
    return Array.isArray(selectedVideos) ? selectedVideos.length : 0;
  }, [selectionCount, selectedVideos]);

  const hasSelection = derivedSelectionCount > 0;

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
    if (!hasSelection) return [];
    const tags = [];
    tagCounts.forEach((count, tag) => {
      if (count === derivedSelectionCount) tags.push(tag);
    });
    return tags.sort((a, b) => a.localeCompare(b));
  }, [tagCounts, derivedSelectionCount, hasSelection]);

  const partialTags = useMemo(() => {
    if (!hasSelection) return [];
    const tags = [];
    tagCounts.forEach((count, tag) => {
      if (count > 0 && count < derivedSelectionCount) {
        tags.push({ tag, count });
      }
    });
    return tags.sort((a, b) => a.tag.localeCompare(b.tag));
  }, [tagCounts, derivedSelectionCount, hasSelection]);

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

  const singleSelectionInfo = useMemo(() => {
    if (derivedSelectionCount !== 1 || !selectedVideos.length) {
      return null;
    }

    const video = selectedVideos[0];
    if (!video) return null;

    const parseToDate = (value) => {
      if (!value) return null;
      if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value) || value <= 0) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
      }
      if (typeof value === "string" && value.trim()) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
      }
      return null;
    };

    const createdDate =
      parseToDate(video?.metadata?.dateCreatedFormatted) ||
      parseToDate(video?.createdMs) ||
      parseToDate(video?.dateCreated) ||
      parseToDate(video?.metadata?.dateCreated);

    const formatDateTime = (date) => {
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        return null;
      }

      try {
        return new Intl.DateTimeFormat(undefined, {
          year: "numeric",
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(date);
      } catch (err) {
        const pad = (value) => String(value).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
          date.getDate()
        )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
          date.getSeconds()
        )}`;
      }
    };

    let createdDisplay = formatDateTime(createdDate);
    if (!createdDisplay && typeof video?.metadata?.dateCreatedFormatted === "string") {
      createdDisplay = video.metadata.dateCreatedFormatted;
    }

    const deriveFilename = () => {
      const fromMetadata = video?.metadata?.filename || video?.metadata?.fileName;
      const primary =
        video?.name ||
        video?.filename ||
        video?.fileName ||
        fromMetadata;

      if (primary) return primary;

      const path = video?.fullPath || video?.path || video?.sourcePath;
      if (typeof path === "string" && path.trim()) {
        const segments = path.split(/[\\/]/).filter(Boolean);
        if (segments.length) {
          return segments[segments.length - 1];
        }
      }

      return null;
    };

    const filename = deriveFilename();

    const width = Number(video?.dimensions?.width);
    const height = Number(video?.dimensions?.height);
    const hasResolution =
      Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
    const resolution = hasResolution ? `${width}×${height}` : null;

    if (!filename && !createdDisplay && !resolution) {
      return null;
    }

    return {
      filename,
      created: createdDisplay,
      resolution,
    };
  }, [derivedSelectionCount, selectedVideos]);

  const sharedTagSet = useMemo(() => new Set(sharedTags), [sharedTags]);

  const suggestionTags = useMemo(() => {
    if (!isOpen || !Array.isArray(availableTags)) return [];

    const query = inputValue.trim().toLowerCase();
    const deduped = new Map();

    availableTags.forEach((entry) => {
      const name = entry?.name?.trim();
      if (!name || sharedTagSet.has(name)) return;

      const usageCount =
        typeof entry.usageCount === "number" && Number.isFinite(entry.usageCount)
          ? entry.usageCount
          : 0;

      const existing = deduped.get(name);
      if (!existing || (existing.usageCount || 0) < usageCount) {
        deduped.set(name, { name, usageCount });
      }
    });

    let list = Array.from(deduped.values());

    if (query) {
      list = list.filter((item) => item.name.toLowerCase().includes(query));
    }

    list.sort((a, b) => {
      const usageDiff = (b.usageCount || 0) - (a.usageCount || 0);
      if (usageDiff !== 0) return usageDiff;
      return a.name.localeCompare(b.name);
    });

    return list.slice(0, MAX_SUGGESTION_TAGS);
  }, [availableTags, inputValue, sharedTagSet, isOpen]);

  const hasSuggestionQuery = inputValue.trim().length > 0;

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

  const toggleDisabled = !hasSelection;

  const panelClass = [
    "metadata-panel",
    isOpen ? "metadata-panel--open" : "metadata-panel--collapsed",
    !hasSelection ? "metadata-panel--empty" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <aside
      ref={ref}
      className={panelClass}
      aria-hidden={!isOpen && !hasSelection}
    >
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
            {hasSelection ? `${derivedSelectionCount} selected` : "No selection"}
          </span>
        </div>
      </div>

      <div className="metadata-panel__content">
        {!hasSelection ? (
          <div className="metadata-panel__empty-state">
            <p>Select one or more videos to tag and rate them.</p>
          </div>
        ) : (
          <>
            {singleSelectionInfo && (
              <section className="metadata-panel__section metadata-panel__info">
                <div className="metadata-panel__info-grid">
                  {singleSelectionInfo.filename && (
                    <div className="metadata-panel__info-item metadata-panel__info-item--filename">
                      <span className="metadata-panel__info-label">Filename</span>
                      <span className="metadata-panel__info-value" title={singleSelectionInfo.filename}>
                        {singleSelectionInfo.filename}
                      </span>
                    </div>
                  )}
                  {singleSelectionInfo.created && (
                    <div className="metadata-panel__info-item">
                      <span className="metadata-panel__info-label">Date created</span>
                      <span className="metadata-panel__info-value">
                        {singleSelectionInfo.created}
                      </span>
                    </div>
                  )}
                  {singleSelectionInfo.resolution && (
                    <div className="metadata-panel__info-item">
                      <span className="metadata-panel__info-label">Resolution</span>
                      <span className="metadata-panel__info-value">
                        {singleSelectionInfo.resolution}
                      </span>
                    </div>
                  )}
                </div>
              </section>
            )}
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
                disabled={!hasSelection}
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
                        title={`Apply to all (${count}/${derivedSelectionCount})`}
                      >
                        <span>#{tag}</span>
                        <span className="metadata-panel__chip-count">
                          {count}/{derivedSelectionCount}
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
                  disabled={!hasSelection}
                />
                <button
                  type="button"
                  onClick={handleTagSubmit}
                  disabled={!hasSelection || !inputValue.trim()}
                >
                  Add
                </button>
              </div>

              {suggestionTags.length > 0 && (
                <div className="metadata-panel__suggestions" aria-live="polite">
                  <div className="metadata-panel__section-subtitle metadata-panel__suggestions-title">
                    {hasSuggestionQuery
                      ? "Matching tags"
                      : `Popular tags (top ${MAX_SUGGESTION_TAGS})`}
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
});

MetadataPanel.displayName = "MetadataPanel";

export default MetadataPanel;
