import React, { useEffect, useId, useRef } from "react";
import "../ProcessReviewResultsDialog.css";
import "./SequenceDialogs.css";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The modal frame the sequence file actions share: the review dialogs' look,
 * a focus trap, and Escape or the backdrop to close unless work is running.
 */
export default function SequenceDialog({
  open,
  title,
  subtitle,
  mark = "▦",
  busy = false,
  onClose,
  footer,
  children,
  closeLabel = "Close",
}) {
  const id = useId().replace(/:/g, "");
  const dialogRef = useRef(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const previousActiveElement = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector(FOCUSABLE_SELECTOR)?.focus?.();

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      previousActiveElement?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="review-results-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose?.();
      }}
    >
      <section
        ref={dialogRef}
        className="review-results-dialog sequence-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={subtitle ? `${id}-subtitle` : undefined}
        data-hotkey-exempt
        tabIndex={-1}
      >
        <header className="review-results-dialog__header">
          <div className="review-results-dialog__mark" aria-hidden="true">
            {mark}
          </div>
          <div className="review-results-dialog__heading">
            <h2 id={`${id}-title`}>{title}</h2>
            {subtitle ? <p id={`${id}-subtitle`}>{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="review-results-dialog__close"
            aria-label={closeLabel}
            disabled={busy}
            onClick={() => onClose?.()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="review-results-dialog__body">{children}</div>
        {footer ? (
          <footer className="review-results-dialog__footer sequence-dialog__footer">
            {footer}
          </footer>
        ) : null}
      </section>
    </div>
  );
}
