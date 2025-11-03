function MemoryAlert({ memStatus }) {
  if (!memStatus || !memStatus.isNearLimit) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: "80px",
        right: "20px",
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
