import { useEffect, useRef } from "react";

// Checks after the cards change: new cards register as visible a moment
// after they appear, and hover audio waits for that, so it is asked again.
const RECHECK_MS = Object.freeze([60, 250, 700]);

/** The card under a point: its `data-video-id`, or null. */
export function cardIdAtPoint(point, doc = document) {
  if (!point || typeof doc?.elementFromPoint !== "function") return null;
  const element = doc.elementFromPoint(point.x, point.y);
  const card = element?.closest?.(".video-item[data-video-id]");
  return card?.getAttribute("data-video-id") || null;
}

/**
 * Cards that appear under a pointer that has not moved (a new arena round)
 * get no mouseenter until it moves. When `trigger` changes, the card under
 * the pointer's last position counts as entered: `onEnter(id)`.
 */
export function useHoverUnderPointer(trigger, onEnter) {
  const pointRef = useRef(null);
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;

  useEffect(() => {
    const track = (event) => {
      pointRef.current = { x: event.clientX, y: event.clientY };
    };
    const forget = () => {
      pointRef.current = null;
    };
    window.addEventListener("pointermove", track, { passive: true });
    document.documentElement.addEventListener("mouseleave", forget);
    return () => {
      window.removeEventListener("pointermove", track);
      document.documentElement.removeEventListener("mouseleave", forget);
    };
  }, []);

  useEffect(() => {
    if (trigger == null) return undefined;
    const timers = RECHECK_MS.map((delay) =>
      setTimeout(() => {
        const id = cardIdAtPoint(pointRef.current);
        if (id) onEnterRef.current?.(id);
      }, delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [trigger]);
}
