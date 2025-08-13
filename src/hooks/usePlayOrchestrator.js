import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Centralized play orchestration:
 * - Chooses which videos should be playing (up to maxPlaying)
 * - Always includes the most-recently hovered item if loaded (may bump another)
 * - Demotes items that failed to start (temporary penalty)
 * - Keeps already-playing items stable when possible
 */
export default function usePlayOrchestrator({
  visibleIds,          // Set<string>
  loadedIds,           // Set<string>
  maxPlaying,          // number
  penaltyMs = 6000,    // failure penalty lifetime
  hoverBoostMs = 2000, // hover priority lifetime
}) {
  const [playingSet, setPlayingSet] = useState(new Set());

  const failMapRef = useRef(new Map()); // id -> { count, ts }
  const hoverRef = useRef({ id: null, ts: 0 });
  const prevPlayingRef = useRef(new Set());

  // Call this when a card is hovered
  const markHover = useCallback((id) => {
    if (!id) return;
    hoverRef.current = { id, ts: Date.now() };
  }, []);

  // Card reported a play() rejection
  const reportPlayError = useCallback((id) => {
    if (!id) return;
    const m = failMapRef.current;
    const prev = m.get(id) || { count: 0, ts: 0 };
    m.set(id, { count: prev.count + 1, ts: Date.now() });
  }, []);

  // Card reported it started playing
  const reportStarted = useCallback((id) => {
    const m = failMapRef.current;
    const prev = m.get(id);
    if (prev) {
      const next = Math.max(0, prev.count - 1);
      if (next === 0) m.delete(id);
      else m.set(id, { count: next, ts: prev.ts });
    }
  }, []);

  useEffect(() => {
    const now = Date.now();
    const prev = prevPlayingRef.current;

    // Base candidates: visible & loaded
    const visibleLoaded = Array.from(visibleIds).filter((id) =>
      loadedIds.has(id)
    );

    // Stability: keep already playing, still eligible
    const keep = visibleLoaded.filter((id) => prev.has(id));

    // Remaining candidates
    const rest = visibleLoaded.filter((id) => !prev.has(id));

    // Hover handling (can override visibility, but must be loaded)
    const hovered =
      hoverRef.current.id && now - hoverRef.current.ts < hoverBoostMs
        ? hoverRef.current.id
        : null;

    // If hovered is loaded, ensure it's a candidate
    let hoveredEligible = null;
    if (hovered && loadedIds.has(hovered)) {
      hoveredEligible = hovered;
      if (!rest.includes(hoveredEligible) && !keep.includes(hoveredEligible)) {
        rest.unshift(hoveredEligible);
      }
    }

    // Expire old penalties
    const fm = failMapRef.current;
    for (const [id, rec] of fm) {
      if (now - rec.ts > penaltyMs) fm.delete(id);
    }

    // Sort new candidates by penalty (lower penalty first)
    rest.sort(
      (a, b) => (fm.get(a)?.count || 0) - (fm.get(b)?.count || 0)
    );

    // Compose target
    let target = [...keep];

    // Always include hovered if eligible
    if (
      hoveredEligible &&
      !target.includes(hoveredEligible) &&
      !rest.includes(hoveredEligible)
    ) {
      rest.unshift(hoveredEligible);
    }

    // Fill remaining slots from rest
    const slots = Math.max(0, maxPlaying - target.length);
    if (slots > 0) {
      target = target.concat(rest.slice(0, slots));
    }

    // If still not included hovered but eligible, forcibly include it by bumping the last one
    if (hoveredEligible && !target.includes(hoveredEligible)) {
      if (target.length < maxPlaying) {
        target.push(hoveredEligible);
      } else if (maxPlaying > 0) {
        // Prefer to bump the last non-hover, non-keep if possible
        const toBumpIdx = target.findLastIndex((id) => id !== hoveredEligible && !prev.has(id));
        const bumpIndex = toBumpIdx >= 0 ? toBumpIdx : target.length - 1;
        target[bumpIndex] = hoveredEligible;
      }
    }

    const nextSet = new Set(target);
    prevPlayingRef.current = nextSet;
    setPlayingSet(nextSet);
  }, [visibleIds, loadedIds, maxPlaying, penaltyMs, hoverBoostMs]);

  return { playingSet, markHover, reportPlayError, reportStarted };
}
