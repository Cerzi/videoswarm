import { useCallback, useEffect, useRef, useState } from "react";

// Back and forward between views: folders, library searches and open stacks.
// A view is recorded once it has settled, so the steps of one navigation (a
// root opening, then its folder) make one entry. Going back or forward lands
// through the app's own navigation; wherever it settles then replaces that
// entry rather than adding one.

export const VIEW_HISTORY_LIMIT = 50;
export const VIEW_SETTLE_MS = 350;
// A back or forward that has not settled by now stops waiting for it.
const LANDING_TIMEOUT_MS = 8000;

export const viewHistoryKey = (entry) => (entry ? JSON.stringify(entry) : "");

const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;

const isTyping = (target) =>
  Boolean(
    target &&
      (target.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName || "") ||
        target.closest?.("[data-hotkey-exempt]"))
  );

/**
 * `current` is the view now on screen (or null, which is not recorded);
 * `navigate(entry)` takes the app to a recorded view. `onBack` runs instead
 * of going back when it returns true (closing fullscreen, for one). Returns
 * `{ back, forward, canGoBack, canGoForward }`.
 */
export function useViewHistory({ current, navigate, onBack, enabled = true }) {
  const historyRef = useRef({ entries: [], index: -1, landing: null, landingSince: 0 });
  const [position, setPosition] = useState({ canGoBack: false, canGoForward: false });
  const currentRef = useRef(current);
  currentRef.current = current;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const currentKey = viewHistoryKey(current);

  const publish = useCallback(() => {
    const { entries, index } = historyRef.current;
    setPosition((previous) => {
      const next = { canGoBack: index > 0, canGoForward: index < entries.length - 1 };
      return previous.canGoBack === next.canGoBack && previous.canGoForward === next.canGoForward
        ? previous
        : next;
    });
  }, []);

  useEffect(() => {
    if (!currentKey) return undefined;
    const timer = setTimeout(() => {
      const history = historyRef.current;
      const entry = currentRef.current;
      const key = viewHistoryKey(entry);
      if (!key) return;
      if (history.landing !== null && Date.now() - history.landingSince > LANDING_TIMEOUT_MS) {
        history.landing = null;
      }
      if (history.landing !== null) {
        history.entries[history.index] = entry;
        if (key === history.landing) history.landing = null;
      } else if (viewHistoryKey(history.entries[history.index]) !== key) {
        history.entries = [...history.entries.slice(0, history.index + 1), entry].slice(
          -VIEW_HISTORY_LIMIT
        );
        history.index = history.entries.length - 1;
      }
      publish();
    }, VIEW_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [currentKey, publish]);

  const go = useCallback(
    (step) => {
      const history = historyRef.current;
      const target = history.index + step;
      if (target < 0 || target >= history.entries.length) return false;
      history.index = target;
      history.landing = viewHistoryKey(history.entries[target]);
      history.landingSince = Date.now();
      publish();
      navigateRef.current?.(history.entries[target]);
      return true;
    },
    [publish]
  );

  const back = useCallback(() => {
    if (onBackRef.current?.()) return true;
    return go(-1);
  }, [go]);
  const forward = useCallback(() => go(1), [go]);

  // The mouse's back and forward buttons, and Alt+← / Alt+→.
  useEffect(() => {
    if (!enabled) return undefined;
    const onMouseUp = (event) => {
      if (event.button !== BACK_BUTTON && event.button !== FORWARD_BUTTON) return;
      event.preventDefault();
      if (event.button === BACK_BUTTON) back();
      else forward();
    };
    const onKeyDown = (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      if (event.key === "ArrowLeft") back();
      else forward();
    };
    window.addEventListener("mouseup", onMouseUp, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [back, enabled, forward]);

  return { back, forward, ...position };
}
