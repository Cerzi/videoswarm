import React, { useEffect, useMemo, useRef } from "react";
import { ActionIds } from "../../hooks/actions/actions";
import {
  FULLSCREEN_SHORTCUT_HELP_SECTIONS,
  REVIEW_PRIMARY_KEY_BY_STATE,
} from "../../hotkeys/shortcutCatalog";
import {
  REVIEW_STATES,
  normalizeReviewState,
  reviewStateLabel,
} from "../../review/reviewState";
import {
  MetadataFileFactsSection,
  MetadataGenerationSection,
  MetadataTagsSection,
} from "../metadata/MetadataContentSections";
import { deriveSingleSelectionInfo } from "../metadata/metadataContent";
import "./FullscreenReviewPanels.css";

const RATINGS = [1, 2, 3, 4, 5];
const REVIEW_ACTIONS = [
  { state: REVIEW_STATES.PICK, label: "Accept" },
  { state: REVIEW_STATES.REVIEWED, label: "Reviewed" },
  { state: REVIEW_STATES.REJECT, label: "Reject" },
  { state: REVIEW_STATES.UNREVIEWED, label: "Unreviewed" },
];
const SAFE_ACTIONS = [
  { id: ActionIds.SHOW_IN_FOLDER, label: "Open in folder", nativeOnly: true },
  { id: ActionIds.OPEN_EXTERNAL, label: "Open externally", nativeOnly: true },
  { id: ActionIds.COPY_PATH, label: "Copy path" },
  { id: ActionIds.COPY_RELATIVE_PATH, label: "Copy relative path" },
  { id: ActionIds.COPY_FILENAME, label: "Copy filename" },
];

const formatProgress = (progress) => {
  const reviewed = Number(progress?.reviewedTotal) || 0;
  const total = Number(progress?.total) || 0;
  return `${reviewed.toLocaleString()} / ${total.toLocaleString()} reviewed`;
};

export function FullscreenHeaderContent({ video, isCurrentInView = true }) {
  const location = video?.relativePath || video?.dirname || "";
  const folder = location.includes("/")
    ? location.slice(0, Math.max(0, location.lastIndexOf("/")))
    : video?.dirname || "";
  const state = reviewStateLabel(normalizeReviewState(video?.reviewState));

  return (
    <div className="fullscreen-review-panel__header-copy">
      {folder ? <span title={folder}>{folder}</span> : <span>Current collection</span>}
      <span className="fullscreen-review-panel__state">{state}</span>
      {!isCurrentInView ? (
        <span className="fullscreen-review-panel__outside-view">
          No longer matches this view
        </span>
      ) : null}
    </div>
  );
}

export function FullscreenProgressContent({ progress }) {
  return (
    <span className="fullscreen-review-panel__progress" title="Review progress">
      {formatProgress(progress)}
    </span>
  );
}

export function FullscreenReviewRail({
  video,
  busy = false,
  canUndo = false,
  autoAdvance = false,
  onSetReviewState,
  onSetRating,
  onUndo,
  onAutoAdvanceChange,
}) {
  const reviewState = normalizeReviewState(video?.reviewState);
  const rating = Number.isFinite(Number(video?.rating))
    ? Math.max(0, Math.min(5, Math.round(Number(video.rating))))
    : 0;
  const disabled = busy || !video?.fingerprint;

  return (
    <div className="fullscreen-review-panel__rail-content">
      <div className="fullscreen-review-panel__rail-heading">
        <strong>Review</strong>
        {busy ? <span role="status">Saving…</span> : null}
      </div>
      <div className="fullscreen-review-panel__review-grid">
        {REVIEW_ACTIONS.map(({ state, label }) => (
          <button
            key={state}
            type="button"
            className={`fullscreen-review-panel__review-button fullscreen-review-panel__review-button--${state}`}
            aria-pressed={reviewState === state}
            disabled={disabled}
            onClick={() => onSetReviewState?.(state)}
            title={`${label} (${REVIEW_PRIMARY_KEY_BY_STATE[state]})`}
          >
            <span>{label}</span>
            <kbd>{REVIEW_PRIMARY_KEY_BY_STATE[state]}</kbd>
          </button>
        ))}
      </div>

      <div className="fullscreen-review-panel__rating" aria-label="Rating">
        <span>Rating</span>
        <div>
          {RATINGS.map((value) => (
            <button
              key={value}
              type="button"
              className={rating >= value ? "is-active" : ""}
              aria-label={`Rate ${value} star${value === 1 ? "" : "s"}`}
              aria-pressed={rating === value}
              disabled={disabled}
              onClick={() => onSetRating?.(value)}
              title={`Rate ${value} (${value})`}
            >
              ★
            </button>
          ))}
        </div>
        <button
          type="button"
          className="fullscreen-review-panel__clear-rating"
          disabled={disabled || rating === 0}
          onClick={() => onSetRating?.(null)}
          title="Clear rating (0)"
        >
          Clear <kbd>0</kbd>
        </button>
      </div>

      <button
        type="button"
        className="fullscreen-review-panel__undo"
        disabled={busy || !canUndo}
        onClick={() => onUndo?.()}
        title="Undo last review change (Z)"
      >
        Undo <kbd>Z</kbd>
      </button>

      <label className="fullscreen-review-panel__advance">
        <input
          type="checkbox"
          checked={autoAdvance}
          onChange={(event) => onAutoAdvanceChange?.(event.target.checked)}
        />
        <span>
          Advance after marking
          <small>Skip duplicate instances of the marked content</small>
        </span>
      </label>
    </div>
  );
}

function ShortcutKeys({ shortcut }) {
  return (
    <span className="fullscreen-review-panel__help-keys">
      {shortcut.keys.map((key) => (
        <kbd key={`${shortcut.id}-${key}`}>{key}</kbd>
      ))}
    </span>
  );
}

export function FullscreenHeaderActions({
  video,
  surface,
  onSurfaceChange,
  onSafeAction,
  onRetry,
}) {
  const menuRef = useRef(null);
  const helpRef = useRef(null);
  const actionsButtonRef = useRef(null);
  const helpButtonRef = useRef(null);
  const previousSurfaceRef = useRef(surface);
  const actionsOpen = surface === "actions";
  const helpOpen = surface === "help";

  useEffect(() => {
    const target = actionsOpen ? menuRef.current : helpOpen ? helpRef.current : null;
    target?.querySelector?.("button:not([disabled])")?.focus?.();
    const previous = previousSurfaceRef.current;
    if (!surface && previous === "actions") actionsButtonRef.current?.focus?.();
    if (!surface && previous === "help") helpButtonRef.current?.focus?.();
    previousSurfaceRef.current = surface;
  }, [actionsOpen, helpOpen]);

  const run = (actionId) => {
    onSurfaceChange?.(null);
    onSafeAction?.(actionId);
  };

  return (
    <div className="fullscreen-review-panel__actions" data-hotkey-exempt>
      <button
        ref={actionsButtonRef}
        type="button"
        className="fullscreen-review__button"
        aria-haspopup="menu"
        aria-expanded={actionsOpen}
        onClick={() => onSurfaceChange?.(actionsOpen ? null : "actions")}
        title="Safe file actions"
      >
        More
      </button>
      <button
        ref={helpButtonRef}
        type="button"
        className="fullscreen-review__button"
        aria-haspopup="dialog"
        aria-expanded={helpOpen}
        onClick={() => onSurfaceChange?.(helpOpen ? null : "help")}
        title="Fullscreen shortcuts (?)"
      >
        ?
      </button>

      {actionsOpen ? (
        <div
          ref={menuRef}
          className="fullscreen-review-panel__menu"
          role="menu"
          aria-label="Safe clip actions"
        >
          {SAFE_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              disabled={action.nativeOnly && !video?.isElectronFile}
              onClick={() => run(action.id)}
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onSurfaceChange?.(null);
              onRetry?.();
            }}
          >
            Retry playback
          </button>
        </div>
      ) : null}

      {helpOpen ? (
        <section
          ref={helpRef}
          className="fullscreen-review-panel__help"
          role="dialog"
          aria-modal="false"
          aria-labelledby="fullscreen-shortcuts-title"
        >
          <header>
            <div>
              <h3 id="fullscreen-shortcuts-title">Fullscreen shortcuts</h3>
              <p>Review the active clip without leaving the Loupe.</p>
            </div>
            <button
              type="button"
              aria-label="Close fullscreen shortcuts"
              onClick={() => onSurfaceChange?.(null)}
            >
              ×
            </button>
          </header>
          <div className="fullscreen-review-panel__help-grid">
            {FULLSCREEN_SHORTCUT_HELP_SECTIONS.map((section) => (
              <section key={section.id}>
                <h4>{section.title}</h4>
                {section.shortcuts.map((shortcut) => (
                  <div key={shortcut.id}>
                    <span>{shortcut.label}</span>
                    <ShortcutKeys shortcut={shortcut} />
                  </div>
                ))}
              </section>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function FullscreenDetailsDock({
  video,
  availableTags,
  generationMetadataState,
  onAddTags,
  onRemoveTag,
  onApplyTag,
}) {
  const info = useMemo(
    () => deriveSingleSelectionInfo(video ? [video] : [], video ? 1 : 0),
    [video]
  );
  if (!video) return null;

  return (
    <div className="fullscreen-review-panel__details-content">
      <div className="fullscreen-review-panel__details-heading">
        <strong>Clip details</strong>
        <span>{video.name}</span>
      </div>
      <MetadataFileFactsSection info={info} includeRelativePath />
      <MetadataGenerationSection state={generationMetadataState} />
      <MetadataTagsSection
        selectedVideos={[video]}
        selectionCount={1}
        availableTags={availableTags}
        resetKey={`${video.id}:${video.fingerprint || ""}`}
        onAddTag={onAddTags}
        onRemoveTag={onRemoveTag}
        onApplyTagToSelection={onApplyTag}
      />
    </div>
  );
}
