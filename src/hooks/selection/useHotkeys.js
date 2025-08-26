// hooks/useHotkeys.js
import { useEffect, useRef } from "react";
import { ActionIds } from "../actions/actions";
import { isEnabledForToolbar } from "../actions/actionPolicies";

const clampIndex = (i, lo, hi) => Math.min(hi, Math.max(lo, i));

export default function useHotkeys(run, getSelection, opts = {}) {
  const {
    getZoomIndex,
    setZoomIndexSafe,
    minZoomIndex = 0,
    maxZoomIndex = 4,
    wheelStepUnits = 120,   // 120 ≈ one "notch" after normalization
    maxStepsPerFrame = 3,   // safety: avoid huge jumps per frame
  } = opts;

  // ----- existing key handling (Enter/Ctrl+C/Delete/+/-) stays the same -----
  useEffect(() => {
    const onKey = (e) => {
      const sel = getSelection();
      const size = sel?.size ?? 0;

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

      // +/- zoom (no modifiers)
      if (getZoomIndex && setZoomIndexSafe) {
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          setZoomIndexSafe(clampIndex(getZoomIndex() + 1, minZoomIndex, maxZoomIndex));
        } else if (e.key === "-") {
          e.preventDefault();
          setZoomIndexSafe(clampIndex(getZoomIndex() - 1, minZoomIndex, maxZoomIndex));
        }
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [run, getSelection, getZoomIndex, setZoomIndexSafe, minZoomIndex, maxZoomIndex]);

  // ----- Ctrl/⌘ + Wheel → zoom, coalesced per frame -----
  const accumRef = useRef(0);
  const rafRef = useRef(0);
  const lastDirRef = useRef(0); // remember last direction to keep feel consistent within frame

  const normalizeDelta = (e) => {
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;     // lines → px
    else if (e.deltaMode === 2) dy *= 120; // pages → px
    return dy;
  };

  useEffect(() => {
    if (!getZoomIndex || !setZoomIndexSafe) return;

    const tick = () => {
      rafRef.current = 0;

      // Convert accumulated delta into whole steps
      const units = wheelStepUnits || 120;
      let stepsFloat = accumRef.current / units;
      let steps = stepsFloat < 0 ? Math.floor(stepsFloat) : Math.ceil(stepsFloat);
      // Bound steps per frame to avoid big jumps
      steps = Math.max(-maxStepsPerFrame, Math.min(maxStepsPerFrame, steps));

      if (steps !== 0) {
        // consume exactly the units we’re applying
        accumRef.current -= steps * units;

        let current = getZoomIndex();
        const dir = steps > 0 ? (lastDirRef.current || 1) : (lastDirRef.current || -1);
        const sign = steps > 0 ? Math.sign(dir) : Math.sign(dir);

        // apply one-step moves repeatedly; this guarantees we never skip an index
        const iterations = Math.abs(steps);
        for (let i = 0; i < iterations; i++) {
          const next = clampIndex(current + (sign < 0 ? -1 : +1), minZoomIndex, maxZoomIndex);
          if (next === current) break; // hit a bound
          setZoomIndexSafe(next);
          current = next;
        }

        lastDirRef.current = sign;
      }
    };

    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // only when modifier held
      e.preventDefault();

      const dy = normalizeDelta(e);
      accumRef.current += dy;

      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel, { passive: false });
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      accumRef.current = 0;
      lastDirRef.current = 0;
    };
  }, [getZoomIndex, setZoomIndexSafe, minZoomIndex, maxZoomIndex, wheelStepUnits, maxStepsPerFrame]);
}
