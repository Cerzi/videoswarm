// hooks/useHotkeys.js
import { useEffect, useRef } from "react";
import { ActionIds } from "../actions/actions";
import { isEnabledForToolbar } from "../actions/actionPolicies";
import {
  ADD_TO_SEQUENCE_KEYS,
  FOLDER_DIRECTION_BY_KEY,
  REVIEW_CLEAR_RATING_KEYS,
  REVIEW_RATING_BY_KEY,
  REVIEW_STATE_BY_KEY,
  REVIEW_UNDO_KEYS,
  STACK_REJECT_UNREVIEWED_KEYS,
  STACK_TOGGLE_KEYS,
} from "../../hotkeys/shortcutCatalog";
import { ZOOM_LEVEL_STEP } from "../../zoom/config";

const clampIndex = (i, lo, hi) => Math.min(hi, Math.max(lo, i));

const normalizeDelta = (e) => {
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16;     // lines → px
  else if (e.deltaMode === 2) dy *= 120; // pages → px
  return dy;
};

const hasTextSelection = () => {
  const text = typeof window !== "undefined" ? window.getSelection?.()?.toString() : "";
  return Boolean(text && text.trim());
};

const readOptions = ({ run, getSelection, opts }) => {
  const {
    getZoomIndex,
    setZoomIndexSafe,
    minZoomIndex = 0,
    maxZoomIndex = 4,
    zoomStep = ZOOM_LEVEL_STEP,
    wheelStepUnits = 120,   // 120 ≈ one "notch" after normalization
    maxStepsPerFrame = 3,   // safety: avoid huge jumps per frame
    onSetReviewState,
    onSetRating,
    onUndoReview,
    onPreviousFolder,
    onNextFolder,
    onOpenHelp,
    onOpenDetails,
    onAddToSequence,
    // Prompt stacks: `onOpenStack(selection)` returns true when Enter opened
    // a stack, so a selected stack never falls through to opening clips.
    onToggleStacks,
    onOpenStack,
    onCloseStack,
    onRejectUnreviewedInStack,
    // Ctrl/⌘+A selects every clip the grid shows; Esc clears the selection.
    onSelectAll,
    onClearSelection,
    // Shift+R starts a review pass; Shift+1 / Shift+2 accept and send to the
    // first or second companion quick action.
    onStartReviewPass,
    onQuickReview,
  } = opts;
  return {
    run,
    getSelection,
    getZoomIndex,
    setZoomIndexSafe,
    minZoomIndex,
    maxZoomIndex,
    zoomStep,
    wheelStepUnits,
    maxStepsPerFrame,
    onSetReviewState,
    onSetRating,
    onUndoReview,
    onPreviousFolder,
    onNextFolder,
    onOpenHelp,
    onOpenDetails,
    onAddToSequence,
    onToggleStacks,
    onOpenStack,
    onCloseStack,
    onRejectUnreviewedInStack,
    onSelectAll,
    onClearSelection,
    onStartReviewPass,
    onQuickReview,
  };
};

// Chromium does not report Ctrl+wheel as a zoom request on macOS, so the
// renderer keeps its own wheel listener there.
const electronZoomWheelBridge = () => {
  if (typeof window === "undefined") return null;
  const api = window.electronAPI;
  if (!api || api.platform === "darwin") return null;
  return typeof api.onZoomWheel === "function" ? api.onZoomWheel : null;
};

export default function useHotkeys(run, getSelection, opts = {}) {
  const { enabled = true } = opts;
  const zoomAvailable = Boolean(opts.getZoomIndex && opts.setZoomIndexSafe);

  // Callers pass fresh closures on every render. Reading them through a ref
  // keeps one set of listeners for as long as the hook is enabled instead of
  // removing and re-adding them on every render.
  const latestRef = useRef(null);
  latestRef.current = { run, getSelection, opts };

  // ----- existing key handling (Enter/Ctrl+C/Delete/+/-) stays the same -----
  useEffect(() => {
    if (!enabled) return undefined;

    const onKey = (e) => {
      const {
        run,
        getSelection,
        getZoomIndex,
        setZoomIndexSafe,
        minZoomIndex,
        maxZoomIndex,
        zoomStep,
        onSetReviewState,
        onSetRating,
        onUndoReview,
        onPreviousFolder,
        onNextFolder,
        onOpenHelp,
        onOpenDetails,
        onAddToSequence,
        onToggleStacks,
        onOpenStack,
        onCloseStack,
        onRejectUnreviewedInStack,
        onSelectAll,
        onClearSelection,
        onStartReviewPass,
        onQuickReview,
      } = readOptions(latestRef.current);
      const target = e.target;
      if (target) {
        const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
        const isEditable =
          target.isContentEditable ||
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT";
        if (isEditable) {
          return;
        }
        if (target.closest?.("[data-hotkey-exempt]")) {
          return;
        }
      }

      const sel = getSelection();
      const size = sel?.size ?? 0;

      // Shift with a digit or R, by physical key so a layout's shifted
      // symbol does not matter.
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        if (e.code === "KeyR" && onStartReviewPass) {
          e.preventDefault();
          onStartReviewPass();
          return;
        }
        const quickIndex = e.code === "Digit1" ? 0 : e.code === "Digit2" ? 1 : -1;
        if (quickIndex >= 0 && onQuickReview && size > 0) {
          e.preventDefault();
          onQuickReview(quickIndex);
          return;
        }
      }

      // Every clip the grid shows, on screen or not; never the page's text.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "a" &&
        onSelectAll
      ) {
        e.preventDefault();
        onSelectAll();
        return;
      }

      if (size) {
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          e.key.toLowerCase() === "i" &&
          onOpenDetails
        ) {
          e.preventDefault();
          onOpenDetails();
          return;
        }
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          !e.repeat &&
          onAddToSequence &&
          ADD_TO_SEQUENCE_KEYS.includes(e.key.toLowerCase())
        ) {
          e.preventDefault();
          onAddToSequence(sel);
          return;
        }
        if (e.key === "Enter") {
          if (!e.repeat && onOpenStack?.(sel) === true) {
            e.preventDefault();
            return;
          }
          if (!isEnabledForToolbar(ActionIds.OPEN_EXTERNAL, size)) return;
          e.preventDefault();
          run(ActionIds.OPEN_EXTERNAL, sel);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
          // Highlighted text, such as a prompt in Details, copies as text.
          if (hasTextSelection()) return;
          e.preventDefault();
          run(ActionIds.COPY_PATH, sel);
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          run(ActionIds.MOVE_TO_TRASH, sel);
          return;
        }
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          !e.repeat &&
          onSetReviewState
        ) {
          const reviewState = REVIEW_STATE_BY_KEY[e.key.toLowerCase()];
          if (reviewState) {
            e.preventDefault();
            onSetReviewState(reviewState, sel);
            return;
          }
        }
        if (
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          !e.repeat &&
          onSetRating
        ) {
          const key = e.key.toLowerCase();
          const rating = REVIEW_RATING_BY_KEY[key];
          if (rating !== undefined) {
            e.preventDefault();
            onSetRating(rating, sel);
            return;
          }
          if (REVIEW_CLEAR_RATING_KEYS.includes(key)) {
            e.preventDefault();
            onSetRating(null, sel);
            return;
          }
        }
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const key = e.key.toLowerCase();
        if (!e.shiftKey && !e.repeat && onToggleStacks && STACK_TOGGLE_KEYS.includes(key)) {
          e.preventDefault();
          onToggleStacks();
          return;
        }
        if (
          e.shiftKey &&
          !e.repeat &&
          onRejectUnreviewedInStack &&
          STACK_REJECT_UNREVIEWED_KEYS.includes(key)
        ) {
          e.preventDefault();
          onRejectUnreviewedInStack();
          return;
        }
        if (e.key === "Escape" && onCloseStack) {
          e.preventDefault();
          onCloseStack();
          return;
        }
        // Esc meant for a dialog or menu never also drops the selection.
        if (
          e.key === "Escape" &&
          size > 0 &&
          onClearSelection &&
          !target?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]')
        ) {
          e.preventDefault();
          onClearSelection();
          return;
        }
        if (
          !e.shiftKey &&
          !e.repeat &&
          onUndoReview &&
          REVIEW_UNDO_KEYS.includes(e.key.toLowerCase())
        ) {
          e.preventDefault();
          onUndoReview();
          return;
        }
        if (e.key === "?" && onOpenHelp) {
          e.preventDefault();
          onOpenHelp();
          return;
        }
        const folderDirection = FOLDER_DIRECTION_BY_KEY[e.key];
        const navigateFolder =
          folderDirection === "previous"
            ? onPreviousFolder
            : folderDirection === "next"
              ? onNextFolder
              : null;
        if (navigateFolder) {
          e.preventDefault();
          navigateFolder();
          return;
        }
      }

      // +/- zoom (no modifiers)
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        getZoomIndex &&
        setZoomIndexSafe
      ) {
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          setZoomIndexSafe(
            clampIndex(getZoomIndex() + zoomStep, minZoomIndex, maxZoomIndex)
          );
        } else if (e.key === "-") {
          e.preventDefault();
          setZoomIndexSafe(
            clampIndex(getZoomIndex() - zoomStep, minZoomIndex, maxZoomIndex)
          );
        }
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);

  // ----- Ctrl/⌘ + Wheel → zoom, coalesced per frame -----
  useEffect(() => {
    if (!enabled || !zoomAvailable) return undefined;

    let accumulated = 0;
    let frame = 0;

    const tick = () => {
      frame = 0;
      const {
        getZoomIndex,
        setZoomIndexSafe,
        minZoomIndex,
        maxZoomIndex,
        zoomStep,
        wheelStepUnits,
        maxStepsPerFrame,
      } = readOptions(latestRef.current);
      if (!getZoomIndex || !setZoomIndexSafe) {
        accumulated = 0;
        return;
      }

      // Convert accumulated delta into whole steps
      const units = wheelStepUnits || 120;
      const stepsFloat = accumulated / units;
      let steps = stepsFloat < 0 ? Math.floor(stepsFloat) : Math.ceil(stepsFloat);
      // Bound steps per frame to avoid big jumps
      steps = Math.max(-maxStepsPerFrame, Math.min(maxStepsPerFrame, steps));
      if (steps === 0) return;

      // consume exactly the units we’re applying
      accumulated -= steps * units;

      // apply one-step moves repeatedly; this guarantees we never skip an index
      let current = getZoomIndex();
      const delta = steps > 0 ? zoomStep : -zoomStep;
      for (let i = 0; i < Math.abs(steps); i++) {
        const next = clampIndex(current + delta, minZoomIndex, maxZoomIndex);
        if (next === current) break; // hit a bound
        setZoomIndexSafe(next);
        current = next;
      }
    };

    const queue = (units) => {
      accumulated += units;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const cancel = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      accumulated = 0;
    };

    // In Electron, Ctrl+wheel arrives from the main process as zoom-changed.
    // A non-passive wheel listener on window would make Chromium wait for this
    // renderer's main thread before every scroll, so it is avoided there.
    const subscribeZoomWheel = electronZoomWheelBridge();
    if (subscribeZoomWheel) {
      const unsubscribe = subscribeZoomWheel((direction) => {
        const units = readOptions(latestRef.current).wheelStepUnits || 120;
        queue(direction === "in" ? units : -units);
      });
      return () => {
        if (typeof unsubscribe === "function") unsubscribe();
        cancel();
      };
    }

    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // only when modifier held
      e.preventDefault();
      queue(-normalizeDelta(e));
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel, { passive: false });
      cancel();
    };
  }, [enabled, zoomAvailable]);
}
