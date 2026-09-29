import React, { useMemo } from "react";
import {
  deriveMetadataSelectionCount,
  deriveSingleSelectionInfo,
  MAX_FULLSCREEN_METADATA_SUGGESTION_TAGS,
} from "./metadata/metadataContent";
import MetadataInspectorContent from "./metadata/MetadataInspectorContent";
import { MetadataGenerationSection } from "./metadata/MetadataContentSections";
import { FocusSelectionIcon, UndockPanelIcon } from "./UiIcons";

export default function DockedMetadataInspector({
  selectionCount,
  selectedVideos = [],
  selectionKey,
  availableTags = [],
  generationVersions = null,
  onAddTag,
  onRemoveTag,
  onApplyTagToSelection,
  onSetRating,
  onClearRating,
  onSetReviewState,
  onFocusSelection,
  onTransferSelection,
  onAddToSequence,
  onUndock,
  reviewModeEnabled = true,
}) {
  const count = useMemo(
    () => deriveMetadataSelectionCount(selectionCount, selectedVideos),
    [selectionCount, selectedVideos]
  );
  const singleSelectionInfo = useMemo(
    () => deriveSingleSelectionInfo(selectedVideos, count),
    [count, selectedVideos]
  );
  if (count < 1) return null;

  const subtitle = count === 1
    ? singleSelectionInfo?.filename || "1 clip selected"
    : `${count.toLocaleString()} clips selected`;
  const announcement = count === 1 && singleSelectionInfo?.filename
    ? `Details updated for ${singleSelectionInfo.filename}`
    : `Details updated for ${count.toLocaleString()} selected clips`;

  return (
    <section
      className="metadata-docked-inspector"
      aria-label="Docked selection details"
    >
      <header className="metadata-docked-inspector__header">
        <div className="metadata-panel__titles">
          <strong className="metadata-panel__title">Details</strong>
          <span className="metadata-panel__subtitle" title={subtitle}>
            {subtitle}
          </span>
        </div>
        <div className="metadata-docked-inspector__actions">
          {typeof onFocusSelection === "function" ? (
            <button
              type="button"
              className="metadata-panel__button metadata-panel__button--compact metadata-panel__button--focus"
              onClick={onFocusSelection}
              aria-label="Focus selection in grid"
              title="Scroll to selected videos"
            >
              <FocusSelectionIcon />
              <span>Focus</span>
            </button>
          ) : null}
          {typeof onTransferSelection === "function" ? (
            <button
              type="button"
              className="metadata-panel__button metadata-panel__button--compact"
              onClick={() => onTransferSelection(selectedVideos)}
              aria-label={`Transfer ${count} selected clip${
                count === 1 ? "" : "s"
              }`}
              title="Transfer the selection: move, copy or link it into another folder"
            >
              <span>Transfer</span>
            </button>
          ) : null}
          {typeof onAddToSequence === "function" ? (
            <button
              type="button"
              className="metadata-panel__button metadata-panel__button--compact"
              onClick={() => onAddToSequence()}
              aria-label={`Add ${count} selected clip${
                count === 1 ? "" : "s"
              } to the sequence`}
              title="Append to the active sequence in the grid's sort order (B)"
            >
              <span>+ Sequence</span>
            </button>
          ) : null}
          <button
            type="button"
            className="metadata-panel__button metadata-panel__button--compact metadata-panel__button--dock"
            onClick={onUndock}
            aria-label="Undock selection details"
            title="Return details to a floating inspector"
          >
            <UndockPanelIcon />
            <span>Undock</span>
          </button>
        </div>
      </header>

      <span className="metadata-panel__announcement" aria-live="polite">
        {announcement}
      </span>
      <div className="metadata-docked-inspector__content">
        <MetadataInspectorContent
          selectionCount={count}
          selectedVideos={selectedVideos}
          availableTags={availableTags}
          active
          selectionKey={selectionKey}
          suggestionLimit={MAX_FULLSCREEN_METADATA_SUGGESTION_TAGS}
          generationVersions={generationVersions}
          showGeneration={false}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          onApplyTagToSelection={onApplyTagToSelection}
          onSetRating={onSetRating}
          onClearRating={onClearRating}
          onSetReviewState={onSetReviewState}
          reviewModeEnabled={reviewModeEnabled}
        />
      </div>
    </section>
  );
}

// The docked Generation panel: how the one selected clip was made, with the
// whole sidebar to itself, so Details keeps review and tags in view.
export function DockedGenerationPanel({ filename, generationMetadataState = null }) {
  if (!generationMetadataState) return null;
  return (
    <section
      className="metadata-docked-inspector"
      aria-label="Docked generation details"
    >
      <header className="metadata-docked-inspector__header">
        <div className="metadata-panel__titles">
          <strong className="metadata-panel__title">Generation</strong>
          <span className="metadata-panel__subtitle" title={filename || ""}>
            {filename || ""}
          </span>
        </div>
      </header>
      <div className="metadata-docked-inspector__content">
        <MetadataGenerationSection
          state={generationMetadataState}
          collapsible={false}
        />
      </div>
    </section>
  );
}
