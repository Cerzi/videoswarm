import React, { useEffect, useRef, useState } from "react";
import "./ReviewSessionControls.css";

const SESSION_MODES = new Set([
  "none",
  "active",
  "available",
  "elsewhere",
  "restoring",
  "complete",
  "complete-view",
  "index-required",
]);

const modeOf = (session) =>
  SESSION_MODES.has(session?.mode) ? session.mode : "none";

const primaryStatusFor = (mode) => {
  switch (mode) {
    case "active":
      return "Review position saved";
    case "available":
      return "New Unreviewed clips";
    case "restoring":
      return "Restoring saved review…";
    case "complete-view":
      return "Review complete for this saved view";
    case "complete":
      return "Review complete";
    case "index-required":
      return "Subfolder index required";
    case "elsewhere":
      return "Resume point saved elsewhere";
    default:
      return "Ready to review";
  }
};

export default function ReviewSessionControls({
  session,
  disabled = false,
  onStart,
  onContinue,
  onMove,
  onForget,
  onReviewAllUnreviewed,
  onShowTarget,
  onIndexSubfolders,
}) {
  const [confirmation, setConfirmation] = useState(null);
  const confirmationInvokedByRef = useRef(null);
  const cancelConfirmationRef = useRef(null);
  const focusAfterConfirmationRef = useRef(null);

  const mode = modeOf(session);
  const status = primaryStatusFor(mode);
  const hasCheckpoint = mode !== "none";
  const isRestoring = mode === "restoring";

  useEffect(() => {
    if (confirmation) cancelConfirmationRef.current?.focus();
  }, [confirmation]);

  useEffect(() => {
    if (confirmation || !focusAfterConfirmationRef.current) return;
    focusAfterConfirmationRef.current.focus();
    focusAfterConfirmationRef.current = null;
  }, [confirmation]);

  if (!session) return null;

  const requestConfirmation = (kind, event, focusTarget) => {
    confirmationInvokedByRef.current = focusTarget || event.currentTarget;
    setConfirmation(kind);
  };

  const closeConfirmation = () => {
    focusAfterConfirmationRef.current = confirmationInvokedByRef.current;
    setConfirmation(null);
  };

  const confirmAction = () => {
    if (confirmation === "forget") onForget?.();
    if (confirmation === "move") onMove?.();
    closeConfirmation();
  };

  const announcement =
    session.message ||
    (session.candidateName ? `Review target: ${session.candidateName}` : status);

  return (
    <div
      className={`review-session review-session--${mode}`}
      aria-busy={isRestoring || undefined}
    >
      <div className="review-session__summary">
        <span className="review-session__indicator" aria-hidden="true" />
        <span className="review-session__copy">
          <strong>{status}</strong>
          {session.savedAtLabel ? <span>{session.savedAtLabel}</span> : null}
          {session.locationLabel && mode === "elsewhere" ? (
            <span>{session.locationLabel}</span>
          ) : null}
          {mode === "none" ? (
            <span>Marks work now; your first review or rating saves this position.</span>
          ) : null}
        </span>
      </div>

      <div className="review-session__actions">
        {mode === "none" ? (
          <button
            type="button"
            disabled={disabled || typeof onStart !== "function"}
            onClick={() => onStart?.()}
            aria-label={
                session.startActionContext
                ? `Find next Unreviewed — ${session.startActionContext}`
                : "Find next Unreviewed"
            }
            title="Save this folder scope, filters, and sort as a resume point, then jump to the next Unreviewed clip."
          >
            Find Unreviewed
          </button>
        ) : null}
        {mode === "active" ? (
          <button
            type="button"
            className="review-session__primary"
            disabled={disabled || typeof onContinue !== "function"}
            onClick={() => onContinue?.()}
            aria-label={
              session.savedActionContext
                ? `Find next Unreviewed from saved position \u2014 ${session.savedActionContext}`
                : "Find next Unreviewed from saved position"
            }
            title="Restore the saved folder scope, filters, sort, and position, then jump to the next Unreviewed clip."
          >
            Find Unreviewed
          </button>
        ) : null}


        {mode === "elsewhere" ? (
          <>
            <button
              type="button"
              className="review-session__primary"
              disabled={disabled || typeof onContinue !== "function"}
              onClick={() => onContinue?.()}
              aria-label={
                session.savedActionContext
                  ? `Resume saved position — ${session.savedActionContext}`
                  : "Resume saved position"
              }
            >
              Resume
            </button>
            <button
              type="button"
              disabled={disabled || typeof onMove !== "function"}
              onClick={(event) => requestConfirmation("move", event)}
              aria-label={
                session.startActionContext
                  ? `Save current position instead — ${session.startActionContext}`
                  : "Save current position instead…"
              }
            >
              Save position here…
            </button>
          </>
        ) : null}

        {mode === "available" ? (
          <button
            type="button"
            className="review-session__primary"
            disabled={disabled || typeof onContinue !== "function"}
            onClick={() => onContinue?.()}
            aria-label={
                session.savedActionContext
                ? `Resume review — ${session.savedActionContext}`
                : "Resume review"
            }
          >
            Resume
          </button>
        ) : null}

        {mode === "complete-view" && onReviewAllUnreviewed ? (
          <button
            type="button"
            className="review-session__primary"
            disabled={disabled || typeof onReviewAllUnreviewed !== "function"}
            onClick={() => onReviewAllUnreviewed()}
          >
            Review all Unreviewed
          </button>
        ) : null}

        {mode === "index-required" && onIndexSubfolders ? (
          <button
            type="button"
            className="review-session__primary"
            disabled={disabled || typeof onIndexSubfolders !== "function"}
            onClick={() => onIndexSubfolders()}
          >
            Index subfolders to continue
          </button>
        ) : null}

        {session.showTarget && onShowTarget ? (
          <button
            type="button"
            className="review-session__primary"
            disabled={disabled || typeof onShowTarget !== "function"}
            onClick={() => onShowTarget()}
          >
            Show review target
          </button>
        ) : null}

        {hasCheckpoint && !isRestoring ? (
          <button
            type="button"
            className="review-session__clear-position"
            disabled={disabled || typeof onForget !== "function"}
            onClick={(event) => requestConfirmation("forget", event)}
          >
            Clear resume point…
          </button>
        ) : null}
      </div>

      {session.checkingForFiles ? (
        <span className="review-session__checking">
          Checking for newer files…
        </span>
      ) : null}

      <span
        className="review-session__announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </span>

      {confirmation ? (
        <div
          className="review-session__confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="review-session-confirmation-title"
          aria-describedby="review-session-confirmation-description"
        >
          <strong id="review-session-confirmation-title">
            {confirmation === "forget"
              ? "Clear this resume point?"
              : "Save the current review position instead?"}
          </strong>
          <span id="review-session-confirmation-description">
            {confirmation === "forget"
              ? "Review decisions, ratings, and tags will remain unchanged."
              : "This replaces the saved cursor and view. Review decisions, ratings, and tags remain unchanged."}
          </span>
          <span className="review-session__confirmation-actions">
            <button
              ref={cancelConfirmationRef}
              type="button"
              onClick={closeConfirmation}
            >
              Cancel
            </button>
            <button
              type="button"
              className="review-session__confirm"
              onClick={confirmAction}
            >
              {confirmation === "forget" ? "Clear resume point" : "Save position"}
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
