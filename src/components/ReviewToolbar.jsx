import React, { useRef } from "react";
import { REVIEW_PRIMARY_KEY_BY_STATE } from "../hotkeys/shortcutCatalog";
import { REVIEW_STATES } from "../review/reviewState";
import ReviewSessionControls from "./ReviewSessionControls";
import MenuButton from "./menu/MenuButton";
import useFoldToFit from "./menu/useFoldToFit";
import "./ReviewToolbar.css";

// One row, like the top bar: when it does not fit, these give way in order.
// The session hint becomes a tooltip, the review buttons drop their words
// (icon and key stay), and the rest moves into the bar's ⋯ menu.
export const REVIEW_FOLD_ORDER = Object.freeze([
  "sessionDetail",
  "advance",
  "counts",
  "labels",
  "undo",
  "progress",
]);
const MENU_KEYS = new Set(["advance", "counts", "undo", "progress"]);

const formatCount = (value) =>
  Math.max(0, Number(value) || 0).toLocaleString();

const REVIEW_ACTIONS = Object.freeze([
  Object.freeze({ state: REVIEW_STATES.PICK, label: "Accept", icon: "✓" }),
  Object.freeze({ state: REVIEW_STATES.REVIEWED, label: "Reviewed", icon: "●" }),
  Object.freeze({ state: REVIEW_STATES.REJECT, label: "Reject", icon: "×" }),
  Object.freeze({ state: REVIEW_STATES.UNREVIEWED, label: "Unreviewed", icon: "↶" }),
]);

export default function ReviewToolbar({
  progress = {},
  selectedCount = 0,
  autoAdvance = false,
  canUndo = false,
  isBusy = false,
  canProcessResults = true,
  processResultsReason = "",
  session = null,
  onSetReviewState,
  onAutoAdvanceChange,
  onUndo,
  onProcessResults,
  onStartSession,
  onContinueSession,
  onMoveSession,
  onForgetSession,
  onReviewAllUnreviewed,
  onShowReviewTarget,
  onIndexSubfolders,
  initialFolded = [],
}) {
  const barRef = useRef(null);
  const total = Math.max(0, Number(progress.total) || 0);
  const { folded, isFolded } = useFoldToFit(barRef, {
    order: REVIEW_FOLD_ORDER,
    foldable: {
      sessionDetail: Boolean(session),
      advance: total > 0,
      counts: total > 0,
      labels: total > 0,
      undo: total > 0,
      progress: total > 0,
    },
    initialFolded,
  });
  if (total === 0 && !session) return null;

  const reviewedTotal = Math.min(
    total,
    Math.max(0, Number(progress.reviewedTotal) || 0)
  );
  const selectionDisabled = isBusy || selectedCount < 1;
  const percentage = Math.round((reviewedTotal / total) * 100);

  const menuItems = total > 0
    ? [
      isFolded("progress")
        ? { type: "note", id: "progress", text: `Reviewed ${formatCount(reviewedTotal)} / ${formatCount(total)}` }
        : null,
      isFolded("counts")
        ? { type: "note", id: "counts", text: `Accept ${formatCount(progress.accept)} · Reject ${formatCount(progress.reject)}` }
        : null,
      isFolded("undo")
        ? { type: "item", id: "undo", label: "Undo", shortcut: "Z", disabled: isBusy || !canUndo, onSelect: () => onUndo?.() }
        : null,
      isFolded("advance")
        ? { type: "checkbox", id: "advance", label: "Advance after marking", checked: autoAdvance, disabled: isBusy, onChange: (value) => onAutoAdvanceChange?.(value) }
        : null,
    ]
    : [];
  const showMenu = folded.some((key) => MENU_KEYS.has(key)) && menuItems.some(Boolean);

  return (
    <section className="review-toolbar" aria-label="Review workflow">
      <div className="review-toolbar__scroller" ref={barRef}>
        {session ? (
          <ReviewSessionControls
            session={session}
            disabled={isBusy || Boolean(session.disabled)}
            onStart={onStartSession}
            onContinue={onContinueSession}
            onMove={onMoveSession}
            onForget={onForgetSession}
            onReviewAllUnreviewed={onReviewAllUnreviewed}
            onShowTarget={onShowReviewTarget}
            onIndexSubfolders={onIndexSubfolders}
            compact={isFolded("sessionDetail")}
          />
        ) : null}

        {total > 0 && !isFolded("progress") ? (
          <div
            className="review-toolbar__progress"
            role="progressbar"
            aria-label="Review progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={reviewedTotal}
            aria-valuetext={`${formatCount(reviewedTotal)} of ${formatCount(total)} reviewed`}
          >
            <span className="review-toolbar__progress-copy" aria-live="polite">
              <span>Reviewed</span>
              <strong>{formatCount(reviewedTotal)}</strong>
              <span className="review-toolbar__progress-total">/ {formatCount(total)}</span>
            </span>
            <span className="review-toolbar__progress-track" aria-hidden="true">
              <span style={{ width: `${percentage}%` }} />
            </span>
          </div>
        ) : null}

        {total > 0 && !isFolded("counts") ? <div className="review-toolbar__counts" aria-label="Review result counts">
          <span className="review-toolbar__count review-toolbar__count--accept">
            Accept <strong>{formatCount(progress.accept)}</strong>
          </span>
          <span className="review-toolbar__count review-toolbar__count--reject">
            Reject <strong>{formatCount(progress.reject)}</strong>
          </span>
        </div> : null}

        {total > 0 ? <div className="review-toolbar__actions" role="group" aria-label="Classify selection">
          {REVIEW_ACTIONS.map(({ state, label, icon }) => {
            const key = REVIEW_PRIMARY_KEY_BY_STATE[state];
            const resetHint = state === REVIEW_STATES.UNREVIEWED
              ? "; clears ratings but keeps tags"
              : "";
            return (
              <button
                type="button"
                key={state}
                className={`review-toolbar__action review-toolbar__action--${state}`}
                disabled={selectionDisabled}
                onClick={() => onSetReviewState?.(state)}
                title={`${label} selected clips (${key})${resetHint}`}
                aria-label={isFolded("labels") ? label : undefined}
              >
                <span aria-hidden="true">{icon}</span>
                {isFolded("labels") ? null : <span>{label}</span>}
                <kbd aria-hidden={isFolded("labels") || undefined}>{key}</kbd>
              </button>
            );
          })}
        </div> : null}

        {total > 0 && !isFolded("advance") ? <label className="review-toolbar__advance">
          <input
            type="checkbox"
            checked={autoAdvance}
            disabled={isBusy}
            onChange={(event) => onAutoAdvanceChange?.(event.target.checked)}
          />
          <span>Advance after marking</span>
        </label> : null}

        {total > 0 && !isFolded("undo") ? <button
          type="button"
          className="review-toolbar__utility"
          disabled={isBusy || !canUndo}
          onClick={() => onUndo?.()}
          title="Undo the last review or rating change (Z)"
        >
          Undo <kbd>Z</kbd>
        </button> : null}

        {total > 0 ? <button
          type="button"
          className="review-toolbar__process"
          disabled={isBusy || !canProcessResults}
          onClick={() => onProcessResults?.()}
          title={
            canProcessResults
              ? "Review or export the results for this folder scope"
              : processResultsReason || "Results are unavailable until folder loading completes"
          }
        >
          Process results
        </button> : null}

        {showMenu ? (
          <MenuButton
            ariaLabel="More review controls"
            title="More review controls"
            icon={<span aria-hidden="true">⋯</span>}
            showCaret={false}
            buttonClassName="review-toolbar__utility review-toolbar__more"
            items={menuItems}
          />
        ) : null}
      </div>
    </section>
  );
}
