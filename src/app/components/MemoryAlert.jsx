import React from "react";

function MemoryAlert({ memStatus }) {
  if (!memStatus || !memStatus.isNearLimit) return null;
  return (
    <div
      style={{
        // Bottom-right, clear of the toast stack, and never in the way of
        // the controls underneath.
        position: "fixed",
        bottom: "20px",
        right: "20px",
        pointerEvents: "none",
        background: "rgba(255, 107, 107, 0.95)",
        color: "white",
        padding: "1rem",
        borderRadius: "8px",
        zIndex: 1000,
        maxWidth: "300px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      }}
    >
      <div style={{ fontWeight: "bold", marginBottom: "0.5rem" }}>
        🚨 Memory Warning
      </div>
      <div style={{ fontSize: "0.9rem" }}>
        Memory usage: {memStatus.currentMemoryMB}MB ({memStatus.memoryPressure}%)
        <br />
        Reducing video quality to prevent crashes.
      </div>
    </div>
  );
}

export default MemoryAlert;
