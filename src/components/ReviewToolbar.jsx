import React from "react";
import { REVIEW_PRIMARY_KEY_BY_STATE } from "../hotkeys/shortcutCatalog";
import { REVIEW_STATES } from "../review/reviewState";
import "./ReviewToolbar.css";

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
  onSetReviewState,
  onAutoAdvanceChange,
  onUndo,
  onProcessResults,
}) {
  const total = Math.max(0, Number(progress.total) || 0);
  if (total === 0) return null;

  const reviewedTotal = Math.min(
    total,
    Math.max(0, Number(progress.reviewedTotal) || 0)
  );
  const selectionDisabled = isBusy || selectedCount < 1;
  const percentage = Math.round((reviewedTotal / total) * 100);

  return (
    <section className="review-toolbar" aria-label="Review workflow">
      <div className="review-toolbar__scroller">
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

        <div className="review-toolbar__counts" aria-label="Review result counts">
          <span className="review-toolbar__count review-toolbar__count--accept">
            Accept <strong>{formatCount(progress.accept)}</strong>
          </span>
          <span className="review-toolbar__count review-toolbar__count--reject">
            Reject <strong>{formatCount(progress.reject)}</strong>
          </span>
        </div>

        <div className="review-toolbar__actions" role="group" aria-label="Classify selection">
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
              >
                <span aria-hidden="true">{icon}</span>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </button>
            );
          })}
        </div>

        <label className="review-toolbar__advance">
          <input
            type="checkbox"
            checked={autoAdvance}
            disabled={isBusy}
            onChange={(event) => onAutoAdvanceChange?.(event.target.checked)}
          />
          <span>Advance after marking</span>
        </label>

        <button
          type="button"
          className="review-toolbar__utility"
          disabled={isBusy || !canUndo}
          onClick={() => onUndo?.()}
          title="Undo the last review or rating change (Z)"
        >
          Undo <kbd>Z</kbd>
        </button>

        <button
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
        </button>
      </div>
    </section>
  );
}
