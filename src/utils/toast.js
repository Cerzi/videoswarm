export function showToast(message, type = "info") {
  const colors = {
    error: "#ff4444",
    success: "#4CAF50",
    warning: "#ff9800",
    info: "#007acc",
  };
  const icons = { error: "❌", success: "✅", warning: "⚠️", info: "ℹ️" };

  const el = document.createElement("div");
  el.style.cssText = `
      position: fixed; top: 80px; right: 20px;
      background: ${colors[type] || colors.info};
      color: white; padding: 12px 16px; border-radius: 8px; z-index: 10001;
      font-family: system-ui, -apple-system, sans-serif; font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 300px; display:flex; gap:8px;
      animation: slideInFromRight 0.2s ease-out;
      pointer-events: none;
    `;
  el.textContent = `${icons[type] || icons.info} ${message}`;
  document.body.appendChild(el);

  const timer = setTimeout(() => {
    if (document.body.contains(el)) {
      document.body.removeChild(el);
    }
  }, 3000);

  return {
    element: el,
    dispose: () => {
      clearTimeout(timer);
      if (document.body.contains(el)) {
        document.body.removeChild(el);
      }
    },
  };
}
