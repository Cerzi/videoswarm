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
    onFocusSelection,
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
        typeof fromMetadata === "string" && fromMetadata.trim()
          ? fromMetadata
          : typeof video?.name === "string"
          ? video.name
          : null;
      if (primary) return primary;
      const fallback = video?.path || video?.metadata?.path;
      if (typeof fallback === "string" && fallback.trim()) {
        return fallback.split(/[\/\\]/).filter(Boolean).pop();
      }
      return null;
    };

    const filename = deriveFilename();
    const resolution =
      video?.dimensions?.width && video?.dimensions?.height
        ? `${video.dimensions.width}×${video.dimensions.height}`
        : null;

    if (!filename && !createdDisplay && !resolution) {
      return null;
    }

    return {
      filename,
      createdDisplay,
      resolution,
    };
  }, [derivedSelectionCount, selectedVideos]);

  const suggestionTags = useMemo(() => {
    const seen = new Set();
    const suggestions = [];
    for (const video of selectedVideos) {
      const tags = Array.isArray(video?.tags) ? video.tags : [];
      for (const tag of tags) {
        const normalized = typeof tag === "string" ? tag.trim() : "";
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        suggestions.push(normalized);
        if (suggestions.length >= MAX_SUGGESTION_TAGS) {
          return suggestions;
        }
      }
    }
    return suggestions;
  }, [selectedVideos]);

  const handleSubmit = (event) => {
    event.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    onAddTag?.(trimmed);
    setInputValue("");
  };

  const toggleDisabled = !hasSelection;

  const panelClass = [
    "metadata-panel",
    isOpen ? "metadata-panel--open" : "metadata-panel--collapsed",
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
          className="metadata-panel__toggle"
          onClick={() => onToggle?.()}
          aria-expanded={isOpen}
          aria-controls="metadata-panel-body"
        >
          Metadata
        </button>
        <span className="metadata-panel__selection-count">
          {hasSelection ? `${derivedSelectionCount} selected` : "No selection"}
        </span>
      </div>

      <div id="metadata-panel-body" className="metadata-panel__body">
        <form className="metadata-panel__form" onSubmit={handleSubmit}>
          <label className="metadata-panel__label" htmlFor="metadata-tag-input">
            Tags
          </label>
          <div className="metadata-panel__tag-input-row">
            <input
              ref={inputRef}
              id="metadata-tag-input"
              type="text"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Add tag and press Enter"
              disabled={toggleDisabled}
            />
            <button type="submit" disabled={toggleDisabled}>
              Add
            </button>
          </div>
        </form>

        {suggestionTags.length > 0 && (
          <div className="metadata-panel__suggestions">
            <span className="metadata-panel__suggestions-label">Existing tags</span>
            <div className="metadata-panel__suggestions-list">
              {suggestionTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="metadata-panel__suggestion"
                  onClick={() => onApplyTagToSelection?.(tag)}
                  disabled={toggleDisabled}
                >
                  #{tag}
                </button>
              ))}
            </div>
          </div>
        )}

        {sharedTags.length > 0 && (
          <div className="metadata-panel__shared-tags">
            <span className="metadata-panel__section-label">Shared tags</span>
            <div className="metadata-panel__chip-list">
              {sharedTags.map((tag) => (
                <span key={tag} className="metadata-panel__chip">
                  #{tag}
                  <button
                    type="button"
                    className="metadata-panel__chip-remove"
                    onClick={() => onRemoveTag?.(tag)}
                    title={`Remove tag ${tag}`}
                    disabled={toggleDisabled}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        {partialTags.length > 0 && (
          <div className="metadata-panel__partial-tags">
            <span className="metadata-panel__section-label">Partial tags</span>
            <div className="metadata-panel__chip-list">
              {partialTags.map(({ tag, count }) => (
                <span key={tag} className="metadata-panel__chip metadata-panel__chip--partial">
                  #{tag}
                  <span className="metadata-panel__chip-count">{count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="metadata-panel__actions">
          <span className="metadata-panel__section-label">Rating</span>
          <RatingStars
            value={ratingInfo.value}
            isMixed={ratingInfo.mixed}
            onSelect={onSetRating}
            onClear={onClearRating}
            disabled={toggleDisabled || !ratingInfo.hasAny}
          />
        </div>

        {singleSelectionInfo && (
          <div className="metadata-panel__single-selection">
            <h3 className="metadata-panel__section-title">Details</h3>
            <dl className="metadata-panel__details">
              {singleSelectionInfo.filename && (
                <div className="metadata-panel__detail">
                  <dt>Filename</dt>
                  <dd>{singleSelectionInfo.filename}</dd>
                </div>
              )}
              {singleSelectionInfo.createdDisplay && (
                <div className="metadata-panel__detail">
                  <dt>Date created</dt>
                  <dd>{singleSelectionInfo.createdDisplay}</dd>
                </div>
              )}
              {singleSelectionInfo.resolution && (
                <div className="metadata-panel__detail">
                  <dt>Resolution</dt>
                  <dd>{singleSelectionInfo.resolution}</dd>
                </div>
              )}
            </dl>
          </div>
        )}

        <div className="metadata-panel__footer">
          <button
            type="button"
            className="metadata-panel__focus-selection"
            onClick={() => onFocusSelection?.()}
            disabled={!hasSelection}
          >
            Focus selection
          </button>
        </div>
      </div>
    </aside>
  );
});

MetadataPanel.displayName = "MetadataPanel";

export default MetadataPanel;
