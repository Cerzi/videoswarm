function readWindowActivity(window) {
  const destroyed = Boolean(window?.isDestroyed?.());
  const visible = !destroyed && (window?.isVisible?.() ?? true);
  const minimized = !destroyed && Boolean(window?.isMinimized?.());
  const active = visible && !minimized;

  return {
    active,
    visible,
    minimized,
    reason: destroyed
      ? "destroyed"
      : !visible
        ? "hidden"
        : minimized
          ? "minimized"
          : "active",
  };
}

function attachWindowActivity(window, onChange, { emitInitial = true } = {}) {
  if (!window || typeof onChange !== "function") return () => {};

  let disposed = false;
  const publish = () => {
    if (!disposed) onChange(readWindowActivity(window));
  };
  const events = ["minimize", "restore", "hide", "show", "closed"];
  for (const eventName of events) window.on?.(eventName, publish);
  if (emitInitial) publish();

  return () => {
    if (disposed) return;
    disposed = true;
    for (const eventName of events) {
      window.removeListener?.(eventName, publish);
    }
  };
}

module.exports = {
  attachWindowActivity,
  readWindowActivity,
};
