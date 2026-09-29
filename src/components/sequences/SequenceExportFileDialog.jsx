import React, { useCallback, useEffect, useRef, useState } from "react";
import SequenceDialog from "./SequenceDialog";

const formatDuration = (milliseconds) => {
  const total = Math.round(Number(milliseconds) / 1000);
  if (!Number.isFinite(total) || total <= 0) return null;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

const PHASES = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  READY: "ready",
  RUNNING: "running",
  CANCELLING: "cancelling",
  DONE: "done",
});

/**
 * One-video export (clip-sequences.md, Section 6, tier 2). The plan says,
 * before anything runs, whether the clips are joined as they are or
 * re-encoded, and exactly what differs if they are re-encoded.
 */
export default function SequenceExportFileDialog({
  open,
  sequenceName = "",
  clipCount = 0,
  onPrepare,
  onStart,
  onCancel,
  progress = null,
  onClose,
}) {
  const [phase, setPhase] = useState(PHASES.IDLE);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const planRef = useRef(null);
  planRef.current = plan;

  useEffect(() => {
    if (open) return;
    setPhase(PHASES.IDLE);
    setPlan(null);
    setResult(null);
    setError("");
  }, [open]);

  const busy = [PHASES.PREPARING, PHASES.RUNNING, PHASES.CANCELLING].includes(phase);

  const choose = useCallback(async () => {
    setPhase(PHASES.PREPARING);
    setError("");
    setResult(null);
    try {
      const response = await onPrepare?.();
      if (response?.success === false) throw new Error(response.error);
      if (!response || response.cancelled) {
        setPhase(planRef.current ? PHASES.READY : PHASES.IDLE);
        return;
      }
      setPlan(response);
      setPhase(PHASES.READY);
    } catch (prepareError) {
      setPlan(null);
      setPhase(PHASES.IDLE);
      setError(prepareError?.message || "The export could not be prepared");
    }
  }, [onPrepare]);

  const start = useCallback(async () => {
    if (!plan?.planId) return;
    setPhase(PHASES.RUNNING);
    setError("");
    try {
      const response = await onStart?.(plan.planId);
      if (response?.success === false) throw new Error(response.error);
      setResult(response || {});
    } catch (startError) {
      setResult({ failed: true });
      setError(startError?.message || "The export failed");
    }
    // The plan is spent whatever happened; another export starts afresh.
    setPlan((current) => (current ? { ...current, planId: null } : current));
    setPhase(PHASES.DONE);
  }, [onStart, plan?.planId]);

  const cancel = useCallback(async () => {
    if (!plan?.planId) return;
    setPhase(PHASES.CANCELLING);
    try {
      await onCancel?.(plan.planId);
    } catch {
      // The run reports its own outcome when it stops.
    }
  }, [onCancel, plan?.planId]);

  const progressMatches = progress && plan?.planId && progress.planId === plan.planId;
  const progressText = !progressMatches
    ? "Starting ffmpeg…"
    : progress.phase === "encoding"
      ? `Re-encoding clip ${progress.index} of ${progress.total}…`
      : progress.phase === "joining"
        ? "Joining the clips…"
        : "Finishing…";
  const progressValue = progressMatches && progress.phase === "encoding"
    ? Math.max(0, Number(progress.index) - 1)
    : progressMatches && progress.phase === "joining"
      ? Number(progress.total) || clipCount
      : 0;
  const progressTotal = Math.max(1, (Number(progress?.total) || clipCount) + 1);
  const duration = formatDuration(plan?.totalDurationMs);

  return (
    <SequenceDialog
      open={open}
      title="Export as one video"
      subtitle={`“${sequenceName}” · ${clipCount.toLocaleString()} clip${
        clipCount === 1 ? "" : "s"
      }`}
      mark="▶"
      busy={busy}
      onClose={onClose}
      closeLabel="Close one-video export"
      footer={
        <button
          type="button"
          className="sequence-dialog__secondary"
          disabled={busy}
          onClick={() => onClose?.()}
        >
          {phase === PHASES.DONE ? "Done" : "Cancel"}
        </button>
      }
    >
      <p className="sequence-dialog__lead">
        Joins the clips into one file with ffmpeg, in sequence order. The
        originals are not touched and nothing is overwritten.
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
          <span>Save to</span>
          <strong>{plan?.destinationLabel || "No folder chosen"}</strong>
        </div>
        <button
          type="button"
          className="sequence-dialog__secondary"
          disabled={busy || clipCount === 0}
          onClick={choose}
        >
          {phase === PHASES.PREPARING
            ? "Checking the clips…"
            : plan
              ? "Change…"
              : "Choose folder…"}
        </button>
      </div>

      {phase === PHASES.READY && plan && (
        <div className="review-results-copy-plan" aria-live="polite">
          {plan.mode === "copy" ? (
            <p className="review-results-dialog__notice" role="status">
              Every clip has the same codec, frame size, frame rate and audio,
              so they are joined as they are: fast, with no loss of quality.
            </p>
          ) : (
            <div
              className="review-results-dialog__notice review-results-dialog__notice--warning"
              role="status"
            >
              <strong>
                The clips differ, so each is re-encoded to{" "}
                {plan.target?.width}×{plan.target?.height} at{" "}
                {plan.target?.frameRate} fps before joining.
              </strong>{" "}
              This takes longer and compresses the video again. Clips of
              another shape are letterboxed
              {plan.target?.hasAudio ? "; clips without sound get silence" : ""}.
              {plan.encoder === "mpeg4"
                ? " This FFmpeg has no H.264 encoder, so MPEG-4 Part 2 is used."
                : ""}
              <ul className="sequence-dialog__mismatches">
                {(plan.mismatches || []).map((mismatch) => (
                  <li key={mismatch}>{mismatch}</li>
                ))}
              </ul>
            </div>
          )}
          <dl className="review-results-copy-plan__facts">
            <div>
              <dt>File</dt>
              <dd>{plan.outputName}</dd>
            </div>
            {duration && (
              <div>
                <dt>Length</dt>
                <dd>{duration}</dd>
              </div>
            )}
          </dl>
          <div className="sequence-dialog__row">
            <button type="button" className="sequence-dialog__primary" onClick={start}>
              {plan.mode === "copy" ? "Export" : "Re-encode and export"}
            </button>
          </div>
        </div>
      )}

      {[PHASES.RUNNING, PHASES.CANCELLING].includes(phase) && (
        <div className="review-results-copy-running">
          <div className="review-results-copy-running__status" aria-live="polite">
            <strong>
              {phase === PHASES.CANCELLING ? "Stopping ffmpeg…" : progressText}
            </strong>
            <span>{plan?.outputName}</span>
          </div>
          <div
            className="review-results-dialog__progress review-results-dialog__progress--copy"
            role="progressbar"
            aria-label="One-video export progress"
            aria-valuemin="0"
            aria-valuemax={progressTotal}
            aria-valuenow={progressValue}
          >
            <span style={{ width: `${(progressValue / progressTotal) * 100}%` }} />
          </div>
          <button
            type="button"
            className="sequence-dialog__secondary"
            disabled={phase === PHASES.CANCELLING}
            onClick={cancel}
          >
            {phase === PHASES.CANCELLING ? "Cancel requested" : "Cancel export"}
          </button>
        </div>
      )}

      {phase === PHASES.DONE && result && !result.failed && (
        <div
          className={`review-results-copy-result${
            result.cancelled ? " review-results-copy-result--partial" : ""
          }`}
          role="status"
        >
          <strong>{result.cancelled ? "Export cancelled" : "Export complete"}</strong>
          <p>
            {result.cancelled
              ? "Nothing was written: the partial file was removed."
              : `Saved “${result.outputName}” in ${plan?.destinationLabel || "the chosen folder"}.`}
          </p>
        </div>
      )}
    </SequenceDialog>
  );
}
