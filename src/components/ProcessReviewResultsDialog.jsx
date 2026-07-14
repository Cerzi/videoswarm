import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  REVIEW_RESULTS_TRASH_LIMIT,
  summarizeReviewScope,
} from "../review/reviewResults";
import "./ProcessReviewResultsDialog.css";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const COUNT_CARDS = [
  { key: "pick", label: "Accept", tone: "accept" },
  { key: "reviewed", label: "Reviewed", tone: "reviewed" },
  { key: "reject", label: "Reject", tone: "reject" },
  { key: "unreviewed", label: "Unreviewed", tone: "unreviewed" },
];

export default function ProcessReviewResultsDialog({
  open,
  videos = [],
  scopeLabel = "Current folder",
  processingReady = true,
  readinessMessage = "Finish loading this folder before processing results.",
  busy = false,
  onClose,
  onTrashRejects,
  onExportManifest,
}) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const actionBusyRef = useRef(false);
  const externalBusyRef = useRef(Boolean(busy));
  const onCloseRef = useRef(onClose);
  const [pendingAction, setPendingAction] = useState(null);
  const [actionError, setActionError] = useState("");
  const summary = useMemo(() => summarizeReviewScope(videos), [videos]);
  const actionBusy = busy || pendingAction !== null;
  actionBusyRef.current = actionBusy;
  externalBusyRef.current = Boolean(busy);
  onCloseRef.current = onClose;
  const trashOverLimit = summary.trashableRejectCount > REVIEW_RESULTS_TRASH_LIMIT;
  const canTrash =
    processingReady &&
    !actionBusy &&
    summary.canTrashRejects &&
    typeof onTrashRejects === "function";
  const canExport =
    processingReady &&
    !actionBusy &&
    summary.instanceCount > 0 &&
    typeof onExportManifest === "function";

  useEffect(() => {
    if (!open) {
      setPendingAction(null);
      setActionError("");
      return undefined;
    }

    const previousActiveElement = document.activeElement;
    const backdrop = backdropRef.current;
    const backgroundSiblings = backdrop?.parentElement
      ? Array.from(backdrop.parentElement.children)
          .filter((element) => element !== backdrop)
          .map((element) => ({
            element,
            ariaHidden: element.getAttribute("aria-hidden"),
            inert: element.hasAttribute("inert"),
          }))
      : [];
    for (const { element } of backgroundSiblings) {
      element.setAttribute("aria-hidden", "true");
      element.setAttribute("inert", "");
    }
    const dialog = dialogRef.current;
    dialog?.querySelector(FOCUSABLE_SELECTOR)?.focus?.();

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !actionBusyRef.current) {
        event.preventDefault();
        onCloseRef.current?.();
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
      document.removeEventListener("keydown", handleKeyDown);
      for (const { element, ariaHidden, inert } of backgroundSiblings) {
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
        if (!inert) element.removeAttribute("inert");
      }
      previousActiveElement?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const runAction = async (name, action) => {
    if (actionBusyRef.current || typeof action !== "function") return;
    actionBusyRef.current = true;
    setPendingAction(name);
    setActionError("");
    try {
      await action();
    } catch (error) {
      setActionError(error?.message || "The action could not be completed.");
    } finally {
      actionBusyRef.current = externalBusyRef.current;
      setPendingAction(null);
    }
  };

  return (
    <div
      ref={backdropRef}
      className="review-results-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !actionBusy) onClose?.();
      }}
    >
      <section
        ref={dialogRef}
        className="review-results-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-results-title"
        aria-describedby="review-results-description"
        data-hotkey-exempt
        tabIndex={-1}
      >
        <header className="review-results-dialog__header">
          <div className="review-results-dialog__mark" aria-hidden="true">✓</div>
          <div className="review-results-dialog__heading">
            <h2 id="review-results-title">Process review results</h2>
            <p id="review-results-description">
              {scopeLabel} · {summary.instanceCount.toLocaleString()} file
              {summary.instanceCount === 1 ? "" : "s"} · {summary.uniqueCount.toLocaleString()} unique
            </p>
          </div>
          <button
            type="button"
            className="review-results-dialog__close"
            aria-label="Close review results"
            disabled={actionBusy}
            onClick={() => onClose?.()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="review-results-dialog__body">
          <div className="review-results-dialog__progress-copy">
            <strong>{summary.reviewedTotal.toLocaleString()} reviewed</strong>
            <span>{summary.instanceCount.toLocaleString()} total</span>
          </div>
          <div
            className="review-results-dialog__progress"
            role="progressbar"
            aria-label="Review progress"
            aria-valuemin="0"
            aria-valuemax={summary.instanceCount || 1}
            aria-valuenow={summary.reviewedTotal}
          >
            <span
              style={{
                width: `${summary.instanceCount
                  ? Math.min(100, (summary.reviewedTotal / summary.instanceCount) * 100)
                  : 0}%`,
              }}
            />
          </div>

          <div className="review-results-dialog__counts">
            {COUNT_CARDS.map(({ key, label, tone }) => (
              <div
                className={`review-results-count review-results-count--${tone}`}
                key={key}
              >
                <span>{label}</span>
                <strong>{summary[key].toLocaleString()}</strong>
              </div>
            ))}
          </div>

          {!processingReady && (
            <p className="review-results-dialog__notice" role="status">
              {readinessMessage}
            </p>
          )}
          {trashOverLimit && (
            <p className="review-results-dialog__notice review-results-dialog__notice--warning">
              This folder scope contains {summary.trashableRejectCount.toLocaleString()} local rejects. The safety limit is
              {` ${REVIEW_RESULTS_TRASH_LIMIT.toLocaleString()}`}; choose a smaller folder to avoid a
              partial operation. No files will be moved.
            </p>
          )}
          {summary.nonLocalRejectCount > 0 && (
            <p className="review-results-dialog__notice">
              {summary.nonLocalRejectCount.toLocaleString()} rejected file
              {summary.nonLocalRejectCount === 1 ? " is" : "s are"} not a local Electron file and cannot be moved to Bin.
            </p>
          )}
          {actionError && (
            <p className="review-results-dialog__notice review-results-dialog__notice--error" role="alert">
              {actionError}
            </p>
          )}

          <div className="review-results-dialog__actions">
            <article className="review-results-action review-results-action--danger">
              <div>
                <h3>Move rejects to Bin</h3>
                <p>
                  Process only rejected files in this folder scope. A native confirmation appears
                  before anything is moved.
                </p>
              </div>
              <button
                type="button"
                disabled={!canTrash}
                onClick={() => runAction("trash", () => onTrashRejects(summary.rejectVideos))}
              >
                {pendingAction === "trash"
                  ? "Processing…"
                  : `Move ${summary.trashableRejectCount.toLocaleString()} to Bin`}
              </button>
            </article>

            <article className="review-results-action">
              <div>
                <h3>Export review manifest</h3>
                <p>
                  Save a portable JSON list containing every review state, rating, and tag in this
                  scope. Media files are not copied.
                </p>
              </div>
              <button
                type="button"
                disabled={!canExport}
                onClick={() => runAction("export", onExportManifest)}
              >
                {pendingAction === "export" ? "Saving…" : "Export JSON"}
              </button>
            </article>
          </div>
        </div>

        <footer className="review-results-dialog__footer">
          <span>Actions use the current folder before search and filter controls.</span>
          <button type="button" disabled={actionBusy} onClick={() => onClose?.()}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}
