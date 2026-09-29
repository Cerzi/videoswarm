import React, { useCallback, useEffect, useState } from "react";
import SequenceDialog from "./SequenceDialog";
import { COPY_PHASES, useMediaTransfer } from "../../hooks/transfer/useMediaTransfer";

const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  return `${amount.toFixed(amount >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const PREVIEW_NAMES = 6;

/**
 * Numbered copy of a sequence (clip-sequences.md, Section 6, tier 1).
 *
 * Destination, preflight, progress and cancellation are the transfer flow's
 * (useMediaTransfer and the native coordinator), so the no-overwrite rules
 * and partial-result wording are the ones every transfer uses. What differs
 * is that a sequence copy is all-or-nothing: a taken name blocks the start
 * instead of being skipped, because a copy missing a shot is a different
 * story and concat.txt would name someone else's file.
 */
export default function SequenceExportCopyDialog({
  open,
  sequenceName = "",
  clipCount = 0,
  onPrepare,
  onStart,
  onCancel,
  onListDestinations,
  progress = null,
  onClose,
}) {
  const [error, setError] = useState("");
  const [sequencePlan, setSequencePlan] = useState(null);

  const transfer = useMediaTransfer({
    open,
    enabled: typeof onPrepare === "function" && clipCount > 0,
    onPrepare: async (destinationPath, _layout, reusePlanId) => {
      setSequencePlan(null);
      const response = await onPrepare({ destinationPath, reusePlanId });
      if (response?.success === false) {
        throw new Error(response.error || "The copy could not be prepared");
      }
      setSequencePlan(response?.sequence || null);
      return response;
    },
    onStart,
    onCancel,
    onListDestinations,
    layout: "structured",
    progress,
    onError: setError,
  });
  const { phase, plan, result, busy } = transfer;

  useEffect(() => {
    if (!open) {
      setError("");
      setSequencePlan(null);
    }
  }, [open]);

  const close = useCallback(() => {
    if (transfer.busyRef.current) return;
    transfer.abandonActivePlan();
    onClose?.();
  }, [onClose, transfer]);

  const blockedReason = sequencePlan?.blockedReason || null;
  const targetNames = Array.isArray(sequencePlan?.targetNames)
    ? sequencePlan.targetNames
    : [];
  const copying = [COPY_PHASES.COPYING, COPY_PHASES.CANCELLING].includes(phase);

  return (
    <SequenceDialog
      open={open}
      title="Copy as numbered files"
      subtitle={`“${sequenceName}” · ${clipCount.toLocaleString()} clip${
        clipCount === 1 ? "" : "s"
      }`}
      mark="⧉"
      busy={busy}
      onClose={close}
      closeLabel="Close numbered copy"
      footer={
        <button
          type="button"
          className="sequence-dialog__secondary"
          disabled={busy}
          onClick={close}
        >
          {phase === COPY_PHASES.COMPLETE ? "Done" : "Cancel"}
        </button>
      }
    >
      <p className="sequence-dialog__lead">
        Copies each clip into a folder you choose as 010_, 020_ … in sequence
        order, plus a <code>concat.txt</code> that ffmpeg can join. The
        originals are not touched. A clip used twice is copied twice.
      </p>

      {error && (
        <p
          className="review-results-dialog__notice review-results-dialog__notice--error"
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="review-results-destination" aria-live="polite">
        <div>
          <span>Destination</span>
          <strong>{plan?.destinationLabel || "No folder chosen"}</strong>
        </div>
        <button
          type="button"
          className="sequence-dialog__secondary"
          disabled={!transfer.enabled || busy}
          onClick={() => transfer.chooseDestination()}
        >
          {phase === COPY_PHASES.PREPARING
            ? "Checking…"
            : plan
              ? "Change…"
              : "Choose folder…"}
        </button>
      </div>

      {transfer.recentDestinations.length > 0 && !copying && (
        <div className="review-results-recent-destinations">
          <span id="sequence-recent-destinations">Recent</span>
          <ul aria-labelledby="sequence-recent-destinations">
            {transfer.recentDestinations.map((destination) => (
              <li key={destination.path}>
                <button
                  type="button"
                  disabled={!transfer.enabled || busy}
                  title={destination.path}
                  onClick={() => transfer.chooseDestination(destination.path)}
                >
                  {destination.label || destination.path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {phase === COPY_PHASES.READY && plan && (
        <div className="review-results-copy-plan" aria-live="polite">
          <dl className="review-results-copy-plan__facts">
            <div>
              <dt>Files</dt>
              <dd>{plan.mediaCount.toLocaleString()} + concat.txt</dd>
            </div>
            <div>
              <dt>Estimated size</dt>
              <dd>{formatBytes(plan.totalBytes)}</dd>
            </div>
          </dl>
          {targetNames.length > 0 && (
            <ol className="sequence-dialog__names" aria-label="Names in the destination">
              {targetNames.slice(0, PREVIEW_NAMES).map((name, index) => (
                <li key={`${index}:${name}`}>{name}</li>
              ))}
              {plan.mediaCount > PREVIEW_NAMES && (
                <li className="sequence-dialog__more">
                  … {(plan.mediaCount - PREVIEW_NAMES).toLocaleString()} more
                </li>
              )}
            </ol>
          )}
          {blockedReason && (
            <div
              className="review-results-dialog__notice review-results-dialog__notice--warning"
              role="status"
            >
              <strong>{blockedReason}</strong>
              {plan.collisionSamples.length > 0 && (
                <ul className="review-results-copy-samples">
                  {plan.collisionSamples.map((name, index) => (
                    <li key={`${name}:${index}`}>{name}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="sequence-dialog__row">
            <button
              ref={transfer.primaryActionRef}
              type="button"
              className="sequence-dialog__primary"
              disabled={!plan.canStart}
              onClick={() => transfer.start("copy")}
            >
              Copy {plan.mediaCount.toLocaleString()} file
              {plan.mediaCount === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}

      {copying && (
        <div className="review-results-copy-running">
          <div className="review-results-copy-running__status" aria-live="polite">
            <strong>
              {phase === COPY_PHASES.CANCELLING
                ? "Finishing the current file…"
                : `Copying ${transfer.progressValue.toLocaleString()} of ${transfer.progressTotal.toLocaleString()}…`}
            </strong>
            <span>{plan?.destinationLabel}</span>
          </div>
          <div
            className="review-results-dialog__progress review-results-dialog__progress--copy"
            role="progressbar"
            aria-label="Numbered copy progress"
            aria-valuemin="0"
            aria-valuemax={transfer.progressTotal}
            aria-valuenow={transfer.progressValue}
          >
            <span
              style={{
                width: `${(transfer.progressValue / transfer.progressTotal) * 100}%`,
              }}
            />
          </div>
          <button
            type="button"
            className="sequence-dialog__secondary"
            disabled={phase === COPY_PHASES.CANCELLING}
            onClick={transfer.cancel}
          >
            {phase === COPY_PHASES.CANCELLING ? "Cancel requested" : "Cancel copy"}
          </button>
        </div>
      )}

      {phase === COPY_PHASES.COMPLETE && result && (
        <div
          className={`review-results-copy-result${
            transfer.terminalHasIssues || result.cancelled
              ? " review-results-copy-result--partial"
              : ""
          }`}
          role={result.failedCount > 0 || result.error ? "alert" : "status"}
        >
          <strong>
            {result.cancelled
              ? "Copy cancelled"
              : transfer.terminalHasIssues
                ? "Copy finished with issues"
                : "Numbered copy complete"}
          </strong>
          {result.error && <p>{result.error}</p>}
          <p>
            {result.copiedCount.toLocaleString()} file
            {result.copiedCount === 1 ? "" : "s"} copied to{" "}
            {plan?.destinationLabel || "the destination"}
            {!result.cancelled && !transfer.terminalHasIssues
              ? ", with concat.txt."
              : "."}
            {result.cancelled && result.copiedCount > 0
              ? " Files already copied stay there; concat.txt was not written."
              : ""}
          </p>
          {result.failureSamples.length > 0 && (
            <ul className="review-results-copy-samples">
              {result.failureSamples.map((sample, index) => (
                <li key={`${sample.relativePath}:${index}`}>
                  {sample.relativePath}
                  {sample.message ? ` — ${sample.message}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SequenceDialog>
  );
}
