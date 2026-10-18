import React from "react";
import "./StackBar.css";

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

// The bar above the grid while one clip's versions are side by side: how many
// there are, how many live in folders that are not open, and the way back.
// See docs/architecture/generation-versions.md, Section 8.
export default function VersionsBar({
  count = 0,
  elsewhere = 0,
  loading = false,
  failed = false,
  truncated = false,
  onClose,
  onRestart,
}) {
  let summary;
  if (failed) summary = "The other versions could not be read";
  else if (loading) summary = "Reading versions…";
  else {
    summary = `${plural(count, "version")} of this generation, best first`;
    if (elsewhere > 0) summary += ` · ${elsewhere.toLocaleString()} from folders that aren't open`;
    if (truncated) summary += " · more not shown";
  }
  return (
    <div className="stack-bar" role="toolbar" aria-label="Versions side by side">
      <button
        type="button"
        className="stack-bar__close"
        onClick={() => onClose?.()}
        title="Back to the grid (Esc)"
      >
        <span aria-hidden="true">‹</span> Back
      </button>
      <span className="stack-bar__summary">{summary}</span>
      <span className="stack-bar__spacer" />
      <button
        type="button"
        onClick={() => onRestart?.()}
        disabled={loading || count < 2}
        title="Play every version from its first frame at once"
      >
        Play together from the start
      </button>
    </div>
  );
}
