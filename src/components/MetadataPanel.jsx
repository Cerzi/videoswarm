import React, {
  useMemo,
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
} from "react";
import "./MetadataPanel.css";

const STAR_VALUES = [1, 2, 3, 4, 5];
const MAX_SUGGESTION_TAGS = 15;
const DEFAULT_LOCAL_DOCK_HEIGHT = 260;

const clampValue = (value, min, max) => Math.max(min, Math.min(max, value));

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
    showCollapsedHint = false,
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
    dockHeight,
    minDockHeight,
    maxDockHeight,
    onDockHeightChange,
  },
  ref
) => {
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef(null);
  const resizeSessionCleanupRef = useRef(null);

  const minHeight = Number.isFinite(minDockHeight) ? Math.max(160, minDockHeight) : 200;
  const maxHeight = Number.isFinite(maxDockHeight) ? maxDockHeight : 520;

  const [internalDockHeight, setInternalDockHeight] = useState(() =>
    clampValue(DEFAULT_LOCAL_DOCK_HEIGHT, minHeight, maxHeight)
  );

  const computeMaxHeight = useCallback(() => {
    if (typeof window !== "undefined" && Number.isFinite(window.innerHeight)) {
      const limit = window.innerHeight - 96;
      if (Number.isFinite(limit)) {
        return clampValue(limit, minHeight, maxHeight);
      }
    }
    return maxHeight;
  }, [minHeight, maxHeight]);

  const effectiveMaxHeight = computeMaxHeight();

  const providedHeight = Number.isFinite(dockHeight)
    ? dockHeight
    : internalDockHeight;
  const resolvedDockHeight = clampValue(
    providedHeight,
    minHeight,
    effectiveMaxHeight
  );

  useEffect(() => {
    if (!Number.isFinite(dockHeight)) return;
    const clamped = clampValue(dockHeight, minHeight, maxHeight);
    setInternalDockHeight((prev) => (prev === clamped ? prev : clamped));
  }, [dockHeight, minHeight, maxHeight]);

  const updateDockHeight = useCallback(
    (nextHeight) => {
      const dynamicMax = computeMaxHeight();
      const clamped = clampValue(nextHeight, minHeight, dynamicMax);
      if (typeof onDockHeightChange === "function") {
        onDockHeightChange(clamped);
      } else {
        setInternalDockHeight((prev) => (prev === clamped ? prev : clamped));
      }
    },
    [computeMaxHeight, minHeight, onDockHeightChange]
  );

  const endActiveResize = useCallback(() => {
    if (typeof resizeSessionCleanupRef.current === "function") {
      resizeSessionCleanupRef.current();
      resizeSessionCleanupRef.current = null;
    }
  }, []);

  useEffect(() => () => endActiveResize(), [endActiveResize]);

  const handleResizePointerDown = useCallback(
    (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      if (typeof window === "undefined") {
        return;
      }

      endActiveResize();

      event.preventDefault();
      event.stopPropagation();

      const startY = event.clientY;
      const startHeight = resolvedDockHeight;
      const pointerId = event.pointerId;

      const handlePointerMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const delta = startY - moveEvent.clientY;
        updateDockHeight(startHeight + delta);
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        try {
          event.currentTarget?.releasePointerCapture(pointerId);
        } catch (err) {}
      };

      const handlePointerUp = (upEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        cleanup();
        resizeSessionCleanupRef.current = null;
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
      resizeSessionCleanupRef.current = cleanup;

      try {
        event.currentTarget?.setPointerCapture(pointerId);
      } catch (err) {}
    },
    [endActiveResize, resolvedDockHeight, updateDockHeight]
  );

  const handleResizeKeyDown = useCallback(
    (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const delta = event.key === "ArrowUp" ? 24 : -24;
        updateDockHeight(resolvedDockHeight + delta);
      } else if (event.key === "Home") {
        event.preventDefault();
        updateDockHeight(computeMaxHeight());
      } else if (event.key === "End") {
        event.preventDefault();
        updateDockHeight(minHeight);
      }
    },
    [computeMaxHeight, minHeight, resolvedDockHeight, updateDockHeight]
  );

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

  const infoLineItems = useMemo(() => {
    if (!singleSelectionInfo) return [];
    const items = [];
    if (singleSelectionInfo.filename) {
      items.push({
        key: "filename",
        label: singleSelectionInfo.filename,
        title: singleSelectionInfo.filename,
        className: "metadata-panel__info-item--filename",
      });
    }
    if (singleSelectionInfo.resolution) {
      items.push({ key: "resolution", label: singleSelectionInfo.resolution });
    }
    if (singleSelectionInfo.created) {
      items.push({ key: "created", label: singleSelectionInfo.created });
    }
    return items;
  }, [singleSelectionInfo]);

  const sharedTagSet = useMemo(() => new Set(sharedTags), [sharedTags]);

  const dedupedAvailableTags = useMemo(() => {
    if (!Array.isArray(availableTags)) return [];

    const deduped = new Map();

    availableTags.forEach((entry) => {
      const name = entry?.name?.trim();
      if (!name) return;

      const usageCount =
        typeof entry.usageCount === "number" && Number.isFinite(entry.usageCount)
          ? entry.usageCount
          : 0;

      const existing = deduped.get(name);
      if (!existing || (existing.usageCount || 0) < usageCount) {
        deduped.set(name, { name, usageCount });
      }
    });

    return Array.from(deduped.values());
  }, [availableTags]);

  const suggestionTags = useMemo(() => {
    if (!isOpen) return [];

    const query = inputValue.trim().toLowerCase();

    let list = dedupedAvailableTags.filter((entry) => !sharedTagSet.has(entry.name));

    if (query) {
      list = list.filter((item) => item.name.toLowerCase().includes(query));
    }

    list.sort((a, b) => {
      const usageDiff = (b.usageCount || 0) - (a.usageCount || 0);
      if (usageDiff !== 0) return usageDiff;
      return a.name.localeCompare(b.name);
    });

    return list.slice(0, MAX_SUGGESTION_TAGS);
  }, [dedupedAvailableTags, inputValue, sharedTagSet, isOpen]);

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
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      handleTagSubmit();
      return;
    }

    if (event.key === "Tab") {
      const rawTokens = inputValue.split(",");
      const lastTokenRaw = rawTokens[rawTokens.length - 1] ?? "";
      const query = lastTokenRaw.trim().toLowerCase();
      if (!query) return;

      const candidates = dedupedAvailableTags.filter((entry) =>
        entry.name.toLowerCase().startsWith(query)
      );

      if (!candidates.length) return;

      candidates.sort((a, b) => {
        const usageDiff = (b.usageCount || 0) - (a.usageCount || 0);
        if (usageDiff !== 0) return usageDiff;
        return a.name.localeCompare(b.name);
      });

      const selected = candidates[0]?.name;
      if (!selected) return;

      event.preventDefault();
      onAddTag?.([selected]);
      setInputValue("");
    }
  };

  if (!isOpen) {
    if (!showCollapsedHint) {
      return null;
    }

    const collapsedLabel = hasSelection
      ? derivedSelectionCount === 1
        ? "Show clip details"
        : `Show details (${derivedSelectionCount})`
      : "Show clip details";

    const collapsedCountLabel = hasSelection
      ? derivedSelectionCount === 1
        ? "1 clip"
        : `${derivedSelectionCount} clips`
      : "No selection";

    return (
      <aside ref={ref} className="metadata-panel metadata-panel--collapsed">
        <button
          type="button"
          className="metadata-panel__collapsed-shell"
          onClick={() => onToggle?.()}
          aria-label={`${collapsedLabel}`}
        >
          <span className="metadata-panel__collapsed-handle" aria-hidden="true" />
          <span className="metadata-panel__collapsed-label">Details</span>
          <span className="metadata-panel__collapsed-count">
            {collapsedCountLabel}
          </span>
        </button>
      </aside>
    );
  }

  const panelClass = [
    "metadata-panel",
    "metadata-panel--open",
    !hasSelection ? "metadata-panel--empty" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const showFocusButton =
    hasSelection && typeof onFocusSelection === "function";

  const contentClass = [
    "metadata-panel__content",
    !hasSelection ? "metadata-panel__content--empty" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const handleRoleProps = {
    role: "slider",
    tabIndex: 0,
    "aria-label": "Resize metadata panel",
    "aria-orientation": "vertical",
    "aria-valuemin": Math.round(minHeight),
    "aria-valuemax": Math.round(effectiveMaxHeight),
    "aria-valuenow": Math.round(resolvedDockHeight),
    title: "Drag or use arrow keys to resize",
  };

  return (
    <aside ref={ref} className={panelClass}>
      <div
        className="metadata-panel__container"
        role="complementary"
        aria-label="Selection metadata"
        style={{ "--metadata-panel-height": `${Math.round(resolvedDockHeight)}px` }}
      >
        <div className="metadata-panel__header">
          <div
            className="metadata-panel__handle"
            {...handleRoleProps}
            onPointerDown={handleResizePointerDown}
            onKeyDown={handleResizeKeyDown}
          />
          <div className="metadata-panel__titles">
            <span className="metadata-panel__title">Details</span>
            <span className="metadata-panel__subtitle">
              {hasSelection ? `${derivedSelectionCount} selected` : "No selection"}
            </span>
          </div>
          {showFocusButton && (
            <button
              type="button"
              className="metadata-panel__focus"
              onClick={onFocusSelection}
              aria-label="Focus selection in grid"
              title="Scroll to selected videos"
            >
              Focus
            </button>
          )}
          <button
            type="button"
            className="metadata-panel__toggle"
            onClick={() => onToggle?.()}
            aria-expanded={isOpen}
            aria-label={isOpen ? "Hide metadata panel" : "Show metadata panel"}
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>

        <div className={contentClass}>
          {!hasSelection ? (
            <div className="metadata-panel__empty-state" aria-live="polite">
              <h3>No clips selected</h3>
              <p>Pick videos from the grid to see quick stats and tags here.</p>
              <p>Tip: Use Shift or Ctrl/Cmd to build multi-select batches.</p>
            </div>
          ) : (
            <div className="metadata-panel__body">
                {infoLineItems.length > 0 && (
                  <section className="metadata-panel__section metadata-panel__info">
                    <div className="metadata-panel__info-line" role="text">
                      {infoLineItems.map((item, index) => (
                        <span
                          key={item.key || index}
                          className={`metadata-panel__info-item${
                            item.className ? ` ${item.className}` : ""
                          }`}
                          title={item.title}
                        >
                          {index > 0 && (
                            <span
                              aria-hidden="true"
                              className="metadata-panel__info-separator"
                            >
                              •
                            </span>
                          )}
                          <span>{item.label}</span>
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                <div className="metadata-panel__grid">
                  <section className="metadata-panel__section metadata-panel__section--rating">
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

                  <section className="metadata-panel__section metadata-panel__section--tags">
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
                  </section>

                  {suggestionTags.length > 0 && (
                    <section
                      className="metadata-panel__section metadata-panel__section--suggestions"
                      aria-live="polite"
                    >
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
                            title={`Apply #${suggestion.name} to selection`}
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
                    </section>
                  )}
                </div>
              </div>
            )}
          </div>
      </div>
    </aside>
  );
});

MetadataPanel.displayName = "MetadataPanel";

export default MetadataPanel;
