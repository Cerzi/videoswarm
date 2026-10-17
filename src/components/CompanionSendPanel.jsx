import React, { useEffect, useMemo } from "react";
import { useCompanionSend } from "../app/companion/useCompanionSend";
import { formatEstimate, summarizeSendResults } from "../app/companion/companionSend";

function Reasons({ title, reasons }) {
  if (!reasons.length) return null;
  return (
    <div className="companion-send__reasons">
      <span>{title}</span>
      <ul>
        {reasons.map(({ why, count }) => (
          <li key={why}>
            <strong>{count.toLocaleString()}</strong> {why}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Progress({ label, done, total }) {
  return (
    <div className="companion-send__progress">
      <p aria-live="polite">{`${label} ${done.toLocaleString()} of ${total.toLocaleString()}…`}</p>
      <div
        className="review-results-dialog__progress"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total || 1}
        aria-valuenow={done}
      >
        <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

/**
 * Sends clips to one of a companion app's actions
 * (docs/architecture/companion-app.md): a dry run says what would happen,
 * then the send. Every word about the action comes from the companion.
 */
export default function CompanionSendPanel({
  companionId,
  action,
  companionName = "The companion app",
  instanceIds = [],
  excludedCount = 0,
  itemLabel = "clips",
  autoCheck = false,
  onBusyChange,
  onSent,
}) {
  const sender = useCompanionSend({ companionId, action: action.id, instanceIds, onSent });
  const { phase, busy, check } = sender;
  const count = instanceIds.length;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (autoCheck && phase === "idle" && count > 0) void check(false);
  }, [autoCheck, check, count, phase]);

  const dry = useMemo(() => summarizeSendResults(sender.dry), [sender.dry]);
  const final = useMemo(() => summarizeSendResults(sender.final), [sender.final]);
  const estimate = formatEstimate(dry.estimate);

  return (
    <article className="review-results-action review-results-action--copy companion-send">
      <div className="review-results-action__copy-heading">
        <div>
          <h3>{action.send}</h3>
          <p>
            {`${count.toLocaleString()} ${itemLabel}. ${companionName} decides what to do with each;`}
            {" Video Swarm names the files and moves nothing."}
          </p>
          {action.hint ? <p>{action.hint}</p> : null}
        </div>
        {phase === "idle" && (
          <button type="button" disabled={count === 0} onClick={() => check(false)}>
            Check {count.toLocaleString()}
          </button>
        )}
      </div>

      {excludedCount > 0 && (
        <p className="review-results-dialog__notice">
          {`${excludedCount.toLocaleString()} clip${excludedCount === 1 ? " is" : "s are"} not an indexed local file and cannot be sent.`}
        </p>
      )}

      {phase === "checking" && <Progress label="Checking" done={sender.done} total={sender.total} />}
      {phase === "sending" && <Progress label="Sending" done={sender.done} total={sender.total} />}

      {phase === "ready" && (
        <div className="companion-send__summary">
          <p role="status">
            <strong>{`${dry.sent.toLocaleString()} will be sent`}</strong>
            {estimate ? ` (${estimate})` : ""}
            {dry.skipped ? ` · ${dry.skipped.toLocaleString()} skipped` : ""}
            {dry.refused ? ` · ${dry.refused.toLocaleString()} cannot be sent` : ""}
            {dry.unknown ? ` · ${dry.unknown.toLocaleString()} unrecognised answers` : ""}
            {sender.dry && sender.dry.size < count
              ? ` · checked ${sender.dry.size.toLocaleString()} of ${count.toLocaleString()}`
              : ""}
          </p>
          <Reasons title="Skipped" reasons={dry.skippedReasons} />
          <Reasons title="Cannot be sent" reasons={dry.refusedReasons} />
          <label className="companion-send__again">
            <input
              type="checkbox"
              checked={sender.again}
              onChange={(event) => check(event.target.checked)}
            />
            <span>Send again clips sent before</span>
          </label>
        </div>
      )}

      {phase === "done" && (
        <div className="companion-send__summary">
          <p role="status">
            <strong>{`Sent ${final.sent.toLocaleString()}`}</strong>
            {final.skipped ? ` · ${final.skipped.toLocaleString()} skipped` : ""}
            {final.refused ? ` · ${final.refused.toLocaleString()} could not be sent` : ""}
            {final.unknown ? ` · ${final.unknown.toLocaleString()} unrecognised answers` : ""}
          </p>
          <Reasons title="Skipped" reasons={final.skippedReasons} />
          <Reasons title="Could not be sent" reasons={final.refusedReasons} />
        </div>
      )}

      {phase === "error" && (
        <p className="review-results-dialog__notice review-results-dialog__notice--error" role="alert">
          {sender.error}
        </p>
      )}

      <div className="companion-send__buttons">
        {busy && (
          <button type="button" onClick={sender.cancel}>
            Stop
          </button>
        )}
        {phase === "ready" && (
          <button type="button" className="companion-send__primary" disabled={dry.sent === 0} onClick={sender.send}>
            {`Send ${dry.sent.toLocaleString()}`}
          </button>
        )}
        {phase === "error" && (
          <button type="button" onClick={() => check(sender.again)}>
            Try again
          </button>
        )}
      </div>
    </article>
  );
}
