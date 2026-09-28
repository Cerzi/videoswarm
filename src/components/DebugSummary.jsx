import React from "react";

// The status line under the top bar. By default only what a reviewer uses:
// how many clips, and how they are sorted. View › Playback details adds the
// diagnostics for tuning playback (UX redesign D2).
export default function DebugSummary({
  detailed = false,
  total,
  rendered,
  playing,
  inView,
  activeWindow,
  activationTarget,
  memoryStatus, // { currentMemoryMB, memoryPressure, isNearLimit, safetyMarginMB }
  sortStatus,
  playbackDecision,
  playbackMode,
  playbackTelemetry,
  workSuspensionReason,
}) {
  if (!detailed) {
    const count = Math.max(0, Number(total) || 0);
    return (
      <div className="debug-info debug-info--short">
        <span>
          {count.toLocaleString()} {count === 1 ? "clip" : "clips"}
        </span>
        {sortStatus && <span aria-hidden="true">·</span>}
        {sortStatus && <span>{sortStatus}</span>}
      </div>
    );
  }

  return (
    <div
      className="debug-info"
      style={{
        fontSize: "0.75rem",
        color: "#888",
        background: "#1a1a1a",
        padding: "0.3rem 0.8rem",
        borderRadius: 4,
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
      }}
    >
      {sortStatus && <span>{sortStatus}</span>}
      {sortStatus && <span>|</span>}
      <span>🎬 {total} videos</span>
      <span>🎭 {rendered} rendered</span>
      {typeof activeWindow === "number" && (
        <span>
          🪄 {activeWindow}
          {typeof activationTarget === "number"
            ? ` / ${Math.round(activationTarget)}`
            : ""}
          {" "}active window
        </span>
      )}
      <span>▶️ {playing} playing</span>
      {playbackDecision && (
        <span title={(playbackDecision.reasons || []).join(", ")}>
          ⚙️ {playbackMode || playbackDecision.mode}: {playbackDecision.target}/
          {playbackDecision.safetyCap} ({playbackDecision.health})
        </span>
      )}
      {workSuspensionReason && <span>⏸ {workSuspensionReason}</span>}
      {playbackTelemetry?.droppedFrameRatio != null && (
        <span>
          Frames dropped {Math.round(playbackTelemetry.droppedFrameRatio * 100)}%
        </span>
      )}
      <span>👁️ {inView} in view</span>

      {memoryStatus && (
        <>
          <span>|</span>
          <span
            style={{
              color: memoryStatus.isNearLimit
                ? "#ff6b6b"
                : memoryStatus.memoryPressure > 70
                ? "#ffa726"
                : "#51cf66",
              fontWeight: memoryStatus.isNearLimit ? "bold" : "normal",
            }}
          >
            🧠 {memoryStatus.currentMemoryMB}MB ({memoryStatus.memoryPressure}
            %)
          </span>
          {memoryStatus.safetyMarginMB < 500 && (
            <span style={{ color: "#ff6b6b", fontWeight: "bold" }}>
              ⚠️ {memoryStatus.safetyMarginMB}MB margin
            </span>
          )}
        </>
      )}

      {total > 100}

      {process.env.NODE_ENV !== "production" && performance.memory && (
        <>
          <span>|</span>
          <span style={{ color: "#666", fontSize: "0.7rem" }}>
            Press Ctrl+Shift+G for manual GC
          </span>
        </>
      )}
    </div>
  );
}
