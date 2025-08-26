// hooks/useHotkeys.js
import { useEffect, useRef } from "react";
import { ActionIds } from "../actions/actions";
import { isEnabledForToolbar } from "../actions/actionPolicies";

const clampIndex = (i, lo, hi) => Math.min(hi, Math.max(lo, i));

/**
 * Global hotkeys → actions + zoom:
 *  - Ctrl/⌘ + MouseWheel → zoom stepwise
 *  - + / - keys → zoom stepwise
 */
export default function useHotkeys(run, getSelection, opts = {}) {
  const {
    getZoomIndex,
    setZoomIndexSafe,
    minZoomIndex = 0,
    maxZoomIndex = 4,
    wheelStepUnits = 100,   // bigger = more scroll to step
    maxStepsPerWheel = 6,   // safety cap per event
  } = opts;

  // --- Keyboard shortcuts (actions + +/- zoom) ---
  useEffect(() => {
    const onKey = (e) => {
      const sel = getSelection();
      const size = sel?.size ?? 0;

      // Selection actions (only if something is selected)
      if (size) {
        if (e.key === "Enter") {
          if (!isEnabledForToolbar(ActionIds.OPEN_EXTERNAL, size)) return;
          e.preventDefault();
          run(ActionIds.OPEN_EXTERNAL, sel);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
          e.preventDefault();
          run(ActionIds.COPY_PATH, sel);
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          run(ActionIds.MOVE_TO_TRASH, sel);
          return;
        }
      }

      // Zoom by +/- (no modifiers)
      if (getZoomIndex && setZoomIndexSafe) {
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          const next = clampIndex(getZoomIndex() + 1, minZoomIndex, maxZoomIndex);
          setZoomIndexSafe(next);
        } else if (e.key === "-") {
          e.preventDefault();
          const next = clampIndex(getZoomIndex() - 1, minZoomIndex, maxZoomIndex);
          setZoomIndexSafe(next);
        }
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [run, getSelection, getZoomIndex, setZoomIndexSafe, minZoomIndex, maxZoomIndex]);

  // --- Ctrl/⌘ + MouseWheel → Zoom ---
  const accumRef = useRef(0);

  const normalizeDelta = (e) => {
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 120;
    return dy;
  };

  useEffect(() => {
    if (!getZoomIndex || !setZoomIndexSafe) return;

    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();

      accumRef.current += normalizeDelta(e);

      // how many steps should we take this event?
      let steps = 0;
      while (Math.abs(accumRef.current) >= wheelStepUnits && steps < maxStepsPerWheel) {
        steps += 1;
        accumRef.current += accumRef.current < 0 ? wheelStepUnits : -wheelStepUnits;
      }
      if (!steps) return;

      // apply steps, updating current as we go
      let current = getZoomIndex();
      for (let i = 0; i < steps; i++) {
        const dir = normalizeDelta(e) < 0 ? +1 : -1; // up/forward = zoom in
        const next = clampIndex(current + dir, minZoomIndex, maxZoomIndex);
        if (next === current) break; // already at bound
        setZoomIndexSafe(next);
        current = next; // advance so we don't repeat same value
      }
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel, { passive: false });
  }, [getZoomIndex, setZoomIndexSafe, minZoomIndex, maxZoomIndex, wheelStepUnits, maxStepsPerWheel]);
}
