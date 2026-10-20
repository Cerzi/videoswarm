// Toasts share one stack in the top-right corner, newest at the bottom, so
// two notifications at once read as two instead of drawing over each other.
// The stack never takes clicks: controls under it stay usable.

export const TOAST_STACK_ID = "app-toast-stack";
const DEFAULT_DURATION_MS = 3000;
// A toast with a button (Undo) stays longer, so there is time to reach it.
const ACTION_DURATION_MS = 8000;
const COLORS = {
  error: "#ff4444",
  success: "#4CAF50",
  warning: "#ff9800",
  info: "#007acc",
};
const ICONS = { error: "❌", success: "✅", warning: "⚠️", info: "ℹ️" };

export function toastStack(doc = document) {
  let stack = doc.getElementById(TOAST_STACK_ID);
  if (!stack) {
    stack = doc.createElement("div");
    stack.id = TOAST_STACK_ID;
    stack.style.cssText = `
      position: fixed; top: 80px; right: 20px; z-index: 10001;
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
      max-width: 320px; pointer-events: none;
    `;
    doc.body.appendChild(stack);
  }
  return stack;
}

/**
 * Shows a toast. `action` (`{ label, onClick }`) adds one button, such as
 * Undo: only that toast takes clicks, it stays longer, and the button acts
 * once and closes it.
 */
export function showToast(message, type = "info", { doc = document, durationMs, action = null } = {}) {
  const toast = doc.createElement("div");
  toast.style.cssText = `
    background: ${COLORS[type] || COLORS.info};
    color: white; padding: 12px 16px; border-radius: 8px;
    font-family: system-ui, -apple-system, sans-serif; font-size: 14px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 300px; display: flex; gap: 8px;
    align-items: center; pointer-events: ${action ? "auto" : "none"};
    animation: slideInFromRight 0.2s ease-out;
  `;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  toast.setAttribute("aria-atomic", "true");
  const text = doc.createElement("span");
  text.textContent = `${ICONS[type] || ICONS.info} ${message}`;
  toast.appendChild(text);
  const stack = toastStack(doc);
  const close = () => {
    toast.remove();
    if (!stack.childElementCount) stack.remove();
  };
  if (action?.label && typeof action.onClick === "function") {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.style.cssText = `
      flex: none; margin-left: auto; padding: 3px 10px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.7); background: rgba(0,0,0,0.18);
      color: white; font: inherit; font-weight: 600; cursor: pointer;
    `;
    button.addEventListener("click", () => {
      close();
      action.onClick();
    }, { once: true });
    toast.appendChild(button);
  }
  stack.appendChild(toast);
  setTimeout(close, durationMs ?? (action ? ACTION_DURATION_MS : DEFAULT_DURATION_MS));
  return toast;
}
