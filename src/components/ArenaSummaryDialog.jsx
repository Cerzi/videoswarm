import React, { useEffect, useRef } from "react";
import "./ArenaSummaryDialog.css";
import { arenaSummaryRows } from "../app/arena/arenaView";

// Shown on leaving the arena (docs/architecture/rating-arena.md, Section 3):
// what the session did, and a way straight back in. Enter keeps going, Esc
// is done.
export default function ArenaSummaryDialog({ ended, onMore, onDone }) {
  const moreRef = useRef(null);
  useEffect(() => {
    if (ended) moreRef.current?.focus();
  }, [ended]);
  if (!ended) return null;
  const rows = arenaSummaryRows(ended.stats, ended.tagged);
  return (
    <div
      className="arena-summary-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDone?.();
      }}
    >
      <div
        className="arena-summary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="arena-summary-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDone?.();
          }
        }}
      >
        <h2 id="arena-summary-title">Arena session done</h2>
        <dl className="arena-summary__counts">
          {rows.map((row) => (
            <div key={row.key} className={`arena-summary__count arena-summary__count--${row.key}`}>
              <dt>{row.label}</dt>
              <dd>{row.value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        <div className="arena-summary__actions">
          <button type="button" onClick={() => onDone?.()}>
            Done <kbd>Esc</kbd>
          </button>
          <button
            type="button"
            ref={moreRef}
            className="arena-summary__more"
            onClick={() => onMore?.()}
          >
            More rounds <kbd>⏎</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
