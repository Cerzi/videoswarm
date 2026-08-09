import React, { useEffect, useRef, useState } from "react";
import MediaTransferPanel from "./MediaTransferPanel";
import { useMediaTransfer } from "../hooks/transfer/useMediaTransfer";
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
 * Transfer an explicit selection rather than a review outcome.
 *
 * The panel, coordinator and bounds are the same ones the review flow uses, so
 * the only thing that differs is which rows are named. Clips without a catalog
 * instance - web files, or anything not yet indexed - cannot be named by id and
 * are reported as excluded instead of being silently dropped.
 */
export default function TransferSelectionDialog({
  open,
  videos = [],
  onClose,
  onPrepareTransfer,
  onStartTransfer,
  onCancelTransfer,
  onListTransferDestinations,
  transferLayout = "structured",
  onTransferLayoutChange,
  transferProgress = null,
}) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const closeBlockedRef = useRef(false);
  const [actionError, setActionError] = useState("");
  onCloseRef.current = onClose;

  const transferable = videos.filter(
    (video) =>
      video &&
      video.isElectronFile &&
      Number.isSafeInteger(Number(video.instanceId)) &&
      Number(video.instanceId) > 0
  );
  const excludedCount = Math.max(0, videos.length - transferable.length);

  const transfer = useMediaTransfer({
    open,
    enabled: transferable.length > 0 && typeof onPrepareTransfer === "function",
    onPrepare: (destinationPath, layout, reusePlanId) =>
      onPrepareTransfer?.({
        instanceIds: transferable.map((video) => Number(video.instanceId)),
        destinationPath,
        layout,
        reusePlanId,
      }),
    onStart: onStartTransfer,
    onCancel: onCancelTransfer,
    onListDestinations: onListTransferDestinations,
    layout: transferLayout,
    onLayoutChange: onTransferLayoutChange,
    progress: transferProgress,
    onError: setActionError,
  });
  closeBlockedRef.current = transfer.busy;

  const closeDialog = () => {
    if (closeBlockedRef.current) return;
    transfer.abandonActivePlan();
    onCloseRef.current?.();
  };

  useEffect(() => {
    if (!open) {
      setActionError("");
      return undefined;
    }
    const previousActiveElement = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector(FOCUSABLE_SELECTOR)?.focus?.();

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !closeBlockedRef.current) {
        event.preventDefault();
        closeDialog();
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

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      transfer.abandonActivePlan();
      document.removeEventListener("keydown", handleKeyDown);
      previousActiveElement?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const count = transferable.length;

  return (
    <div
      ref={backdropRef}
      className="review-results-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !transfer.busy) {
          closeDialog();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="review-results-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-selection-title"
        aria-describedby="transfer-selection-description"
        data-hotkey-exempt
        tabIndex={-1}
      >
        <header className="review-results-dialog__header">
          <div className="review-results-dialog__mark" aria-hidden="true">→</div>
          <div className="review-results-dialog__heading">
            <h2 id="transfer-selection-title">Move or copy clips</h2>
            <p id="transfer-selection-description">
              {count.toLocaleString()} selected clip{count === 1 ? "" : "s"}
            </p>
          </div>
          <button
            type="button"
            className="review-results-dialog__close"
            aria-label="Close transfer"
            disabled={transfer.busy}
            onClick={closeDialog}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="review-results-dialog__body">
          {excludedCount > 0 && (
            <p className="review-results-dialog__notice">
              {excludedCount.toLocaleString()} selected clip
              {excludedCount === 1 ? " is" : "s are"} not an indexed local file
              and cannot be transferred.
            </p>
          )}
          {count === 0 && (
            <p className="review-results-dialog__notice" role="status">
              Nothing in this selection can be transferred.
            </p>
          )}
          {actionError && (
            <p
              className="review-results-dialog__notice review-results-dialog__notice--error"
              role="alert"
            >
              {actionError}
            </p>
          )}

          <div className="review-results-dialog__actions">
            <MediaTransferPanel
              transfer={transfer}
              heading="Selected clips"
              itemLabel="selected clips"
              progressLabel="Selected clip"
              description={`Send ${count.toLocaleString()} selected clip${
                count === 1 ? "" : "s"
              } to another folder.`}
            />
          </div>
        </div>

        <footer className="review-results-dialog__footer">
          <button type="button" disabled={transfer.busy} onClick={closeDialog}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
