import React, { useMemo } from "react";
import SequenceDialog from "./SequenceDialog";

/**
 * Confirmation for renaming a sequence's originals in place. It lists every
 * rename exactly as the main process planned it, grouped by folder, because
 * the whole point of asking is that the person sees what will change.
 */
export default function SequenceRenumberDialog({
  open,
  sequenceName = "",
  plan = null,
  applying = false,
  error = "",
  onConfirm,
  onClose,
}) {
  const renames = Array.isArray(plan?.renames) ? plan.renames : [];
  const unchangedCount = Number(plan?.unchangedCount) || 0;
  const groups = useMemo(() => {
    const byDirectory = new Map();
    for (const rename of renames) {
      const key = rename.directory || "";
      if (!byDirectory.has(key)) byDirectory.set(key, []);
      byDirectory.get(key).push(rename);
    }
    return [...byDirectory.entries()];
  }, [renames]);
  const count = renames.length;

  return (
    <SequenceDialog
      open={open}
      title="Rename originals to this order"
      subtitle={sequenceName ? `“${sequenceName}”` : undefined}
      mark="#"
      busy={applying}
      onClose={onClose}
      closeLabel="Cancel renaming"
      footer={
        <>
          <button
            type="button"
            className="sequence-dialog__secondary"
            disabled={applying}
            onClick={() => onClose?.()}
          >
            {count ? "Cancel" : "Close"}
          </button>
          {count > 0 && (
            <button
              type="button"
              className="sequence-dialog__danger"
              disabled={applying || !plan?.planId}
              onClick={() => onConfirm?.(plan?.planId)}
            >
              {applying
                ? "Renaming…"
                : `Rename ${count.toLocaleString()} file${count === 1 ? "" : "s"}`}
            </button>
          )}
        </>
      }
    >
      {count === 0 ? (
        <p className="review-results-dialog__notice" role="status">
          Every file already carries its number. Nothing needs renaming.
        </p>
      ) : (
        <>
          <p className="sequence-dialog__lead">
            {count.toLocaleString()} original file{count === 1 ? "" : "s"} will
            be renamed in {count === 1 ? "its" : "their"} own folder so the
            names sort in sequence order. Other tools and workflows that refer
            to the old names will no longer find them.
          </p>
          <ul className="sequence-dialog__facts">
            <li>Tags, ratings and review state stay with the clips.</li>
            <li>
              Nothing is overwritten. If any rename fails, every file is
              renamed back.
            </li>
            {unchangedCount > 0 && (
              <li>
                {unchangedCount.toLocaleString()} file
                {unchangedCount === 1 ? " already carries its" : "s already carry their"}{" "}
                number and {unchangedCount === 1 ? "is" : "are"} left alone.
              </li>
            )}
          </ul>
        </>
      )}

      {error && (
        <p
          className="review-results-dialog__notice review-results-dialog__notice--error"
          role="alert"
        >
          {error}
        </p>
      )}

      {groups.map(([directory, items]) => (
        <section key={directory} className="sequence-dialog__group">
          <h3 title={directory}>{directory}</h3>
          <ol className="sequence-dialog__renames" aria-label={`Renames in ${directory}`}>
            {items.map((rename) => (
              <li key={`${rename.position}:${rename.fromName}`}>
                <span className="sequence-dialog__from" title={rename.fromName}>
                  {rename.fromName}
                </span>
                <span className="sequence-dialog__arrow" aria-label="becomes">
                  →
                </span>
                <strong className="sequence-dialog__to" title={rename.toName}>
                  {rename.toName}
                </strong>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </SequenceDialog>
  );
}
