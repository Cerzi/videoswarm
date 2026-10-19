import React from "react";
import "./StackBar.css";

const format = (value) => (Number(value) || 0).toLocaleString();

// The bar above the grid during a review pass: what the pass is, how many of
// its clips have a decision, and the way out. At the end, a pass made from a
// search offers that search again. See docs/architecture/review-passes.md.
export default function ReviewPassBar({
  name = "Review pass",
  decided = 0,
  total = 0,
  done = false,
  canRerun = false,
  onExit,
  onRerun,
}) {
  return (
    <div className="stack-bar" role="toolbar" aria-label="Review pass">
      <button
        type="button"
        className="stack-bar__close"
        onClick={() => onExit?.()}
        title="Leave the pass; it stays in the sidebar to resume until every clip is decided"
      >
        <span aria-hidden="true">‹</span> Exit pass
      </button>
      <span className="stack-bar__summary">
        {done
          ? `${name} · all ${format(total)} decided`
          : `${name} · ${format(decided)} of ${format(total)} decided`}
      </span>
      <span className="stack-bar__spacer" />
      {done && canRerun ? (
        <button
          type="button"
          onClick={() => onRerun?.()}
          title="Run the search this pass was made from again, to see what matches now"
        >
          Run the search again
        </button>
      ) : null}
    </div>
  );
}
