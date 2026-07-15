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
      return "Session active";
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
      return "Review saved elsewhere";
    default:
      return "No saved review";
  }
};

function SessionOptions({ disabled, onRequestForget }) {
  return (
    <details className="review-session__options">
      <summary
        aria-label="Review session options"
        title="Review session options"
      >
        •••
      </summary>
      <div className="review-session__menu" role="menu">
        <button
          type="button"
          role="menuitem"
          disabled={disabled}
          onClick={onRequestForget}
        >
          Forget saved position…
        </button>
      </div>
    </details>
  );
}

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

  const requestConfirmation = (kind, event) => {
    confirmationInvokedByRef.current = event.currentTarget;
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
                ? `Start review here — ${session.startActionContext}`
                : "Start review here"
            }
          >
            Start review here
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
                  ? `Continue saved review — ${session.savedActionContext}`
                  : "Continue saved"
              }
            >
              Continue saved
            </button>
            <button
              type="button"
              disabled={disabled || typeof onMove !== "function"}
              onClick={(event) => requestConfirmation("move", event)}
              aria-label={
                session.startActionContext
                  ? `Move saved review position here — ${session.startActionContext}`
                  : "Move saved review position here…"
              }
            >
              Move saved review position here…
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
                ? `Continue review — ${session.savedActionContext}`
                : "Continue review"
            }
          >
            Continue review
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
          <SessionOptions
            disabled={disabled || typeof onForget !== "function"}
            onRequestForget={(event) => requestConfirmation("forget", event)}
          />
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
              ? "Forget this saved review position?"
              : "Move the saved review position here?"}
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
              {confirmation === "forget" ? "Forget position" : "Move position"}
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
