import React from "react";
import { COPY_PHASES } from "../hooks/transfer/useMediaTransfer";
import { CopyIcon, MoveIcon } from "./UiIcons";

const LAYOUT_OPTIONS = [
  {
    value: "structured",
    label: "Keep folders",
    hint: "Recreate each clip's folder path from the library root.",
  },
  {
    value: "flat",
    label: "Flat",
    hint: "Write every clip straight into the destination. Same-named clips are reported as collisions.",
  },
];

const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "Size unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = amount >= 10 || unitIndex === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
};

/**
 * Destination, layout, preflight summary, progress and outcome for a transfer.
 * Rendering lives here so the review flow and an arbitrary selection present
 * identical collision and partial-result wording; only the heading differs.
 */
export default function MediaTransferPanel({
  transfer,
  heading,
  description,
  // Names the thing being transferred in action labels, so a screen reader
  // hears "Move accepted clips" or "Move selected clips" rather than a
  // generic verb shared by two different flows.
  itemLabel = "clips",
  progressLabel = "Clip",
}) {
  const {
    phase,
    plan,
    result,
    transferMode,
    recentDestinations,
    busy,
    enabled,
    layout,
    primaryActionRef,
    progressTotal,
    progressValue,
    terminalHasIssues,
    chooseDestination,
    changeLayout,
    start,
    cancel,
    reset,
  } = transfer;

  return (
    <article className="review-results-action review-results-action--copy">
      <div className="review-results-action__copy-heading">
        <div>
          <h3>{heading}</h3>
          <p>{description}</p>
        </div>
      </div>

      <div className="review-results-destination" aria-live="polite">
        <div>
          <span>Destination</span>
          <strong>{plan?.destinationLabel || "No folder selected"}</strong>
        </div>
        <button
          type="button"
          className="review-results-copy-actions__secondary"
          disabled={!enabled || busy}
          onClick={() => chooseDestination()}
        >
          {phase === COPY_PHASES.PREPARING
            ? "Checking destination…"
            : plan
              ? "Change…"
              : "Choose destination…"}
        </button>
      </div>

      <div
        className="review-results-layout"
        role="group"
        aria-label="Destination folder layout"
      >
        {LAYOUT_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={
              layout === option.value
                ? "review-results-layout__option is-active"
                : "review-results-layout__option"
            }
            aria-pressed={layout === option.value}
            title={option.hint}
            disabled={!enabled || busy}
            onClick={() => changeLayout(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {recentDestinations.length > 0 && (
        <div className="review-results-recent-destinations">
          <span id="recent-destinations-label">Recent</span>
          <ul aria-labelledby="recent-destinations-label">
            {recentDestinations.map((destination) => (
              <li key={destination.path}>
                <button
                  type="button"
                  disabled={!enabled || busy}
                  title={destination.path}
                  onClick={() => chooseDestination(destination.path)}
                >
                  {destination.label || destination.path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {[COPY_PHASES.IDLE, COPY_PHASES.PREPARING].includes(phase) && (
        <div className="review-results-transfer-actions">
          <button
            type="button"
            className="review-results-transfer-actions__move"
            aria-label={`Move ${itemLabel}; choose a destination first`}
            disabled
          >
            <MoveIcon aria-hidden="true" />
            <span>Move</span>
            <small>Remove originals</small>
          </button>
          <button
            type="button"
            aria-label={`Copy ${itemLabel}; choose a destination first`}
            disabled
          >
            <CopyIcon aria-hidden="true" />
            <span>Copy</span>
            <small>Keep originals</small>
          </button>
        </div>
      )}

      {phase === COPY_PHASES.READY && plan && (
        <div className="review-results-copy-plan" aria-live="polite">
          <dl className="review-results-copy-plan__facts">
            <div><dt>Media</dt><dd>{plan.mediaCount.toLocaleString()}</dd></div>
            <div><dt>Estimated size</dt><dd>{formatBytes(plan.totalBytes)}</dd></div>
          </dl>

          {plan.collisionCount > 0 && (
            <div className="review-results-dialog__notice review-results-dialog__notice--warning">
              <strong>
                {plan.collisionCount.toLocaleString()} existing destination file
                {plan.collisionCount === 1 ? " will" : "s will"} be skipped.
              </strong>
              {plan.collisionSamples.length > 0 && (
                <ul className="review-results-copy-samples">
                  {plan.collisionSamples.map((relativePath, index) => (
                    <li key={`${relativePath}:${index}`}>{relativePath}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {plan.missingCount > 0 && (
            <p className="review-results-dialog__notice">
              {plan.missingCount.toLocaleString()} indexed source file
              {plan.missingCount === 1 ? " is" : "s are"} missing or changed and will be skipped.
            </p>
          )}
          {plan.failureCount > 0 && (
            <div className="review-results-dialog__notice review-results-dialog__notice--warning">
              <strong>
                {plan.failureCount.toLocaleString()} additional file
                {plan.failureCount === 1 ? " could" : "s could"} not be prepared and will be skipped.
              </strong>
              {plan.failureSamples.length > 0 && (
                <ul className="review-results-copy-samples">
                  {plan.failureSamples.map((sample, index) => (
                    <li key={`${sample.relativePath}:${index}`}>
                      {sample.relativePath}
                      {sample.message ? ` — ${sample.message}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!plan.canStart && (
            <p className="review-results-dialog__notice" role="status">
              No files remain to transfer to this destination.
            </p>
          )}
          <div className="review-results-transfer-actions">
            <button
              type="button"
              className="review-results-transfer-actions__move"
              aria-label={`Move ${plan.copyableCount.toLocaleString()} file${plan.copyableCount === 1 ? "" : "s"}; remove originals`}
              disabled={!plan.canStart}
              onClick={() => start("move")}
            >
              <MoveIcon aria-hidden="true" />
              <span>Move</span>
              <small>Remove originals</small>
            </button>
            <button
              ref={primaryActionRef}
              type="button"
              aria-label={`Copy ${plan.copyableCount.toLocaleString()} file${plan.copyableCount === 1 ? "" : "s"}; keep originals`}
              disabled={!plan.canStart}
              onClick={() => start("copy")}
            >
              <CopyIcon aria-hidden="true" />
              <span>Copy</span>
              <small>Keep originals</small>
            </button>
          </div>
        </div>
      )}

      {[COPY_PHASES.COPYING, COPY_PHASES.CANCELLING].includes(phase) && (
        <div className="review-results-copy-running">
          <div
            className="review-results-copy-running__status"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong>
              {phase === COPY_PHASES.CANCELLING
                ? "Finishing the current file…"
                : `${transferMode === "move" ? "Moving" : "Copying"} ${progressValue.toLocaleString()} of ${progressTotal.toLocaleString()} ${progressTotal === 1 ? "file" : "files"}…`}
            </strong>
            <span>{plan?.destinationLabel}</span>
          </div>
          <div
            className="review-results-dialog__progress review-results-dialog__progress--copy"
            role="progressbar"
            aria-label={`${progressLabel} ${transferMode} progress`}
            aria-valuemin="0"
            aria-valuemax={progressTotal}
            aria-valuenow={progressValue}
          >
            <span style={{ width: `${(progressValue / progressTotal) * 100}%` }} />
          </div>
          <button
            ref={primaryActionRef}
            type="button"
            className="review-results-copy-actions__secondary"
            disabled={phase === COPY_PHASES.CANCELLING}
            onClick={cancel}
          >
            {phase === COPY_PHASES.CANCELLING
              ? "Cancel requested"
              : `Cancel ${transferMode}`}
          </button>
        </div>
      )}

      {phase === COPY_PHASES.COMPLETE && result && (
        <div
          className={`review-results-copy-result${terminalHasIssues ? " review-results-copy-result--partial" : ""}`}
          role={result.failedCount > 0 || result.error ? "alert" : "status"}
        >
          <strong>
            {result.cancelled
              ? `${result.transferMode === "move" ? "Move" : "Copy"} cancelled`
              : result.error && result.copiedCount === 0
                ? `${result.transferMode === "move" ? "Move" : "Copy"} could not be completed`
              : terminalHasIssues
                ? `${result.transferMode === "move" ? "Move" : "Copy"} finished with issues`
                : `${result.transferMode === "move" ? "Move" : "Copy"} complete`}
          </strong>
          {result.error && <p>{result.error}</p>}
          <p>
            {result.copiedCount.toLocaleString()} media file
            {result.copiedCount === 1 ? "" : "s"} {result.transferMode === "move" ? "moved" : "copied"}
            {result.skippedCount > 0
              ? ` · ${result.skippedCount.toLocaleString()} existing skipped`
              : ""}
            {result.failedCount > 0
              ? ` · ${result.failedCount.toLocaleString()} failed`
              : ""}
            {result.missingCount > 0
              ? ` · ${result.missingCount.toLocaleString()} missing or changed`
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
          <button ref={primaryActionRef} type="button" onClick={() => reset()}>
            Transfer again
          </button>
        </div>
      )}
    </article>
  );
}
