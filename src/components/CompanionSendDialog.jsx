import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CompanionSendPanel from "./CompanionSendPanel";
import { companionRowsOf } from "../app/companion/companionSend";
import "./ProcessReviewResultsDialog.css";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Sends a selection to one of a companion app's actions. Opens with the dry
 * run already under way, so the first thing shown is what would happen.
 */
export default function CompanionSendDialog({
  open,
  companionId = null,
  action = null,
  companionName = "The companion app",
  videos = [],
  onClose,
  onSent,
}) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  busyRef.current = busy;
  const { instanceIds, excludedCount } = useMemo(() => companionRowsOf(videos), [videos]);

  const closeDialog = useCallback(() => {
    if (!busyRef.current) onCloseRef.current?.();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const previousActiveElement = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector(FOCUSABLE_SELECTOR)?.focus?.();
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
      if (!focusable.length) return;
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
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus?.();
    };
  }, [closeDialog, open]);

  if (!open || !action) return null;

  return (
    <div
      className="review-results-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <section
        ref={dialogRef}
        className="review-results-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="companion-send-title"
        data-hotkey-exempt
        tabIndex={-1}
      >
        <header className="review-results-dialog__header">
          <div className="review-results-dialog__mark" aria-hidden="true">↗</div>
          <div className="review-results-dialog__heading">
            <h2 id="companion-send-title">{action.send}</h2>
            <p>{companionName}</p>
          </div>
          <button
            type="button"
            className="review-results-dialog__close"
            aria-label="Close"
            disabled={busy}
            onClick={closeDialog}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="review-results-dialog__body">
          <div className="review-results-dialog__actions">
            <CompanionSendPanel
              companionId={companionId}
              action={action}
              companionName={companionName}
              instanceIds={instanceIds}
              excludedCount={excludedCount}
              itemLabel={instanceIds.length === 1 ? "clip" : "clips"}
              autoCheck
              onBusyChange={setBusy}
              onSent={onSent}
            />
          </div>
        </div>
        <footer className="review-results-dialog__footer">
          <button type="button" disabled={busy} onClick={closeDialog}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
