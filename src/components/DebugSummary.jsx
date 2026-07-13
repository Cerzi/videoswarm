import React from "react";

export default function DebugSummary({
  total,
  rendered,
  playing,
  inView,
  activeWindow,
  activationTarget,
  progressiveVisible,
  memoryStatus, // { currentMemoryMB, memoryPressure, isNearLimit, safetyMarginMB }
  zoomLevel,
  getMinimumZoomLevel,
  sortStatus,
  playbackDecision,
  playbackMode,
  playbackTelemetry,
  workSuspensionReason,
}) {
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
