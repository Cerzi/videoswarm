import React from "react";

export default function DebugSummary({
  total,
  rendered,
  playing,
  inView,
  memoryStatus, // { currentMemoryMB, memoryPressure, isNearLimit, safetyMarginMB }
  zoomLevel,
  getMinimumZoomLevel,
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
      <span>🎬 {total} videos</span>
      <span>🎭 {rendered} rendered</span>
      <span>▶️ {playing} playing</span>
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
