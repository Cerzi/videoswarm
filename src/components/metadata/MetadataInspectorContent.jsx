import React, { forwardRef, useMemo } from "react";
import { REVIEW_PRIMARY_KEY_BY_STATE } from "../../hotkeys/shortcutCatalog";
import {
  REVIEW_STATES,
  normalizeReviewState,
  reviewStateLabel,
} from "../../review/reviewState";
import {
  deriveMetadataSelectionCount,
  deriveMetadataSelectionKey,
  deriveSingleSelectionInfo,
} from "./metadataContent";
import {
  MetadataFileFactsSection,
  MetadataGenerationSection,
  MetadataTagsSection,
} from "./MetadataContentSections";
import { EraserIcon } from "../UiIcons";

const STAR_VALUES = [1, 2, 3, 4, 5];
const REVIEW_ACTIONS = [
  [REVIEW_STATES.PICK, "Accept"],
  [REVIEW_STATES.REVIEWED, "Reviewed"],
  [REVIEW_STATES.REJECT, "Reject"],
  [REVIEW_STATES.UNREVIEWED, "Unreviewed"],
];

function RatingStars({ value, isMixed, onSelect, onClear, disabled }) {
  return (
    <div className="metadata-panel__rating-row">
      <div
        className={`metadata-panel__stars ${
          isMixed ? "metadata-panel__stars--mixed" : ""
        }`}
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
        className="metadata-panel__button metadata-panel__button--compact metadata-panel__clear-rating"
        onClick={() => !disabled && onClear?.()}
        disabled={disabled}
      >
        <EraserIcon />
        <span>Clear</span>
      </button>
    </div>
  );
}

const MetadataInspectorContent = forwardRef(function MetadataInspectorContent(
  {
    selectionCount,
    selectedVideos = [],
    availableTags = [],
    active = true,
    selectionKey,
    suggestionLimit,
    generationMetadataState = null,
    generationExpanded,
    onGenerationExpandedChange,
    onAddTag,
    onRemoveTag,
    onApplyTagToSelection,
    onSetRating,
    onClearRating,
    onSetReviewState,
    reviewModeEnabled = true,
  },
  inputRef
) {
  const derivedSelectionCount = useMemo(
    () => deriveMetadataSelectionCount(selectionCount, selectedVideos),
    [selectionCount, selectedVideos]
  );
  const hasSelection = derivedSelectionCount > 0;
  const resolvedSelectionKey = useMemo(
    () => deriveMetadataSelectionKey(selectedVideos, selectionKey),
    [selectedVideos, selectionKey]
  );
  const singleSelectionInfo = useMemo(
    () => deriveSingleSelectionInfo(selectedVideos, derivedSelectionCount),
    [derivedSelectionCount, selectedVideos]
  );

  const ratingInfo = useMemo(() => {
    if (!selectedVideos.length) {
      return { value: null, mixed: false, hasAny: false };
    }
    const values = selectedVideos.map((video) =>
      typeof video?.rating === "number"
        ? Math.max(0, Math.min(5, Math.round(video.rating)))
        : null
    );
    const unique = new Set(
      values.map((value) => (value === null ? "none" : value))
    );
    if (unique.size === 1) {
      const raw = values[0];
      return {
        value: raw === null ? null : raw,
        mixed: false,
        hasAny: raw !== null,
      };
    }
    return {
      value: null,
      mixed: true,
      hasAny: values.some((value) => value !== null),
    };
  }, [selectedVideos]);

  const reviewInfo = useMemo(() => {
    if (!selectedVideos.length) {
      return { value: REVIEW_STATES.UNREVIEWED, mixed: false };
    }
    const values = selectedVideos.map((video) =>
      normalizeReviewState(video?.reviewState)
    );
    const unique = new Set(values);
    return {
      value: unique.size === 1 ? values[0] : null,
      mixed: unique.size > 1,
    };
  }, [selectedVideos]);

  return (
    <div className="metadata-panel__body">
      <MetadataFileFactsSection info={singleSelectionInfo} />

      {derivedSelectionCount === 1 ? (
        <MetadataGenerationSection
          state={generationMetadataState}
          expanded={generationExpanded}
          onExpandedChange={onGenerationExpandedChange}
        />
      ) : null}

      <div className="metadata-panel__grid">
        {reviewModeEnabled ? (
        <section className="metadata-panel__section metadata-panel__section--rating">
          <div className="metadata-panel__section-header">
            <span title="Setting a rating also marks an Unreviewed clip as Reviewed">
              Rating
            </span>
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
            onSelect={(value) => onSetRating?.(value)}
            onClear={onClearRating}
            disabled={!hasSelection}
          />
        </section>
        ) : null}

        {reviewModeEnabled ? (
        <section className="metadata-panel__section metadata-panel__section--review">
          <div className="metadata-panel__section-header">
            <span>Review</span>
            <span
              className={`metadata-panel__badge ${
                reviewInfo.value === REVIEW_STATES.PICK
                  ? "metadata-panel__badge--pick"
                  : reviewInfo.value === REVIEW_STATES.REJECT
                    ? "metadata-panel__badge--reject"
                    : ""
              }`}
            >
              {reviewInfo.mixed
                ? "Mixed"
                : reviewStateLabel(reviewInfo.value)}
            </span>
          </div>
          <div
            className="metadata-panel__review-row"
            role="group"
            aria-label="Review state"
          >
            {REVIEW_ACTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`metadata-panel__button metadata-panel__review-button metadata-panel__review-button--${value} ${
                  !reviewInfo.mixed && reviewInfo.value === value
                    ? "is-active"
                    : ""
                }`}
                aria-pressed={!reviewInfo.mixed && reviewInfo.value === value}
                onClick={() => onSetReviewState?.(value)}
                disabled={!hasSelection}
                title={`${label} (${REVIEW_PRIMARY_KEY_BY_STATE[value]})${
                  value === REVIEW_STATES.UNREVIEWED
                    ? "; clears rating, keeps tags"
                    : ""
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </section>
        ) : null}

        <MetadataTagsSection
          ref={inputRef}
          selectedVideos={selectedVideos}
          selectionCount={derivedSelectionCount}
          availableTags={availableTags}
          suggestionLimit={suggestionLimit}
          active={active}
          resetKey={resolvedSelectionKey}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          onApplyTagToSelection={onApplyTagToSelection}
        />
      </div>
    </div>
  );
});

export default MetadataInspectorContent;
