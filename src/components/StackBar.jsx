import React from "react";
import "./StackBar.css";

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

// The bar above the grid while one prompt stack is open: where it sits among
// the stacks, what it holds, and how to leave or cull it. See
// docs/architecture/prompt-stacks.md, Section 4.
export default function StackBar({
  position = 0,
  count = 0,
  runs = 0,
  total = 0,
  seeds = 0,
  hasPrevious = false,
  hasNext = false,
  unreviewedCount = 0,
  reviewModeEnabled = true,
  onClose,
  onPrevious,
  onNext,
  onRejectUnreviewed,
}) {
  const hidden = Math.max(0, total - runs);
  return (
    <div className="stack-bar" role="toolbar" aria-label="Open prompt stack">
      <button
        type="button"
        className="stack-bar__close"
        onClick={() => onClose?.()}
        title="Back to the stacked grid (Esc)"
      >
        <span aria-hidden="true">‹</span> All stacks
      </button>
      <span className="stack-bar__summary">
        {position > 0 && count > 0 ? `Stack ${position} of ${count}` : "Stack"}
        {" · "}
        {plural(runs, "run")}
        {seeds > 0 ? ` · ${plural(seeds, "seed")}` : ""}
        {hidden > 0 ? ` · ${hidden.toLocaleString()} more hidden by filters` : ""}
      </span>
      <span className="stack-bar__spacer" />
      {reviewModeEnabled && (
        <button
          type="button"
          onClick={() => onRejectUnreviewed?.()}
          disabled={unreviewedCount === 0}
          title="Reject every run without a decision; picks, ratings and rejects stay (Shift+D)"
        >
          {unreviewedCount > 0
            ? `Reject ${plural(unreviewedCount, "unreviewed run")}`
            : "No unreviewed runs"}
        </button>
      )}
      <button
        type="button"
        onClick={() => onPrevious?.()}
        disabled={!hasPrevious}
        title="Previous stack ([)"
        aria-label="Previous stack"
      >
        ‹ Previous
      </button>
      <button
        type="button"
        onClick={() => onNext?.()}
        disabled={!hasNext}
        title="Next stack (])"
        aria-label="Next stack"
      >
        Next ›
      </button>
    </div>
  );
}
