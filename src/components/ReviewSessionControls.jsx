import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

const SESSION_MENU_WIDTH = 184;
const SESSION_MENU_HEIGHT = 42;
const SESSION_MENU_MARGIN = 8;
const SESSION_MENU_GAP = 4;

const getSessionMenuPosition = (rect) => {
  const viewportWidth = Math.max(
    SESSION_MENU_WIDTH + SESSION_MENU_MARGIN * 2,
    Number(window.innerWidth) || 0
  );
  const viewportHeight = Math.max(
    SESSION_MENU_HEIGHT + SESSION_MENU_MARGIN * 2,
    Number(window.innerHeight) || 0
  );
  const below = rect.bottom + SESSION_MENU_GAP;
  const top = below + SESSION_MENU_HEIGHT <= viewportHeight - SESSION_MENU_MARGIN
    ? below
    : Math.max(
        SESSION_MENU_MARGIN,
        rect.top - SESSION_MENU_GAP - SESSION_MENU_HEIGHT
      );
  return {
    left: Math.max(
      SESSION_MENU_MARGIN,
      Math.min(
        viewportWidth - SESSION_MENU_WIDTH - SESSION_MENU_MARGIN,
        rect.right - SESSION_MENU_WIDTH
      )
    ),
    top,
  };
};

function SessionOptions({ disabled, onRequestForget }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus?.();
    }
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect?.();
    if (rect) setPosition(getSessionMenuPosition(rect));
    setOpen(true);
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return undefined;

    const firstItem = menuRef.current?.querySelector?.('[role="menuitem"]');
    firstItem?.focus?.();

    const handlePointerDown = (event) => {
      if (
        triggerRef.current?.contains?.(event.target) ||
        menuRef.current?.contains?.(event.target)
      ) {
        return;
      }
      closeMenu(false);
    };
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    };
    const handleViewportChange = () => closeMenu(true);

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closeMenu, open]);

  return (
    <div className="review-session__options">
      <button
        ref={triggerRef}
        type="button"
        className="review-session__options-trigger"
        aria-label="Review session options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Review session options (forget saved position)"
        disabled={disabled}
        onClick={() => (open ? closeMenu(false) : openMenu())}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              className="review-session__menu review-session__menu--portal"
              role="menu"
              aria-label="Review session options"
              style={position}
            >
              <button
                type="button"
                role="menuitem"
                onClick={(event) => {
                  const focusTarget = triggerRef.current;
                  closeMenu(false);
                  onRequestForget?.(event, focusTarget);
                }}
              >
                Forget saved position…
              </button>
            </div>,
            document.body
          )
        : null}
    </div>
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
            onRequestForget={(event, focusTarget) =>
              requestConfirmation("forget", event, focusTarget)
            }
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
